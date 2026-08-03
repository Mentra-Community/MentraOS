/**
 * MentraUIRouter — bidirectional bus between a per-miniapp UI WebView
 * and its bound background JSContext.
 *
 * The flow:
 *
 *   WebView (mentra.send/on)                Background (session.ui.send/on)
 *      │                                       │
 *      │   window.ReactNativeWebView          │
 *      │   .postMessage(jsonEnvelope)         │  session.sendOneShot({
 *      │                                      │     type: "UI_SEND", channel, payload, seq
 *      │                                      │  })
 *      │                                      │
 *      ▼                                      ▼
 *   MiniappHost.onMessage              MentraJSRouter (recognises payload.type==="UI_SEND")
 *      │                                      │
 *      ▼                                      ▼
 *      ──── MentraUIRouter.routeFromWebView   ──── MentraUIRouter.routeFromBackground
 *           ──► Crust.mentraJsDispatchToJs        ──► webView.injectJavaScript("window.__mentra.recv(...)")
 *                {kind:"bridge", raw: JSON({
 *                  payload:{
 *                    type:"EVENT", streamType:"_ui",
 *                    data:{type:"UI_MESSAGE", channel, payload, seq}
 *                  }})}
 *
 * The router is a singleton — one instance for the whole host process —
 * because only one WebView is allowed open at a time per spec. The
 * binding map is therefore N entries (one per "currently has a UI
 * WebView mounted" miniapp), but in practice it's 0 or 1.
 *
 * UI_OPEN / UI_CLOSE lifecycle envelopes are pushed by the WebView's
 * `mentra.ready()` and the host's WebView teardown handler; the router
 * forwards them to background via the same EVENT/_ui envelope shape.
 */

interface MentraUIInjectFn {
  (jsSource: string): void
}

/**
 * Subset of the Crust native module that MentraUIRouter touches.
 * Loose binding keeps tests free of Expo imports.
 */
export interface MentraUICrustBinding {
  mentraJsDispatchToJs(packageName: string, envelope: Record<string, unknown>): Promise<void> | void
}

interface BoundWebView {
  inject: MentraUIInjectFn
}

/**
 * NOTE: the WebView ↔ host heartbeat was removed when the lifecycle
 * inversion landed. The current model is **at most one WebView at a
 * time, foreground UI with an always-on background JSContext** (same
 * shape as the cloud-WebView miniapps). User navigation closes it
 * explicitly and `onContentProcessDidTerminate` catches OS-level
 * crashes, but the host may still re-announce UI_OPEN for an already
 * mounted WebView after app resume/dev respawn so the background can
 * push a fresh authoritative snapshot.
 */

export class MentraUIRouter {
  private readonly bindings: Map<string, BoundWebView> = new Map()
  private readonly crust: MentraUICrustBinding

  constructor(crust: MentraUICrustBinding) {
    this.crust = crust
  }

  /**
   * Called when a UI WebView mounts. `injectFn` wraps
   * `webView.injectJavaScript` — the router calls it with prebuilt
   * `window.__mentra.recv(...)` strings to deliver background-side
   * frames into the WebView's mentra global.
   *
   * The router also pushes a UI_OPEN envelope to the background side
   * once the WebView signals ready (see {@link routeFromWebView}).
   * Calling bindWebView on a packageName that already has a binding
   * replaces the previous one (defensive — should not happen in
   * practice because only one WebView is open at a time).
   */
  bindWebView(packageName: string, injectFn: MentraUIInjectFn): void {
    this.bindings.set(packageName, {inject: injectFn})
  }

  /**
   * Called when the WebView unmounts (user navigated away or the host
   * tore it down on heartbeat timeout). Pushes UI_CLOSE to background
   * so handlers can flush state, then drops the binding.
   */
  unbindWebView(packageName: string): void {
    if (!this.bindings.has(packageName)) return
    this.bindings.delete(packageName)
    this.deliverToBackground(packageName, {type: "UI_CLOSE"})
  }

  /** True iff a WebView is currently bound to the named package. */
  isBound(packageName: string): boolean {
    return this.bindings.has(packageName)
  }

  /**
   * Re-announce the already-mounted WebView to the background JSContext.
   * This covers dev background hot-reload, app resume, and thawed WebViews
   * whose injected UI_SEND frames may have been missed while the host was
   * suspended. Re-emitting UI_OPEN flips `ui.bound` back to true if needed
   * and lets background code push a fresh snapshot via session.ui.onOpen.
   *
   * No-op if no WebView is currently bound for the package.
   */
  notifyReopen(packageName: string): void {
    if (!this.bindings.has(packageName)) return
    this.deliverToBackground(packageName, {type: "UI_OPEN"})
  }

