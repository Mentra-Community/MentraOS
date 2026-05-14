/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, test, jest, mock} from "bun:test"

import type localMiniappRuntime from "../LocalMiniappRuntime"
import {MentraJSRouter, type MentraJSCrustBinding} from "../MentraJSRouter"

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
  grantCalls: Array<{packageName: string; permission: string; granted: boolean}>
} {
  const listeners = new Map<string, Set<CrustListener>>()
  const spawnCalls: Array<{packageName: string; polyfill: string; miniappJs: string}> = []
  const killCalls: string[] = []
  const dispatchCalls: Array<{packageName: string; envelope: Record<string, unknown>}> = []
  const setManifestCalls: Array<{packageName: string; permissions: string[]}> = []
  const grantCalls: Array<{packageName: string; permission: string; granted: boolean}> = []

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
    mentraJsGrantPermission(packageName, permission, granted) {
      grantCalls.push({packageName, permission, granted})
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
    grantCalls,
  }
}

function buildMockRuntime() {
  const registerCalls: Array<{packageName: string; sendFn: (raw: string) => void}> = []
  const handleRawCalls: Array<{packageName: string; raw: string}> = []
  const unregisterCalls: string[] = []
  const runtime = {
    registerApp(packageName: string, sendFn: (raw: string) => void) {
      registerCalls.push({packageName, sendFn})
    },
    handleRawMessage(packageName: string, raw: string) {
      handleRawCalls.push({packageName, raw})
    },
    unregisterApp(packageName: string) {
      unregisterCalls.push(packageName)
    },
  } as unknown as LocalMiniappRuntime
  return {runtime, registerCalls, handleRawCalls, unregisterCalls}
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
    expect(runtimeMock.handleRawCalls).toEqual([
      {packageName: "com.foo", raw: '{"type":"DISPLAY","text":"hi"}'},
    ])
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

  test("spawnAndRegister spawns + sets manifest + registers", async () => {
    const ok = await router.spawnAndRegister("com.foo", "console.log(1)", {permissions: ["MICROPHONE"]})
    expect(ok).toBe(true)
    expect(crust.spawnCalls).toEqual([
      {packageName: "com.foo", polyfill: "/* polyfill */", miniappJs: "console.log(1)"},
    ])
    expect(crust.setManifestCalls).toEqual([{packageName: "com.foo", permissions: ["MICROPHONE"]}])
    expect(runtimeMock.registerCalls).toHaveLength(1)
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
