/**
 * session.ui — message bus between a background JSContext miniapp and
 * its on-demand UI WebView.
 *
 * Buffering on both sides:
 *   - `mentra.send` (WebView → background) BUFFERS until `mentra.ready()`
 *     acks. The WebView is the short-lived side and shouldn't drop user
 *     input.
 *   - `session.ui.send` (background → WebView) silently DROPS when no
 *     WebView is bound. Background is the source of truth, persisted in
 *     `session.storage`; UI state shouldn't accumulate stale updates.
 *   - When a WebView IS bound but its `mentra.on(channel, ...)` listener
 *     for a given channel hasn't attached yet (common: the controller's
 *     `ui.onOpen` handler fires a snapshot before React useEffects have
 *     run), the WebView shim buffers per-channel up to 32 payloads and
 *     drains them into the first subscriber. After that first drain the
 *     channel is "live" and sends with no listener fall back to drop —
 *     a later re-subscribe does NOT replay history.
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
 * for reply).
 */

import type {MiniappSession} from "../session"

export type UIChannelHandler<T = unknown> = (payload: T) => void
export type UIUnsubscribe = () => void

/**
 * Brand for declaring an RPC channel in the shared Channels registry.
 *
 * Wrap a channel's payload type in `Rpc<Req, Res>` to mark it as
 * request/response. The SDK's `mentra.request` / `session.ui.handle`
 * accept only `Rpc<...>` channels; `mentra.send` / `session.ui.on`
 * accept only non-RPC channels. Using the wrong API for the wrong
 * channel is a compile-time error.
 *
 *   export interface Channels {
 *     "live-transcript": {text: string}                    // broadcast
 *     "compute-route":   Rpc<RouteOpts, RouteResult>       // RPC
 *   }
 */
declare const __rpc_brand: unique symbol
export type Rpc<Req, Res> = {readonly [__rpc_brand]: true; readonly req: Req; readonly res: Res}

/** True if `T` is an `Rpc<...>` channel entry. */
export type IsRpc<T> = T extends Rpc<unknown, unknown> ? true : false
/** Request payload type of an `Rpc<Req, Res>` entry. */
export type RpcReq<T> = T extends Rpc<infer Req, unknown> ? Req : never
/** Response payload type of an `Rpc<Req, Res>` entry. */
export type RpcRes<T> = T extends Rpc<unknown, infer Res> ? Res : never

/** Options accepted by `mentra.request`. */
export interface RpcRequestOptions {
  /** Abort the in-flight call. Sends UI_CANCEL to the handler. */
  signal?: AbortSignal
  /** Reject with `MentraRpcTimeoutError` after this many ms. No default. */
  timeout?: number
}

/** Context passed as the optional 2nd arg to an `ui.handle` handler. */
export interface RpcHandlerContext {
  /** Aborts when the UI side cancels the call (or its timeout fires). */
  signal: AbortSignal
}

/**
 * Error thrown by `mentra.request` when the handler threw or returned an
 * error envelope. Plain `Error` subclass — distinguished by `err.name`.
 * `err.cause` is `{code?: string}` if the handler attached one.
 */
export class MentraRpcError extends Error {
  constructor(message: string, options?: {cause?: {code?: string}}) {
    super(message)
    this.name = "MentraRpcError"
    // Assign `cause` directly: the package's tsconfig targets ES2020 lib
    // where `Error`'s ctor is typed as 1-arity (no `ErrorOptions`).
    // Modern JS engines still allow setting `cause` as a plain property.
    if (options?.cause !== undefined) {
      ;(this as Error & {cause?: unknown}).cause = options.cause
    }
  }
}

/** Thrown by `mentra.request` when its `{timeout}` elapses. */
export class MentraRpcTimeoutError extends Error {
  constructor(message = "RPC timed out") {
    super(message)
    this.name = "MentraRpcTimeoutError"
  }
}

/**
 * Public surface mirrored on `session.ui`. Generic over a `Channels`
 * type-map so miniapps importing the typed `shared/channels.ts` get
 * compile-time enforcement on channel names + payload shapes.
 *
 * Broadcast vs. RPC channels are distinguished at the type level:
 *   - Channel value `Rpc<Req, Res>` → only `handle()` accepts it on
 *     background; only `mentra.request(...)` accepts it on UI.
 *   - Channel value anything else   → only `send()`/`on()` accept it
 *     on both sides.
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
   * handler fires immediately for the current binding.
   */
  onOpen(cb: () => void): UIUnsubscribe

  /**
   * Subscribe to the "WebView unmounted" lifecycle event. Fires once
   * per close; if no WebView is bound at subscribe time the handler
   * stays armed for the next mount → close cycle.
   */
  onClose(cb: () => void): UIUnsubscribe

  /**
   * Broadcast a typed message to the bound WebView. Silently drops if
   * no WebView is bound. Compile-error if `C` is an RPC channel.
   */
  send<C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? never : C,
    payload: TChannels[C],
  ): void

  /**
   * Subscribe to broadcast messages from the bound WebView. Returns an
   * unsubscribe fn. Compile-error if `C` is an RPC channel — use
   * `handle()` for RPC channels.
   */
  on<C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? never : C,
    cb: UIChannelHandler<TChannels[C]>,
  ): UIUnsubscribe

  /**
   * Register the single handler for an RPC channel. The UI side calls
   * `mentra.request(channel, payload, options?)`; this handler resolves
   * the call.
   *
   * Throws synchronously if a handler is already registered for the
   * channel. Returns a deregister fn that removes the handler.
   *
   * Compile-error if `C` is a broadcast (non-Rpc) channel.
   */
  handle<C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? C : never,
    handler: (
      payload: RpcReq<TChannels[C]>,
      ctx?: RpcHandlerContext,
    ) => Promise<RpcRes<TChannels[C]>> | RpcRes<TChannels[C]>,
  ): UIUnsubscribe
}

/**
 * Wire-level envelope types. Internal — not exported.
 *
 * `requestId` is set on RPC frames (call, result, cancel). Broadcast
 * `UI_MESSAGE` / `UI_SEND` frames carry no `requestId`. `UI_CANCEL`
 * frames carry only `requestId` (no channel, no payload).
 */
type UISendEnvelope =
  | {type: "UI_SEND"; channel: string; payload: unknown; seq: number; requestId?: string}
  | {type: "UI_CANCEL"; requestId: string}

type UIInboundEnvelope =
  | {type: "UI_MESSAGE"; channel: string; payload: unknown; seq: number; requestId?: string}
  | {type: "UI_OPEN"}
  | {type: "UI_CLOSE"}
  | {type: "UI_CANCEL"; requestId: string}

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

  // All public methods are arrow-property bindings so destructuring
  // (`const {send} = session.ui` or passing `ui.send` as a callback) is
  // safe. Otherwise `this.bound` evaluates as undefined and crashes the
  // JSContext on the first call, which the host turns into a crashloop
  // incident report. The footgun isn't hypothetical — the SDK tester's
  // controller hit it before this fix landed.
  isOpen = (): boolean => {
    return this.bound
  }

  onOpen = (cb: () => void): UIUnsubscribe => {
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

  onClose = (cb: () => void): UIUnsubscribe => {
    this.closeHandlers.add(cb)
    return () => {
      this.closeHandlers.delete(cb)
    }
  }

  send = <C extends keyof TChannels & string>(channel: C, payload: TChannels[C]): void => {
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

  on = <C extends keyof TChannels & string>(
    channel: C,
    cb: UIChannelHandler<TChannels[C]>,
  ): UIUnsubscribe => {
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
