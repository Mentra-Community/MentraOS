/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"

import {SoftapCallError, SOFTAP_STEPS} from "../SoftapCallTransport"
import {awaitCleanupBarrier} from "../SoftapCleanupBarrier"

// Exercise the actual private host methods without loading the Expo app singleton and all
// its hardware services. Only the I/O boundaries are faked; reservation, retirement, and the
// resource-ownership checks come directly from LocalMiniappRuntime's implementation.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = [
  "ensureMeetingStateBridge",
  "leaveMeetingForApp",
  "joinSoftapMeeting",
  "createSoftapAttempt",
  "checkpointSoftapAttempt",
  "runSoftapAttempt",
  "retireSoftapAttempt",
  "teardownSoftapAttempt",
  "settleSoftapTeardown",
  "emitSoftapProgress",
  "softapRecoveryFields",
]
  .map((name) => {
    const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    const end = rest.search(/^  }$/m)
    if (end < 0) throw new Error(`Missing end of runtime method ${name}`)
    return rest.slice(0, end + 3)
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return {promise, resolve, reject}
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Same extraction as the lifecycle methods: the settle gate is pulled from the source so the
 * teardown these tests drive is the one that ships, including the ingest-close wait that a fake
 * host would otherwise silently skip.
 */
type Gates = {ingestClosed?: boolean}

function fixture(gates: Gates = {}): ReturnType<typeof buildFixture> {
  return buildFixture(gates)
}

function buildFixture(gates: Gates) {
  const cleanup = deferred()
  let acsLeaves = 0
  let preflights = 0
  const nativeLeaves: string[] = []
  let stateHandler: ((owner: string, state: {state: string}) => void) | undefined
  let forcedIngestCloses = 0
  const native = {
    setPhotoPauseExpiredHandler() {},
    setStateHandler(handler: typeof stateHandler) {
      stateHandler = handler
    },
    async awaitDefaultNetworkAfterHotspot() {
      return {usable: true, detail: "cellular"}
    },
    async leaveIfOwner(packageName: string) {
      nativeLeaves.push(packageName)
    },
    async leaveAndAwait() {
      acsLeaves++
      if (acsLeaves === 1) await cleanup.promise
      return {completed: true}
    },
    async awaitIngestClosed() {
      // After a forced close the port really is gone, so the re-verify answers true even when the
      // first bounded wait did not.
      return gates.ingestClosed !== false || forcedIngestCloses > 0
    },
    async forceCloseIngest() {
      forcedIngestCloses++
    },
  }
  const permissions = {
    async check() {
      preflights++
      // End at the first I/O boundary: these tests verify that getting here is safely ordered.
      throw new Error("test preflight ended")
    },
  }
  const Host = new Function(
    "holdGlassesWifi",
    "softapTrace",
    "softapTraceFailure",
    "SOFTAP_CLEANUP_STALL_LOG_MS",
    "SOFTAP_CLEANUP_NARRATE_AFTER_MS",
    "SoftapCallError",
    "SOFTAP_STEPS",
    "awaitCleanupBarrier",
    "acsMeetingService",
    "permissions",
    "PermissionFeatures",
    "MiniappResponseType",
    "console",
    "SOFTAP_INGEST_CLOSE_WAIT_MS",
    "SOFTAP_FORCED_VERIFY_MS",
    `${compiled}; return Host`,
  )(
    async () => {
      throw new Error("the glasses Wi-Fi is not held in these tests")
    },
    () => {},
    () => {},
    10_000,
    0,
    SoftapCallError,
    SOFTAP_STEPS,
    awaitCleanupBarrier,
    native,
    permissions,
    {LOCAL_WIFI: "wifi"},
    {MEETING_STATE: "meeting_state"},
    {log() {}, warn() {}},
    50,
    50,
  )
  const host = new Host()
  host.meetingCredentialRequests = new Map()
  const events: unknown[] = []
  host.sendToMiniapp = (owner: string, state: unknown) => events.push({owner, state})
  host.softapAttemptSeq = 0
  host.softapCleanupError = null
  host.narrateSoftapPreflight = () => {}
  const old = host.createSoftapAttempt("com.mentra.call")
  old.ownsResources = true
  old.body = Promise.resolve()
  host.softapAttempt = old
  const join = () =>
    host.joinSoftapMeeting("com.mentra.call", {}).then(
      () => "unexpected success",
      (error: Error) => error.message,
    )
  return {
    host,
    old,
    cleanup,
    join,
    nativeLeaves,
    events,
    emitNative: (state: string) => stateHandler?.("com.mentra.call", {state}),
    preflights: () => preflights,
    acsLeaves: () => acsLeaves,
    forcedIngestCloses: () => forcedIngestCloses,
  }
}

describe("SoftAP host attempt lifecycle", () => {
  test("a queued replacement does not receive the previous call's idle event", async () => {
    const f = fixture()
    f.host.ensureMeetingStateBridge()
    const next = f.host.createSoftapAttempt("com.mentra.call")
    f.host.softapAttempt = next
    f.emitNative("idle")
    expect(f.events).toEqual([])
    next.ownsResources = true
    f.emitNative("connecting")
    expect(f.events).toEqual([{owner: "com.mentra.call", state: {type: "meeting_state", state: "connecting"}}])
  })

  test("closing the miniapp retires startup even before native ACS has an owner", async () => {
    const f = fixture()
    const closed = f.host.leaveMeetingForApp("com.mentra.call")
    expect(f.old.cancelled).toBe(true)
    expect(f.nativeLeaves).toEqual([])
    const retry = f.join()
    await tick()
    expect(f.preflights()).toBe(0)
    f.cleanup.resolve()
    await closed
    expect(await retry).toBe("test preflight ended")
    expect(f.preflights()).toBe(1)
  })

  test("closing a different miniapp does not retire the active hotspot owner", async () => {
    const f = fixture()
    await f.host.leaveMeetingForApp("com.mentra.other")
    expect(f.old.cancelled).toBe(false)
    expect(f.acsLeaves()).toBe(0)
    expect(f.nativeLeaves).toEqual(["com.mentra.other"])
  })

  test("a new join waits for an explicitly retiring call", async () => {
    const f = fixture()
    const leave = f.host.retireSoftapAttempt()
    const join = f.join()
    await tick()
    expect(f.preflights()).toBe(0)
    expect(f.acsLeaves()).toBe(1)
    f.cleanup.resolve()
    await leave
    expect(await join).toBe("test preflight ended")
    expect(f.preflights()).toBe(1)
  })

  test("finished teardown still waits for the previous native join body", async () => {
    const f = fixture()
    const body = deferred()
    f.old.body = body.promise
    const leave = f.host.retireSoftapAttempt()
    f.cleanup.resolve()
    await leave
    const join = f.join()
    await tick()
    expect(f.preflights()).toBe(0)
    body.resolve()
    expect(await join).toBe("test preflight ended")
  })

  test("multiple Starts and Cancel while cleanup is pending acquire no resources", async () => {
    const f = fixture()
    const leave = f.host.retireSoftapAttempt()
    const second = f.join()
    const third = f.join()
    await f.host.retireSoftapAttempt()
    await tick()
    expect(f.preflights()).toBe(0)
    expect(f.acsLeaves()).toBe(1)
    f.cleanup.resolve()
    await leave
    expect(await second).toContain("cancelled")
    expect(await third).toContain("cancelled")
    await tick()
    expect(f.preflights()).toBe(0)
    expect(f.acsLeaves()).toBe(1)
    expect(f.host.softapAttempt).toBeNull()
  })

  test("only the latest queued Start proceeds after the previous cleanup", async () => {
    const f = fixture()
    const leave = f.host.retireSoftapAttempt()
    const second = f.join()
    const third = f.join()
    await tick()
    expect(f.preflights()).toBe(0)
    expect(f.acsLeaves()).toBe(1)
    f.cleanup.resolve()
    await leave
    expect(await second).toContain("cancelled")
    expect(await third).toBe("test preflight ended")
    expect(f.preflights()).toBe(1)
    expect(f.acsLeaves()).toBe(2)
  })

  test("a cleanup failure blocks the waiting join before it acquires resources", async () => {
    const f = fixture()
    const leave = f.host.retireSoftapAttempt()
    const join = f.join()
    f.cleanup.reject(new Error("radio did not release"))
    await leave
    expect(await join).toContain("cleanup has not finished yet")
    expect(f.preflights()).toBe(0)
    expect(f.acsLeaves()).toBe(1)
  })

  test("the refusal tells the wearer to retry rather than to power-cycle anything", async () => {
    const f = fixture()
    const leave = f.host.retireSoftapAttempt()
    const join = f.join()
    f.cleanup.reject(new Error("radio did not release"))
    await leave

    const message = await join
    expect(message).toBe("Previous call cleanup has not finished yet. Please try joining again.")
    // The native reason belongs in the trace; it names a leaked port, not a wearer action.
    expect(message).not.toMatch(/power-cycle/i)
    expect(message).not.toContain("radio did not release")
    // Cleared on read, so the very next attempt gets through — which is what makes "try again" true.
    expect(f.host.softapCleanupError).toBeNull()
    expect(await f.join()).toBe("test preflight ended")
  })
})

/**
 * The gate that stop-then-start actually fails on: the WHIP listener still inside its tombstone.
 * It is a bounded wait, and the point of these tests is that an expired bound is never read as
 * "released".
 */
describe("SoftAP teardown barrier", () => {
  test("an ingest port still held is taken by force and re-verified, not assumed free", async () => {
    const f = fixture({ingestClosed: false})
    f.cleanup.resolve()

    await f.host.retireSoftapAttempt()

    expect(f.forcedIngestCloses()).toBe(1)
    // Recovered, so nothing is recorded against the next call.
    expect(f.host.softapCleanupError).toBeNull()
    expect(await f.join()).toBe("test preflight ended")
  })




  test("a transport hotspot undo timeout does not refuse the next call", async () => {
    const f = fixture()
    f.old.transport = {
      activeSteps: () => [],
      lastTeardownFailures: () => ["hotspot"],
      async stop() {},
    }
    f.cleanup.resolve()

    await f.host.retireSoftapAttempt()

    expect(f.host.softapCleanupError).toBeNull()
    expect(await f.join()).toBe("test preflight ended")
  })

  test("a transport undo other than hotspot still refuses the next call", async () => {
    const f = fixture()
    f.old.transport = {
      activeSteps: () => [],
      lastTeardownFailures: () => ["publish"],
      async stop() {},
    }
    f.cleanup.resolve()

    await f.host.retireSoftapAttempt()

    expect(f.host.softapCleanupError).toContain("could not release publish")
    expect(await f.join()).toContain("cleanup has not finished yet")
  })
})

/**
 * The outer fence. Native has its own generations inside a session; this one exists because a
 * callback can arrive after the attempt it belongs to stopped owning the call at all.
 */
describe("SoftAP attempt fencing", () => {
  test("a stage that completes after the attempt was superseded cannot continue", () => {
    const f = fixture()
    const retired = f.host.softapAttempt
    f.host.softapAttempt = f.host.createSoftapAttempt("com.mentra.call")

    expect(() => f.host.checkpointSoftapAttempt(retired, "acs_join")).toThrow(/cancelled/)
  })

  test("a progress snapshot from a retired attempt is dropped instead of drawn", () => {
    const f = fixture()
    const retired = f.host.softapAttempt
    const sent: unknown[] = []
    f.host.sendToMiniapp = (_pkg: string, message: unknown) => sent.push(message)
    retired.cancelled = true

    f.host.emitSoftapProgress(retired, {phase: "hotspot", traceId: "t-1", steps: []})

    expect(sent).toEqual([])
  })
})

/**
 * The OS-permission gate at join. Extracted the same way as the lifecycle methods above, because
 * what is being asserted is the difference between `check` and `request` — and that difference is
 * invisible to any test that stubs the whole method.
 */
function permissionGateFixture(granted: boolean) {
  const start = source.search(/^ {2}private async requireOsPermission\(/m)
  if (start < 0) throw new Error("Missing runtime method requireOsPermission")
  const rest = source.slice(start)
  const end = rest.search(/^ {2}}$/m)
  const body = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${rest.slice(0, end + 3)} }`)
  const requested: string[] = []
  const results: Array<{ok: boolean; error?: {code: string; message: string; permission?: string}}> = []
  const Host = new Function(
    "permissions",
    "softapTraceFailure",
    "MiniappErrorCode",
    "MiniappRequestType",
    `${body}; return Host`,
  )(
    {
      async check() {
        return granted
      },
      async request(feature: string) {
        requested.push(feature)
        return true
      },
    },
    () => {},
    {PERMISSION_DENIED: "PERMISSION_DENIED"},
    {MEETING_JOIN: "meeting:join"},
  )
  const host = new Host()
  host.meetingCredentialRequests = new Map()
  host.sendResult = (
    _pkg: string,
    _id: string,
    ok: boolean,
    _data: unknown,
    error?: {code: string; message: string; permission?: string},
  ) => results.push({ok, error})
  return {host, requested, results}
}

describe("SoftAP join permission gate", () => {
  test("a denied camera refuses the join and never opens a prompt", async () => {
    const f = permissionGateFixture(false)

    const allowed = await f.host.requireOsPermission("com.mentra.call", "req-1", "camera", "camera")

    expect(allowed).toBe(false)
    // The prompt belongs at miniapp-open time. One here would sit on top of a join that is
    // already building a hotspot, and a wearer who denies it gets a half-existing call.
    expect(f.requested).toEqual([])
    expect(f.results[0]?.ok).toBe(false)
    expect(f.results[0]?.error?.code).toBe("PERMISSION_DENIED")
    expect(f.results[0]?.error?.permission).toBe("camera")
    expect(f.results[0]?.error?.message).toMatch(/Settings/)
  })

  test("a granted permission passes without sending a result", async () => {
    const f = permissionGateFixture(true)

    expect(await f.host.requireOsPermission("com.mentra.call", "req-1", "camera", "camera")).toBe(true)
    expect(f.results).toEqual([])
  })
})
