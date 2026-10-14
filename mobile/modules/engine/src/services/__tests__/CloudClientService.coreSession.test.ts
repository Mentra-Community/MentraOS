/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"
import {AuthExpiredError, AuthUnavailableError, HttpError, SessionRevocationError} from "@mentra/cloud-client"
import type {FleetReport} from "@mentra/cloud-protocol"

import type {FleetSendOutcome} from "../CloudClientService"

import {bluetoothSdk} from "./bluetoothSdkTestMock"
import {reactNative} from "./reactNativeTestMock"

// The Core session the Fleet reporter relies on: which Core the client was built for, whose token it holds, when
// that changes, and the guard that sends a Fleet batch only as the account and Core it was queued for.
;(globalThis as {__DEV__?: boolean}).__DEV__ = false
reactNative.Platform = {OS: "ios", Version: "26.0"}
bluetoothSdk.updateBluetoothSettings = mock(async () => {})

const CORE_X = "https://core.x.example"
const CORE_Y = "https://core.y.example"
const RUNTIME = "https://runtime.example"
const A = "user-a"
const B = "user-b"

type TokenMode = "ok" | "hang" | Error

/** A Core access token for an account: a JWT whose `sub` is the account (unsigned; the client never verifies it). */
function tokenFor(account: string | null): string {
  const claims = Buffer.from(JSON.stringify({sub: account ?? "", tenant_id: "tenant", exp: 4_102_444_800}))
  return `eyJhbGciOiJub25lIn0.${claims.toString("base64url")}.signature`
}

/**
 * A Core token source: whose token it hands out, and how the next request for one goes. Like the real client it
 * persists the refresh token, so a client built later resumes the stored account's Core session instead of
 * exchanging the host's current subject token; `clearSession` removes it and leaves the client inert.
 */
class FakeAuth {
  /** The account the client's stored token belongs to (what `identity` reads). */
  account: string | null = storedAccount ?? nextAccount
  /** Hands out another account's token than `identity` reports, to tell the two apart. */
  issueAs: string | null | undefined = undefined
  mode: TokenMode = nextTokenMode
  /** How the next `clearSession` goes: at once, held until `releaseClear`, or failing to revoke. */
  clearMode: TokenMode = "ok"
  private holding = false
  private cleared = false
  private pending: Array<() => void> = []
  private pendingClears: Array<() => void> = []

  readonly getCoreToken = mock(async (opts?: {forceRefresh?: boolean}): Promise<string> => {
    void opts
    if (this.cleared) throw new AuthExpiredError("auth session was cleared")
    if (this.mode === "hang") await new Promise<void>((resolve) => this.pending.push(resolve))
    if (this.cleared) throw new AuthExpiredError("auth session was cleared")
    if (this.mode instanceof Error) throw this.mode
    this.holding = true
    storedAccount = this.account
    return tokenFor(this.issueAs === undefined ? this.account : this.issueAs)
  })

  /** Local credentials go at once (the stored one included); the revocation that follows may be held or fail. */
  readonly clearSession = mock(async (): Promise<void> => {
    this.cleared = true
    this.holding = false
    storedAccount = null
    if (this.clearMode === "hang") await new Promise<void>((resolve) => this.pendingClears.push(resolve))
    if (this.clearMode instanceof Error) throw this.clearMode
  })

  /** Lets the token requests waiting in "hang" mode finish, in the mode now set. */
  release(): void {
    for (const resolve of this.pending.splice(0)) resolve()
  }

  /** Lets a held `clearSession` finish, in the clear mode now set. */
  releaseClear(): void {
    for (const resolve of this.pendingClears.splice(0)) resolve()
  }

  get identity(): {mentraUserId: string; tenantId: string} {
    if (!this.holding || !this.account)
      throw new AuthExpiredError("Core identity is unavailable before first Core sign-in")
    return {mentraUserId: this.account, tenantId: "tenant"}
  }
}

const ACK: FleetSendOutcome = {kind: "results", ack: {schemaVersion: 1, results: []}}

