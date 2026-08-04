/**
 * @fileoverview ActionsModule — `session.actions`.
 *
 * The MCP-shaped capability layer, both directions:
 *   - `invoke(pkg, actionId, params)` — call another miniapp's declared action.
 *     SYSTEM-only; headless-wakes the target if it's stopped.
 *   - `handle(actionId, fn)` — expose one of your own actions. Open to all
 *     miniapps. Mirrors `session.ui.handle` (one handler per id, throws on
 *     double-register, errors propagate to the caller).
 *
 * `invoke` ↔ `handle` are the two ends of one wire (keyed by `actionId`), which
 * is why they share this namespace rather than being split across
 * `session.miniapps`.
 */

import {MiniappErrorCode, MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

/** Context handed to an action handler. `callerPackageName` is host-stamped. */
export interface ActionContext {
  /** The package that invoked this action (trustworthy — set by the host). */
  callerPackageName: string
}

export type ActionHandler = (params: Record<string, unknown>, ctx: ActionContext) => unknown | Promise<unknown>

export interface InvokeOptions {
  /** Overall timeout in ms (default 30s, max 120s — host-enforced). */
  timeoutMs?: number
}

interface BufferedCall {
  callId: string
  params: Record<string, unknown>
  ctx: ActionContext
  timer: ReturnType<typeof setTimeout>
}

/**
 * How long the SDK holds an inbound ACTION_CALL waiting for its handler to
 * register (a just-woken miniapp registers handlers a beat after CONNECT).
 * If no handler appears in this window the call is failed with
 * NO_ACTION_HANDLER. Mirrors the UI bus's pre-handler buffering.
 */
const HANDLER_WAIT_MS = 5_000

export class ActionsModule {
  private readonly handlers = new Map<string, ActionHandler>()
  /** Inbound calls buffered until their handler registers, keyed by actionId. */
  private readonly buffered = new Map<string, BufferedCall[]>()

  constructor(private readonly session: MiniappSession) {}

  /**
   * Invoke a declared action on another miniapp. Resolves with the handler's
   * return value, rejects with a MiniappRequestError (NOT_PERMITTED,
   * APP_NOT_FOUND, ACTION_NOT_FOUND, WAKE_FAILED, NO_ACTION_HANDLER,
   * ACTION_TIMEOUT, PAYLOAD_TOO_LARGE, or the handler's own error). SYSTEM-only.
   */
  invoke<TResult = unknown>(
    packageName: string,
    actionId: string,
    params?: Record<string, unknown>,
    opts?: InvokeOptions,
  ): Promise<TResult> {
    return this.session.sendRequest<TResult>({
      type: MiniappRequestType.ACTION_INVOKE,
      targetPackageName: packageName,
      actionId,
      params: params ?? {},
      ...(opts?.timeoutMs != null ? {timeoutMs: opts.timeoutMs} : {}),
    })
  }

  /**
   * Register a handler for one of this miniapp's declared actions. One handler
   * per actionId — throws synchronously on double-register. The returned
   * function unregisters. Declare the action in `miniapp.json` for it to be
   * invokable; an undeclared id still registers but the host never routes to it.
   */
  handle(actionId: string, handler: ActionHandler): () => void {
    if (this.handlers.has(actionId)) {
      throw new Error(`session.actions.handle: a handler is already registered for "${actionId}"`)
    }
    this.handlers.set(actionId, handler)

    // Flush any calls that arrived before this handler registered.
    const waiting = this.buffered.get(actionId)
    if (waiting) {
      this.buffered.delete(actionId)
      for (const call of waiting) {
        clearTimeout(call.timer)
        void this.dispatch(call.callId, actionId, call.params, call.ctx)
      }
    }

    return () => {
      if (this.handlers.get(actionId) === handler) this.handlers.delete(actionId)
    }
  }

  /**
   * @internal — called by MiniappSession.handleIncoming on an ACTION_CALL.
   * Routes to the registered handler, or buffers briefly for one to appear.
   */
  _deliver(callId: string, actionId: string, params: Record<string, unknown>, ctx: ActionContext): void {
    if (this.handlers.has(actionId)) {
      void this.dispatch(callId, actionId, params, ctx)
      return
    }
    // No handler yet — buffer, and fail with NO_ACTION_HANDLER if none registers.
    const timer = setTimeout(() => {
      const arr = this.buffered.get(actionId)
      if (arr) {
        const idx = arr.findIndex((c) => c.callId === callId)
        if (idx >= 0) arr.splice(idx, 1)
        if (arr.length === 0) this.buffered.delete(actionId)
      }
      this.sendResult(callId, false, undefined, {
        code: MiniappErrorCode.NO_ACTION_HANDLER,
        message: `No handler registered for action "${actionId}"`,
      })
    }, HANDLER_WAIT_MS)
    const arr = this.buffered.get(actionId) ?? []
    arr.push({callId, params, ctx, timer})
    this.buffered.set(actionId, arr)
  }

  private async dispatch(
    callId: string,
    actionId: string,
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<void> {
    const handler = this.handlers.get(actionId)
    if (!handler) return
    try {
      const result = await handler(params, ctx)
      this.sendResult(callId, true, result ?? null)
    } catch (e) {
      this.sendResult(callId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: (e as Error)?.message ?? "action handler threw",
      })
    }
  }

  private sendResult(callId: string, ok: boolean, result?: unknown, error?: {code: string; message: string}): void {
    this.session.sendOneShot({
      type: MiniappRequestType.ACTION_RESULT,
      callId,
      ok,
      ...(ok ? {result} : {error}),
    })
  }
}
