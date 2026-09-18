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
  "setGlassesHotspotState",
  "settleSoftapTeardown",
  "forceSoftapCleanup",
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

/**
 * The real retry codes, read from the source rather than retyped here.
 *
 * Retyping them would let a rename on the production side leave this suite green while the
 * retry it is supposed to cover never fires.
 */
const REFRESH_CODES: Set<string> = (() => {
  const match = source.match(/const HOTSPOT_SESSION_REFRESH_CODES = new Set\(\[([^\]]*)]\)/)
  if (!match) throw new Error("Missing HOTSPOT_SESSION_REFRESH_CODES")
  const codes = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
  if (codes.length === 0) throw new Error("HOTSPOT_SESSION_REFRESH_CODES is empty")
  return new Set(codes)
})()

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

/** The module-private helper the extracted methods call; same shape, kept trivial on purpose. */
function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Same extraction as the lifecycle methods: the settle/force gates are pulled from the source so
 * the teardown these tests drive is the one that ships, including the two waits (ingest close and
 * hotspot ack) that a fake host would otherwise silently skip.
 */
type HotspotGate = "disabled" | "enabled" | "throw"

/** One scripted outcome per native hotspot command, for the session-refresh retry tests. */
type HotspotScript = Array<HotspotGate | {code: string}>

type Gates = {ingestClosed?: boolean; hotspot?: HotspotGate; hotspotScript?: HotspotScript}

function fixture(gates: Gates = {}): ReturnType<typeof buildFixture> {
  return buildFixture(gates)
}

