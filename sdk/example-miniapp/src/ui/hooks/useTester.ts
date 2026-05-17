import {useEffect, useRef, useState} from "react"

import "../../shared/channels"
import type {TesterEventPayload} from "../../shared/types"

/**
 * useTester — subscribes to a specific iface's tester event stream and
 * returns the latest event log as React state.
 *
 * Calls `mentra.send("tester:start", {iface})` on mount; `mentra.send(
 * "tester:stop", {iface})` on unmount. Background's TesterController is
 * idempotent — calling start twice yields one underlying subscription.
 *
 * Returned shape:
 *   - `latest`        most recent event for this iface (any kind).
 *   - `latestByKind`  most recent event filtered by `kind`. Pages that
 *                     mix streamed `kind: "update"` events with one-shot
 *                     `kind: "result"` returns (e.g. location: `.onUpdate`
 *                     vs `.getOnce`) use this so the render shape stays
 *                     stable across both event sources.
 *   - `log`           sliding window of the last N events (default 50).
 *   - `lastError`     most recent `kind === "error"` event. Pages should
 *                     render this so bad fire() calls don't silently
 *                     disappear (background dispatches `unknown method`
 *                     errors back as `tester:event {kind:"error"}`).
 *   - `fire`          send a `tester:fire` to this iface.
 */
export function useTester(
  iface: string,
  options: {windowSize?: number} = {},
): {
  latest: TesterEventPayload | null
  latestByKind: (kind: string) => TesterEventPayload | null
  log: TesterEventPayload[]
  lastError: TesterEventPayload | null
  fire: (method: string, args?: unknown[]) => void
} {
  const windowSize = options.windowSize ?? 50
  const [latest, setLatest] = useState<TesterEventPayload | null>(null)
  const [log, setLog] = useState<TesterEventPayload[]>([])
  const [lastError, setLastError] = useState<TesterEventPayload | null>(null)
  const ifaceRef = useRef(iface)
  ifaceRef.current = iface

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

  const fire = (method: string, args: unknown[] = []) => {
    mentra.send("tester:fire", {iface: ifaceRef.current, method, args})
  }

  const latestByKind = (kind: string): TesterEventPayload | null => {
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i]!.kind === kind) return log[i]!
    }
    return null
  }

  return {latest, latestByKind, log, lastError, fire}
}
