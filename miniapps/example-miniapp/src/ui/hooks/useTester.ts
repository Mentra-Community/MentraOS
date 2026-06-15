import {useEffect, useRef, useState} from "react"
import {useRpc} from "@mentra/miniapp/ui"

import "../../shared/channels"
import type {Channels} from "../../shared/channels"
import type {TesterEventPayload} from "../../shared/types"

/**
 * useTester — manages a subscribe-based tester (start/stop + streamed
 * events) and exposes an `invoke(method, args)` RPC for imperative calls.
 *
 *   - `latest`, `latestByKind(kind)`, `log`, `lastError` — streamed via
 *     `tester:event` from the background controller.
 *   - `invoke(method, args)` — `mentra.request("tester:invoke", ...)`.
 *     Returns the handler's return value; throws on error.
 */
export function useTester(
  iface: string,
  options: {windowSize?: number} = {},
): {
  latest: TesterEventPayload | null
  latestByKind: (kind: string) => TesterEventPayload | null
  log: TesterEventPayload[]
  lastError: TesterEventPayload | null
  invoke: (method: string, args?: unknown[]) => Promise<unknown>
} {
  // Guard against 0 / negative — those disable trimming and let the log
  // grow unbounded (`slice(-0)` returns the whole array).
  const windowSize = Math.max(1, options.windowSize ?? 50)
  const [latest, setLatest] = useState<TesterEventPayload | null>(null)
  const [log, setLog] = useState<TesterEventPayload[]>([])
  const [lastError, setLastError] = useState<TesterEventPayload | null>(null)
  const ifaceRef = useRef(iface)
  ifaceRef.current = iface
  const rpcInvoke = useRpc<Channels, "tester:invoke">("tester:invoke")

  useEffect(() => {
    // Switching iface re-subscribes; clear the previous iface's state so a
    // stale latest/log/lastError can't bleed into the new tester surface.
    setLatest(null)
    setLog([])
    setLastError(null)
    mentra.send("tester:start", {iface})
    const unsub = mentra.on("tester:event", (raw) => {
      const ev = raw as TesterEventPayload
      if (ev.iface !== ifaceRef.current) return
      setLatest(ev)
      if (ev.kind === "error") setLastError(ev)
      setLog((prev) => {
        const next = [...prev, ev]
        return next.length > windowSize ? next.slice(-windowSize) : next
      })
    })
    return () => {
      unsub()
      mentra.send("tester:stop", {iface})
    }
  }, [iface, windowSize])

  const invoke = async (method: string, args: unknown[] = []) => {
    try {
      return await rpcInvoke({iface: ifaceRef.current, method, args})
    } catch (err) {
      // Surface error in the existing UI error slot so pages don't need
      // a separate try/catch boilerplate.
      setLastError({
        iface: ifaceRef.current,
        kind: "error",
        payload: {method, message: err instanceof Error ? err.message : String(err)},
      })
      throw err
    }
  }

  const latestByKind = (kind: string): TesterEventPayload | null => {
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i]!.kind === kind) return log[i]!
    }
    return null
  }

  return {latest, latestByKind, log, lastError, invoke}
}
