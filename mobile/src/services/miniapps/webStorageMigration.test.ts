import {
  applyWebStorageChange,
  beginWebStorageMove,
  completeWebStorageMove,
  failWebStorageMove,
  isWebStorageMoved,
  keepsWebStorage,
  keptWebStorage,
  keptWebStorageKey,
  MAX_WEB_STORAGE_MOVE_ATTEMPTS,
  MOVED_WEB_STORAGE_KEYS,
  newWebStorageNonce,
  parseWebStorageChange,
  parseWebStorageRead,
  removeWebStorageReader,
  resetWebStorageMoveStateForTests,
  webStorageKeeperScript,
  webStorageMoveAttemptsKey,
  webStorageMovedKey,
  webStorageReaderHtml,
  writeWebStorageReader,
  type WebStorageKeeper,
} from "./webStorageMigration"
import {storage} from "@/utils/storage"

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
const LIVESTREAMER = "com.mentra.livestreamer"
const originOf = (packageName: string) => `miniapp://${packageName}`

/** A page's web storage, as WebKit keeps it on disk. */
type Store = Map<string, string>

/**
 * A minimal page: its own origin, its own Storage class (so a script patching
 * `Storage.prototype` patches only this page), the WebView bridge, and timers.
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
  class Storage {
    constructor(private readonly data: Store) {}
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
  old: Store
  origins: Record<string, Store>
}

/**
 * One open of a miniapp's screen, as LocalMiniappView drives it: the move (the
 * hidden page reads the old store) if it hasn't happened, then a load of the
 * page with the keeper script. `deliver()` hands the page's reports to the
 * host, as LocalMiniappView's onMessage does.
 */