class FakeCloudClient {
  static built: FakeCloudClient[] = []
  private readonly connectedHandlers: Array<() => void> = []
  readonly auth = new FakeAuth()
  readonly core?: {fleet: {report: ReturnType<typeof mock>}}
  readonly runtime = {
    onStatusChanged: () => () => {},
    onTranscript: () => () => {},
    onTranslation: () => () => {},
    getStatus: () => ({status: "idle", audioTransport: null}),
    onConnected: (handler: () => void) => {
      this.connectedHandlers.push(handler)
    },
    onDisconnected: () => {},
    onError: () => {},
    connect: async () => {},
    close: () => {},
    setSubscriptions: async () => {},
  }

  constructor(readonly config: {endpoints: {core?: string; runtime: string}}) {
    FakeCloudClient.built.push(this)
    if (config.endpoints.core) this.core = {fleet: {report: mock(async () => ACK)}}
  }

  /** The Runtime's live session comes up. */
  connectRuntime(): void {
    for (const handler of this.connectedHandlers) handler()
  }
}
/** The account of the Core refresh token in the secure store, which a new client resumes. */
let storedAccount: string | null = null
let nextAccount: string | null = A
let nextTokenMode: TokenMode = "ok"
const latest = () => FakeCloudClient.built[FakeCloudClient.built.length - 1]

mock.module("@mentra/cloud-client/react-native", () => ({
  CloudClient: FakeCloudClient,
  setNativeHttp: () => {},
  setNativeUdp: () => {},
  setSecureStorage: () => {},
}))
mock.module("@mentra/crust", () => ({default: {}, nativeHttpRequest: async () => ({})}))

let authCallback: ((event: string, session: {token?: string | null} | null) => void) | null = null
const endpoints = {current: {core: CORE_X, runtime: RUNTIME} as {core?: string; runtime: string}}
mock.module("../../runtime/bootstrap", () => ({
  getAuth: () => ({
    getSubjectToken: async () => ({token: "subject", type: "mentra"}),
    getRuntimeToken: async () => "runtime-token",
    onStateChange: (callback: typeof authCallback) => {
      authCallback = callback
      return {unsubscribe: () => (authCallback = null)}
    },
  }),
  getConfigValues: () => ({runtimeRealtimeSession: false, resolveCloudEndpoints: () => ({...endpoints.current})}),
  isFeatureEnabled: () => true,
}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {core_token: {key: "core_token"}, lc3_frame_size: {key: "lc3_frame_size"}},
  useSettingsStore: {
    getState: () => ({
      getSetting: () => null,
      setSetting: async () => ({is_error: () => false}),
    }),
    subscribe: () => () => {},
  },
}))

/** The default MMKV instance's values, where the engine keeps the verified identity of the signed-in account. */
const kept = new Map<string, unknown>()
const ok = (value?: unknown) => ({is_ok: () => true, is_error: () => false, value})
mock.module("../../utils/storage", () => ({
  storage: {
    load: (key: string) =>
      kept.has(key) ? ok(kept.get(key)) : {is_ok: () => false, is_error: () => true, error: new Error("missing")},
    save: (key: string, value: unknown) => {
      kept.set(key, value)
      return ok()
    },
    remove: (key: string) => {
      kept.delete(key)
      return ok()
    },
  },
}))
mock.module("../../utils/cloudClient/RnUdpAdapter", () => ({createCloudUdpSocket: () => ({})}))
mock.module("../../utils/cloudClient/cloudSecureStore", () => ({cloudSecureStore: {delete: async () => {}}}))
mock.module("../../stores/cloudClientStatus", () => ({
  useCloudClientStatusStore: {
    getState: () => ({setSnapshot: () => {}, reset: () => {}, status: "idle", audioTransport: null}),
  },
}))
mock.module("../NotificationsEmitter", () => ({islandNotifications: {emit: () => {}}}))
mock.module("../CloudTranscriptE2EMetrics", () => ({logCloudV2TranscriptMetric: () => {}}))
mock.module("../../utils/timers", () => ({
  BgTimer: {setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}},
}))

