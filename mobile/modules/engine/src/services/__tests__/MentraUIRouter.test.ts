/// <reference types="bun-types" />

import {beforeEach, describe, expect, test} from "bun:test"

import {MentraUIRouter, type MentraUICrustBinding} from "../MentraUIRouter"

function buildMockCrust() {
  const dispatchCalls: Array<{packageName: string; envelope: Record<string, unknown>}> = []
  const binding: MentraUICrustBinding = {
    mentraJsDispatchToJs(packageName, envelope) {
      dispatchCalls.push({packageName, envelope})
    },
  }
  return {binding, dispatchCalls}
}

function bindCapture(router: MentraUIRouter, packageName: string) {
  const injects: string[] = []
  router.bindWebView(packageName, (js: string) => {
    injects.push(js)
  })
  return injects
}

describe("MentraUIRouter — routeFromWebView", () => {
  let crust: ReturnType<typeof buildMockCrust>
  let router: MentraUIRouter

  beforeEach(() => {
    crust = buildMockCrust()
    router = new MentraUIRouter(crust.binding)
  })

  test("ready → fires UI_OPEN to background via miniapp_event envelope", () => {
    bindCapture(router, "com.foo")
    router.routeFromWebView("com.foo", JSON.stringify({type: "ready"}))
    expect(crust.dispatchCalls).toHaveLength(1)
    const env = JSON.parse(crust.dispatchCalls[0]!.envelope.raw as string)
    // Wire-level type must match MiniappResponseType.EVENT exactly,
    // else the SDK session's switch falls through and _ui fan-out
    // never fires (bound stays false; ui.send drops).
    expect(env.payload.type).toBe("miniapp_event")
    expect(env.payload.streamType).toBe("_ui")
    expect(env.payload.data.type).toBe("UI_OPEN")
  })

  test("msg → fires UI_MESSAGE to background with channel + payload + seq", () => {
    bindCapture(router, "com.foo")
    router.routeFromWebView(
      "com.foo",
      JSON.stringify({type: "msg", seq: 7, channel: "add-note", payload: {body: "hi"}}),
    )
    expect(crust.dispatchCalls).toHaveLength(1)
    const env = JSON.parse(crust.dispatchCalls[0]!.envelope.raw as string)
    expect(env.payload.data).toEqual({
      type: "UI_MESSAGE",
      channel: "add-note",
      payload: {body: "hi"},
      seq: 7,
    })
  })

  test("heartbeat envelope is silently consumed (no dispatch)", () => {
    bindCapture(router, "com.foo")
    router.routeFromWebView("com.foo", JSON.stringify({type: "heartbeat", seq: 1}))
    expect(crust.dispatchCalls).toHaveLength(0)
  })

  test("malformed JSON drops silently", () => {
    bindCapture(router, "com.foo")
    expect(() => router.routeFromWebView("com.foo", "not-json")).not.toThrow()
    expect(crust.dispatchCalls).toHaveLength(0)
  })

  test("unknown envelope type drops silently", () => {
    bindCapture(router, "com.foo")
    router.routeFromWebView("com.foo", JSON.stringify({type: "weird"}))
    expect(crust.dispatchCalls).toHaveLength(0)
  })
})

describe("MentraUIRouter — routeFromBackground", () => {
  let crust: ReturnType<typeof buildMockCrust>
  let router: MentraUIRouter

  beforeEach(() => {
    crust = buildMockCrust()
    router = new MentraUIRouter(crust.binding)
  })

  test("UI_SEND with a bound WebView injects a msg frame into window.__mentra.recv", () => {
    const injects = bindCapture(router, "com.foo")
    router.routeFromBackground("com.foo", {
      type: "UI_SEND",
      channel: "state",
      payload: {notes: ["a"]},
      seq: 1,
    })
    expect(injects).toHaveLength(1)
    expect(injects[0]).toContain("window.__mentra")
    expect(injects[0]).toContain("recv")
  })

  test("UI_SEND drops silently when no WebView is bound", () => {
    expect(() =>
      router.routeFromBackground("com.foo", {
        type: "UI_SEND",
        channel: "x",
        payload: null,
        seq: 1,
      }),
    ).not.toThrow()
  })
})