function open(packageName: string, env: Env, options: {readerFails?: boolean; failingKeys?: string[]} = {}) {
  const move = beginWebStorageMove(packageName, {devBuild: false})
  if (move) {
    if (options.readerFails) {
      failWebStorageMove(move, "the reader page didn't answer")
    } else {
      const reader = page({origin: "file://", store: env.old})
      reader.run(readerScript(webStorageReaderHtml(move)))
      const read = parseWebStorageRead(reader.posted[0], move)!
      if ("error" in read) failWebStorageMove(move, read.error)
      else completeWebStorageMove(move, read.entries)
    }
  }
  const keeper: WebStorageKeeper = {packageName, origin: originOf(packageName), nonce: newWebStorageNonce()}
  env.origins[packageName] ??= new Map()
  const screen = page({origin: keeper.origin, store: env.origins[packageName], failingKeys: options.failingKeys})
  const script = webStorageKeeperScript(keeper, keptWebStorage(packageName))
  screen.run(script)
  return {
    move,
    keeper,
    screen,
    script,
    deliver() {
      for (const message of screen.posted.splice(0)) {
        const change = parseWebStorageChange(message, keeper)
        if (change) applyWebStorageChange(packageName, change)
      }
    },
  }
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

beforeEach(() => {
  jest.useFakeTimers()
  resetWebStorageMoveStateForTests()
  mockFiles.clear()
  mockDirectories.clear()
  for (const packageName of [...Object.keys(MOVED_WEB_STORAGE_KEYS), "com.example.notes"]) {
    storage.remove(webStorageMovedKey(packageName))
    storage.remove(webStorageMoveAttemptsKey(packageName))
    storage.remove(keptWebStorageKey(packageName))
  }
  jest.spyOn(console, "log").mockImplementation(() => undefined)
  jest.spyOn(console, "warn").mockImplementation(() => undefined)
  jest.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

it("moves the package's own keys and writes them to its origin at the first load", () => {
  const e = env()
  const before = new Map(e.old)
  const first = open(NOTES, e)
  expect(first.move?.attempt).toBe(1)
  expect(Object.fromEntries(e.origins[NOTES])).toEqual({
    "onboarding-progress": '{"step":3,"name":"Ada"}',
    "mentra_recent_searches": '["standup","budget"]',
    "mentra-email-drawer-to": "ada@example.com",
  })
  expect(isWebStorageMoved(NOTES)).toBe(true)
  expect(storage.load(webStorageMoveAttemptsKey(NOTES)).is_error()).toBe(true)
  // The old store is only ever read: a 3.3 build installed over this one still finds everything.
  expect(e.old).toEqual(before)
  // Moved: later opens don't read the old store again.
  expect(open(NOTES, e).move).toBeNull()
})

it("keeps nothing for third-party miniapps, packages without listed keys, or development builds", () => {
  expect(keepsWebStorage("com.example.notes")).toBe(false)
  expect(keepsWebStorage("com.mentra.captions")).toBe(false)
  expect(keepsWebStorage(NOTES)).toBe(true)
  expect(beginWebStorageMove("com.example.notes", {devBuild: false})).toBeNull()
  expect(beginWebStorageMove("com.mentra.captions", {devBuild: false})).toBeNull()
  expect(beginWebStorageMove(NOTES, {devBuild: true})).toBeNull()
  expect(storage.load(webStorageMoveAttemptsKey(NOTES)).is_error()).toBe(true)
})

it("never overwrites a key already on the origin, and the host's copy takes the origin's value", () => {
  const e = env()
  e.origins[NOTES] = new Map([["mentra_recent_searches", '["newer"]']])
  const first = open(NOTES, e)
  expect(e.origins[NOTES].get("mentra_recent_searches")).toBe('["newer"]')
  expect(e.origins[NOTES].get("onboarding-progress")).toBe('{"step":3,"name":"Ada"}')
  first.deliver()
  expect(keptWebStorage(NOTES)["mentra_recent_searches"]).toBe('["newer"]')

  // So a later eviction brings back the origin's value, not the old store's.
  e.origins[NOTES].clear()
  open(NOTES, e)
  expect(e.origins[NOTES].get("mentra_recent_searches")).toBe('["newer"]')
})

it("a value the page wrote that the host never heard about is picked up at the next load", () => {
  const e = env()
  open(NOTES, e)
  // A write the host missed (its report was lost when the app died).
  e.origins[NOTES].set("mentra_recording_time_v2", '{"date":"2026-10-24"}')
  open(NOTES, e).deliver()
  e.origins[NOTES].clear()
  open(NOTES, e)
  expect(e.origins[NOTES].get("mentra_recording_time_v2")).toBe('{"date":"2026-10-24"}')
})

it("brings back the page's latest values, and not what it removed, after WebKit deletes the origin's storage", () => {
  const e = env()
  const first = open(NOTES, e)
  first.screen.localStorage.setItem("mentra_recent_searches", '["after the move"]')
  first.screen.localStorage.removeItem("mentra-email-drawer-to")
  first.screen.localStorage.setItem("mentra-email-drawer-cc", '["bo@example.com"]')
  first.deliver()

  // Tracking prevention deletes everything the origin's pages wrote.
  e.origins[NOTES].clear()
  open(NOTES, e)
  expect(Object.fromEntries(e.origins[NOTES])).toEqual({
    "onboarding-progress": '{"step":3,"name":"Ada"}',
    "mentra_recent_searches": '["after the move"]',
    "mentra-email-drawer-cc": '["bo@example.com"]',
  })
  // Still only read.
  expect(e.old).toEqual(oldStore())
})

it("a reload in the same WebView doesn't bring back what the page removed", () => {
  const e = env()
  const first = open(NOTES, e)
  first.screen.localStorage.removeItem("mentra-email-drawer-to")
  first.deliver()
  // The page reloads (a retry, or its own location.reload()) before the WebView
  // gets a newer copy: its document-start script still holds the old one.
  const session = first.screen.session
  const reload = page({origin: originOf(NOTES), store: e.origins[NOTES], session})
  reload.run(first.script)
  expect(e.origins[NOTES].has("mentra-email-drawer-to")).toBe(false)
  expect(reload.posted).toEqual([])
  // A new WebView gets the current copy, which remembers the removal.
  open(NOTES, e)
  expect(e.origins[NOTES].has("mentra-email-drawer-to")).toBe(false)
})

it("follows clear()", () => {
  const e = env()
  const first = open(NOTES, e)
  first.screen.localStorage.clear()
  first.deliver()
  expect(keptWebStorage(NOTES)).toEqual({})
  open(NOTES, e)
  expect(e.origins[NOTES].size).toBe(0)
})

it("reports only listed localStorage keys, and never its own restore", () => {
  const e = env()
  const first = open(NOTES, e)
  // The restore wrote three keys and reported none of them.
  expect(first.screen.posted).toEqual([])
  first.screen.localStorage.setItem("not-listed", "x")
  first.screen.sessionStorage.setItem("mentra_recent_searches", "session only")
  first.screen.sessionStorage.clear()
  expect(first.screen.posted).toEqual([])
  first.screen.localStorage.setItem("mentra_recording_time_v2", "{}")
  expect(first.screen.posted).toHaveLength(1)
  first.deliver()
  expect(keptWebStorage(NOTES)).toMatchObject({mentra_recording_time_v2: "{}"})
  expect(keptWebStorage(NOTES)).not.toHaveProperty("not-listed")
})

it("a write the origin refuses is restored at the next load", () => {
  const e = env()
  open(NOTES, e, {failingKeys: ["mentra-email-drawer-to"]})
  expect(e.origins[NOTES].has("mentra-email-drawer-to")).toBe(false)
  open(NOTES, e)
  expect(e.origins[NOTES].get("mentra-email-drawer-to")).toBe("ada@example.com")
})

it("a failed write by the page reports nothing", () => {
  const e = env()
  const first = open(NOTES, e, {failingKeys: ["mentra_recent_searches"]})
  expect(() => first.screen.localStorage.setItem("mentra_recent_searches", "[]")).toThrow("QuotaExceededError")
  expect(first.screen.posted).toEqual([])
})

it("retries a failed or interrupted move at the next open, then gives up and goes on without it", () => {
  const e = env()
  for (let attempt = 1; attempt <= MAX_WEB_STORAGE_MOVE_ATTEMPTS; attempt++) {
    const opened = open(NOTES, e, {readerFails: true})
    expect(opened.move?.attempt).toBe(attempt)
    expect(isWebStorageMoved(NOTES)).toBe(false)
  }
  expect(jest.mocked(console.warn).mock.calls.at(-1)?.[0]).toContain("giving up")
  expect(open(NOTES, e).move).toBeNull()
  expect(open(NOTES, e).move).toBeNull()
  expect(jest.mocked(console.error)).toHaveBeenCalledTimes(1)
  expect(isWebStorageMoved(NOTES)).toBe(true)
  expect(e.origins[NOTES].size).toBe(0)
  expect(e.old).toEqual(oldStore())
})

it("a move after a failed attempt doesn't bring back a key the page removed meanwhile", () => {
  const e = env()
  // The 3.3 store's value reached the origin some other way (an earlier build); the page then removes it.
  e.origins[NOTES] = new Map([["onboarding-progress", '{"step":3,"name":"Ada"}']])
  const first = open(NOTES, e, {readerFails: true})
  first.screen.localStorage.removeItem("onboarding-progress") // finished onboarding
  first.deliver()
  const second = open(NOTES, e)
  expect(second.move?.attempt).toBe(2)
  expect(keptWebStorage(NOTES)).not.toHaveProperty("onboarding-progress")
  expect(e.origins[NOTES].has("onboarding-progress")).toBe(false)
  // Other keys still move.
  expect(e.origins[NOTES].get("mentra_recent_searches")).toBe('["standup","budget"]')
})

it("a move after clear() moves nothing back", () => {
  const e = env()
  const first = open(NOTES, e, {readerFails: true})
  first.screen.localStorage.clear()
  first.deliver()
  open(NOTES, e)
  expect(isWebStorageMoved(NOTES)).toBe(true)
  expect(e.origins[NOTES].size).toBe(0)
})

it("a move after a failed attempt keeps what the page has changed since", () => {
  const e = env()
  const first = open(NOTES, e, {readerFails: true})
  first.screen.localStorage.setItem("mentra_recent_searches", '["written in 3.4"]')
  first.deliver()
  const second = open(NOTES, e)
  expect(second.move?.attempt).toBe(2)
  expect(keptWebStorage(NOTES)).toMatchObject({
    "mentra_recent_searches": '["written in 3.4"]',
    "onboarding-progress": '{"step":3,"name":"Ada"}',
  })
  expect(e.origins[NOTES].get("mentra_recent_searches")).toBe('["written in 3.4"]')
})

it("an interrupted move finishes at the next open without overwriting what the miniapp changed", () => {
  const e = env()
  // The first open's reader never answered (the app died); the page wrote a key anyway.
  e.origins[NOTES] = new Map([["onboarding-progress", '{"step":5}']])
  open(NOTES, e, {readerFails: true})
  resetWebStorageMoveStateForTests()
  expect(open(NOTES, e).move?.attempt).toBe(2)
  expect(e.origins[NOTES].get("onboarding-progress")).toBe('{"step":5}')
})

it("loading again changes nothing", () => {
  const e = env()
  open(NOTES, e)
  const after = new Map(e.origins[NOTES])
  const again = open(NOTES, e)
  expect(e.origins[NOTES]).toEqual(after)
  expect(again.screen.posted).toEqual([])
})

it("a second package sees none of the first package's data", () => {
  const e = env()
  open(NOTES, e)
  const call = open(CALL, e)
  expect(Object.fromEntries(e.origins[CALL])).toEqual({"mentra-call.quota": '{"remaining":4}'})
  expect(keptWebStorage(CALL)).toEqual({"mentra-call.quota": '{"remaining":4}'})
  expect(Object.fromEntries(e.origins[NOTES])).not.toHaveProperty("mentra-call.quota")
  // Call's page is never even handed Notes' values or key names.
  expect(call.script).not.toContain("ada@example.com")
  expect(call.script).not.toContain("onboarding-progress")
  // Keys no first-party miniapp lists stay behind.
  for (const store of Object.values(e.origins)) {
    expect(store.has("MENTRA_MOCK")).toBe(false)
    expect(store.has("some-other-miniapp-key")).toBe(false)
  }
  // A Notes report can't change Call's copy, and a report with another screen's nonce is nothing.
  const notesKeeper: WebStorageKeeper = {packageName: NOTES, origin: originOf(NOTES), nonce: "a".repeat(32)}
  const forged = JSON.stringify({
    type: "mentra_web_storage_changed",
    nonce: "b".repeat(32),
    set: {"onboarding-progress": "x"},
  })
  expect(parseWebStorageChange(forged, notesKeeper)).toBeNull()
  const unlisted = JSON.stringify({
    type: "mentra_web_storage_changed",
    nonce: notesKeeper.nonce,
    set: {"mentra-call.quota": "x", "onboarding-progress": "y"},
    remove: ["livestreamer.developerMode"],
  })
  expect(parseWebStorageChange(unlisted, notesKeeper)).toEqual({
    clear: false,
    remove: [],
    set: {"onboarding-progress": "y"},
  })
})

it("the keeper runs only in the top frame of the package's own origin", () => {
  const e = env()
  open(LIVESTREAMER, e)
  const keeper: WebStorageKeeper = {packageName: LIVESTREAMER, origin: originOf(LIVESTREAMER), nonce: "c".repeat(32)}
  const script = webStorageKeeperScript(keeper, keptWebStorage(LIVESTREAMER))

  const frameStore = new Map<string, string>()
  const frame = page({origin: originOf(LIVESTREAMER), store: frameStore, topFrame: false})
  frame.run(script)
  frame.localStorage.setItem("livestreamer.developerMode", "disabled")
  expect(frameStore.get("livestreamer.developerMode")).toBe("disabled")
  expect(frame.posted).toEqual([])

  const elsewhereStore = new Map<string, string>()
  const elsewhere = page({origin: "https://player.example", store: elsewhereStore})
  elsewhere.run(script)
  expect(elsewhereStore.size).toBe(0)
  elsewhere.localStorage.setItem("livestreamer.developerMode", "disabled")
  expect(elsewhere.posted).toEqual([])
})

it("queues the page's reports in order until the WebView's bridge is there", () => {
  const keeper: WebStorageKeeper = {packageName: NOTES, origin: originOf(NOTES), nonce: "d".repeat(32)}
  const screen = page({origin: keeper.origin, store: new Map(), bridge: false})
  screen.run(webStorageKeeperScript(keeper, {}))
  screen.localStorage.setItem("mentra_recent_searches", "[1]")
  screen.localStorage.setItem("mentra_recent_searches", "[1,2]")
  screen.localStorage.removeItem("mentra_recent_searches")
  const posted: string[] = []
  jest.advanceTimersByTime(120)
  screen.window.ReactNativeWebView = {postMessage: (message: string) => posted.push(message)}
  jest.advanceTimersByTime(60)
  expect(posted.map((message) => parseWebStorageChange(message, keeper))).toEqual([
    {clear: false, remove: [], set: {mentra_recent_searches: "[1]"}},
    {clear: false, remove: [], set: {mentra_recent_searches: "[1,2]"}},
    {clear: false, remove: ["mentra_recent_searches"], set: {}},
  ])
})

it("the reader page reads only the package's listed keys, loads nothing and posts with its nonce", () => {
  const move = beginWebStorageMove(CALL, {devBuild: false})!
  const html = webStorageReaderHtml(move)
  expect(html).toContain(`content="default-src 'none'; script-src 'unsafe-inline'"`)
  expect(html).not.toMatch(/<script[^>]+src=/)
  const reader = page({origin: "file://", store: oldStore()})
  reader.run(readerScript(html))
  expect(reader.posted).toHaveLength(1)
  expect(JSON.parse(reader.posted[0])).toEqual({
    type: "mentra_web_storage_read",
    nonce: move.nonce,
    entries: {"mentra-call.quota": '{"remaining":4}'},
    error: null,
  })
  // Another attempt's message, another type, or junk is not this read.
  expect(parseWebStorageRead(reader.posted[0], {...move, nonce: "0".repeat(32)})).toBeNull()
  expect(parseWebStorageRead(JSON.stringify({type: "ready"}), move)).toBeNull()
  expect(parseWebStorageRead("not json", move)).toBeNull()
  // Whatever a page claims, only the package's listed keys are taken.
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

it("carries any stored text through the reader, the host's copy and the keeper unchanged", () => {
  const awkward = '</script><script>alert(1)</script>\u2028\u2029"\\\n\u{1F600}'
  const e: Env = {old: new Map([["mentra-email-drawer-cc", awkward]]), origins: {}}
  const first = open(NOTES, e)
  expect(e.origins[NOTES].get("mentra-email-drawer-cc")).toBe(awkward)
  first.screen.localStorage.setItem("mentra-email-drawer-to", awkward)
  first.deliver()
  e.origins[NOTES].clear()
  open(NOTES, e)
  expect(e.origins[NOTES].get("mentra-email-drawer-to")).toBe(awkward)
  const move = beginWebStorageMove(CALL, {devBuild: false})!
  expect(webStorageReaderHtml(move).match(/<\/script>/g)).toHaveLength(1)
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
