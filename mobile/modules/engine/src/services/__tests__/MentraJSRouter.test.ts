/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, test, jest} from "bun:test"

import type localMiniappRuntime from "../LocalMiniappRuntime"
import {MentraJSRouter, type MentraJSCrustBinding} from "../MentraJSRouter"
import {MentraUIRouter} from "../MentraUIRouter"

type LocalMiniappRuntime = typeof localMiniappRuntime

interface CrustListener {
  (payload: Record<string, unknown>): void
}

function buildMockCrust(): {
  binding: MentraJSCrustBinding
  emit: (event: string, payload: Record<string, unknown>) => void
  spawnCalls: Array<{packageName: string; polyfill: string; miniappJs: string}>
  killCalls: string[]
  dispatchCalls: Array<{packageName: string; envelope: Record<string, unknown>}>
  setManifestCalls: Array<{packageName: string; permissions: string[]}>
} {
  const listeners = new Map<string, Set<CrustListener>>()
  const spawnCalls: Array<{packageName: string; polyfill: string; miniappJs: string}> = []
  const killCalls: string[] = []
  const dispatchCalls: Array<{packageName: string; envelope: Record<string, unknown>}> = []
  const setManifestCalls: Array<{packageName: string; permissions: string[]}> = []

  const binding: MentraJSCrustBinding = {
    mentraJsSpawn(packageName, polyfill, miniappJs) {
      spawnCalls.push({packageName, polyfill, miniappJs})
      return true
    },
    mentraJsKill(packageName) {
      killCalls.push(packageName)
    },
    mentraJsDispatchToJs(packageName, envelope) {
      dispatchCalls.push({packageName, envelope})
    },
    mentraJsSetManifest(packageName, permissions) {
      setManifestCalls.push({packageName, permissions})
    },
    mentraJsLoadPolyfillBundle() {
      return "/* polyfill */"
    },
    mentraJsAlivePackages() {
      return []
    },
    addListener(event, handler) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(handler)
      return {
        remove() {
          set!.delete(handler)
        },
      } as unknown as ReturnType<MentraJSCrustBinding["addListener"]>
    },
  }
  return {
    binding,
    emit(event, payload) {
      const set = listeners.get(event)
      if (!set) return
      for (const l of set) l(payload)
    },
    spawnCalls,
    killCalls,
    dispatchCalls,
    setManifestCalls,
  }
}

function buildMockRuntime() {
  const registerCalls: Array<{
    packageName: string
    sendFn: (raw: string) => void
    installedManifest?: unknown
  }> = []
  const handleRawCalls: Array<{packageName: string; raw: string}> = []
  const unregisterCalls: string[] = []
  const probeCalls: Array<{packageName: string; reason?: string; timeoutMs?: number}> = []
  const setManifestCalls: Array<{packageName: string; installedManifest: unknown}> = []
  const resetHandshakeCalls: string[] = []
  const runtime = {
    registerApp(packageName: string, sendFn: (raw: string) => void, installedManifest?: unknown) {
      registerCalls.push({packageName, sendFn, installedManifest})
    },
    handleRawMessage(packageName: string, raw: string) {
      handleRawCalls.push({packageName, raw})
    },
    unregisterApp(packageName: string) {
      unregisterCalls.push(packageName)
    },
    probeForegroundLiveness(packageName: string, reason?: string, timeoutMs?: number) {
      probeCalls.push({packageName, reason, timeoutMs})
    },
    setInstalledManifest(packageName: string, installedManifest: unknown) {
      setManifestCalls.push({packageName, installedManifest})
    },
    resetHandshake(packageName: string) {
      resetHandshakeCalls.push(packageName)
    },
  } as unknown as LocalMiniappRuntime
  return {runtime, registerCalls, handleRawCalls, unregisterCalls, probeCalls, setManifestCalls, resetHandshakeCalls}
}

function silentLogger() {
  return {log: jest.fn(), warn: jest.fn(), error: jest.fn()}
}

