/**
 * session.ui — bus between a background JSContext miniapp and its
 * on-demand UI WebView. Supports two interaction patterns:
 *
 *   1. **Broadcast** (fire-and-forget, either direction)
 *      - background → UI: `session.ui.send(channel, payload)`
 *      - UI → background: `mentra.send(channel, payload)`
 *      - subscribe:        `session.ui.on(channel, cb)` / `mentra.on(channel, cb)`
 *
 *   2. **RPC** (request/response, UI → background only)
 *      - UI side:          `await mentra.request(channel, payload, options?)`
 *      - background side:  `session.ui.handle(channel, (payload, ctx?) => result)`
 *      - single handler per channel; double-register throws synchronously.
 *      - errors thrown in the handler reject the caller's promise.
 *      - cancellation via `options.signal` aborts the handler's `ctx.signal`
 *        and drops the eventual reply.
 *
 * Broadcast vs. RPC is declared at the channel level: wrap a channel's
 * payload type in `Rpc<Req, Res>` in the shared registry to make it RPC.
 * Wrong-API-for-channel is a compile-time error.
 *
 * Buffering:
 *   - `mentra.send` BUFFERS until `mentra.ready()` acks. The WebView is
 *     the short-lived side and shouldn't drop user input.
 *   - `session.ui.send` silently DROPS when no WebView is bound.
 *     Background is the source of truth; UI state shouldn't accumulate.
 *   - Per-channel inbound buffering (up to 32 payloads) covers the
 *     `controller pushed before React attached the listener` race — see
 *     the WebView shim for details.
 *
 * Wire envelopes (internal — not part of the SDK surface):
 *   - `UI_OPEN` — WebView posted `{type:"ready"}`.
 *   - `UI_CLOSE` — host tore down the WebView.
 *   - `UI_MESSAGE` — WebView → background. `requestId` set on RPC calls.
 *   - `UI_SEND` — background → WebView. `requestId` set on RPC replies.
 *   - `UI_CANCEL` — either direction. Carries only `requestId`; aborts
 *     the in-flight handler's signal.
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
export interface UIModule<TChannels extends object = Record<string, unknown>> {
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

function rpcErrorFromUnknown(e: unknown): RpcErrorEnvelope {
  if (e instanceof Error) {
    // `cause` is ES2022; this package's lib targets ES2020 where Error
    // has no `cause` field. Read it via a structural cast. Diagnostic fields
    // (code/stage/transport) may live as own props (PhotoError-style) or on
    // the cause — own props win.
    const own = e as Error & {code?: string; stage?: string; transport?: string; cause?: unknown}
    const cause = own.cause as {code?: string} | undefined
    return compactEnvelope({
      message: e.message,
      code: own.code ?? cause?.code,
      stage: own.stage,
      transport: own.transport,
    })
  }
  if (e && typeof e === "object") {
    // Hosts reject RPCs with plain structured objects ({code, message, stage,
    // transport}); stringifying them produced the infamous "[object Object]".
    const o = e as {message?: unknown; code?: unknown; stage?: unknown; transport?: unknown}
    return compactEnvelope({
      message: typeof o.message === "string" ? o.message : JSON.stringify(e),
      code: typeof o.code === "string" ? o.code : undefined,
      stage: typeof o.stage === "string" ? o.stage : undefined,
      transport: typeof o.transport === "string" ? o.transport : undefined,
    })
  }
  return {message: String(e)}
}

export interface RpcErrorEnvelope {
  message: string
  code?: string
  stage?: string
  transport?: string
}

function compactEnvelope(env: RpcErrorEnvelope): RpcErrorEnvelope {
  const out: RpcErrorEnvelope = {message: env.message}
  if (env.code) out.code = env.code
  if (env.stage) out.stage = env.stage
  if (env.transport) out.transport = env.transport
  return out
}

export class UIModuleImpl<TChannels extends object = Record<string, unknown>>
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

  /** channel → single registered RPC handler. */
  private readonly rpcHandlers: Map<
    string,
    (payload: unknown, ctx: RpcHandlerContext) => Promise<unknown> | unknown
  > = new Map()

  /** requestId → AbortController for in-flight RPC handler invocations. */
  private readonly inflightRpc: Map<string, AbortController> = new Map()

  constructor(private readonly session: MiniappSession) {
    // The session forwards UI_OPEN / UI_CLOSE / UI_MESSAGE envelopes via
    // its internal stream subscriber surface. The UIModule registers
    // once via session._subscribe to receive them. The "_ui" stream
    // name is internal — not exposed in the public stream list — so
    // the host router knows to route lifecycle frames here without
    // bumping any existing stream type.
    this.session._subscribe("_ui", (env: unknown) => this.handleInbound(env as UIInboundEnvelope))
  }

  // Arrow-property bindings make every public method safe to destructure
  // (`const {send} = session.ui`) or pass as a bare callback — a plain
  // method loses `this` and crashes on `this.bound`.
  isOpen = (): boolean => {
    return this.bound
  }

  onOpen = (cb: () => void): UIUnsubscribe => {
    this.openHandlers.add(cb)
    if (this.bound) {
      // Late subscriber — fire once for the current binding so callers
      // that wire onOpen *after* the WebView mounted don't miss it.
      // Gate on session readiness for the same reason handleInbound does:
      // a late onOpen must still observe populated capabilities, not the
      // pre-CONNECT_ACK null snapshot. If not yet ready, the "ready"
      // listener registered in handleInbound's UI_OPEN branch will fan
      // out to every openHandler (this one included), so we don't wire a
      // second listener here.
      if (this.session.ready) {
        try {
          cb()
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("session.ui.onOpen late-fire threw:", e)
        }
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

  handle = <C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? C : never,
    handler: (
      payload: RpcReq<TChannels[C]>,
      ctx?: RpcHandlerContext,
    ) => Promise<RpcRes<TChannels[C]>> | RpcRes<TChannels[C]>,
  ): UIUnsubscribe => {
    const key = channel as unknown as string
    if (this.rpcHandlers.has(key)) {
      throw new Error(`session.ui.handle: a handler is already registered for "${key}"`)
    }
    this.rpcHandlers.set(
      key,
      handler as unknown as (payload: unknown, ctx: RpcHandlerContext) => Promise<unknown> | unknown,
    )
    return () => {
      this.rpcHandlers.delete(key)
    }
  }

  /** Fire every registered open handler once. Guarded per-handler. */
  private fireOpenHandlers(): void {
    for (const h of this.openHandlers) {
      try {
        h()
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("session.ui.onOpen handler threw", e)
      }
    }
  }

  /** @internal — handle UI_OPEN / UI_CLOSE / UI_MESSAGE envelopes from the host. */
  private handleInbound(env: UIInboundEnvelope): void {
    if (env.type === "UI_OPEN") {
      this.bound = true
      this.nextSeq = 1
      // onOpen handlers almost always read session.capabilities /
      // session.ready to hydrate the fresh WebView. The WebView's
      // `mentra.ready()` (which produces this UI_OPEN) races the
      // background session's CONNECT_ACK — on a fast bridge UI_OPEN can
      // arrive first, leaving capabilities null and the UI rendering a
      // "no glasses" snapshot that never self-corrects. Gate the open
      // fan-out on session readiness so handlers always observe a
      // populated session. The WebView is marked bound immediately
      // (send/isOpen work, inbound stays buffered) — only the open
      // callbacks wait.
      if (this.session.ready) {
        this.fireOpenHandlers()
      } else {
        const off = this.session.on("ready", () => {
          off()
          // If the WebView closed during the connect window, don't fire
          // stale open handlers — a later UI_OPEN will re-trigger them.
          if (this.bound) this.fireOpenHandlers()
        })
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
      // RPC call: requestId set → dispatch to handle() handler.
      if (typeof env.requestId === "string") {
        this.dispatchRpcCall(env.channel, env.payload, env.requestId)
        return
      }
      // Broadcast: fan out to on() subscribers.
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
      return
    }
    if (env.type === "UI_CANCEL") {
      const ctrl = this.inflightRpc.get(env.requestId)
      if (ctrl) {
        try {
          ctrl.abort()
        } catch {
          /* ignore */
        }
      }
      return
    }
  }

  /** @internal — invoke a registered RPC handler and send back the reply. */
  private dispatchRpcCall(channel: string, payload: unknown, requestId: string): void {
    const handler = this.rpcHandlers.get(channel)
    if (!handler) {
      // No handler registered. Reply with a structured error so the
      // UI's request promise rejects with a useful message.
      this.sendRpcReply(channel, requestId, {
        ok: false,
        error: {message: `no handler registered for "${channel}"`},
      })
      return
    }
    const ctrl = new AbortController()
    this.inflightRpc.set(requestId, ctrl)
    const ctx: RpcHandlerContext = {signal: ctrl.signal}

    const finish = (
      envelope:
        | {ok: true; result: unknown}
        | {ok: false; error: RpcErrorEnvelope},
    ): void => {
      this.inflightRpc.delete(requestId)
      // If the controller already aborted (UI cancelled), drop the
      // reply — the UI side has already removed its listener.
      if (ctrl.signal.aborted) return
      this.sendRpcReply(channel, requestId, envelope)
    }

    let result: unknown
    try {
      result = handler(payload, ctx)
    } catch (e) {
      finish({ok: false, error: rpcErrorFromUnknown(e)})
      return
    }
    if (result && typeof (result as {then?: unknown}).then === "function") {
      ;(result as Promise<unknown>).then(
        (v) => finish({ok: true, result: v}),
        (e) => finish({ok: false, error: rpcErrorFromUnknown(e)}),
      )
    } else {
      finish({ok: true, result})
    }
  }

  /** @internal — send a UI_SEND envelope tagged with a requestId. */
  private sendRpcReply(
    channel: string,
    requestId: string,
    payload:
      | {ok: true; result: unknown}
      | {ok: false; error: RpcErrorEnvelope},
  ): void {
    if (!this.bound) return
    const seq = this.nextSeq++
    const envelope: UISendEnvelope = {type: "UI_SEND", channel, payload, seq, requestId}
    this.session.sendOneShot(envelope)
  }
}
