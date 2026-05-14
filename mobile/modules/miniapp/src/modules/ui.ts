/**
 * session.ui — message bus between a background JSContext miniapp and
 * its on-demand UI WebView (Phase 3).
 *
 * Asymmetry with the WebView-side `mentra` global:
 *   - `mentra.send` (WebView → background) BUFFERS until `mentra.ready()`
 *     acks. The WebView is the short-lived side and shouldn't drop user
 *     input.
 *   - `session.ui.send` (background → WebView) silently DROPS when no
 *     WebView is bound. Background is the source of truth, persisted in
 *     `session.storage`; UI state shouldn't accumulate stale updates.
 *
 * Channel routing is opaque to the background — names are arbitrary
 * strings on the wire. Per-miniapp `src/shared/channels.ts` declares
 * the typed channel registry at compile time; both halves of the
 * miniapp import that file so message names are type-checked.
 *
 * The host pushes lifecycle envelopes through the existing transport:
 *   - `{type: "UI_OPEN"}` — fired by the WebView's mentra.ready() ack
 *     handler. session.ui.onOpen handlers fire here.
 *   - `{type: "UI_CLOSE"}` — fired by the host when it tears down the
 *     WebView (user navigated away or heartbeat timeout). session.ui.onClose
 *     handlers fire here.
 *   - `{type: "UI_MESSAGE", channel, payload, seq}` — WebView → background.
 *   - `{type: "UI_SEND", channel, payload, seq}` — background → WebView,
 *     sent via session.sendOneShot through the bridge.
 *
 * No request/response correlator at the SDK level — the bus is
 * fire-and-forget. Authors who need request/response semantics
 * implement it themselves using two channels (one for request, one
 * for reply). Decision parked under Phase 5 open questions.
 */

import type {MiniappSession} from "../session"

export type UIChannelHandler<T = unknown> = (payload: T) => void
export type UIUnsubscribe = () => void

/**
 * Public surface mirrored on `session.ui`. Generic over a `Channels`
 * type-map so miniapps importing the typed `shared/channels.ts` get
 * compile-time enforcement on channel names + payload shapes.
 *
 * The default `Record<string, unknown>` mapping lets unannotated usage
 * compile — the SDK doesn't impose a registry of its own.
 */
export interface UIModule<TChannels extends Record<string, unknown> = Record<string, unknown>> {
  /** True iff a WebView is currently bound to this miniapp. */
  isOpen(): boolean

  /**
   * Subscribe to the "WebView mounted + ready()" lifecycle event. If
   * a WebView is already mounted when subscribe() is called, the
   * handler fires immediately for the current binding (mirrors the
   * existing `events.on` "fire-once for late subscribers" behaviour
   * elsewhere in the SDK).
   */
  onOpen(cb: () => void): UIUnsubscribe

  /**
   * Subscribe to the "WebView unmounted" lifecycle event. Fires once
   * per close; if no WebView is bound at subscribe time the handler
   * stays armed for the next mount → close cycle.
   */
  onClose(cb: () => void): UIUnsubscribe

  /**
   * Send a typed message to the bound WebView. Silently drops if no
   * WebView is bound. The host router serialises the envelope and
   * injects it via `webview.injectJavaScript("window.__mentra.recv(...)")`.
   */
  send<C extends keyof TChannels & string>(channel: C, payload: TChannels[C]): void

  /**
   * Subscribe to messages from the bound WebView. The same handler
   * fires for every WebView open/close cycle — registering once is
   * enough. Returns an unsubscribe fn.
   */
  on<C extends keyof TChannels & string>(channel: C, cb: UIChannelHandler<TChannels[C]>): UIUnsubscribe
}

/**
 * Wire-level envelope types. Internal — not exported.
 */
type UISendEnvelope = {
  type: "UI_SEND"
  channel: string
  payload: unknown
  seq: number
}