const {cloudClientService} = await import("../CloudClientService")
type CoreSessionChange = Parameters<Parameters<typeof cloudClientService.onCoreSessionChanged>[0]>[0]

const IDENTITY_KEY = "mentra.localMiniapp.userId"
const BATCH: FleetReport = {schemaVersion: 1, records: []}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function reportOf(client: FakeCloudClient) {
  if (!client.core) throw new Error("this client has no Core")
  return client.core.fleet.report
}

beforeEach(() => {
  FakeCloudClient.built = []
  storedAccount = null
  nextAccount = A
  nextTokenMode = "ok"
  endpoints.current = {core: CORE_X, runtime: RUNTIME}
  kept.clear()
})

afterEach(async () => {
  // Nothing a test held may outlive it: a token request left hanging would keep the engine's Bluetooth token sync
  // (one at a time, process-wide) waiting into the next test.
  nextTokenMode = "ok"
  for (const built of FakeCloudClient.built) {
    built.auth.mode = "ok"
    built.auth.clearMode = "ok"
    built.auth.release()
    built.auth.releaseClear()
  }
  cloudClientService.reconnect(null)
  cloudClientService.stop()
  // Token requests the teardown started must not land in the next test's secure store.
  await settle()
})

describe("the Core session", () => {
  test("is null before the client exists, and without a Core", () => {
    expect(cloudClientService.getCoreSession()).toBeNull()
    endpoints.current = {runtime: RUNTIME}
    cloudClientService.init()
    expect(cloudClientService.hasCore()).toBe(false)
    expect(cloudClientService.getCoreSession()).toBeNull()
  })

  test("names the Core URL the client was built with, not the one the resolver gives now", async () => {
    cloudClientService.init()
    await settle()
    endpoints.current = {core: CORE_Y, runtime: RUNTIME}
    expect(cloudClientService.getCoreUrl()).toBe(CORE_Y)
    expect(cloudClientService.getCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: A})
  })

  test("names the account of the client's token, before the identity kept for the signed-in account", async () => {
    kept.set(IDENTITY_KEY, "kept-account")
    cloudClientService.init()
    await settle()
    expect(cloudClientService.getCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: A})
  })

  test("falls back to the kept identity while there is no token (offline), else to no account", async () => {
    nextTokenMode = new Error("offline")
    kept.set(IDENTITY_KEY, "kept-account")
    cloudClientService.init()
    await settle()
    expect(cloudClientService.getCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: "kept-account"})
    kept.clear()
    cloudClientService.stop()
    cloudClientService.init()
    await settle()
    expect(cloudClientService.getCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: null})
  })

  test("resolveCoreSession makes the token current first", async () => {
    nextTokenMode = new Error("offline")
    cloudClientService.init()
    await settle()
    expect(cloudClientService.getCoreSession()?.mentraUserId).toBeNull()
    latest().auth.mode = "ok"
    expect(await cloudClientService.resolveCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: A})
  })

  test.each([
    ["Core is unavailable", () => new AuthUnavailableError("refresh could not be completed; try again later")],
    ["the network failed", () => new HttpError("network", 0)],
    ["the host could not hand over a subject token", () => new Error("engine.configure: no subject token available")],
  ])(
    "resolveCoreSession rejects when no account is known and the token cannot be had because %s",
    async (_why, error) => {
      nextTokenMode = error()
      cloudClientService.init()
      await settle()
      // The account is not known, which is not the same as there being none.
      await expect(cloudClientService.resolveCoreSession()).rejects.toBeDefined()
    },
  )

  test("resolveCoreSession answers with the kept identity when the token cannot be had for now", async () => {
    nextTokenMode = new AuthUnavailableError("refresh could not be completed; try again later")
    kept.set(IDENTITY_KEY, "kept-account")
    cloudClientService.init()
    await settle()
    expect(await cloudClientService.resolveCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: "kept-account"})
  })

  test("resolveCoreSession answers with no account when Core refused the credentials", async () => {
    nextTokenMode = new AuthExpiredError()
    cloudClientService.init()
    await settle()
    expect(await cloudClientService.resolveCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: null})
  })
})