describe("MentraJSRouter", () => {
  let crust: ReturnType<typeof buildMockCrust>
  let runtimeMock: ReturnType<typeof buildMockRuntime>
  let logger: ReturnType<typeof silentLogger>
  let router: MentraJSRouter

  beforeEach(() => {
    crust = buildMockCrust()
    runtimeMock = buildMockRuntime()
    logger = silentLogger()
    router = new MentraJSRouter(runtimeMock.runtime, crust.binding, logger)
  })

  afterEach(() => {
    router.stop()
  })

  test("start() attaches a single mentrajs_message listener", () => {
    router.start()
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__log",
      method: "log",
      argsJson: '["hi"]',
    })
    expect(logger.log).toHaveBeenCalledTimes(1)
  })

  test("__bridge.send (args[] form) routes raw envelope into handleRawMessage", () => {
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__bridge",
      method: "send",
      args: ['{"type":"DISPLAY","text":"hi"}'],
    })
    expect(runtimeMock.handleRawCalls).toEqual([{packageName: "com.foo", raw: '{"type":"DISPLAY","text":"hi"}'}])
  })

  test("__bridge.send (argsJson string form) routes raw envelope into handleRawMessage", () => {
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.bar",
      iface: "__bridge",
      method: "send",
      argsJson: JSON.stringify(['{"type":"SUBSCRIBE","streams":["mic_pcm"]}']),
    })
    expect(runtimeMock.handleRawCalls).toEqual([
      {packageName: "com.bar", raw: '{"type":"SUBSCRIBE","streams":["mic_pcm"]}'},
    ])
  })

  test("__bridge.send with missing payload logs warning and does NOT call handleRawMessage", () => {
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__bridge",
      method: "send",
      argsJson: "[]",
    })
    expect(runtimeMock.handleRawCalls).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalled()
  })

  test("__log frame routes through console.* on the host", () => {
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__log",
      method: "warn",
      argsJson: '["watch out", 42]',
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]![0]).toContain("com.foo")
  })

  test("__log frame redacts secret-looking values + appends to ring buffer", () => {
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__log",
      method: "log",
      argsJson: JSON.stringify([{apiKey: "secret123", name: "alex"}]),
    })
    expect(logger.log).toHaveBeenCalledTimes(1)
    // Second arg is the redacted args list.
    const args = logger.log.mock.calls[0]![1] as Array<{apiKey: string; name: string}>
    expect(args[0]!.apiKey).toBe("[REDACTED]")
    expect(args[0]!.name).toBe("alex")
    // Ring buffer should have a stringified entry.
    const ring = router.logRing.snapshot("com.foo")
    expect(ring).toHaveLength(1)
    expect(ring[0]).toContain("[REDACTED]")
  })

  test("__log frames over the throttle threshold drop silently + emit a [throttled N] summary", () => {
    // Override throttle to a tighter budget for the test.
    const {MentraJSLogThrottle} = require("../MentraJSLogPipeline")
    let clock = 0
    router.logThrottle = new MentraJSLogThrottle({
      tokensPerSecond: 10,
      bucketCapacity: 3,
      now: () => clock,
    })
    router.start()
    for (let i = 0; i < 5; i++) {
      crust.emit("mentrajs_message", {
        packageName: "com.foo",
        iface: "__log",
        method: "log",
        argsJson: JSON.stringify([`line ${i}`]),
      })
    }
    // First 3 are allowed; #4 and #5 are silent drops.
    expect(logger.log).toHaveBeenCalledTimes(3)
    // Advance the clock so the bucket refills, then a 6th call shows
    // the "[throttled 2]" summary.
    clock += 1_000
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__log",
      method: "log",
      argsJson: JSON.stringify(["line 6"]),
    })
    // The 4th `logger.log` call carries the synthetic throttled line.
    const tag = logger.log.mock.calls[3]![0] as string
    expect(tag).toContain("[throttled 2]")
  })

  test("__error frame logs at error level", () => {
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__error",
      method: "unhandledRejection",
      argsJson: '{"reason":"boom"}',
    })
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  test("ready_nack is a warn, not an error — the context is busy, not dead", () => {
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.mentra.call",
      iface: "__error",
      method: "ready_nack",
      argsJson: '{"phase":"steady-state","timeoutMs":3000}',
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]![0]).toContain("ready_nack")
    expect(logger.error).not.toHaveBeenCalled()
  })

  test("unknown iface logs a debug line but does NOT crash", () => {
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "weird",
      method: "thing",
      argsJson: "[]",
    })
    expect(logger.log).toHaveBeenCalled()
    expect(runtimeMock.handleRawCalls).toHaveLength(0)
  })

  test("malformed event missing packageName/iface logs a warning", () => {
    router.start()
    crust.emit("mentrajs_message", {iface: "x", method: "y"})
    expect(logger.warn).toHaveBeenCalled()
  })

  test("stop() detaches the listener and subsequent events are ignored", () => {
    router.start()
    router.stop()
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__bridge",
      method: "send",
      args: ['{"type":"PING"}'],
    })
    expect(runtimeMock.handleRawCalls).toHaveLength(0)
  })

  test("registerApp() registers a sendMessage that calls mentraJsDispatchToJs with kind=bridge", () => {
    router.registerApp("com.foo")
    expect(runtimeMock.registerCalls).toHaveLength(1)
    expect(runtimeMock.registerCalls[0]!.packageName).toBe("com.foo")
    runtimeMock.registerCalls[0]!.sendFn('{"type":"DISPLAY","text":"hi"}')
    expect(crust.dispatchCalls).toEqual([
      {packageName: "com.foo", envelope: {kind: "bridge", raw: '{"type":"DISPLAY","text":"hi"}'}},
    ])
  })

  test("PING delivery gets correlated metadata without recording the raw payload", () => {
    router.registerApp("com.foo")
    const raw = JSON.stringify({payload: {type: "miniapp_ping", token: "private-value"}})
    runtimeMock.registerCalls[0]!.sendFn(raw)
    expect(crust.dispatchCalls[0]!.envelope).toEqual({kind: "bridge", raw, deliveryId: 1})
    expect(logger.log.mock.calls).toContainEqual(["PING submitted for com.foo", {deliveryId: 1}])
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain("private-value")
  })

  test("native delivery rejection is caught and preserves safe error identity", async () => {
    router.registerApp("com.foo")
    crust.binding.mentraJsDispatchToJs = () => Promise.reject(new TypeError("token=private-value"))
    runtimeMock.registerCalls[0]!.sendFn(JSON.stringify({payload: {type: "miniapp_ping"}}))
    await Promise.resolve()
    expect(logger.warn.mock.calls).toContainEqual([
      "Native delivery rejected for com.foo",
      {deliveryId: 1, errorClass: "TypeError"},
    ])
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private-value")
  })

  test("native delivery diagnostics use the existing host and crash-report log path", () => {
    router.start()
    const metadata = {event: "native-ping-delivery", deliveryId: 5, phase: "evaluate-failed", errorClass: "IOException"}
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__log",
      method: "warn",
      argsJson: JSON.stringify([metadata]),
    })
    expect(logger.warn.mock.calls).toContainEqual(["[com.foo] console.warn", [metadata]])
    expect(router.logRing.snapshot("com.foo")[0]).toContain("evaluate-failed")
    expect(router.logRing.snapshot("com.foo")[0]).toContain("IOException")
  })

  test("spawnAndRegister spawns + sets manifest + registers + dispatches init", async () => {
    const installedManifest = {
      permissions: [{type: "MICROPHONE", description: "transcription"}],
      hardwareRequirements: [{type: "DISPLAY", level: "REQUIRED"}],
    }
    const ok = await router.spawnAndRegister("com.foo", "console.log(1)", {
      permissions: ["MICROPHONE"],
      installedManifest,
    })
    expect(ok).toBe(true)
    expect(crust.spawnCalls).toEqual([
      {packageName: "com.foo", polyfill: "/* polyfill */", miniappJs: "console.log(1)"},
    ])
    expect(crust.setManifestCalls).toEqual([{packageName: "com.foo", permissions: ["MICROPHONE"]}])
    expect(runtimeMock.registerCalls).toHaveLength(1)
    // installedManifest threads through to LocalMiniappRuntime so the
    // SUBSCRIBE gate matches stream→permission against declared types.
    expect(runtimeMock.registerCalls[0]!.installedManifest).toEqual(installedManifest)
    // The init envelope is what fires registerMiniapp's handler inside
    // the JSContext. Without it, the user's code never runs.
    const initCalls = crust.dispatchCalls.filter((c) => c.envelope.kind === "init")
    expect(initCalls).toHaveLength(1)
    expect(initCalls[0]!.packageName).toBe("com.foo")
    expect(typeof initCalls[0]!.envelope.sessionId).toBe("string")
  })

  test("spawnAndRegister works without installedManifest (back-compat)", async () => {
    const ok = await router.spawnAndRegister("com.foo", "console.log(1)")
    expect(ok).toBe(true)
    expect(runtimeMock.registerCalls).toHaveLength(1)
    expect(runtimeMock.registerCalls[0]!.installedManifest).toBeUndefined()
  })

  test("probeForegroundLiveness only probes registered packages", async () => {
    router.probeForegroundLiveness("com.foo", "before-register")
    expect(runtimeMock.probeCalls).toHaveLength(0)

    await router.spawnAndRegister("com.foo", "console.log(1)")
    router.probeForegroundLiveness("com.foo", "foreground-open")

    expect(runtimeMock.probeCalls).toEqual([{packageName: "com.foo", reason: "foreground-open", timeoutMs: undefined}])

    router.probeForegroundLiveness("com.foo", "app-active", 12_000)
    expect(runtimeMock.probeCalls[1]).toEqual({packageName: "com.foo", reason: "app-active", timeoutMs: 12_000})
  })

  test("spawnAndRegister returns false when native spawn fails", async () => {
    crust.binding.mentraJsSpawn = () => false
    const ok = await router.spawnAndRegister("com.bad", "junk")
    expect(ok).toBe(false)
    expect(runtimeMock.registerCalls).toHaveLength(0)
  })

  test("unregister calls runtime.unregisterApp + mentraJsKill", async () => {
    router.registerApp("com.foo")
    await router.unregister("com.foo")
    expect(runtimeMock.unregisterCalls).toEqual(["com.foo"])
    expect(crust.killCalls).toEqual(["com.foo"])
  })

  test("registeredPackages tracks registered packages", () => {
    router.registerApp("a")
    router.registerApp("b")
    expect(router.registeredPackages().sort()).toEqual(["a", "b"])
  })

  test("crash controller receives __error frames and schedules respawn", async () => {
    const {MentraJSCrashController} = await import("../MentraJSCrashController")
    let clock = 0
    const controller = new MentraJSCrashController({
      now: () => clock,
      backoffMs: [2_000],
      maxRetries: 3,
    })
    router.crashController = controller
    await router.spawnAndRegister("com.foo", "/* miniapp js */", {permissions: ["MICROPHONE"]})
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__error",
      method: "exception",
      argsJson: JSON.stringify({message: "boom"}),
    })
    expect(controller.stateFor("com.foo")?.kind).toBe("BACKOFF")
  })

  test("crashloop transitions invoke onCrashloop hook", async () => {
    const {MentraJSCrashController} = await import("../MentraJSCrashController")
    let clock = 0
    const controller = new MentraJSCrashController({
      now: () => clock,
      backoffMs: [10],
      maxRetries: 3,
    })
    router.crashController = controller
    const crashloops: Array<{packageName: string; reason: string}> = []
    router.onCrashloop = (p, r) => crashloops.push({packageName: p, reason: r})
    await router.spawnAndRegister("com.foo", "/* miniapp js */")
    router.start()
    for (let i = 0; i < 4; i++) {
      crust.emit("mentrajs_message", {
        packageName: "com.foo",
        iface: "__error",
        method: "exception",
        argsJson: JSON.stringify({message: `boom-${i}`}),
      })
      clock += 100
    }
    expect(controller.stateFor("com.foo")?.kind).toBe("CRASHLOOP_DISABLED")
    expect(crashloops).toHaveLength(1)
    expect(crashloops[0]!.packageName).toBe("com.foo")
  })

  test("unregister cancels a pending crash-respawn timer", async () => {
    const {MentraJSCrashController} = await import("../MentraJSCrashController")
    const controller = new MentraJSCrashController({
      now: () => 0,
      backoffMs: [60_000], // long backoff so the timer would still be pending
      maxRetries: 3,
    })
    router.crashController = controller
    await router.spawnAndRegister("com.foo", "/* miniapp js */")
    router.start()
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__error",
      method: "exception",
      argsJson: JSON.stringify({message: "boom"}),
    })
    crust.spawnCalls.length = 0
    await router.unregister("com.foo")
    // Give the timer a chance to fire (it shouldn't, because we cancelled it).
    await new Promise((r) => setTimeout(r, 20))
    expect(crust.spawnCalls).toHaveLength(0)
  })

  test("liveness timeout respawn re-registers the runtime app", async () => {
    const {MentraJSCrashController} = await import("../MentraJSCrashController")
    const controller = new MentraJSCrashController({
      now: () => 0,
      backoffMs: [1],
      maxRetries: 3,
    })
    router.crashController = controller
    router.start()

    const manifest = {permissions: [{type: "MICROPHONE"}]}
    await router.spawnAndRegister("com.foo", "/* miniapp js */", {
      permissions: ["MICROPHONE"],
      installedManifest: manifest,
    })
    ;(runtimeMock.runtime as unknown as {onLivenessTimeout: (packageName: string) => void}).onLivenessTimeout("com.foo")
    await new Promise((r) => setTimeout(r, 20))

    expect(crust.killCalls).toEqual(["com.foo"])
    expect(crust.spawnCalls).toHaveLength(2)
    expect(runtimeMock.registerCalls.map((c) => c.packageName)).toEqual(["com.foo", "com.foo"])
    expect(runtimeMock.registerCalls[1]!.installedManifest).toBe(manifest)
    expect(crust.dispatchCalls.at(-1)).toMatchObject({
      packageName: "com.foo",
      envelope: {kind: "init"},
    })
  })

  test("recovery reopens mounted UI once the replacement connects, not at init", async () => {
    const {MentraJSCrashController} = await import("../MentraJSCrashController")
    router.crashController = new MentraJSCrashController({backoffMs: [1], maxRetries: 3})
    router.uiRouter = new MentraUIRouter(crust.binding)
    router.uiRouter.bindWebView("com.foo", () => {})
    router.start()
    await router.spawnAndRegister("com.foo", "/* miniapp */")
    crust.dispatchCalls.length = 0
    ;(runtimeMock.runtime as unknown as {onLivenessTimeout: (p: string) => void}).onLivenessTimeout("com.foo")
    await new Promise((resolve) => setTimeout(resolve, 20))
    // UI_OPEN before the fresh SDK session exists would be dropped.
    expect(crust.dispatchCalls.map((call) => call.envelope.kind)).toEqual(["init"])
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__bridge",
      method: "send",
      args: [JSON.stringify({payload: {type: "miniapp_connect", packageName: "com.foo"}})],
    })
    const reopen = crust.dispatchCalls.filter((call) => call.envelope.kind === "bridge")
    expect(reopen).toHaveLength(1)
    expect(JSON.parse(reopen[0]!.envelope.raw as string)).toMatchObject({
      payload: {streamType: "_ui", data: {type: "UI_OPEN"}},
    })
  })

  test("recovery does not announce an unmounted UI", async () => {
    const {MentraJSCrashController} = await import("../MentraJSCrashController")
    router.crashController = new MentraJSCrashController({backoffMs: [1], maxRetries: 3})
    router.uiRouter = new MentraUIRouter(crust.binding)
    router.start()
    await router.spawnAndRegister("com.foo", "/* miniapp */")
    crust.dispatchCalls.length = 0
    ;(runtimeMock.runtime as unknown as {onLivenessTimeout: (p: string) => void}).onLivenessTimeout("com.foo")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(crust.dispatchCalls.map((call) => call.envelope.kind)).toEqual(["init"])
  })

  test("listener throwing does not poison subsequent events", () => {
    router.start()
    // Send a bad event that makes our handler throw, then a good one.
    const badRuntime = runtimeMock.runtime as unknown as {handleRawMessage: (p: string, r: string) => void}
    let firstCall = true
    badRuntime.handleRawMessage = () => {
      if (firstCall) {
        firstCall = false
        throw new Error("boom")
      }
    }
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__bridge",
      method: "send",
      args: ["raw1"],
    })
    crust.emit("mentrajs_message", {
      packageName: "com.foo",
      iface: "__bridge",
      method: "send",
      args: ["raw2"],
    })
    expect(logger.error).toHaveBeenCalled()
    // Second event still routed despite the first throwing.
    // (badRuntime no-ops on second call so we just verify the router did not detach.)
  })
})