type UIInboundEnvelope =
  | {type: "UI_MESSAGE"; channel: string; payload: unknown; seq: number}
  | {type: "UI_OPEN"}
  | {type: "UI_CLOSE"}

export class UIModuleImpl<TChannels extends Record<string, unknown> = Record<string, unknown>>
  implements UIModule<TChannels>
{
  /** True between UI_OPEN and the matching UI_CLOSE. */
  private bound = false
  /** Monotonic outbound seq number. Reset on bind. */
  private nextSeq = 1
  /** Open-lifecycle handlers — fire on every UI_OPEN. */
  private readonly openHandlers: Set<() => void> = new Set()
  private readonly closeHandlers: Set<() => void> = new Set()
  /** channel → set of subscribers. */
  private readonly channelHandlers: Map<string, Set<UIChannelHandler>> = new Map()

  constructor(private readonly session: MiniappSession) {
    // The session forwards UI_OPEN / UI_CLOSE / UI_MESSAGE envelopes via
    // its internal stream subscriber surface. The UIModule registers
    // once via session._subscribe to receive them. The "_ui" stream
    // name is internal — not exposed in the public stream list — so
    // the host router knows to route lifecycle frames here without
    // bumping any existing stream type.
    this.session._subscribe("_ui", (env: unknown) => this.handleInbound(env as UIInboundEnvelope))
  }

  isOpen(): boolean {
    return this.bound
  }

  onOpen(cb: () => void): UIUnsubscribe {
    this.openHandlers.add(cb)
    if (this.bound) {
      // Late subscriber — fire once for the current binding so callers
      // that wire onOpen *after* the WebView mounted don't miss it.
      try {
        cb()
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("session.ui.onOpen late-fire threw:", e)
      }
    }
    return () => {
      this.openHandlers.delete(cb)
    }
  }

  onClose(cb: () => void): UIUnsubscribe {
    this.closeHandlers.add(cb)
    return () => {
      this.closeHandlers.delete(cb)
    }
  }

  send<C extends keyof TChannels & string>(channel: C, payload: TChannels[C]): void {
    if (!this.bound) {
      // Per spec: drop silently when no WebView is bound. Background
      // is the source of truth — the WebView re-fetches state on next
      // open via session.ui.onOpen.
      return
    }
    const seq = this.nextSeq++
    const envelope: UISendEnvelope = {type: "UI_SEND", channel, payload, seq}
    this.session.sendOneShot(envelope)
  }

  on<C extends keyof TChannels & string>(channel: C, cb: UIChannelHandler<TChannels[C]>): UIUnsubscribe {
    let set = this.channelHandlers.get(channel as string)
    if (!set) {
      set = new Set()
      this.channelHandlers.set(channel as string, set)
    }
    set.add(cb as UIChannelHandler)
    return () => {
      set!.delete(cb as UIChannelHandler)
    }
  }

  /** @internal — handle UI_OPEN / UI_CLOSE / UI_MESSAGE envelopes from the host. */
  private handleInbound(env: UIInboundEnvelope): void {
    if (env.type === "UI_OPEN") {
      this.bound = true
      this.nextSeq = 1
      for (const h of this.openHandlers) {
        try {
          h()
        } catch (e) {
          // eslint-disable-next-line no-console
        console.warn("session.ui.onOpen handler threw", e)
        }
      }
      return
    }
    if (env.type === "UI_CLOSE") {
      this.bound = false
      for (const h of this.closeHandlers) {
        try {
          h()
        } catch (e) {
          // eslint-disable-next-line no-console
        console.warn("session.ui.onClose handler threw", e)
        }
      }
      return
    }
    if (env.type === "UI_MESSAGE") {
      const set = this.channelHandlers.get(env.channel)
      if (!set || set.size === 0) return
      for (const h of set) {
        try {
          h(env.payload)
        } catch (e) {
          // eslint-disable-next-line no-console
        console.warn(`session.ui.on(${env.channel}) threw`, e)
        }
      }
    }
  }
}
