/// <reference types="bun-types" />

import {readFileSync} from "node:fs"
import {join} from "node:path"
import {describe, expect, test} from "bun:test"
import vm from "node:vm"

/**
 * Snapshot + behaviour tests for the built `dist/startup.js` bundle.
 *
 * We can't run inside the real JSC / QuickJS engines from CI without a
 * device, but Node's `vm` module gives us a similar bare ECMAScript
 * sandbox (no DOM, no Node globals unless explicitly added). That lets
 * us validate:
 *   - the bundle parses + executes without throwing
 *   - the side-effecting installs (console, timers, fetch, localStorage,
 *     crypto, TextEncoder, atob/btoa, __deliver) all land on globalThis
 *   - send-request / event listener helpers wire up correctly
 *
 * Engine-level Promise reaction ordering differs slightly between V8
 * (Node) and JSC, but the visible API surface is identical for the
 * paths we exercise here.
 */

const BUNDLE_PATH = join(__dirname, "..", "dist", "startup.js")
const BUNDLE = readFileSync(BUNDLE_PATH, "utf8")

interface BridgeStubs {
  dispatchCalls: Array<{iface: string; method: string; argsJson: string}>
  /** Map of (iface,method) → handler returning a JSON string the polyfill JSON.parses. */
  dispatchHandlers: Map<string, (args: unknown[], reqId?: string) => string | null>
  hostLogCalls: Array<{level: string; messageJson: string}>
  hostErrorCalls: string[]
  hostUnhandledRejectionCalls: string[]
  /** token → {callback, ms}. setInterval re-arms the timer in __deliverTimer. */
  timers: Map<number, {fn: () => void; ms: number}>
}

function buildSandbox(stubs: BridgeStubs) {
  const sandbox: Record<string, unknown> = {}
  sandbox.globalThis = sandbox
  sandbox.Promise = Promise
  sandbox.Map = Map
  sandbox.Set = Set
  sandbox.WeakSet = WeakSet
  sandbox.WeakMap = WeakMap
  sandbox.Object = Object
  sandbox.Array = Array
  sandbox.Number = Number
  sandbox.String = String
  sandbox.Boolean = Boolean
  sandbox.JSON = JSON
  sandbox.Math = Math
  sandbox.Error = Error
  sandbox.Date = Date
  sandbox.ArrayBuffer = ArrayBuffer
  sandbox.Uint8Array = Uint8Array
  sandbox.DataView = DataView
  sandbox.parseInt = parseInt
  sandbox.parseFloat = parseFloat
  sandbox.isNaN = isNaN
  sandbox.isFinite = isFinite
  sandbox.undefined = undefined
  sandbox.NaN = NaN
  sandbox.Infinity = Infinity

  sandbox.__dispatch = (iface: string, method: string, argsJson: string) => {
    stubs.dispatchCalls.push({iface, method, argsJson})
    const key = `${iface}.${method}`
    const handler = stubs.dispatchHandlers.get(key)
    if (!handler) return null
    // The polyfill encodes a request as `{args, reqId}` and a one-shot as
    // a bare `[args]` array. Decode both shapes.
    let args: unknown[] = []
    let reqId: string | undefined
    if (argsJson.startsWith("{")) {
      const parsed = JSON.parse(argsJson)
      args = parsed.args ?? []
      reqId = parsed.reqId
    } else {
      args = JSON.parse(argsJson)
    }
    return handler(args, reqId)
  }
  sandbox.__hostLog = (level: string, messageJson: string) => {
    stubs.hostLogCalls.push({level, messageJson})
  }
  sandbox.__hostError = (payloadJson: string) => {
    stubs.hostErrorCalls.push(payloadJson)
  }
  sandbox.__hostUnhandledRejection = (payloadJson: string) => {
    stubs.hostUnhandledRejectionCalls.push(payloadJson)
  }
  sandbox.__nativeSetTimeout = (token: number, ms: number) => {
    // We don't actually fire timers — tests trigger via __deliverTimer.
    stubs.timers.set(token, {fn: () => {}, ms})
  }
  sandbox.__nativeClearTimer = (token: number) => {
    stubs.timers.delete(token)
  }
  return sandbox
}

function freshStubs(): BridgeStubs {
  return {
    dispatchCalls: [],
    dispatchHandlers: new Map(),
    hostLogCalls: [],
    hostErrorCalls: [],
    hostUnhandledRejectionCalls: [],
    timers: new Map(),
  }
}

function evalBundle(stubs = freshStubs()): Record<string, unknown> {
  const sandbox = buildSandbox(stubs)
  vm.createContext(sandbox)
  vm.runInContext(BUNDLE, sandbox, {filename: "startup.js"})
  return sandbox
}

