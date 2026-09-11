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
