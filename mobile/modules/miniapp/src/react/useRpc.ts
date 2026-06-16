/**
 * useRpc — React hook around `mentra.request(channel, ...)`.
 *
 * Returns a stable callable plus an `.abort()` method. The internal
 * AbortController is recreated per call and bound to component lifecycle:
 *
 *   - Calling the returned function once: abort() the previous in-flight
 *     call (if any), then issue a fresh request. Useful for per-keystroke
 *     autocomplete — every keystroke aborts the stale request.
 *   - Unmount: all in-flight calls abort.
 *   - Caller-provided `options.signal` is merged with the internal one
 *     via `AbortSignal.any` when available; manual fan-out otherwise.
 */

import {useCallback, useEffect, useRef} from "react"

import type {RpcReq, RpcRes, RpcRequestOptions} from "../modules/ui"

type RequestFn = (channel: string, payload: unknown, options?: RpcRequestOptions) => Promise<unknown>

/** Walk to the global `mentra.request` (typed). */
function getMentraRequest(): RequestFn {
  const m = (globalThis as unknown as {mentra?: {request?: RequestFn}}).mentra
  if (!m || typeof m.request !== "function") {
    throw new Error(
      "useRpc: window.mentra.request is not available — is this miniapp running in a UI WebView with the shim injected?",
    )
  }
  return m.request
}

/** AbortSignal.any polyfill — combine multiple signals into one. */
function mergeSignals(signals: AbortSignal[]): AbortSignal {
  type WithAny = {any?: (s: AbortSignal[]) => AbortSignal}
  const ctor = AbortSignal as unknown as WithAny
  if (typeof ctor.any === "function") return ctor.any(signals)
  const ctrl = new AbortController()
  const onAbort = (sig: AbortSignal) => {
    if (!ctrl.signal.aborted) ctrl.abort(sig.reason)
  }
  for (const s of signals) {
    if (s.aborted) {
      onAbort(s)
      break
    }
    s.addEventListener("abort", () => onAbort(s))
  }
  return ctrl.signal
}

export interface RpcCallable<TChannels extends object, C extends keyof TChannels & string> {
  (payload: RpcReq<TChannels[C]>, options?: RpcRequestOptions): Promise<RpcRes<TChannels[C]>>
  /** Abort the current in-flight call (if any). No-op if nothing is pending. */
  abort(): void
}

/**
 * Returns a stable callable for an RPC channel. The callable auto-aborts
 * on unmount and exposes `.abort()` for cancel-previous patterns.
 *
 *   const autocomplete = useRpc<Channels, "places:autocomplete">("places:autocomplete")
 *   const suggestions = await autocomplete({query: "..."})
 *   autocomplete.abort()   // cancel the latest in-flight call
 */
export function useRpc<
  TChannels extends object,
  C extends keyof TChannels & string,
>(channel: C): RpcCallable<TChannels, C> {
  // Latest in-flight controller. Replaced on each call.
  const currentRef = useRef<AbortController | null>(null)
  // Mount controller — aborts every in-flight call on unmount.
  const mountRef = useRef<AbortController | null>(null)
  if (mountRef.current == null) mountRef.current = new AbortController()

  useEffect(() => {
    const mount = mountRef.current!
    return () => {
      mount.abort()
      currentRef.current?.abort()
      currentRef.current = null
    }
  }, [])

  const callable = useCallback(
    (payload: RpcReq<TChannels[C]>, options?: RpcRequestOptions) => {
      // Abort any previous call for this hook.
      currentRef.current?.abort()
      const ctrl = new AbortController()
      currentRef.current = ctrl
      const signals: AbortSignal[] = [ctrl.signal, mountRef.current!.signal]
      if (options?.signal) signals.push(options.signal)
      const signal = mergeSignals(signals)
      return getMentraRequest()(channel, payload, {signal, timeout: options?.timeout}) as Promise<
        RpcRes<TChannels[C]>
      >
    },
    [channel],
  ) as RpcCallable<TChannels, C>

  callable.abort = () => {
    currentRef.current?.abort()
    currentRef.current = null
  }

  return callable
}
