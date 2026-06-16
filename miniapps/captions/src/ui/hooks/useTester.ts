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
  status: InvokeStatus
} {
  const windowSize = options.windowSize ?? 50
  const [latest, setLatest] = useState<TesterEventPayload | null>(null)
  const [log, setLog] = useState<TesterEventPayload[]>([])
  const [lastError, setLastError] = useState<TesterEventPayload | null>(null)
  const ifaceRef = useRef(iface)
  ifaceRef.current = iface
  const rpcInvoke = useRpc<Channels, "tester:invoke">("tester:invoke")

  useEffect(() => {
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

  // Live invoke status so a page can show "running…" the instant a button is
  // tapped and the precise failure the instant it fails — no silent hang while
  // a request is in flight, which is the single most confusing dev experience.
  const [status, setStatus] = useState<InvokeStatus>({phase: "idle"})

  const invoke = async (method: string, args: unknown[] = []) => {
    const startedAt = Date.now()
    setStatus({phase: "running", method, startedAt})
    try {
      const result = await rpcInvoke({iface: ifaceRef.current, method, args})
      setStatus({phase: "ok", method, startedAt, ms: Date.now() - startedAt})
      return result
    } catch (err) {
      // The host returns structured failures ({code, message, stage, transport}).
      // Preserve every field so the UI can name exactly where and on which
      // transport it broke, not just a flattened message string.
      const detail = errorDetail(err)
      setLastError({
        iface: ifaceRef.current,
        kind: "error",
        payload: {method, ...detail},
      })
      setStatus({phase: "error", method, startedAt, ms: Date.now() - startedAt, ...detail})
      throw err
    }
  }

  const latestByKind = (kind: string): TesterEventPayload | null => {
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i]!.kind === kind) return log[i]!
    }
    return null
  }

  return {latest, latestByKind, log, lastError, invoke, status}
}

export type InvokeStatus =
  | {phase: "idle"}
  | {phase: "running"; method: string; startedAt: number}
  | {phase: "ok"; method: string; startedAt: number; ms: number}
  | ({phase: "error"; method: string; startedAt: number; ms: number} & ErrorDetail)

interface ErrorDetail {
  message: string
  /** Machine code from the host, e.g. PHOTO_REQUEST_FAILED, GLASSES_NOT_CONNECTED. */
  code?: string
  /** Pipeline stage that failed: presign | command | capture | upload | push. */
  stage?: string
  /** Transport in play when it failed: cloud-rest | ble | wifi | ws | udp. */
  transport?: string
}

/** Pull every diagnostic field out of whatever the host threw. */
function errorDetail(err: unknown): ErrorDetail {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>
    return {
      message: typeof e.message === "string" ? e.message : String(err),
      code: typeof e.code === "string" ? e.code : undefined,
      stage: typeof e.stage === "string" ? e.stage : undefined,
      transport: typeof e.transport === "string" ? e.transport : undefined,
    }
  }
  return {message: String(err)}
}
