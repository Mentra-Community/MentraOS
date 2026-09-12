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
  "joinSoftapMeeting",
  "createSoftapAttempt",
  "checkpointSoftapAttempt",
  "runSoftapAttempt",
  "retireSoftapAttempt",
  "teardownSoftapAttempt",
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

function fixture() {
  const cleanup = deferred()
  let nativeReleases = 0
  let preflights = 0
  const native = {
    beginScopedTeardown() {},
    async leaveScopedNetwork() {
      nativeReleases++
      if (nativeReleases === 1) await cleanup.promise
    },
    async awaitValidatedDefaultNetwork() {
      return {usable: true, detail: "cellular"}
    },
    async leaveAndAwait() {
      return {completed: true}
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
    "console",
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
    {log() {}, warn() {}},
  )
  const host = new Host()
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
  return {host, old, cleanup, join, preflights: () => preflights, nativeReleases: () => nativeReleases}
}

describe("SoftAP host attempt lifecycle", () => {
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
    expect(await join).toContain("Previous call cleanup failed")
    expect(f.preflights()).toBe(0)
    expect(f.nativeReleases()).toBe(1)
  })
})