  /**
   * Forward a WebView-originated postMessage envelope to the JSContext.
   * `rawJson` is the raw string from `event.nativeEvent.data` — the
   * caller hasn't parsed it yet so the router controls the wire format
   * end-to-end.
   *
   * Recognised envelope types from the WebView shim:
   *   - {type: "ready"}                              → fire UI_OPEN
   *   - {type: "msg", seq, channel, payload}         → fire UI_MESSAGE
   *   - {type: "heartbeat", seq}                     → silently ack
   */
  routeFromWebView(packageName: string, rawJson: string): void {
    let env: {
      type?: string
      seq?: number
      channel?: string
      payload?: unknown
      requestId?: string
    }
    try {
      env = JSON.parse(rawJson)
    } catch {
      return
    }
    if (typeof env.type !== "string") return

    if (env.type === "ready") {
      this.deliverToBackground(packageName, {type: "UI_OPEN"})
      return
    }
    if (env.type === "msg" && typeof env.channel === "string") {
      const out: Record<string, unknown> = {
        type: "UI_MESSAGE",
        channel: env.channel,
        payload: env.payload,
        seq: env.seq,
      }
      if (typeof env.requestId === "string") out.requestId = env.requestId
      this.deliverToBackground(packageName, out)
      return
    }
    if (env.type === "cancel" && typeof env.requestId === "string") {
      this.deliverToBackground(packageName, {type: "UI_CANCEL", requestId: env.requestId})
      return
    }
    // NOTE: console.* logs do NOT come through this router. The
    // miniappGlobals console-tap shim posts {payload:{type:"dev_log"}}
    // envelopes which LocalMiniappRuntime handles and forwards to the
    // dev sidecar tagged source:"ui". Keeping that path one-way means
    // we don't have two console-capture pipelines competing.
    //
    // Unknown envelope — drop silently.
  }

  /**
   * Called by MentraJSRouter when it sees a `__bridge.send` outbound
   * frame whose parsed payload is a UI_SEND envelope. The router
   * forwards it as a `msg` frame to the bound WebView (or drops if no
   * WebView is currently mounted).
   *
   * `uiSendPayload` is the raw `{type:"UI_SEND", channel, payload, seq}`
   * shape produced by `session.ui.send` on the background side.
   */
  routeFromBackground(
    packageName: string,
    uiSendPayload: {
      type: string
      channel?: string
      payload?: unknown
      seq?: number
      requestId?: string
    },
  ): void {
    const binding = this.bindings.get(packageName)
    if (!binding) return
    if (uiSendPayload.type === "UI_CANCEL" && typeof uiSendPayload.requestId === "string") {
      const cancel = {type: "cancel", requestId: uiSendPayload.requestId}
      const literal = JSON.stringify(cancel)
      const escaped = JSON.stringify(literal)
      binding.inject(`if (window.__mentra && window.__mentra.recv) window.__mentra.recv(JSON.parse(${escaped})); true;`)
      return
    }
    const outbound: Record<string, unknown> = {
      type: "msg",
      seq: uiSendPayload.seq ?? 0,
      channel: uiSendPayload.channel,
      payload: uiSendPayload.payload,
    }
    if (typeof uiSendPayload.requestId === "string") outbound.requestId = uiSendPayload.requestId
    const literal = JSON.stringify(outbound)
    const escaped = JSON.stringify(literal)
    binding.inject(`if (window.__mentra && window.__mentra.recv) window.__mentra.recv(JSON.parse(${escaped})); true;`)
  }

  /**
   * Send a synthetic frame to the WebView. Used for host-initiated
   * lifecycle events (`open`, `close`, `ack`). The wire shape is the
   * same as the WebView shim's recv handler expects.
   */
  pushLifecycleFrame(packageName: string, frame: {type: "open" | "close" | "ack"; seq?: number}): void {
    const binding = this.bindings.get(packageName)
    if (!binding) return
    const literal = JSON.stringify(frame)
    const escaped = JSON.stringify(literal)
    binding.inject(`if (window.__mentra && window.__mentra.recv) window.__mentra.recv(JSON.parse(${escaped})); true;`)
  }

  /**
   * Wrap an EVENT envelope and push it to background via the bridge.
   * Background's UIModule listens for stream `_ui`. The `type` is the
   * wire value `miniapp_event` — must match `MiniappResponseType.EVENT`
   * exactly, otherwise the SDK's session switch falls through and the
   * `_ui` fan-out never fires (bound stays false; `ui.send` drops).
   */
  private deliverToBackground(packageName: string, data: Record<string, unknown>): void {
    const innerEnvelope = {
      payload: {
        type: "miniapp_event",
        streamType: "_ui",
        data,
      },
    }
    void this.crust.mentraJsDispatchToJs(packageName, {
      kind: "bridge",
      raw: JSON.stringify(innerEnvelope),
    })
  }
}
