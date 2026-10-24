import {resolveMiniappDataPartition} from "@mentra/engine-host-internal"

import {
  applyWebStorageReport,
  beginWebStorageMove,
  isWebStorageMoved,
  legacyKeptWebStorageKey,
  legacyWebStorageMoveAttemptsKey,
  legacyWebStorageMovedKey,
  MAX_WEB_STORAGE_MOVE_ATTEMPTS,
  MOVED_WEB_STORAGE_KEYS,
  movesWebStorage,
  openWebStorageKeeper,
  parseWebStorageRead,
  parseWebStorageReport,
  removeWebStorageReader,
  resetWebStorageMoveStateForTests,
  webStorageReaderHtml,
  writeWebStorageReader,
  type WebStorageKeeper,
} from "./webStorageMigration"
import {storage} from "@/utils/storage"

// MMKV with one store per instance id, so logout's clearAll() of the default instance is what it is on a phone.
const mockMmkvInstances = new Map<string, Map<string, string>>()
jest.mock("react-native-mmkv", () => ({
  createMMKV: (config?: {id?: string}) => {
    const id = config?.id ?? "mmkv.default"
    if (!mockMmkvInstances.has(id)) mockMmkvInstances.set(id, new Map())
    const values = mockMmkvInstances.get(id)!
    return {
      getString: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, String(value)),
      remove: (key: string) => values.delete(key),
      contains: (key: string) => values.has(key),
      getAllKeys: () => [...values.keys()],
      clearAll: () => values.clear(),
      trim: () => undefined,
    }
  },
}))

const mockFiles = new Map<string, string>()
const mockDirectories = new Set<string>()
jest.mock("expo-file-system", () => {
  const join = (parts: unknown[]) =>
    parts
      .map((part) => (typeof part === "string" ? part : (part as {uri: string}).uri))
      .join("/")
      .replace(/([^:/])\/{2,}/g, "$1/")
  class Directory {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = join(parts)
    }
    get exists() {
      return mockDirectories.has(this.uri)
    }
    create() {
      mockDirectories.add(this.uri)
    }
    delete() {
      mockDirectories.delete(this.uri)
      for (const key of [...mockFiles.keys()]) if (key.startsWith(`${this.uri}/`)) mockFiles.delete(key)
    }
  }
  class File {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = join(parts)
    }
    write(content: string) {
      mockFiles.set(this.uri, content)
    }
  }
  return {Directory, File, Paths: {cache: "file:///cache", document: "file:///documents"}}
})

const NOTES = "com.mentra.notes"
const CALL = "com.mentra.call"
const JOURNAL = "com.example.journal"
const DIARY = "com.example.diary"
const originOf = (packageName: string) => `miniapp://${packageName}`

/** A page's web storage, as WebKit keeps it on disk. */
type Store = Map<string, string>

/**
 * A minimal page: its own origin, its own Storage class (so a script patching `Storage.prototype` patches only this
 * page), the WebView bridge, timers, and the page-hide events.
 */
function page(options: {
  origin: string
  store: Store
  /** The WebView's session storage: shared by its documents, so a reload keeps it. */
  session?: Store
  topFrame?: boolean
  failingKeys?: string[]
  bridge?: boolean
}) {
  const posted: string[] = []
  const listeners: Record<string, () => void> = {}
  class Storage {
    constructor(private readonly data: Store) {}
    get length() {
      return this.data.size
    }
    key(index: number) {
      return [...this.data.keys()][index] ?? null
    }
    getItem(key: string) {
      return this.data.has(key) ? this.data.get(key)! : null
    }
    setItem(key: string, value: string) {
      if (options.failingKeys?.includes(key)) throw new Error("QuotaExceededError")
      this.data.set(key, String(value))
    }
    removeItem(key: string) {
      this.data.delete(key)
    }
    clear() {
      this.data.clear()
    }
  }
  const sessionData: Store = options.session ?? new Map()
  const win: Record<string, unknown> = {
    location: {origin: options.origin},
    localStorage: new Storage(options.store),
    sessionStorage: new Storage(sessionData),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    addEventListener: (type: string, fn: () => void) => (listeners[type] = fn),
  }
  if (options.bridge !== false) win.ReactNativeWebView = {postMessage: (message: string) => posted.push(message)}
  win.self = win
  win.top = options.topFrame === false ? {} : win
  return {
    posted,
    window: win,
    localStorage: win.localStorage as Storage,
    sessionStorage: win.sessionStorage as Storage,
    session: sessionData,
    hide() {
      listeners.pagehide?.()
    },
    run(script: string) {
      new Function("window", script)(win)
    },
  }
}

