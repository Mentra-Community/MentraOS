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

/** A frame posted by the WebView shim. */
interface UIFrame {
  type?: string
  seq?: number
  channel?: string
  payload?: unknown
  requestId?: string
}

/**
 * A UI channel the host answers itself. Messages on it never reach the background JSContext,
 * and the background cannot send on it either.
 */
export type MentraUIHostChannelHandler = (packageName: string, message: {payload: unknown; requestId?: string}) => void

export type MentraUIHostReply = {ok: true; result?: unknown} | {ok: false; error: {code: string; message: string}}

/**
 * The host mounts at most one miniapp UI WebView at a time. Its background
 * JSContext runs separately on the phone and can remain alive after UI closure.
 * UI closure unbinds the WebView and sends UI_CLOSE; on iOS the host also exits
 * the UI when `onContentProcessDidTerminate` reports a content-process exit.
 * The host may re-announce UI_OPEN after app resume or background dev respawn
 * so the background can push a fresh snapshot. This router has no WebView
 * heartbeat timeout.
 */

export class MentraUIRouter {
  private readonly bindings: Map<string, BoundWebView> = new Map()
  /** Spawned backgrounds whose init has not settled; nothing has reached them yet. */
  private readonly starting = new Set<string>()
  private readonly restarting = new Set<string>()
  /** UI_OPEN requested while the background was not ready; sent once it is. */
  private readonly uiOpenOwed = new Set<string>()
  private readonly stopped = new Set<string>()
  private readonly pendingInput = new Map<string, string[]>()
  private readonly backgroundRequests = new Map<string, Set<string>>()
  private readonly crust: MentraUICrustBinding
  private readonly hostChannels: Map<string, MentraUIHostChannelHandler> = new Map()
  private readonly readyListeners = new Set<(packageName: string) => void>()
  private readonly backgroundReadyListeners = new Set<(packageName: string) => void>()

  constructor(crust: MentraUICrustBinding) {
    this.crust = crust
  }

  /** Reserve `channel` for the host. Pass null to release it. */
  setHostChannel(channel: string, handler: MentraUIHostChannelHandler | null): void {
    if (handler) this.hostChannels.set(channel, handler)
    else this.hostChannels.delete(channel)
  }

  /**
   * Observe the WebView shim's `ready` envelope. It is posted exactly once per document, so this
   * is the host's signal that a new document exists — unlike `onLoadEnd`, which fires several
   * times per load.
   */
  onWebViewReady(listener: (packageName: string) => void): () => void {
    this.readyListeners.add(listener)
    return () => this.readyListeners.delete(listener)
  }

  /** Observe a background becoming ready for its UI; see {@link backgroundReady}. */
  onBackgroundReady(listener: (packageName: string) => void): () => void {
    this.backgroundReadyListeners.add(listener)
    return () => {
      this.backgroundReadyListeners.delete(listener)
    }
  }

  /** False while a spawned or restarting background has not reported ready. */
  isBackgroundReady(packageName: string): boolean {
    return !this.starting.has(packageName) && !this.restarting.has(packageName)
  }

  /** Answer a `mentra.request` on a host channel. */
  replyToWebView(packageName: string, channel: string, requestId: string, reply: MentraUIHostReply): void {
    const binding = this.bindings.get(packageName)
    if (!binding) return
    this.injectFrame(binding, {type: "msg", seq: 0, channel, requestId, payload: reply})
  }

  /** Push an event on a host channel; the page receives it through `mentra.on(channel)`. */
  pushToWebView(packageName: string, channel: string, payload: unknown): void {
    const binding = this.bindings.get(packageName)
    if (!binding) return
    this.injectFrame(binding, {type: "msg", seq: 0, channel, payload})
  }