describe("MentraUIRouter — lifecycle", () => {
  let crust: ReturnType<typeof buildMockCrust>
  let router: MentraUIRouter

  beforeEach(() => {
    crust = buildMockCrust()
    router = new MentraUIRouter(crust.binding)
  })

  test("isBound tracks bindWebView / unbindWebView", () => {
    expect(router.isBound("com.foo")).toBe(false)
    bindCapture(router, "com.foo")
    expect(router.isBound("com.foo")).toBe(true)
    router.unbindWebView("com.foo")
    expect(router.isBound("com.foo")).toBe(false)
  })

  test("unbindWebView fires UI_CLOSE to background", () => {
    bindCapture(router, "com.foo")
    crust.dispatchCalls.length = 0
    router.unbindWebView("com.foo")
    expect(crust.dispatchCalls).toHaveLength(1)
    const env = JSON.parse(crust.dispatchCalls[0]!.envelope.raw as string)
    expect(env.payload.data).toEqual({type: "UI_CLOSE"})
  })

  test("unbindWebView for an unknown package is a no-op", () => {
    expect(() => router.unbindWebView("nobody")).not.toThrow()
    expect(crust.dispatchCalls).toHaveLength(0)
  })

  test("notifyReopen fires UI_OPEN while a WebView is still bound", () => {
    bindCapture(router, "com.foo")
    crust.dispatchCalls.length = 0
    router.notifyReopen("com.foo")
    expect(crust.dispatchCalls).toHaveLength(1)
    const env = JSON.parse(crust.dispatchCalls[0]!.envelope.raw as string)
    expect(env.payload.data).toEqual({type: "UI_OPEN"})
  })

  test("notifyReopen for an unknown package is a no-op", () => {
    expect(() => router.notifyReopen("nobody")).not.toThrow()
    expect(crust.dispatchCalls).toHaveLength(0)
  })

  test("bindWebView replaces an existing binding (defensive)", () => {
    bindCapture(router, "com.foo")
    bindCapture(router, "com.foo")
    expect(router.isBound("com.foo")).toBe(true)
  })

  test("pushLifecycleFrame injects an open/close envelope into the bound WebView", () => {
    const injects = bindCapture(router, "com.foo")
    router.pushLifecycleFrame("com.foo", {type: "close"})
    expect(injects).toHaveLength(1)
    // The frame is JSON-stringified twice (once for the literal, once
    // for embedding inside JSON.parse). The unescaped close type
    // appears as \"type\":\"close\" inside the injected source.
    expect(injects[0]).toContain('\\"type\\":\\"close\\"')
  })

  test("legacy heartbeat envelope is silently consumed (back-compat for older shims)", () => {
    bindCapture(router, "com.foo")
    crust.dispatchCalls.length = 0
    router.routeFromWebView("com.foo", JSON.stringify({type: "heartbeat", seq: 1}))
    expect(crust.dispatchCalls).toHaveLength(0)
    expect(router.isBound("com.foo")).toBe(true)
  })
})