describe("startup bundle", () => {
  test("bundle parses + executes without throwing", () => {
    expect(() => evalBundle()).not.toThrow()
  })

  test("installs console.* methods", () => {
    const sandbox = evalBundle()
    const console_ = sandbox.console as {log: Function; warn: Function; error: Function; info: Function}
    expect(typeof console_.log).toBe("function")
    expect(typeof console_.warn).toBe("function")
    expect(typeof console_.error).toBe("function")
    expect(typeof console_.info).toBe("function")
  })

  test("console.log forwards to __hostLog with JSON-encoded args", () => {
    const stubs = freshStubs()
    const sandbox = evalBundle(stubs)
    ;(sandbox.console as {log: (...a: unknown[]) => void}).log("hello", 42, {a: 1})
    expect(stubs.hostLogCalls).toHaveLength(1)
    expect(stubs.hostLogCalls[0]!.level).toBe("log")
    expect(JSON.parse(stubs.hostLogCalls[0]!.messageJson)).toEqual(["hello", 42, {a: 1}])
  })

  test("installs setTimeout / clearTimeout / setInterval / clearInterval", () => {
    const sandbox = evalBundle()
    expect(typeof sandbox.setTimeout).toBe("function")
    expect(typeof sandbox.clearTimeout).toBe("function")
    expect(typeof sandbox.setInterval).toBe("function")
    expect(typeof sandbox.clearInterval).toBe("function")
  })

  test("setTimeout registers a native timer and fires via __deliverTimer", () => {
    const stubs = freshStubs()
    const sandbox = evalBundle(stubs)
    let fired = false
    const token = (sandbox.setTimeout as (fn: () => void, ms: number) => number)(() => {
      fired = true
    }, 100)
    expect(token).toBeGreaterThan(0)
    expect(stubs.timers.has(token)).toBe(true)
    expect(stubs.timers.get(token)!.ms).toBe(100)
    ;(sandbox.__deliverTimer as (n: number) => void)(token)
    expect(fired).toBe(true)
    // One-shot — token must have been removed.
    // (Note: our __nativeClearTimer is called by JS only when fired === false.
    // Re-firing is a no-op because the callbacks map cleared it.)
    ;(sandbox.__deliverTimer as (n: number) => void)(token)
  })

  test("clearTimeout removes the pending callback", () => {
    const stubs = freshStubs()
    const sandbox = evalBundle(stubs)
    let fired = false
    const token = (sandbox.setTimeout as (fn: () => void, ms: number) => number)(() => {
      fired = true
    }, 100)
    ;(sandbox.clearTimeout as (n: number) => void)(token)
    expect(stubs.timers.has(token)).toBe(false)
    ;(sandbox.__deliverTimer as (n: number) => void)(token)
    expect(fired).toBe(false)
  })

  test("setInterval re-arms via __nativeSetTimeout after each tick", () => {
    const stubs = freshStubs()
    const sandbox = evalBundle(stubs)
    let count = 0
    const token = (sandbox.setInterval as (fn: () => void, ms: number) => number)(() => {
      count++
    }, 50)
    ;(sandbox.__deliverTimer as (n: number) => void)(token)
    ;(sandbox.__deliverTimer as (n: number) => void)(token)
    ;(sandbox.__deliverTimer as (n: number) => void)(token)
    expect(count).toBe(3)
  })

  test("installs localStorage backed by __dispatch", () => {
    const stubs = freshStubs()
    const stored = new Map<string, string>()
    stubs.dispatchHandlers.set("localStorage.setItem", (args) => {
      stored.set(String(args[0]), String(args[1]))
      return "null"
    })
    stubs.dispatchHandlers.set("localStorage.getItem", (args) => {
      const v = stored.get(String(args[0]))
      return v === undefined ? "null" : JSON.stringify(v)
    })
    const sandbox = evalBundle(stubs)
    const ls = sandbox.localStorage as {setItem: (k: string, v: string) => void; getItem: (k: string) => string | null}
    ls.setItem("k", "v")
    expect(ls.getItem("k")).toBe("v")
    expect(ls.getItem("missing")).toBeNull()
  })

  test("crypto.randomUUID produces v4 format", () => {
    const stubs = freshStubs()
    stubs.dispatchHandlers.set("crypto.getRandomBytes", (args) => {
      const n = args[0] as number
      const arr = new Array(n)
      for (let i = 0; i < n; i++) arr[i] = (i * 17 + 3) % 256
      return JSON.stringify(arr)
    })
    const sandbox = evalBundle(stubs)
    const uuid = (sandbox.crypto as {randomUUID: () => string}).randomUUID()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test("TextEncoder / TextDecoder round-trip UTF-8", () => {
    const sandbox = evalBundle()
    const enc = new (sandbox.TextEncoder as new () => {encode: (s: string) => Uint8Array})()
    const dec = new (sandbox.TextDecoder as new () => {decode: (b: Uint8Array) => string})()
    expect(dec.decode(enc.encode("hello"))).toBe("hello")
    expect(dec.decode(enc.encode("héllo 🌍"))).toBe("héllo 🌍")
  })

  test("atob / btoa round-trip ASCII", () => {
    const sandbox = evalBundle()
    const btoa = sandbox.btoa as (s: string) => string
    const atob = sandbox.atob as (s: string) => string
    expect(btoa("hello")).toBe("aGVsbG8=")
    expect(atob("aGVsbG8=")).toBe("hello")
  })

  test("__mentraSendRequest resolves on a matching response envelope", async () => {
    const stubs = freshStubs()
    let captured: string | undefined
    stubs.dispatchHandlers.set("display.showText", (_args, reqId) => {
      captured = reqId
      return null
    })
    const sandbox = evalBundle(stubs)
    const sendRequest = sandbox.__mentraSendRequest as (i: string, m: string, a: unknown[]) => Promise<unknown>
    const p = sendRequest("display", "showText", ["hi"])
    expect(typeof captured).toBe("string")
    // Now deliver the response envelope back.
    ;(sandbox.__deliver as (j: string) => void)(
      JSON.stringify({kind: "response", reqId: captured, ok: true, result: 42}),
    )
    await expect(p).resolves.toBe(42)
  })

  test("__mentraSendRequest rejects on an error envelope", async () => {
    const stubs = freshStubs()
    let captured: string | undefined
    stubs.dispatchHandlers.set("mic.start", (_a, r) => {
      captured = r
      return null
    })
    const sandbox = evalBundle(stubs)
    const p = (sandbox.__mentraSendRequest as (i: string, m: string, a: unknown[]) => Promise<unknown>)(
      "mic",
      "start",
      [],
    )
    ;(sandbox.__deliver as (j: string) => void)(
      JSON.stringify({
        kind: "response",
        reqId: captured,
        ok: false,
        error: {code: "PERMISSION_DENIED", message: "MICROPHONE"},
      }),
    )
    await expect(p).rejects.toMatchObject({code: "PERMISSION_DENIED"})
  })

  test("__mentraSubscribe + event envelope fan-out", () => {
    const sandbox = evalBundle()
    const received: unknown[] = []
    const unsub = (
      sandbox.__mentraSubscribe as (i: string, cb: (p: unknown) => void) => () => void
    )("button", (p) => received.push(p))
    ;(sandbox.__deliver as (j: string) => void)(
      JSON.stringify({kind: "event", iface: "button", payload: {which: "main"}}),
    )
    expect(received).toEqual([{which: "main"}])
    unsub()
    ;(sandbox.__deliver as (j: string) => void)(
      JSON.stringify({kind: "event", iface: "button", payload: {which: "ignored"}}),
    )
    expect(received).toHaveLength(1)
  })

  test("signal ready fires __dispatch('__runtime', 'ready', '[]') on install", () => {
    const stubs = freshStubs()
    evalBundle(stubs)
    const readyCall = stubs.dispatchCalls.find((c) => c.iface === "__runtime" && c.method === "ready")
    expect(readyCall).toBeDefined()
    expect(JSON.parse(readyCall!.argsJson)).toEqual([])
  })

  test("__deliver init envelope stamps __mentraSessionId", () => {
    const sandbox = evalBundle()
    ;(sandbox.__deliver as (j: string) => void)(JSON.stringify({kind: "init", sessionId: "abc-123"}))
    expect(sandbox.__mentraSessionId).toBe("abc-123")
  })

  test("__deliver init fires __mentraInitCallback if set", () => {
    const sandbox = evalBundle()
    const seen: string[] = []
    ;(sandbox as Record<string, unknown>).__mentraInitCallback = (sid: string) => seen.push(sid)
    ;(sandbox.__deliver as (j: string) => void)(JSON.stringify({kind: "init", sessionId: "callback-test"}))
    expect(seen).toEqual(["callback-test"])
  })

  test("malformed __deliver envelope surfaces via __hostError instead of throwing", () => {
    const stubs = freshStubs()
    const sandbox = evalBundle(stubs)
    expect(() => (sandbox.__deliver as (j: string) => void)("not-json")).not.toThrow()
    expect(stubs.hostErrorCalls.length).toBeGreaterThan(0)
  })
})