function buildFixture(gates: Gates) {
  const cleanup = deferred()
  let nativeReleases = 0
  let preflights = 0
  const nativeLeaves: string[] = []
  let stateHandler: ((owner: string, state: {state: string}) => void) | undefined
  let forcedIngestCloses = 0
  const hotspotCommands: boolean[] = []
  const native = {
    setStateHandler(handler: typeof stateHandler) {
      stateHandler = handler
    },
    beginScopedTeardown() {},
    async leaveScopedNetwork() {
      nativeReleases++
      if (nativeReleases === 1) await cleanup.promise
    },
    async awaitDefaultNetworkAfterHotspot() {
      return {usable: true, detail: "cellular"}
    },
    async leaveIfOwner(packageName: string) {
      nativeLeaves.push(packageName)
    },
    async leaveAndAwait() {
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
  const bluetooth = {
    async setHotspotState(enabled: boolean) {
      hotspotCommands.push(enabled)
      // `hotspotScript` steps once per native command, so a test can say "the first send is
      // cancelled by a session refresh, the second succeeds" and count the sends.
      const step = gates.hotspotScript?.[hotspotCommands.length - 1]
      const outcome = step ?? gates.hotspot
      if (outcome && typeof outcome === "object") {
        // Shaped like an Expo CodedException reaching JS: the code is what we branch on.
        throw Object.assign(new Error("The glasses WiFi protocol session changed."), {code: outcome.code})
      }
      if (outcome === "throw") throw new Error("glasses did not answer")
      return {state: outcome === "enabled" ? "enabled" : "disabled"}
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
    "acquireGlassesHotspot",
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
    "BluetoothSdk",
    "withTimeout",
    "SOFTAP_INGEST_CLOSE_WAIT_MS",
    "SOFTAP_HOTSPOT_OFF_ACK_MS",
    "SOFTAP_FORCED_VERIFY_MS",
    "HOTSPOT_SESSION_REFRESH_CODES",
    "HOTSPOT_SESSION_RETRY_DELAY_MS",
    `${compiled}; return Host`,
  )(
    () => () => {},
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
    bluetooth,
    withTimeout,
    50,
    50,
    50,
    REFRESH_CODES,
    5,
  )
  const host = new Host()
  const events: unknown[] = []
  host.sendToMiniapp = (owner: string, state: unknown) => events.push({owner, state})
  host.softapAttemptSeq = 0
  host.softapCleanupError = null
  host.glassesHotspotCommand = Promise.resolve()
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
    nativeReleases: () => nativeReleases,
    forcedIngestCloses: () => forcedIngestCloses,
    hotspotCommands: () => hotspotCommands,
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
    expect(f.nativeReleases()).toBe(0)
    expect(f.nativeLeaves).toEqual(["com.mentra.other"])
  })

  test("a new join waits for an explicitly retiring call", async () => {
    const f = fixture()
    const leave = f.host.retireSoftapAttempt()
    const join = f.join()
    await tick()
    expect(f.preflights()).toBe(0)
    expect(f.nativeReleases()).toBe(1)
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
    expect(f.nativeReleases()).toBe(1)
    f.cleanup.resolve()
    await leave
    expect(await second).toContain("cancelled")
    expect(await third).toContain("cancelled")
    await tick()
    expect(f.preflights()).toBe(0)
    expect(f.nativeReleases()).toBe(1)
    expect(f.host.softapAttempt).toBeNull()
  })

  test("only the latest queued Start proceeds after the previous cleanup", async () => {
    const f = fixture()
    const leave = f.host.retireSoftapAttempt()
    const second = f.join()
    const third = f.join()
    await tick()
    expect(f.preflights()).toBe(0)
    expect(f.nativeReleases()).toBe(1)
    f.cleanup.resolve()
    await leave
    expect(await second).toContain("cancelled")
    expect(await third).toBe("test preflight ended")
    expect(f.preflights()).toBe(1)
    expect(f.nativeReleases()).toBe(2)
  })

  test("a cleanup failure blocks the waiting join before it acquires resources", async () => {
    const f = fixture()
    const leave = f.host.retireSoftapAttempt()
    const join = f.join()
    f.cleanup.reject(new Error("radio did not release"))
    await leave
    expect(await join).toContain("cleanup has not finished yet")
    expect(f.preflights()).toBe(0)
    expect(f.nativeReleases()).toBe(1)
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
 * The two gates that stop-then-start actually fails on: the WHIP listener still inside its
 * tombstone, and a glasses hotspot that is still up. Both are bounded waits, and the point of
 * these tests is that an expired bound is never read as "released".
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

  test("glasses that never acknowledge hotspot off do not refuse the next call", async () => {
    const f = fixture({hotspot: "throw"})
    f.cleanup.resolve()

    await f.host.retireSoftapAttempt()

    // Once in the settle gate, once more in forced cleanup — leftover ON is the next
    // join's starting state, not a power-cycle dead end.
    expect(f.hotspotCommands()).toEqual([false, false])
    expect(f.host.softapCleanupError).toBeNull()
    expect(await f.join()).toBe("test preflight ended")
  })

  test("overlapping hotspot disables wait their turn instead of failing cleanup", async () => {
    const f = fixture()

    await Promise.all([f.host.setGlassesHotspotState(false), f.host.setGlassesHotspotState(false)])

    expect(f.hotspotCommands()).toEqual([false, false])
    expect(f.host.softapCleanupError).toBeNull()
  })

  test("a hotspot that answers 'enabled' after disable does not refuse the next call", async () => {
    const f = fixture({hotspot: "enabled"})
    f.cleanup.resolve()

    await f.host.retireSoftapAttempt()

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
 * The glasses re-announce their Wi-Fi session on every `glasses_ready`, which cancels whatever
 * hotspot command was in flight. That is what refused a join outright at 13:58:32 with a
 * power-cycle instruction, so these cover both that the retry happens and that it cannot be
 * used as a wedge for a later command to change the hotspot underneath it.
 */
describe("hotspot command across a Wi-Fi protocol session refresh", () => {
  for (const code of REFRESH_CODES) {
    test(`a command cancelled by ${code} is re-sent and succeeds`, async () => {
      const f = fixture({hotspotScript: [{code}, "disabled"]})

      const status = await f.host.setGlassesHotspotState(false)

      expect(status).toEqual({state: "disabled"})
      expect(f.hotspotCommands()).toEqual([false, false])
    })
  }

  test("glasses that went away are not re-sent to", async () => {
    const f = fixture({hotspotScript: [{code: "wifi_session_disconnected"}]})

    await expect(f.host.setGlassesHotspotState(false)).rejects.toThrow(/session changed/)
    expect(f.hotspotCommands()).toEqual([false])
  })

  test("a generic failure is not re-sent", async () => {
    const f = fixture({hotspot: "throw"})

    await expect(f.host.setGlassesHotspotState(false)).rejects.toThrow("glasses did not answer")
    expect(f.hotspotCommands()).toEqual([false])
  })

  test("a second attempt that also fails propagates, without a third", async () => {
    const f = fixture({hotspotScript: [{code: "wifi_session_restarted"}, "throw"]})

    await expect(f.host.setGlassesHotspotState(false)).rejects.toThrow("glasses did not answer")
    expect(f.hotspotCommands()).toEqual([false, false])
  })

  test("a refresh on the retry itself is not retried again", async () => {
    const f = fixture({
      hotspotScript: [{code: "wifi_session_restarted"}, {code: "wifi_session_restarted"}],
    })

    await expect(f.host.setGlassesHotspotState(false)).rejects.toThrow(/session changed/)
    expect(f.hotspotCommands()).toEqual([false, false])
  })

  /**
   * The invariant: one logical hotspot operation issues at most two native commands, and no
   * later operation runs between them. A retry outside the queue would let this `on` land
   * between the two halves of the `off` and leave the glasses in the opposite state.
   */
  test("a later command cannot execute between the two halves of a retried one", async () => {
    const f = fixture({hotspotScript: [{code: "wifi_session_restarted"}, "disabled", "enabled"]})

    const off = f.host.setGlassesHotspotState(false)
    const on = f.host.setGlassesHotspotState(true)
    await Promise.all([off, on])

    expect(f.hotspotCommands()).toEqual([false, false, true])
    expect(f.hotspotCommands()).not.toEqual([false, true, false])
  })

  test("a queued command still runs after the one before it exhausts its retry", async () => {
    const f = fixture({hotspotScript: [{code: "wifi_session_changed"}, "throw", "enabled"]})

    const off = f.host.setGlassesHotspotState(false)
    const on = f.host.setGlassesHotspotState(true)

    await expect(off).rejects.toThrow("glasses did not answer")
    expect(await on).toEqual({state: "enabled"})
    expect(f.hotspotCommands()).toEqual([false, false, true])
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