describe("MentraUIRouter — host channels", () => {
  let crust: ReturnType<typeof buildMockCrust>
  let router: MentraUIRouter

  beforeEach(() => {
    crust = buildMockCrust()
    router = new MentraUIRouter(crust.binding)
  })

  function recvFrames(injects: string[]): Array<Record<string, unknown>> {
    return injects.map((js) => {
      const match = /JSON\.parse\((".*")\)\); true;$/.exec(js)
      return JSON.parse(JSON.parse(match![1]!)) as Record<string, unknown>
    })
  }

  test("a host channel request is answered by the host and never reaches the background", () => {
    const seen: Array<{packageName: string; payload: unknown; requestId?: string}> = []
    router.setHostChannel("_preview", (packageName, message) => seen.push({packageName, ...message}))
    const injects = bindCapture(router, "com.foo")
    router.routeFromWebView(
      "com.foo",
      JSON.stringify({type: "msg", seq: 3, channel: "_preview", payload: {cmd: "handshake"}, requestId: "r1"}),
    )
    expect(seen).toEqual([{packageName: "com.foo", payload: {cmd: "handshake"}, requestId: "r1"}])
    expect(crust.dispatchCalls).toHaveLength(0)

    router.replyToWebView("com.foo", "_preview", "r1", {ok: true, result: {t: "waiting_for_lease"}})
    router.pushToWebView("com.foo", "_preview", {t: "lease_available"})
    expect(recvFrames(injects)).toEqual([
      {
        type: "msg",
        seq: 0,
        channel: "_preview",
        requestId: "r1",
        payload: {ok: true, result: {t: "waiting_for_lease"}},
      },
      {type: "msg", seq: 0, channel: "_preview", payload: {t: "lease_available"}},
    ])
  })

  test("the background cannot send on a host channel", () => {
    router.setHostChannel("_preview", () => {})
    const injects = bindCapture(router, "com.foo")
    router.routeFromBackground("com.foo", {type: "UI_SEND", channel: "_preview", payload: {t: "lease_available"}})
    expect(injects).toHaveLength(0)
    router.routeFromBackground("com.foo", {type: "UI_SEND", channel: "notes", payload: {}})
    expect(injects).toHaveLength(1)
  })

  test("ready notifies observers once per envelope, and a throwing observer does not block UI_OPEN", () => {
    const ready: string[] = []
    router.onWebViewReady(() => {
      throw new Error("observer bug")
    })
    const unsubscribe = router.onWebViewReady((packageName) => ready.push(packageName))
    bindCapture(router, "com.foo")
    router.routeFromWebView("com.foo", JSON.stringify({type: "ready"}))
    unsubscribe()
    router.routeFromWebView("com.foo", JSON.stringify({type: "ready"}))
    expect(ready).toEqual(["com.foo"])
    expect(crust.dispatchCalls).toHaveLength(2)
  })

  test("releasing a host channel routes it to the background again", () => {
    router.setHostChannel("_preview", () => {})
    router.setHostChannel("_preview", null)
    bindCapture(router, "com.foo")
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", seq: 1, channel: "_preview", payload: {}}))
    expect(crust.dispatchCalls).toHaveLength(1)
  })
})

describe("background replacement", () => {
  test("fails in-flight calls, holds new requests and input for the replacement, and keeps host RPCs", () => {
    const crust = buildMockCrust()
    const router = new MentraUIRouter(crust.binding)
    const injected = bindCapture(router, "com.foo")
    const hostCalls: unknown[] = []
    router.setHostChannel("host", (_pkg, message) => hostCalls.push(message))
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "save", requestId: "old"}))
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "host", requestId: "host-old"}))
    router.backgroundRestarting("com.foo")
    // Only the call the dead context was handling fails; it is never replayed.
    expect(injected[0]).toContain("old")
    expect(injected[0]).not.toContain("host-old")
    const before = crust.dispatchCalls.length
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "auth:get", requestId: "during"}))
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "draft", payload: "typed during restart"}))
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "host", requestId: "host-during"}))
    expect(crust.dispatchCalls).toHaveLength(before)
    expect(hostCalls).toHaveLength(2)
    expect(injected).toHaveLength(1)
    router.backgroundStarting("com.foo")
    router.backgroundReady("com.foo")
    const resumed = crust.dispatchCalls
      .slice(before)
      .map((call) => JSON.parse(call.envelope.raw as string).payload.data)
    expect(resumed).toEqual([
      {type: "UI_OPEN"},
      {type: "UI_MESSAGE", channel: "auth:get", payload: undefined, seq: undefined, requestId: "during"},
      {type: "UI_MESSAGE", channel: "draft", payload: "typed during restart"},
    ])
    router.backgroundReady("com.foo")
    expect(crust.dispatchCalls).toHaveLength(before + 3)
  })
})

