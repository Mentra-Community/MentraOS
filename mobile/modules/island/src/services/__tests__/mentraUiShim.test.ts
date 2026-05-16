/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import vm from "node:vm"

import {buildMentraUiShim} from "../mentraUiShim"

interface ShimGlobals {
  mentra?: {
    send: (channel: string, payload: unknown) => void
    on: (channel: string, cb: (p: unknown) => void) => () => void
    onOpen: (cb: () => void) => () => void
    onClose: (cb: () => void) => () => void
    ready: () => void
  }
  __mentra?: {recv: (env: unknown) => void}
  ReactNativeWebView?: {postMessage: (s: string) => void}
  outboundQueue: string[]
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
}

function evalShim(packageName = "com.test"): ShimGlobals {
  const sandbox: Record<string, unknown> = {}
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.console = console
  // No timers needed — the shim no longer schedules anything (heartbeat
  // removed since WebViews are foreground-only).
  sandbox.setInterval = (() => 0) as typeof setInterval
  sandbox.clearInterval = (() => {}) as typeof clearInterval
  sandbox.Date = Date
  sandbox.Array = Array
  sandbox.Object = Object
  sandbox.JSON = JSON
  sandbox.String = String
  sandbox.Number = Number
  ;(sandbox as ShimGlobals).outboundQueue = []
  ;(sandbox as ShimGlobals).ReactNativeWebView = {
    postMessage: (s: string) => {
      ;(sandbox as ShimGlobals).outboundQueue.push(s)
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(buildMentraUiShim({packageName}), sandbox)
  return sandbox as unknown as ShimGlobals
}

describe("buildMentraUiShim", () => {
  test("installs window.mentra and window.__mentra", () => {
    const g = evalShim()
    expect(typeof g.mentra).toBe("object")
    expect(typeof g.mentra!.send).toBe("function")
    expect(typeof g.mentra!.on).toBe("function")
    expect(typeof g.mentra!.ready).toBe("function")
    expect(typeof g.__mentra).toBe("object")
    expect(typeof g.__mentra!.recv).toBe("function")
  })

  test("send() before ready() buffers and does NOT post", () => {
    const g = evalShim()
    g.mentra!.send("foo", {x: 1})
    g.mentra!.send("bar", "y")
    expect(g.outboundQueue).toHaveLength(0)
  })

  test("ready() flushes buffered messages and posts a 'ready' envelope", () => {
    const g = evalShim()
    g.mentra!.send("foo", 1)
    g.mentra!.send("bar", 2)
    g.mentra!.ready()
    // First post is the 'ready' envelope; then the two buffered sends.
    expect(g.outboundQueue).toHaveLength(3)
    expect(JSON.parse(g.outboundQueue[0]!)).toEqual({type: "ready"})
    expect(JSON.parse(g.outboundQueue[1]!).channel).toBe("foo")
    expect(JSON.parse(g.outboundQueue[2]!).channel).toBe("bar")
  })

  test("send() after ready() posts immediately with monotonic seq numbers", () => {
    const g = evalShim()
    g.mentra!.ready()
    g.mentra!.send("a", 1)
    g.mentra!.send("a", 2)
    const seqs = g.outboundQueue.slice(1).map((s) => JSON.parse(s).seq as number)
    expect(seqs).toEqual([1, 2])
  })

  test("recv routes 'msg' envelopes to subscribed handlers", () => {
    const g = evalShim()
    const got: unknown[] = []
    g.mentra!.on("greeting", (p) => got.push(p))
    g.__mentra!.recv({type: "msg", channel: "greeting", payload: "hello", seq: 1})
    expect(got).toEqual(["hello"])
  })

  test("recv 'close' fires onClose handlers", () => {
    const g = evalShim()
    const closes: number[] = []
    g.mentra!.onClose(() => closes.push(1))
    g.__mentra!.recv({type: "close"})
    expect(closes).toEqual([1])
  })

  test("ready() fires onOpen handlers registered before ready", () => {
    const g = evalShim()
    const opens: number[] = []
    g.mentra!.onOpen(() => opens.push(1))
    g.mentra!.ready()
    expect(opens).toEqual([1])
  })

  test("onOpen registered after ready fires immediately", () => {
    const g = evalShim()
    g.mentra!.ready()
    const opens: number[] = []
    g.mentra!.onOpen(() => opens.push(1))
    expect(opens).toEqual([1])
  })

  test("unsubscribe from on() stops further deliveries", () => {
    const g = evalShim()
    const got: unknown[] = []
    const off = g.mentra!.on("ch", (p) => got.push(p))
    g.__mentra!.recv({type: "msg", channel: "ch", payload: 1, seq: 1})
    off()
    g.__mentra!.recv({type: "msg", channel: "ch", payload: 2, seq: 2})
    expect(got).toEqual([1])
  })

  test("recv silently ignores unknown envelope types", () => {
    const g = evalShim()
    expect(() => g.__mentra!.recv({type: "weird"})).not.toThrow()
    expect(() => g.__mentra!.recv(null)).not.toThrow()
  })

  test("packageName is stamped on the global for diagnostics", () => {
    const g = evalShim("com.example.app")
    expect((g.mentra as unknown as {_packageName: string})._packageName).toBe("com.example.app")
  })
})
