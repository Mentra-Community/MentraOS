/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"

// A miniapp's token carries what Core knew about the user when it was minted (the features they hold), so the
// runtime asks for a fresh one whenever the miniapp opens: on CONNECT, on its foreground edge, and when the
// scheduled refresh falls due. If CONNECT's fresh mint fails, its retries go through the default path, which
// serves a still-valid cached token. These run the shipped methods against a fake clock, fake timers and a fake
// Cloud Client, in the style of the runtime's other isolated suites, instead of booting the Expo app singleton.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = [
  "updateVisibility",
  "handleConnect",
  "requestMiniappAuth",
  "refreshMiniappAuth",
  "currentAuthApp",
  "scheduleMiniappAuthRefresh",
  "clearMiniappAuthRefresh",
  "deliverInitialMiniappAuth",
  "scheduleInitialMiniappAuthRetry",
  "clearMiniappAuthDeliveryRetry",
  "redriveMiniappAuthDelivery",
]
  .map((name) => {
    const start = source.search(new RegExp(`^  (?:public|private) (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    const end = rest.search(/^ {2}}$/m)
    if (end < 0) throw new Error(`Missing end of runtime method ${name}`)
    return rest.slice(0, end + 3)
  })
  .join("\n")

/** The runtime's own timing constants, read from the source so a change there cannot leave this suite stale. */
const constants = [
  "MINIAPP_AUTH_REFRESH_HEADROOM_MS",
  "MINIAPP_AUTH_REFRESH_MIN_DELAY_MS",
  "MINIAPP_AUTH_RETRY_BASE_MS",
  "MINIAPP_AUTH_RETRY_MAX_MS",
]
  .map((name) => {
    const line = source.match(new RegExp(`^const ${name} = .*$`, "m"))
    if (!line) throw new Error(`Missing runtime constant ${name}`)
    return line[0]
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`${constants}\nclass Host { ${methods} }`)
const constantValue = (name: string): number => Number(new Function(`${constants}; return ${name}`)())

const HEADROOM_MS = constantValue("MINIAPP_AUTH_REFRESH_HEADROOM_MS")
const MIN_DELAY_MS = constantValue("MINIAPP_AUTH_REFRESH_MIN_DELAY_MS")
const RETRY_BASE_MS = constantValue("MINIAPP_AUTH_RETRY_BASE_MS")
const RETRY_MAX_MS = constantValue("MINIAPP_AUTH_RETRY_MAX_MS")

const CALL = "com.mentra.call"
const HOUR_MS = 60 * 60 * 1000
/** The cloud client keeps a cached miniapp token until this close to its expiry. */
const CACHE_MARGIN_MS = 60_000

interface Token {
  token: string
  expiresAt: number
}
interface Request {
  packageName: string
  opts: {minTtlMs?: number; fresh?: boolean} | undefined
}
type Plan = (request: Request) => Promise<Token>

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function fixture() {
  let now = 1_800_000_000_000
  let timerSeq = 0
  const timers = new Map<number, {at: number; delay: number; callback: () => void}>()
  const bgTimer = {
    setTimeout(callback: () => void, delay: number) {
      const id = ++timerSeq
      timers.set(id, {at: now + delay, delay, callback})
      return id
    },
    clearTimeout(id: number) {
      timers.delete(id)
    },
  }

  // The cloud client's cache rule, which is why a scheduled refresh before expiry used to hand back the same token.
  let minted = 0
  let cached: Token | null = null
  const requests: Request[] = []
  const plans: Plan[] = []
  const mint = (): Token => {
    cached = {token: `token-${++minted}`, expiresAt: now + HOUR_MS}
    return cached
  }
  const cloudClientService = {
    hasCore: () => true,
    getMiniappAuthToken(packageName: string, opts?: Request["opts"]): Promise<Token> {
      const request = {packageName, opts}
      requests.push(request)
      const plan = plans.shift()
      if (plan) return plan(request)
      if (!opts?.fresh && cached && cached.expiresAt - CACHE_MARGIN_MS > now) return Promise.resolve(cached)
      return Promise.resolve(mint())
    },
  }

  const warnings: string[] = []
  const Host = new Function(
    "BgTimer",
    "cloudClientService",
    "getDevAppSourcePackage",
    "useSettingsStore",
    "ISLAND_SETTINGS_KEYS",
    "DeviceTypes",
    "getModelCapabilities",
    "computeDeclaredPermissionRecord",
    "getMiniappConfiguration",
    "MiniappResponseType",
    "LOG_TAG",
    "Date",
    "console",
    `${compiled}; return Host`,
  )(
    bgTimer,
    cloudClientService,
    () => undefined,
    {getState: () => ({getSetting: () => undefined})},
    {defaultWearable: "default_wearable"},
    {NONE: "none"},
    () => ({}),
    () => ({}),
    () => ({}),
    {CONNECT_ACK: "connect_ack", AUTH_UPDATE: "auth_update"},
    "LOCAL_MINIAPP",
    {now: () => now},
    {log() {}, warn: (message: string) => warnings.push(message)},
  )

  let visible: string | null = null
  const host = new Host()
  const sent: Array<{type: string; auth?: Token}> = []
  const visibility: Array<[string, string]> = []
  host.connectedApps = new Map()
  host.handshookApps = new Set()
  host.visiblePackage = null
  host.authSessionSeq = 0
  host.currentVisiblePackage = () => visible
  host.sendToMiniapp = (_packageName: string, message: {type: string; auth?: Token}) => sent.push(message)
  host.sendVisibilityChange = (packageName: string, state: string) => visibility.push([packageName, state])
  host.sendCloudStatusToMiniapp = () => {}
  host.flushConnectWaiters = () => {}

  /** registerApp: a respawned miniapp replaces the old entry and drops its timers. */
  const register = (packageName = CALL) => {
    const existing = host.connectedApps.get(packageName)
    if (existing?.authRefreshTimerId != null) bgTimer.clearTimeout(existing.authRefreshTimerId)
    if (existing?.authRetryTimerId != null) bgTimer.clearTimeout(existing.authRetryTimerId)
    host.connectedApps.set(packageName, {
      lastPongAt: 0,
      unansweredPingRounds: 0,
      installedManifest: undefined,
      authRefreshTimerId: null,
      authRetryTimerId: null,
      authDelivered: false,
      authSession: 0,
    })
  }

  /** Move the clock forward, running every timer that falls due on the way, in order. */
  async function advance(ms: number): Promise<void> {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = Math.max(now, due[1].at)
      due[1].callback()
      await flush()
    }
    now = target
    await flush()
  }

  return {
    host,
    requests,
    warnings,
    visibility,
    /** Tokens the miniapp was handed, in order (CONNECT's delivery and every AUTH_UPDATE after it). */
    delivered: () => sent.filter((message) => message.type === "auth_update").map((message) => message.auth?.token),
    now: () => now,
    /** Timers still armed, with the delay each was armed for. */
    armed: () => [...timers.values()].map((timer) => timer.delay),
    plan: (...next: Plan[]) => plans.push(...next),
    advance,
    /** The miniapp's WebView connects. */
    async connect() {
      register()
      host.handleConnect(CALL, {}, "req-1")
      await flush()
    },
    /** The same WebView sends CONNECT again without being respawned. */
    async connectAgain() {
      host.handleConnect(CALL, {}, "req-2")
      await flush()
    },
    /** The cloud client (re)connects: apps still missing their first token retry at once. */
    async redrive() {
      host.redriveMiniappAuthDelivery()
      await flush()
    },
    /** The miniapp becomes the visible one (or, with null, none is). */
    async show(packageName: string | null) {
      visible = packageName
      host.updateVisibility()
      await flush()
    },
    register,
  }
}

const fails =
  (message: string): Plan =>
  () =>
    Promise.reject(new Error(message))

/** A token request the test answers itself, when and as it likes. */
function pending() {
  let resolve!: (token: Token) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Token>((res, rej) => {
    resolve = res
    reject = rej
  })
  const plan: Plan = () => promise
  return {plan, resolve, reject}
}

describe("a miniapp that connects", () => {
  test("is handed a token minted now, not a cached one", async () => {
    const f = fixture()
    await f.connect()

    expect(f.requests).toEqual([{packageName: CALL, opts: {fresh: true}}])
    expect(f.delivered()).toEqual(["token-1"])
  })

  test("two opens within an hour get two tokens", async () => {
    const f = fixture()
    await f.connect()
    await f.advance(10 * 60_000)
    await f.connect()

    expect(f.requests.map((request) => request.opts)).toEqual([{fresh: true}, {fresh: true}])
    expect(f.delivered()).toEqual(["token-1", "token-2"])
  })

  test("arms the scheduled refresh for the token's own expiry", async () => {
    const f = fixture()
    await f.connect()

    expect(f.armed()).toEqual([HOUR_MS - HEADROOM_MS])
  })
})

describe("the scheduled refresh before expiry", () => {
  test("delivers a new token and re-arms for the new expiry, not every few seconds", async () => {
    const f = fixture()
    await f.connect()

    await f.advance(HOUR_MS - HEADROOM_MS)

    expect(f.requests.map((request) => request.opts?.fresh)).toEqual([true, true])
    expect(f.delivered()).toEqual(["token-1", "token-2"])
    expect(f.armed()).toEqual([HOUR_MS - HEADROOM_MS])
    expect(f.armed()[0]).toBeGreaterThan(MIN_DELAY_MS)

    // Nothing more goes out until the new token's own refresh falls due.
    await f.advance(HOUR_MS - HEADROOM_MS - 1_000)
    expect(f.requests).toHaveLength(2)
    await f.advance(1_000)
    expect(f.requests).toHaveLength(3)
    expect(f.delivered()).toEqual(["token-1", "token-2", "token-3"])
  })

  test("does not hand the same token back and re-send it", async () => {
    const f = fixture()
    await f.connect()

    await f.advance(HOUR_MS - HEADROOM_MS + 5 * MIN_DELAY_MS)

    expect(new Set(f.delivered()).size).toBe(f.delivered().length)
    expect(f.requests).toHaveLength(2)
  })

  test("a failed refresh is logged and keeps the token the miniapp has", async () => {
    const f = fixture()
    await f.connect()
    f.plan(fails("offline"))

    await f.advance(HOUR_MS - HEADROOM_MS)

    expect(f.warnings.some((warning) => warning.includes("auth refresh failed"))).toBe(true)
    expect(f.delivered()).toEqual(["token-1"])
  })
})

describe("a miniapp that comes to the foreground", () => {
  test("is handed a token minted now, after the visibility change", async () => {
    const f = fixture()
    await f.connect()

    await f.show(CALL)

    expect(f.visibility).toEqual([[CALL, "foreground"]])
    expect(f.requests.map((request) => request.opts)).toEqual([{fresh: true}, {fresh: true}])
    expect(f.delivered()).toEqual(["token-1", "token-2"])
  })

  test("re-arms the scheduled refresh for the new token only", async () => {
    const f = fixture()
    await f.connect()
    await f.advance(20 * 60_000)

    await f.show(CALL)

    expect(f.armed()).toEqual([HOUR_MS - HEADROOM_MS])
  })

  test("is handed a new token each time it returns", async () => {
    const f = fixture()
    await f.connect()

    await f.show(CALL)
    await f.show(null)
    await f.show(CALL)

    expect(f.delivered()).toEqual(["token-1", "token-2", "token-3"])
  })

  test("is not handed another token while the first is still on its way", async () => {
    const f = fixture()
    let release!: (token: Token) => void
    f.plan(() => new Promise<Token>((resolve) => (release = resolve)))
    await f.connect()

    await f.show(CALL)
    expect(f.requests).toHaveLength(1)

    release({token: "token-1", expiresAt: f.now() + HOUR_MS})
    await flush()
    expect(f.requests).toHaveLength(1)
    expect(f.delivered()).toEqual(["token-1"])
  })

  test("leaves the miniapp it moves away from alone", async () => {
    const f = fixture()
    await f.connect()
    await f.show(CALL)
    f.requests.length = 0

    await f.show(null)

    expect(f.visibility.at(-1)).toEqual([CALL, "background"])
    expect(f.requests).toHaveLength(0)
  })

  test("does nothing when the visible miniapp has not changed", async () => {
    const f = fixture()
    await f.connect()
    await f.show(CALL)
    f.requests.length = 0

    await f.show(CALL)

    expect(f.requests).toHaveLength(0)
  })

  test("is left to its own CONNECT when it has not connected yet", async () => {
    const f = fixture()
    f.register()

    await f.show(CALL)

    expect(f.requests).toHaveLength(0)
  })

  test("keeps the token it has when the mint fails", async () => {
    const f = fixture()
    await f.connect()
    f.plan(fails("offline"))

    await f.show(CALL)

    expect(f.warnings.some((warning) => warning.includes("auth refresh failed"))).toBe(true)
    expect(f.delivered()).toEqual(["token-1"])
    expect(f.armed()).toEqual([HOUR_MS - HEADROOM_MS])
  })
})

describe("a mint that fails when the miniapp connects", () => {
  test("is retried with the existing backoff, through the default path after the first fresh request", async () => {
    const f = fixture()
    f.plan(fails("not ready"), fails("not ready"), fails("not ready"))
    await f.connect()

    expect(f.armed()).toEqual([RETRY_BASE_MS])
    await f.advance(RETRY_BASE_MS)
    expect(f.armed()).toEqual([RETRY_BASE_MS * 2])
    await f.advance(RETRY_BASE_MS * 2)
    expect(f.armed()).toEqual([RETRY_BASE_MS * 4])
    await f.advance(RETRY_BASE_MS * 4)

    expect(f.requests.map((request) => request.opts)).toEqual([{fresh: true}, undefined, undefined, undefined])
    expect(f.delivered()).toEqual(["token-1"])
    // The retries are over; only the token's refresh is armed.
    expect(f.armed()).toEqual([HOUR_MS - HEADROOM_MS])
  })

  test("backs off no further than the cap", async () => {
    const f = fixture()
    f.plan(...Array.from({length: 7}, () => fails("not ready")))
    await f.connect()

    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      delays.push(...f.armed())
      await f.advance(f.armed()[0])
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS])
  })

  test("with a still-valid cached token, delivers it on the first retry", async () => {
    const f = fixture()
    await f.connect()
    await f.advance(10 * 60_000)
    f.plan(fails("Core is down"))

    await f.connect()
    // The fresh mint failed and nothing has been delivered for this open yet.
    expect(f.delivered()).toEqual(["token-1"])
    expect(f.armed()).toEqual([RETRY_BASE_MS])

    await f.advance(RETRY_BASE_MS)

    expect(f.requests.map((request) => request.opts)).toEqual([{fresh: true}, {fresh: true}, undefined])
    expect(f.delivered()).toEqual(["token-1", "token-1"])
    // No more retries; the refresh is armed for the cached token's own expiry.
    expect(f.armed()).toEqual([HOUR_MS - HEADROOM_MS - 10 * 60_000 - RETRY_BASE_MS])
  })

  test("with a cached token, the refresh that follows is still fresh", async () => {
    const f = fixture()
    await f.connect()
    f.plan(fails("Core is down"))
    await f.connect()
    await f.advance(RETRY_BASE_MS)

    await f.advance(f.armed()[0])

    expect(f.requests.at(-1)?.opts).toEqual({fresh: true})
    expect(f.delivered().at(-1)).toBe("token-2")
  })

  test("with a cached token that is about to expire, the retry mints", async () => {
    const f = fixture()
    await f.connect()
    // The scheduled refresh failed, so the cached token ran down into the cloud client's expiry margin, where the
    // default path no longer serves it.
    f.plan(fails("Core is down"), fails("Core is down"))
    await f.advance(HOUR_MS - CACHE_MARGIN_MS / 2)
    expect(f.delivered()).toEqual(["token-1"])

    await f.connect()
    await f.advance(RETRY_BASE_MS)

    expect(f.requests.at(-1)?.opts).toBeUndefined()
    expect(f.delivered().at(-1)).toBe("token-2")
  })

  test("the reconnect redrive also takes the default path, delivering a valid cached token", async () => {
    const f = fixture()
    await f.connect()
    f.plan(fails("Core is down"))
    await f.connect()
    expect(f.armed()).toEqual([RETRY_BASE_MS])

    await f.redrive()

    expect(f.requests.map((request) => request.opts)).toEqual([{fresh: true}, {fresh: true}, undefined])
    expect(f.delivered()).toEqual(["token-1", "token-1"])
    // The redrive took over from the pending retry.
    expect(f.armed()).toEqual([HOUR_MS - HEADROOM_MS])
  })

  test("the reconnect redrive with no cached token mints", async () => {
    const f = fixture()
    f.plan(fails("Core is down"))
    await f.connect()

    await f.redrive()

    expect(f.requests.map((request) => request.opts)).toEqual([{fresh: true}, undefined])
    expect(f.delivered()).toEqual(["token-1"])
  })
})

describe("a miniapp that connects again while an earlier token request is out", () => {
  // The purchase happens between the two opens: request A was made before it and request B after it.
  const before = (f: ReturnType<typeof fixture>): Token => ({token: "before-purchase", expiresAt: f.now() + HOUR_MS})
  const after = (f: ReturnType<typeof fixture>): Token => ({
    token: "after-purchase",
    expiresAt: f.now() + HOUR_MS + 10 * 60_000,
  })

  test("a replaced miniapp gets the token minted for its own open, not the older answer", async () => {
    const f = fixture()
    const a = pending()
    const b = pending()
    f.plan(a.plan, b.plan)
    await f.connect()
    await f.connect()

    a.resolve(before(f))
    await flush()
    b.resolve(after(f))
    await flush()

    expect(f.delivered()).toEqual(["after-purchase"])
    expect(f.armed()).toEqual([HOUR_MS + 10 * 60_000 - HEADROOM_MS])
  })

  test("the same WebView sending CONNECT again gets the token minted for its second open", async () => {
    const f = fixture()
    const a = pending()
    const b = pending()
    f.plan(a.plan, b.plan)
    await f.connect()
    await f.connectAgain()

    a.resolve(before(f))
    await flush()
    b.resolve(after(f))
    await flush()

    expect(f.delivered()).toEqual(["after-purchase"])
    expect(f.armed()).toEqual([HOUR_MS + 10 * 60_000 - HEADROOM_MS])
  })

  test("the older answer arriving last changes nothing", async () => {
    const f = fixture()
    const a = pending()
    const b = pending()
    f.plan(a.plan, b.plan)
    await f.connect()
    await f.connect()

    b.resolve(after(f))
    await flush()
    a.resolve(before(f))
    await flush()

    expect(f.delivered()).toEqual(["after-purchase"])
    expect(f.armed()).toEqual([HOUR_MS + 10 * 60_000 - HEADROOM_MS])
  })

  test("an older request that fails starts no retry for the later open", async () => {
    const f = fixture()
    const a = pending()
    const b = pending()
    f.plan(a.plan, b.plan)
    await f.connect()
    await f.connectAgain()

    a.reject(new Error("offline"))
    await flush()
    expect(f.armed()).toEqual([])

    b.resolve(after(f))
    await flush()
    expect(f.requests).toHaveLength(2)
    expect(f.delivered()).toEqual(["after-purchase"])
  })

  test("a foreground refresh that is still out when the miniapp is replaced is not handed to the new one", async () => {
    const f = fixture()
    await f.connect()
    const stale = pending()
    f.plan(stale.plan)
    await f.show(CALL)

    await f.connect()
    expect(f.delivered()).toEqual(["token-1", "token-2"])
    stale.resolve(before(f))
    await flush()

    expect(f.delivered()).toEqual(["token-1", "token-2"])
    expect(f.armed()).toEqual([HOUR_MS - HEADROOM_MS])
  })
})