function readerScript(html: string): string {
  const match = /<script>([\s\S]*)<\/script>/.exec(html)
  if (!match) throw new Error("no script in the reader page")
  return match[1]
}

interface Env {
  /** The 3.3 store every file:// page shared. */
  old: Store
  /** Each origin's WebKit storage. */
  origins: Record<string, Store>
}

/** Signs in as another account (another data partition). */
function useAccount(partitionId: string) {
  jest.mocked(resolveMiniappDataPartition).mockReturnValue({id: partitionId, personalUserId: null})
}

/**
 * One open of a miniapp's screen, as LocalMiniappView drives it: the keeper set up (with the move, if it hasn't
 * happened), then a load of the page with the keeper script. `deliver()` lets the keeper report and hands its
 * reports to the host, as LocalMiniappView's onMessage does.
 */
async function open(
  packageName: string,
  env: Env,
  options: {readerFails?: boolean; failingKeys?: string[]; devBuild?: boolean; origin?: string; session?: Store} = {},
) {
  const origin = options.origin ?? originOf(packageName)
  const moves: number[] = []
  const opened = (await openWebStorageKeeper({
    packageName,
    origin,
    devBuild: options.devBuild ?? false,
    previous: null,
    readOldStore: async (move) => {
      moves.push(move.attempt)
      if (options.readerFails) return {error: "the reader page didn't answer"}
      const reader = page({origin: "file://", store: env.old})
      reader.run(readerScript(webStorageReaderHtml(move)))
      return parseWebStorageRead(reader.posted[0], move)!
    },
    checkpoint: () => undefined,
  })) as {keeper: WebStorageKeeper; script: string}
  env.origins[origin] ??= new Map()
  const screen = page({origin, store: env.origins[origin], failingKeys: options.failingKeys, session: options.session})
  screen.run(opened.script)
  const deliver = () => {
    jest.advanceTimersByTime(200)
    for (const message of screen.posted.splice(0)) {
      const report = parseWebStorageReport(message, opened.keeper)
      if (report) applyWebStorageReport(opened.keeper, report)
    }
  }
  return {...opened, screen, moves, deliver}
}

/** Opens and closes a screen: its keeper's first report reaches the host. */
async function visit(packageName: string, env: Env, options?: Parameters<typeof open>[2]) {
  const opened = await open(packageName, env, options)
  opened.deliver()
  return opened
}

function oldStore(): Store {
  // Every 3.3 miniapp's page was a file:// page, so they all wrote here.
  return new Map([
    ["onboarding-progress", '{"step":3,"name":"Ada"}'],
    ["mentra_recent_searches", '["standup","budget"]'],
    ["mentra-email-drawer-to", "ada@example.com"],
    ["mentra-call.quota", '{"remaining":4}'],
    ["livestreamer.developerMode", "enabled"],
    ["MENTRA_MOCK", "1"],
    ["some-other-miniapp-key", "theirs"],
  ])
}

const env = (): Env => ({old: oldStore(), origins: {}})
const wipe = (e: Env, packageName: string) => e.origins[originOf(packageName)].clear()
const originStore = (e: Env, packageName: string) => Object.fromEntries(e.origins[originOf(packageName)])

