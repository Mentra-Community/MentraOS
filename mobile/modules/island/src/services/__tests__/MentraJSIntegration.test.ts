/// <reference types="bun-types" />

/**
 * End-to-end-ish wiring test for the WebView ↔ JSContext bus.
 *
 * Verifies that a UI envelope sent from background `session.ui.send`
 * round-trips through:
 *   MentraJSRouter (peeks UI_SEND on __bridge.send)
 *     → MentraUIRouter.routeFromBackground
 *       → bound WebView's `inject(window.__mentra.recv(...))`
 *
 * And the reverse: a WebView postMessage (`{type:"msg",...}`) goes:
 *   MentraUIRouter.routeFromWebView
 *     → mentraJsDispatchToJs with kind:"bridge", raw:EVENT/_ui envelope
 *       → JSContext-side __deliver fans into the session.ui subscription
 *
 * Uses a fake Crust binding so the test runs without native. Both
 * sides of the bus live in plain TS — the polyfill bundle's
 * EVENT-handling and the host-side router code.
 */

import {beforeEach, describe, expect, test, mock} from "bun:test"

import type localMiniappRuntime from "../LocalMiniappRuntime"
import {MentraJSRouter, type MentraJSCrustBinding} from "../MentraJSRouter"
import {MentraUIRouter} from "../MentraUIRouter"

type LocalMiniappRuntime = typeof localMiniappRuntime

interface CrustListener {
  (payload: Record<string, unknown>): void
}

function buildFakeCrust() {
  const listeners = new Map<string, Set<CrustListener>>()
  // dispatchToJs deliveries — what the host pushes into the JSContext.
  // In a real test we'd evaluate them inside the polyfill bundle; here
  // we just capture them so the test can assert wire format.
  const deliveries: Array<{packageName: string; envelope: Record<string, unknown>}> = []
  const binding: MentraJSCrustBinding = {
    mentraJsSpawn() {
      return true
    },
    mentraJsKill() {},
    mentraJsDispatchToJs(packageName, envelope) {
      deliveries.push({packageName, envelope})
    },
    mentraJsSetManifest() {},
    mentraJsLoadPolyfillBundle() {
      return "/* fake polyfill */"
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
    deliveries,
    emit(event: string, payload: Record<string, unknown>) {
      listeners.get(event)?.forEach((h) => h(payload))
    },
  }
}

function buildFakeRuntime() {
  const handleRawCalls: Array<{packageName: string; raw: string}> = []
  return {
    runtime: {
      registerApp(_p: string, _fn: (raw: string) => void) {},
      handleRawMessage(packageName: string, raw: string) {
        handleRawCalls.push({packageName, raw})
      },
      unregisterApp() {},
    } as unknown as LocalMiniappRuntime,
    handleRawCalls,
  }
}

describe("MentraJSRouter + MentraUIRouter — end-to-end UI bus", () => {
  let crust: ReturnType<typeof buildFakeCrust>
  let runtime: ReturnType<typeof buildFakeRuntime>
  let router: MentraJSRouter
  let uiRouter: MentraUIRouter

  beforeEach(() => {
    crust = buildFakeCrust()
    runtime = buildFakeRuntime()
    uiRouter = new MentraUIRouter(crust.binding)
    router = new MentraJSRouter(runtime.runtime, crust.binding, {
      log: mock(),
      warn: mock(),
      error: mock(),
    })
    router.uiRouter = uiRouter
    router.start()
  })

  test("background session.ui.send → bound WebView receives msg via inject", async () => {
    // Bind a fake WebView.
    const injects: string[] = []
    uiRouter.bindWebView("com.example", (js) => {
      injects.push(js)
    })
    // Background-emitted bridge envelope: session.ui.send wraps as
    // {type:"UI_SEND", channel, payload, seq}. session.ts sends via
    // sendOneShot → transport → __bridge.send([raw]).
    await router.spawnAndRegister("com.example", "/* miniapp */")
    crust.emit("mentrajs_message", {
      packageName: "com.example",
      iface: "__bridge",
      method: "send",
      args: [
        JSON.stringify({
          payload: {type: "UI_SEND", channel: "state", payload: {hello: "world"}, seq: 1},
        }),
      ],
    })
    // The router should have intercepted (not forwarded to
    // LocalMiniappRuntime) and asked the UI router to inject.
    expect(runtime.handleRawCalls).toHaveLength(0)
    expect(injects).toHaveLength(1)
    expect(injects[0]).toContain("window.__mentra")
    expect(injects[0]).toContain("recv")
    // The injected JSON literal should carry the channel + payload.
    expect(injects[0]).toContain('\\"channel\\":\\"state\\"')
  })

  test("legacy non-UI_SEND bridge frame still falls through to runtime.handleRawMessage", async () => {
    uiRouter.bindWebView("com.example", () => {})
    await router.spawnAndRegister("com.example", "/* miniapp */")
    const legacyEnvelope = JSON.stringify({payload: {type: "DISPLAY", text: "hi"}})
    crust.emit("mentrajs_message", {
      packageName: "com.example",
      iface: "__bridge",
      method: "send",
      args: [legacyEnvelope],
    })
    expect(runtime.handleRawCalls).toEqual([{packageName: "com.example", raw: legacyEnvelope}])
  })

  test("WebView postMessage → mentraJsDispatchToJs with EVENT/_ui envelope", () => {
    uiRouter.bindWebView("com.example", () => {})
    uiRouter.routeFromWebView(
      "com.example",
      JSON.stringify({type: "msg", seq: 1, channel: "ping", payload: {at: 1}}),
    )
    expect(crust.deliveries).toHaveLength(1)
    const env = JSON.parse(crust.deliveries[0]!.envelope.raw as string)
    expect(env.payload.type).toBe("EVENT")
    expect(env.payload.streamType).toBe("_ui")
    expect(env.payload.data).toEqual({
      type: "UI_MESSAGE",
      channel: "ping",
      payload: {at: 1},
      seq: 1,
    })
  })

  test("WebView 'ready' → UI_OPEN delivered to JSContext", () => {
    uiRouter.bindWebView("com.example", () => {})
    uiRouter.routeFromWebView("com.example", JSON.stringify({type: "ready"}))
    const env = JSON.parse(crust.deliveries[0]!.envelope.raw as string)
    expect(env.payload.data).toEqual({type: "UI_OPEN"})
  })

  test("unbindWebView → UI_CLOSE delivered to JSContext", () => {
    uiRouter.bindWebView("com.example", () => {})
    uiRouter.unbindWebView("com.example")
    const closeDelivery = crust.deliveries.find((d) => {
      const env = JSON.parse(d.envelope.raw as string)
      return env.payload.data.type === "UI_CLOSE"
    })
    expect(closeDelivery).toBeDefined()
  })
})