  private injectFrame(binding: BoundWebView, frame: Record<string, unknown>): void {
    const literal = JSON.stringify(frame)
    const escaped = JSON.stringify(literal)
    binding.inject(`if (window.__mentra && window.__mentra.recv) window.__mentra.recv(JSON.parse(${escaped})); true;`)
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
   * Called when the host tears down the WebView. Drops the binding and
   * sends UI_CLOSE to the background so handlers can flush state.
   */
  unbindWebView(packageName: string): void {
    if (!this.bindings.has(packageName)) return
    this.bindings.delete(packageName)
    this.backgroundRequests.delete(packageName)
    this.pendingInput.delete(packageName)
    this.uiOpenOwed.delete(packageName)
    this.deliverToBackground(packageName, {type: "UI_CLOSE"})
  }

  /** True iff a WebView is currently bound to the named package. */
  isBound(packageName: string): boolean {
    return this.bindings.has(packageName)
  }

  /** Fail calls owned by the retired context; never replay user mutations. */
  backgroundRestarting(packageName: string): void {
    this.restarting.add(packageName)
    const binding = this.bindings.get(packageName)
    const requestIds = [...(this.backgroundRequests.get(packageName) ?? [])]
    this.backgroundRequests.delete(packageName)
    if (binding) this.injectFrame(binding, {type: "background_restart", requestIds})
    console.warn(`MentraUIRouter: ${packageName} background restarting; UI bound=${!!binding}`)
  }

  /** Terminal recovery/explicit teardown retires input that has no future owner. */
  backgroundStopped(packageName: string): void {
    this.backgroundRestarting(packageName)
    this.stopped.add(packageName)
    this.starting.delete(packageName)
    this.uiOpenOwed.delete(packageName)
    // Requests held for a background that never became ready must not hang.
    for (const raw of this.pendingInput.get(packageName) ?? []) {
      const held = this.parseFrame(raw)
      if (typeof held?.channel !== "string" || typeof held.requestId !== "string") continue
      this.replyToWebView(packageName, held.channel, held.requestId, {
        ok: false,
        error: {code: "BACKGROUND_STOPPED", message: "Miniapp background stopped; request was not delivered"},
      })
    }
    this.pendingInput.delete(packageName)
  }

  /**
   * A background JSContext was spawned. Hold UI_OPEN and every WebView frame
   * until it reports ready: its `session.ui.handle` handlers may be registered
   * after an await in the miniapp's init handler. A respawn after a crash keeps
   * the restart semantics of {@link backgroundRestarting}.
   */
  backgroundStarting(packageName: string): void {
    this.stopped.delete(packageName)
    if (!this.restarting.has(packageName)) this.starting.add(packageName)
  }

  /**
   * The background's init handler settled (READY), it predates READY, or the
   * host stopped waiting. Open the UI, then deliver held input in order.
   */
  backgroundReady(packageName: string): void {
    const wasRestarting = this.restarting.delete(packageName)
    const wasStarting = this.starting.delete(packageName)
    this.stopped.delete(packageName)
    if (!wasRestarting && !wasStarting) return
    const openOwed = this.uiOpenOwed.delete(packageName)
    if (this.bindings.has(packageName) && (wasRestarting || openOwed))
      this.deliverToBackground(packageName, {type: "UI_OPEN"})
    const pending = this.pendingInput.get(packageName) ?? []
    this.pendingInput.delete(packageName)
    for (const raw of pending) this.routeFromWebView(packageName, raw)
    console.log(
      `MentraUIRouter: ${packageName} background ready (${
        wasRestarting ? "restart" : "start"
      }); UI bound=${this.isBound(packageName)} held=${pending.length}`,
    )
    for (const listener of [...this.backgroundReadyListeners]) {
      try {
        listener(packageName)
      } catch (error) {
        console.warn("MentraUIRouter: background ready listener threw", error)
      }
    }
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
    if (!this.isBackgroundReady(packageName)) {
      this.uiOpenOwed.add(packageName)
      return
    }
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
   */
  routeFromWebView(packageName: string, rawJson: string): void {
    const env = this.parseFrame(rawJson)
    if (!env || typeof env.type !== "string") return

    if (env.type === "ready") {
      for (const listener of [...this.readyListeners]) {
        try {
          listener(packageName)
        } catch (error) {
          console.warn("MentraUIRouter: ready listener threw", error)
        }
      }
      if (this.isBackgroundReady(packageName)) this.deliverToBackground(packageName, {type: "UI_OPEN"})
      else this.uiOpenOwed.add(packageName)
      return
    }
    if (env.type === "msg" && typeof env.channel === "string") {
      const hostChannel = this.hostChannels.get(env.channel)
      if (hostChannel) {
        try {
          hostChannel(packageName, {payload: env.payload, requestId: env.requestId})
        } catch (error) {
          console.warn(`MentraUIRouter: host channel ${env.channel} threw`, error)
        }
        return
      }
      // Requests during backoff have no live owner. Reject instead of silently
      // dispatching to the old context or replaying them in the replacement.
      if (this.restarting.has(packageName)) {
        if (typeof env.requestId === "string") {
          this.replyToWebView(packageName, env.channel, env.requestId, {
            ok: false,
            error: {code: "BACKGROUND_RESTARTED", message: "Miniapp background restarting; request was not replayed"},
          })
        } else if (!this.stopped.has(packageName)) {
          // This input has never been delivered; retain it until READY.
          this.holdInput(packageName, rawJson, env)
        }
        return
      }
      // Nothing has reached a starting background yet, so delivering this
      // request once it is ready is its first delivery, not a replay.
      if (this.starting.has(packageName)) {
        this.holdInput(packageName, rawJson, env)
        return
      }
      const out: Record<string, unknown> = {
        type: "UI_MESSAGE",
        channel: env.channel,
        payload: env.payload,
        seq: env.seq,
      }
      if (typeof env.requestId === "string") {
        out.requestId = env.requestId
        let requests = this.backgroundRequests.get(packageName)
        if (!requests) {
          requests = new Set()
          this.backgroundRequests.set(packageName, requests)
        }
        requests.add(env.requestId)
      }
      this.deliverToBackground(packageName, out)
      return
    }
    if (env.type === "cancel" && typeof env.requestId === "string") {
      const held = this.pendingInput.get(packageName)
      const heldIndex = held?.findIndex((raw) => this.parseFrame(raw)?.requestId === env.requestId) ?? -1
      if (held && heldIndex >= 0) {
        held.splice(heldIndex, 1)
        return
      }
      this.backgroundRequests.get(packageName)?.delete(env.requestId)
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

  private parseFrame(rawJson: string): UIFrame | null {
    try {
      const frame = JSON.parse(rawJson) as UIFrame
      return frame && typeof frame === "object" ? frame : null
    } catch {
      return null
    }
  }

  /** Queue an undelivered WebView frame until the background is ready. */
  private holdInput(packageName: string, rawJson: string, env: UIFrame): void {
    let pending = this.pendingInput.get(packageName)
    if (!pending) {
      pending = []
      this.pendingInput.set(packageName, pending)
    }
    // Bound the queue even if the background never becomes ready.
    if (pending.length < 128) {
      pending.push(rawJson)
      return
    }
    if (typeof env.channel === "string" && typeof env.requestId === "string") {
      this.replyToWebView(packageName, env.channel, env.requestId, {
        ok: false,
        error: {code: "BACKGROUND_NOT_READY", message: "Miniapp background is not ready; request was not delivered"},
      })
    } else {
      console.warn(`MentraUIRouter: ${packageName} held input queue full; draft remains in UI`)
    }
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
    if (!binding || this.restarting.has(packageName)) return
    // A background cannot impersonate the host on a reserved channel.
    if (typeof uiSendPayload.channel === "string" && this.hostChannels.has(uiSendPayload.channel)) return
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
    if (typeof uiSendPayload.requestId === "string") {
      this.backgroundRequests.get(packageName)?.delete(uiSendPayload.requestId)
      outbound.requestId = uiSendPayload.requestId
    }
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