test("terminal background teardown fails held requests, drops input and bounds the queue", () => {
  const crust = buildMockCrust()
  const router = new MentraUIRouter(crust.binding)
  const injected = bindCapture(router, "com.foo")
  router.backgroundRestarting("com.foo")
  const warn = console.warn
  console.warn = () => {}
  try {
    for (let i = 0; i < 10000; i++)
      router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "draft", payload: i}))
  } finally {
    console.warn = warn
  }
  router.backgroundReady("com.foo")
  expect(crust.dispatchCalls).toHaveLength(129)
  crust.dispatchCalls.length = 0
  router.backgroundRestarting("com.foo")
  router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "draft", payload: "retired"}))
  router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "save", requestId: "held"}))
  router.backgroundStopped("com.foo")
  router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "save", requestId: "after-stop"}))
  router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "draft", payload: "no future owner"}))
  expect(injected.filter((js) => js.includes("BACKGROUND_STOPPED"))).toHaveLength(2)
  expect(crust.dispatchCalls).toHaveLength(0)
  // A later spawn reopens the still-mounted UI and starts with nothing held.
  router.backgroundStarting("com.foo")
  router.backgroundReady("com.foo")
  expect(crust.dispatchCalls.map((call) => JSON.parse(call.envelope.raw as string).payload.data)).toEqual([
    {type: "UI_OPEN"},
  ])
})

describe("background start gate", () => {
  const delivered = (crust: ReturnType<typeof buildMockCrust>) =>
    crust.dispatchCalls.map((call) => JSON.parse(call.envelope.raw as string).payload.data)

  test("holds UI_OPEN and every WebView frame until the background is ready, then delivers in order", () => {
    const crust = buildMockCrust()
    const router = new MentraUIRouter(crust.binding)
    const ready: string[] = []
    router.onBackgroundReady((pkg) => ready.push(pkg))
    router.backgroundStarting("com.foo")
    bindCapture(router, "com.foo")
    expect(router.isBackgroundReady("com.foo")).toBe(false)

    router.routeFromWebView("com.foo", JSON.stringify({type: "ready"}))
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "history:get", requestId: "r1"}))
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "draft", payload: "typed"}))
    router.notifyReopen("com.foo")
    expect(crust.dispatchCalls).toHaveLength(0)

    router.backgroundReady("com.foo")
    expect(delivered(crust)).toEqual([
      {type: "UI_OPEN"},
      {type: "UI_MESSAGE", channel: "history:get", payload: undefined, seq: undefined, requestId: "r1"},
      {type: "UI_MESSAGE", channel: "draft", payload: "typed", seq: undefined},
    ])
    expect(ready).toEqual(["com.foo"])
    expect(router.isBackgroundReady("com.foo")).toBe(true)

    // Once ready, traffic flows directly and a repeat ready is a no-op.
    router.backgroundReady("com.foo")
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "draft", payload: "live"}))
    expect(crust.dispatchCalls).toHaveLength(4)
    expect(ready).toEqual(["com.foo"])
  })

  test("a background that stops before it is ready rejects held requests", () => {
    const crust = buildMockCrust()
    const router = new MentraUIRouter(crust.binding)
    router.backgroundStarting("com.foo")
    const injected = bindCapture(router, "com.foo")
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "history:get", requestId: "r1"}))
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "draft", payload: "typed"}))
    router.backgroundStopped("com.foo")
    expect(injected.some((js) => js.includes("BACKGROUND_STOPPED") && js.includes("r1"))).toBe(true)
    expect(crust.dispatchCalls).toHaveLength(0)
  })

  test("cancelling a held request drops it before delivery", () => {
    const crust = buildMockCrust()
    const router = new MentraUIRouter(crust.binding)
    router.backgroundStarting("com.foo")
    bindCapture(router, "com.foo")
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "history:get", requestId: "r1"}))
    router.routeFromWebView("com.foo", JSON.stringify({type: "cancel", requestId: "r1"}))
    router.backgroundReady("com.foo")
    expect(delivered(crust)).toEqual([])
  })

  test("a fresh start after a stop holds requests instead of rejecting them", () => {
    const crust = buildMockCrust()
    const router = new MentraUIRouter(crust.binding)
    const injected = bindCapture(router, "com.foo")
    router.backgroundStopped("com.foo")
    router.backgroundStarting("com.foo")
    router.routeFromWebView("com.foo", JSON.stringify({type: "ready"}))
    router.routeFromWebView("com.foo", JSON.stringify({type: "msg", channel: "chat:get-history", requestId: "r1"}))
    expect(injected.some((js) => js.includes("r1"))).toBe(false)
    router.backgroundReady("com.foo")
    expect(delivered(crust)).toEqual([
      {type: "UI_OPEN"},
      {type: "UI_MESSAGE", channel: "chat:get-history", payload: undefined, seq: undefined, requestId: "r1"},
    ])
  })
})