beforeEach(() => {
  jest.useFakeTimers()
  for (const values of mockMmkvInstances.values()) values.clear()
  resetWebStorageMoveStateForTests()
  jest
    .requireActual<
      typeof import("../../../modules/engine/src/services/miniappWebStorage")
    >("../../../modules/engine/src/services/miniappWebStorage")
    .resetMiniappWebStorageForTests()
  mockFiles.clear()
  mockDirectories.clear()
  useAccount("p.mu_1")
  jest.spyOn(console, "log").mockImplementation(() => undefined)
  jest.spyOn(console, "warn").mockImplementation(() => undefined)
  jest.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe("every miniapp's localStorage", () => {
  it("comes back after WebKit deletes the origin's storage, every key, with the page's latest values", async () => {
    const e = env()
    const first = await open(JOURNAL, e)
    first.screen.localStorage.setItem("draft", "Dear diary")
    first.screen.localStorage.setItem("theme", "dark")
    first.screen.localStorage.setItem("theme", "light")
    first.deliver()

    // Tracking prevention deletes everything the origin's pages wrote.
    wipe(e, JOURNAL)
    const second = await open(JOURNAL, e)
    // Restored before the miniapp's own scripts run, and the restore reports nothing back.
    expect(originStore(e, JOURNAL)).toEqual({draft: "Dear diary", theme: "light"})
    second.deliver()
    expect(second.screen.posted).toEqual([])
  })

  it("keeps a removed key removed, and follows clear()", async () => {
    const e = env()
    const first = await open(JOURNAL, e)
    first.screen.localStorage.setItem("a", "1")
    first.screen.localStorage.setItem("b", "2")
    first.screen.localStorage.removeItem("a")
    first.deliver()
    wipe(e, JOURNAL)
    const second = await open(JOURNAL, e)
    expect(originStore(e, JOURNAL)).toEqual({b: "2"})
    second.screen.localStorage.clear()
    second.screen.localStorage.setItem("c", "3")
    second.deliver()
    wipe(e, JOURNAL)
    await open(JOURNAL, e)
    expect(originStore(e, JOURNAL)).toEqual({c: "3"})
  })

  it("never overwrites a key the origin has, and takes the origin's values the host never heard about", async () => {
    const e = env()
    const first = await open(JOURNAL, e)
    first.screen.localStorage.setItem("draft", "kept")
    first.deliver()
    // A write the host missed (its report was lost when the app died), and one written by property assignment.
    e.origins[originOf(JOURNAL)].set("draft", "newer")
    const second = await open(JOURNAL, e)
    expect(originStore(e, JOURNAL)).toEqual({draft: "newer"})
    ;(second.screen.localStorage as unknown as Record<string, string>).note = "assigned"
    e.origins[originOf(JOURNAL)].set("note", "assigned")
    second.screen.hide()
    second.deliver()
    wipe(e, JOURNAL)
    await open(JOURNAL, e)
    expect(originStore(e, JOURNAL)).toEqual({draft: "newer", note: "assigned"})
  })

  it("a reload in the same WebView doesn't bring back what the page removed", async () => {
    const e = env()
    const first = await visit(JOURNAL, e)
    first.screen.localStorage.setItem("a", "1")
    first.deliver()
    const second = await open(JOURNAL, e)
    second.screen.localStorage.removeItem("a")
    second.deliver()
    // The page reloads before the WebView gets a newer copy: its document-start script still holds the old one.
    const reload = page({
      origin: originOf(JOURNAL),
      store: e.origins[originOf(JOURNAL)],
      session: second.screen.session,
    })
    reload.run(second.script)
    jest.advanceTimersByTime(200)
    expect(e.origins[originOf(JOURNAL)].has("a")).toBe(false)
    expect(reload.posted).toEqual([])
  })

  it("a page clearing its session storage and reloading never gets the restore again", async () => {
    const e = env()
    const first = await open(JOURNAL, e)
    first.screen.localStorage.setItem("draft", "old")
    first.screen.localStorage.setItem("gone", "x")
    first.deliver()
    useAccount("p.mu_2")
    await visit(JOURNAL, e) // the origin now holds mu_2's copy
    useAccount("p.mu_1")
    const back = await open(JOURNAL, e)
    expect(back.keeper.session.mode).toBe("replace")
    back.screen.localStorage.setItem("draft", "new")
    back.screen.localStorage.removeItem("gone")
    back.screen.sessionStorage.clear()
    back.screen.sessionStorage.removeItem("mentra:web-storage-restored")
    back.deliver()
    // The page reloads in the same WebView, with the script it was set up with.
    const reload = page({origin: originOf(JOURNAL), store: e.origins[originOf(JOURNAL)], session: back.screen.session})
    reload.run(back.script)
    expect(originStore(e, JOURNAL)).toEqual({draft: "new"})
  })

  it("keeps each package's data to itself", async () => {
    const e = env()
    const journal = await open(JOURNAL, e)
    journal.screen.localStorage.setItem("secret", "journal's")
    journal.deliver()
    const diary = await open(DIARY, e)
    expect(originStore(e, DIARY)).toEqual({})
    expect(diary.script).not.toContain("journal's")
    expect(diary.script).not.toContain("secret")
    // A report with another screen's nonce is nothing.
    const forged = JSON.stringify({type: "mentra_web_storage_changed", nonce: "b".repeat(32), ops: [["set", "x", "y"]]})
    expect(parseWebStorageReport(forged, diary.keeper)).toBeNull()
    expect(parseWebStorageReport(forged.replace("b".repeat(32), diary.keeper.nonce), diary.keeper)).toEqual({
      loaded: false,
      ops: [["set", "x", "y"]],
    })
  })

  it("gives another account its own copy, and its page never sees the first account's data", async () => {
    const e = env()
    const first = await open(JOURNAL, e)
    first.screen.localStorage.setItem("who", "mu_1")
    first.deliver()

    useAccount("p.mu_2")
    const other = await open(JOURNAL, e)
    // The origin held mu_1's copy: it is replaced before the page's scripts run, and nothing of mu_1's is reported.
    expect(other.keeper.session.mode).toBe("replace")
    expect(originStore(e, JOURNAL)).toEqual({})
    other.screen.localStorage.setItem("who", "mu_2")
    other.deliver()

    useAccount("p.mu_1")
    await visit(JOURNAL, e)
    expect(originStore(e, JOURNAL)).toEqual({who: "mu_1"})
  })

  it("is cleared by logout: the next account's first open finds the origin empty", async () => {
    const e = env()
    const first = await open(JOURNAL, e)
    first.screen.localStorage.setItem("draft", "private")
    first.deliver()
    storage.clearAll() // LogoutUtils, which clears SDK storage the same way
    const after = await open(JOURNAL, e)
    expect(after.keeper.session.mode).toBe("replace")
    expect(originStore(e, JOURNAL)).toEqual({})
    // A late report from the screen of before the logout changes nothing.
    first.screen.localStorage.setItem("draft", "late")
    first.deliver()
    wipe(e, JOURNAL)
    await open(JOURNAL, e)
    expect(originStore(e, JOURNAL)).toEqual({})
  })

  it("keeps up to 5 MB; a write over the cap isn't kept, but the page still has it", async () => {
    const e = env()
    const first = await open(JOURNAL, e)
    const big = "x".repeat(3 * 1024 * 1024) // 6 MB as UTF-16
    first.screen.localStorage.setItem("small", "kept")
    first.screen.localStorage.setItem("big", big)
    expect(first.screen.localStorage.getItem("big")).toBe(big)
    first.deliver()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("over the 5 MB"))
    wipe(e, JOURNAL)
    await open(JOURNAL, e)
    expect(originStore(e, JOURNAL)).toEqual({small: "kept"})
  })

  it("reports only localStorage, never session storage or its own restore", async () => {
    const e = env()
    const first = await visit(JOURNAL, e)
    first.screen.sessionStorage.setItem("tab", "only")
    first.screen.sessionStorage.clear()
    jest.advanceTimersByTime(200)
    expect(first.screen.posted).toEqual([])
  })

  it("a failed write by the page reports nothing, and a refused restore is retried at the next load", async () => {
    const e = env()
    const first = await visit(JOURNAL, e)
    first.screen.localStorage.setItem("a", "1")
    first.deliver()
    wipe(e, JOURNAL)
    const refused = await open(JOURNAL, e, {failingKeys: ["a"]})
    expect(e.origins[originOf(JOURNAL)].has("a")).toBe(false)
    expect(() => refused.screen.localStorage.setItem("a", "2")).toThrow("QuotaExceededError")
    refused.deliver()
    await open(JOURNAL, e)
    expect(originStore(e, JOURNAL)).toEqual({a: "1"})
  })

  it("runs only in the top frame of the screen's own origin", async () => {
    const e = env()
    const opened = await visit(JOURNAL, e)
    const frameStore = new Map<string, string>()
    const frame = page({origin: originOf(JOURNAL), store: frameStore, topFrame: false})
    frame.run(opened.script)
    frame.localStorage.setItem("k", "v")
    const elsewhereStore = new Map<string, string>()
    const elsewhere = page({origin: "https://player.example", store: elsewhereStore})
    elsewhere.run(opened.script)
    elsewhere.localStorage.setItem("k", "v")
    jest.advanceTimersByTime(200)
    expect(frame.posted).toEqual([])
    expect(elsewhere.posted).toEqual([])
  })

  it("queues the page's reports in order until the WebView's bridge is there", async () => {
    const e = env()
    const opened = await visit(JOURNAL, e)
    const screen = page({origin: originOf(JOURNAL), store: new Map(), bridge: false})
    screen.run(opened.script)
    screen.localStorage.setItem("q", "[1]")
    screen.localStorage.setItem("q", "[1,2]")
    screen.localStorage.removeItem("q")
    const posted: string[] = []
    jest.advanceTimersByTime(300)
    screen.window.ReactNativeWebView = {postMessage: (message: string) => posted.push(message)}
    jest.advanceTimersByTime(60)
    const ops = posted.flatMap((message) => parseWebStorageReport(message, opened.keeper)!.ops)
    expect(ops).toEqual([
      ["set", "q", "[1]"],
      ["set", "q", "[1,2]"],
      ["remove", "q"],
    ])
  })

  it("carries any text and any key through the copy and the keeper unchanged", async () => {
    const e = env()
    const awkward = '</script><script>alert(1)</script>  "\\\n\u{1F600}'
    const first = await open(JOURNAL, e)
    first.screen.localStorage.setItem("note", awkward)
    first.screen.localStorage.setItem("__proto__", "p")
    first.deliver()
    wipe(e, JOURNAL)
    const second = await open(JOURNAL, e)
    expect(e.origins[originOf(JOURNAL)].get("note")).toBe(awkward)
    expect(e.origins[originOf(JOURNAL)].get("__proto__")).toBe("p")
    expect(second.script).not.toContain("</script>")
  })

  it("keeps a development build's data in its own partition, and moves nothing for it", async () => {
    const e = env()
    useAccount("p.mu_1.p.local")
    const dev = await open(NOTES, e, {devBuild: true, origin: "miniapp://invalid.dev.com.mentra.notes"})
    expect(dev.moves).toEqual([])
    expect(dev.keeper.session.partitionId).toBe("p.mu_1.p.local")
    dev.screen.localStorage.setItem("draft", "dev")
    dev.deliver()
    useAccount("p.mu_1")
    const real = await visit(NOTES, e)
    expect(real.script).not.toContain('"draft"')
  })

  it("while no account is known, the page starts empty, and the next load gets the account's copy back", async () => {
    const e = env()
    const first = await open(JOURNAL, e)
    first.screen.localStorage.setItem("secret", "mu_1's")
    first.deliver()
    // mu_1 signs out: the host's copy goes with SDK storage, but WebKit still holds the origin's data.
    storage.clearAll()
    expect(e.origins[originOf(JOURNAL)].get("secret")).toBe("mu_1's")
    jest.mocked(resolveMiniappDataPartition).mockImplementation(() => {
      throw new Error("Mentra user identity is unavailable")
    })
    const {cloudClientService} = jest.requireMock("@mentra/engine-host-internal") as {
      cloudClientService: {resolveMentraUserId: jest.Mock}
    }
    cloudClientService.resolveMentraUserId.mockRejectedValueOnce(new Error("offline"))
    const none = await openWebStorageKeeper({
      packageName: JOURNAL,
      origin: originOf(JOURNAL),
      devBuild: false,
      previous: null,
      readOldStore: async () => ({entries: {}}),
      checkpoint: () => undefined,
    })
    expect(none.keeper).toBeNull()
    // The page loads before any account is known: the isolation script runs before the page's own scripts.
    const screen = page({origin: originOf(JOURNAL), store: e.origins[originOf(JOURNAL)]})
    screen.run(none.script)
    expect(screen.localStorage.getItem("secret")).toBeNull()
    expect(none.script).not.toContain("mu_1's")
    // A reload in the same WebView keeps what the page wrote since; other frames and origins are untouched.
    screen.localStorage.setItem("written", "while signed out")
    page({origin: originOf(JOURNAL), store: e.origins[originOf(JOURNAL)], session: screen.session}).run(none.script)
    expect(screen.localStorage.getItem("written")).toBe("while signed out")
    const elsewhere = new Map([["k", "v"]])
    page({origin: "https://player.example", store: elsewhere}).run(none.script)
    page({origin: originOf(JOURNAL), store: elsewhere, topFrame: false}).run(none.script)
    expect(elsewhere.get("k")).toBe("v")
    jest.advanceTimersByTime(200)
    expect(screen.posted).toEqual([])

    // An account is known again: its copy replaces what the page wrote meanwhile.
    useAccount("p.mu_2")
    const next = await open(JOURNAL, e)
    expect(next.keeper.session.mode).toBe("replace")
    expect(originStore(e, JOURNAL)).toEqual({})
  })

  it("reuses the nonce for the same copy, so the page still showing keeps reporting", async () => {
    const e = env()
    const first = await visit(JOURNAL, e)
    const again = await openWebStorageKeeper({
      packageName: JOURNAL,
      origin: originOf(JOURNAL),
      devBuild: false,
      previous: first.keeper,
      readOldStore: async () => ({entries: {}}),
      checkpoint: () => undefined,
    })
    expect(again.keeper!.nonce).toBe(first.keeper.nonce)
    useAccount("p.mu_2")
    const other = await openWebStorageKeeper({
      packageName: JOURNAL,
      origin: originOf(JOURNAL),
      devBuild: false,
      previous: first.keeper,
      readOldStore: async () => ({entries: {}}),
      checkpoint: () => undefined,
    })
    expect(other.keeper!.nonce).not.toBe(first.keeper.nonce)
  })
})

describe("moving a first-party miniapp's old file:// data", () => {
  it("moves the package's own listed keys once, and never changes the old store", async () => {
    const e = env()
    const first = await open(NOTES, e)
    expect(first.moves).toEqual([1])
    expect(originStore(e, NOTES)).toEqual({
      "onboarding-progress": '{"step":3,"name":"Ada"}',
      "mentra_recent_searches": '["standup","budget"]',
      "mentra-email-drawer-to": "ada@example.com",
    })
    expect(isWebStorageMoved(NOTES)).toBe(true)
    expect(e.old).toEqual(oldStore())
    expect((await open(NOTES, e)).moves).toEqual([])
    // Another first-party package gets only its own key, never Notes' or unlisted ones.
    await open(CALL, e)
    expect(originStore(e, CALL)).toEqual({"mentra-call.quota": '{"remaining":4}'})
    for (const store of Object.values(e.origins)) {
      expect(store.has("MENTRA_MOCK")).toBe(false)
      expect(store.has("some-other-miniapp-key")).toBe(false)
    }
  })

  it("moves nothing for third-party miniapps, packages without listed keys, or development builds", async () => {
    expect(movesWebStorage(JOURNAL)).toBe(false)
    expect(movesWebStorage("com.mentra.captions")).toBe(false)
    expect(movesWebStorage(NOTES)).toBe(true)
    expect(beginWebStorageMove(JOURNAL, {devBuild: false})).toBeNull()
    expect(beginWebStorageMove(NOTES, {devBuild: true})).toBeNull()
    expect((await open(JOURNAL, env())).moves).toEqual([])
  })

  it("never overwrites a key already on the origin; the copy takes the origin's value", async () => {
    const e = env()
    e.origins[originOf(NOTES)] = new Map([["mentra_recent_searches", '["newer"]']])
    await visit(NOTES, e)
    expect(e.origins[originOf(NOTES)].get("mentra_recent_searches")).toBe('["newer"]')
    wipe(e, NOTES)
    await open(NOTES, e)
    expect(e.origins[originOf(NOTES)].get("mentra_recent_searches")).toBe('["newer"]')
    expect(e.origins[originOf(NOTES)].get("onboarding-progress")).toBe('{"step":3,"name":"Ada"}')
  })

  it("retries a failed move at the next open, then gives up and goes on without it", async () => {
    const e = env()
    for (let attempt = 1; attempt <= MAX_WEB_STORAGE_MOVE_ATTEMPTS; attempt++) {
      expect((await open(NOTES, e, {readerFails: true})).moves).toEqual([attempt])
      expect(isWebStorageMoved(NOTES)).toBe(false)
    }
    expect(jest.mocked(console.warn).mock.calls.at(-1)?.[0]).toContain("giving up")
    expect((await open(NOTES, e)).moves).toEqual([])
    expect(jest.mocked(console.error)).toHaveBeenCalledTimes(1)
    expect(isWebStorageMoved(NOTES)).toBe(true)
    expect(originStore(e, NOTES)).toEqual({})
    expect(e.old).toEqual(oldStore())
  })

  it("a move after a failed attempt keeps what the page changed and doesn't bring back what it removed", async () => {
    const e = env()
    e.origins[originOf(NOTES)] = new Map([["onboarding-progress", '{"step":3,"name":"Ada"}']])
    const first = await open(NOTES, e, {readerFails: true})
    first.screen.localStorage.removeItem("onboarding-progress") // finished onboarding
    first.screen.localStorage.setItem("mentra_recent_searches", '["written in 3.4"]')
    first.deliver()
    const second = await open(NOTES, e)
    expect(second.moves).toEqual([2])
    expect(e.origins[originOf(NOTES)].has("onboarding-progress")).toBe(false)
    expect(e.origins[originOf(NOTES)].get("mentra_recent_searches")).toBe('["written in 3.4"]')
    expect(e.origins[originOf(NOTES)].get("mentra-email-drawer-to")).toBe("ada@example.com")
  })

  it("a move after clear() moves nothing back", async () => {
    const e = env()
    const first = await open(NOTES, e, {readerFails: true})
    first.screen.localStorage.clear()
    first.deliver()
    await open(NOTES, e)
    expect(isWebStorageMoved(NOTES)).toBe(true)
    expect(originStore(e, NOTES)).toEqual({})
  })

  it("happens once per phone: a logout doesn't move the old data into the next account", async () => {
    const e = env()
    await visit(NOTES, e)
    storage.clearAll()
    useAccount("p.mu_2")
    const next = await open(NOTES, e)
    expect(next.moves).toEqual([])
    expect(originStore(e, NOTES)).toEqual({})
  })

  it("takes over the first 3.4 builds' copy and move records without losing data or removals", async () => {
    const e = env()
    storage.save(legacyKeptWebStorageKey(NOTES), {
      "mentra_recent_searches": '["kept by 17.10"]',
      "mentra-email-drawer-to": null,
      "not-listed": "x",
    })
    storage.save(legacyWebStorageMovedKey(NOTES), 1)
    storage.save(legacyWebStorageMoveAttemptsKey(CALL), 2)
    // The origin holds what that build's keeper left there.
    e.origins[originOf(NOTES)] = new Map([["onboarding-progress", '{"step":4}']])
    const opened = await open(NOTES, e)
    expect(opened.moves).toEqual([])
    expect(originStore(e, NOTES)).toEqual({
      "onboarding-progress": '{"step":4}',
      "mentra_recent_searches": '["kept by 17.10"]',
    })
    opened.deliver()
    expect(storage.load(legacyKeptWebStorageKey(NOTES)).is_error()).toBe(true)
    expect(storage.load(legacyWebStorageMovedKey(NOTES)).is_error()).toBe(true)
    wipe(e, NOTES)
    await open(NOTES, e)
    expect(originStore(e, NOTES)).toEqual({
      "onboarding-progress": '{"step":4}',
      "mentra_recent_searches": '["kept by 17.10"]',
    })
    // The removal it remembered still holds against the move (Call's attempts carried over too).
    expect(beginWebStorageMove(CALL, {devBuild: false})?.attempt).toBe(3)
  })

  it("the reader page reads only the package's listed keys, loads nothing and posts with its nonce", () => {
    const move = beginWebStorageMove(CALL, {devBuild: false})!
    const html = webStorageReaderHtml(move)
    expect(html).toContain(`content="default-src 'none'; script-src 'unsafe-inline'"`)
    expect(html).not.toMatch(/<script[^>]+src=/)
    const reader = page({origin: "file://", store: oldStore()})
    reader.run(readerScript(html))
    expect(JSON.parse(reader.posted[0])).toEqual({
      type: "mentra_web_storage_read",
      nonce: move.nonce,
      entries: {"mentra-call.quota": '{"remaining":4}'},
      error: null,
    })
    expect(parseWebStorageRead(reader.posted[0], {...move, nonce: "0".repeat(32)})).toBeNull()
    expect(parseWebStorageRead("not json", move)).toBeNull()
    const claimed = JSON.stringify({
      type: "mentra_web_storage_read",
      nonce: move.nonce,
      entries: {"onboarding-progress": "x"},
    })
    expect(parseWebStorageRead(claimed, move)).toEqual({entries: {}})
  })

  it("reports a reader that couldn't read the old store as a failure", () => {
    const move = beginWebStorageMove(CALL, {devBuild: false})!
    const reader = page({origin: "file://", store: oldStore()})
    ;(reader.window as {localStorage: unknown}).localStorage = null
    reader.run(readerScript(webStorageReaderHtml(move)))
    expect(parseWebStorageRead(reader.posted[0], move)).toEqual({
      error: expect.stringContaining("reading the old store failed"),
    })
  })

  it("writes the reader page in a directory of its own and removes it", () => {
    const move = beginWebStorageMove(NOTES, {devBuild: false})!
    const {pageUri, directoryUri} = writeWebStorageReader(move)
    expect(directoryUri).toBe("file:///cache/miniapp-web-storage-move/com.mentra.notes")
    expect(pageUri).toBe(`${directoryUri}/read.html`)
    expect(mockFiles.get(pageUri)).toBe(webStorageReaderHtml(move))
    removeWebStorageReader(move)
    expect(mockDirectories.size).toBe(0)
    expect(mockFiles.size).toBe(0)
  })

  it("lists keys only for first-party packages", () => {
    for (const packageName of Object.keys(MOVED_WEB_STORAGE_KEYS))
      expect(packageName.startsWith("com.mentra.")).toBe(true)
  })
})