describe("sending a Fleet batch as an account", () => {
  test("sends as the expected account to the expected Core", async () => {
    cloudClientService.init()
    await settle()
    const signal = new AbortController().signal
    const outcome = await cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH, {signal})
    expect(outcome).toEqual(ACK)
    // The token whose account was checked is the token sent.
    expect(reportOf(latest())).toHaveBeenCalledWith(BATCH, {signal, bearer: tokenFor(A)})
  })

  test("checks the account of the very token it sends, not what the client reports afterwards", async () => {
    cloudClientService.init()
    await settle()
    latest().auth.issueAs = B
    expect(await cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH)).toEqual({
      kind: "session_changed",
    })
    expect(reportOf(latest())).not.toHaveBeenCalled()
  })

  test("an equivalent spelling of the Core URL is the same Core", async () => {
    cloudClientService.init()
    await settle()
    const sameCore = "HTTPS://Core.X.Example:443/"
    expect(await cloudClientService.core.fleet.reportAs({coreUrl: sameCore, mentraUserId: A}, BATCH)).toEqual(ACK)
    expect(reportOf(latest())).toHaveBeenCalledTimes(1)
  })

  test("refuses, sending nothing, for another Core", async () => {
    cloudClientService.init()
    await settle()
    expect(await cloudClientService.core.fleet.reportAs({coreUrl: CORE_Y, mentraUserId: A}, BATCH)).toEqual({
      kind: "session_changed",
    })
    expect(reportOf(latest())).not.toHaveBeenCalled()
  })

  test("refuses, sending nothing, when the client's token belongs to another account", async () => {
    cloudClientService.init()
    await settle()
    latest().auth.account = B
    expect(await cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH)).toEqual({
      kind: "session_changed",
    })
    expect(reportOf(latest())).not.toHaveBeenCalled()
  })

  test("refuses, sending nothing, when the client is rebuilt while the token is fetched", async () => {
    cloudClientService.init()
    await settle()
    const old = latest()
    old.auth.mode = "hang"
    const sending = cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH)
    cloudClientService.reconnect()
    old.auth.mode = "ok"
    old.auth.release()
    expect(await sending).toEqual({kind: "session_changed"})
    expect(reportOf(old)).not.toHaveBeenCalled()
    expect(reportOf(latest())).not.toHaveBeenCalled()
  })

  test("never builds a client of its own", async () => {
    expect(await cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH)).toEqual({
      kind: "session_changed",
    })
    expect(FakeCloudClient.built).toEqual([])
  })

  test("a 401 force-refreshes the token once and answers unauthorized", async () => {
    cloudClientService.init()
    await settle()
    const client = latest()
    reportOf(client).mockImplementationOnce(async () => {
      throw new HttpError("unauthorized", 401)
    })
    client.auth.getCoreToken.mockClear()
    expect(await cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH)).toEqual({
      kind: "unauthorized",
    })
    const forced = client.auth.getCoreToken.mock.calls.filter(([opts]) => opts?.forceRefresh === true)
    expect(forced).toHaveLength(1)
  })

  test("credentials that cannot be refreshed answer unauthorized after one forced refresh, sending nothing", async () => {
    cloudClientService.init()
    await settle()
    const client = latest()
    client.auth.mode = new AuthExpiredError()
    client.auth.getCoreToken.mockClear()
    expect(await cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH)).toEqual({
      kind: "unauthorized",
    })
    expect(client.auth.getCoreToken.mock.calls.filter(([opts]) => opts?.forceRefresh === true)).toHaveLength(1)
    expect(reportOf(client)).not.toHaveBeenCalled()
  })

  test("a token failure that is not about credentials is unavailable, sending nothing", async () => {
    cloudClientService.init()
    await settle()
    latest().auth.mode = new HttpError("network", 0)
    expect(await cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH)).toEqual({
      kind: "unavailable",
      retryAfterSeconds: null,
    })
    expect(reportOf(latest())).not.toHaveBeenCalled()
  })

  test("an aborted request is never sent", async () => {
    cloudClientService.init()
    await settle()
    const controller = new AbortController()
    controller.abort()
    await expect(
      cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH, {signal: controller.signal}),
    ).rejects.toBeDefined()
    expect(reportOf(latest())).not.toHaveBeenCalled()
  })
})

