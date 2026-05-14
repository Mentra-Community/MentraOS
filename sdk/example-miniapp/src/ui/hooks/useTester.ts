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
 * `latest` is the most recent event for this iface. `log` is a sliding
 * window of the last N events (default 50). Callers that only need the
 * latest can ignore `log` and TS will elide it from output.
 */
export function useTester(
  iface: string,
  options: {windowSize?: number} = {},
): {latest: TesterEventPayload | null; log: TesterEventPayload[]; fire: (method: string, args?: unknown[]) => void} {
  const windowSize = options.windowSize ?? 50
  const [latest, setLatest] = useState<TesterEventPayload | null>(null)
  const [log, setLog] = useState<TesterEventPayload[]>([])
  const ifaceRef = useRef(iface)
  ifaceRef.current = iface

  useEffect(() => {
    mentra.send("tester:start", {iface})
    const unsub = mentra.on("tester:event", (raw) => {
      const ev = raw as TesterEventPayload
      if (ev.iface !== ifaceRef.current) return
      setLatest(ev)
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

  return {latest, log, fire}
}