describe("Core session changes", () => {
  function listen(): CoreSessionChange[] {
    const changes: CoreSessionChange[] = []
    cloudClientService.onCoreSessionChanged((change) => changes.push(change))
    return changes
  }

  test("a sign-out reaches listeners with no account", async () => {
    cloudClientService.init()
    await settle()
    const changes = listen()
    authCallback?.("SIGNED_OUT", null)
    expect(changes).toEqual([{reason: "signed_out", coreUrl: CORE_X, mentraUserId: null}])
    expect(kept.has(IDENTITY_KEY)).toBe(false)
  })

  test("a sign-in reaches listeners after the previous account's identity is forgotten", async () => {
    cloudClientService.init()
    await settle()
    expect(kept.get(IDENTITY_KEY)).toBe(A)
    nextAccount = B
    nextTokenMode = "hang"
    const changes = listen()
    authCallback?.("SIGNED_IN", {token: "t"})
    await settle()
    // The sign-in rebuilds the client; neither change may name the old account.
    expect(changes).toEqual([
      {reason: "reconnect", coreUrl: CORE_X, mentraUserId: null},
      {reason: "signed_in", coreUrl: CORE_X, mentraUserId: null},
    ])
    // The rebuilt client exchanges the new sign-in rather than resuming the previous account's stored session.
    latest().auth.mode = "ok"
    latest().auth.release()
    expect(await cloudClientService.resolveCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: B})
  })

  test("a sign-in while the Runtime is connected replaces the previous account's Core session too", async () => {
    cloudClientService.init()
    await settle()
    const previous = latest()
    previous.connectRuntime()
    expect(cloudClientService.isConnected()).toBe(true)
    expect(cloudClientService.getCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: A})
    nextAccount = B
    // The new client's first token is an exchange, a network round trip away.
    nextTokenMode = "hang"
    const changes = listen()
    authCallback?.("SIGNED_IN", {token: "t"})
    await settle()
    expect(previous.auth.clearSession).toHaveBeenCalledTimes(1)
    expect(latest()).not.toBe(previous)
    expect(changes).toEqual([
      {reason: "reconnect", coreUrl: CORE_X, mentraUserId: null},
      {reason: "signed_in", coreUrl: CORE_X, mentraUserId: null},
    ])
    latest().auth.mode = "ok"
    latest().auth.release()
    expect(await cloudClientService.resolveCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: B})
    // Nothing is sent as the account that signed in before.
    expect(await cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH)).toEqual({
      kind: "session_changed",
    })
    expect(reportOf(previous)).not.toHaveBeenCalled()
    expect(reportOf(latest())).not.toHaveBeenCalled()
  })

  test("the new client is built only once the previous credentials are gone, and nothing is sent in between", async () => {
    cloudClientService.init()
    await settle()
    const previous = latest()
    previous.auth.clearMode = "hang"
    nextAccount = B
    const changes = listen()
    authCallback?.("SIGNED_IN", {token: "t"})
    await settle()
    expect(FakeCloudClient.built).toHaveLength(1)
    expect(changes).toEqual([])
    expect(cloudClientService.getCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: null})
    expect(await cloudClientService.core.fleet.reportAs({coreUrl: CORE_X, mentraUserId: A}, BATCH)).toEqual({
      kind: "unauthorized",
    })
    expect(reportOf(previous)).not.toHaveBeenCalled()
    previous.auth.releaseClear()
    await settle()
    expect(FakeCloudClient.built).toHaveLength(2)
    expect(changes.map((change) => change.reason)).toEqual(["reconnect", "signed_in"])
  })

  test("a revocation that fails still leaves a client for the new sign-in", async () => {
    cloudClientService.init()
    await settle()
    const previous = latest()
    previous.auth.clearMode = new SessionRevocationError("Core session revocation failed")
    nextAccount = B
    const warn = mock(() => {})
    const originalWarn = console.warn
    console.warn = warn
    try {
      authCallback?.("SIGNED_IN", {token: "t"})
      await settle()
    } finally {
      console.warn = originalWarn
    }
    expect(previous.auth.clearSession).toHaveBeenCalledTimes(1)
    expect(latest()).not.toBe(previous)
    expect(await cloudClientService.resolveCoreSession()).toEqual({coreUrl: CORE_X, mentraUserId: B})
  })

  test("sign-ins in a row clear the previous credentials once and rebuild once", async () => {
    cloudClientService.init()
    await settle()
    const previous = latest()
    previous.auth.clearMode = "hang"
    authCallback?.("SIGNED_IN", {token: "t"})
    authCallback?.("SIGNED_IN", {token: "t"})
    await settle()
    previous.auth.releaseClear()
    await settle()
    expect(previous.auth.clearSession).toHaveBeenCalledTimes(1)
    expect(FakeCloudClient.built).toHaveLength(2)
  })

  test("a logout while the previous credentials are being cleared builds nothing", async () => {
    cloudClientService.init()
    await settle()
    const previous = latest()
    previous.auth.clearMode = "hang"
    const changes = listen()
    authCallback?.("SIGNED_IN", {token: "t"})
    await settle()
    cloudClientService.stop()
    previous.auth.releaseClear()
    await settle()
    expect(FakeCloudClient.built).toHaveLength(1)
    expect(changes).toEqual([])
  })

  test("a sign-in that carries no session to exchange leaves the Core credentials alone", async () => {
    cloudClientService.init()
    await settle()
    const previous = latest()
    previous.connectRuntime()
    const changes = listen()
    authCallback?.("SIGNED_IN", {token: null})
    await settle()
    expect(previous.auth.clearSession).not.toHaveBeenCalled()
    expect(FakeCloudClient.built).toHaveLength(1)
    expect(changes.map((change) => change.reason)).toEqual(["signed_in"])
  })

  test("without a Core, a sign-in while the Runtime is connected leaves the client as it is", async () => {
    endpoints.current = {runtime: RUNTIME}
    cloudClientService.init()
    await settle()
    latest().connectRuntime()
    const changes = listen()
    authCallback?.("SIGNED_IN", {token: "t"})
    await settle()
    expect(FakeCloudClient.built).toHaveLength(1)
    expect(changes).toEqual([{reason: "signed_in", coreUrl: null, mentraUserId: null}])
  })

  test("a reconnect to another Core reaches listeners with that Core", async () => {
    cloudClientService.init()
    await settle()
    const changes = listen()
    cloudClientService.reconnect({core: CORE_Y, runtime: RUNTIME})
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({reason: "reconnect", coreUrl: CORE_Y})
    expect(cloudClientService.getCoreSession()?.coreUrl).toBe(CORE_Y)
  })

  test("a failing listener does not stop the others, and unsubscribing works", async () => {
    cloudClientService.init()
    await settle()
    const warn = mock(() => {})
    const originalWarn = console.warn
    console.warn = warn
    try {
      const unsubscribe = cloudClientService.onCoreSessionChanged(() => {
        throw new Error("listener failed")
      })
      const changes = listen()
      cloudClientService.reconnect()
      expect(changes).toHaveLength(1)
      unsubscribe()
      cloudClientService.reconnect()
      expect(changes).toHaveLength(2)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      console.warn = originalWarn
    }
  })
})
