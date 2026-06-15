import {useCallback, useState} from "react"

export type LogEntry = {id: number; time: string; text: string; level: "info" | "error"}

let nextId = 0

function stamp(): string {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Tiny in-memory console so the demo's button results are visible on-device
 * without a Metro terminal attached. Keeps the most recent entries only.
 */
export function useLog(max = 60) {
  const [entries, setEntries] = useState<LogEntry[]>([])

  const push = useCallback(
    (text: string, level: LogEntry["level"]) => {
      setEntries((prev) => [{id: nextId++, time: stamp(), text, level}, ...prev].slice(0, max))
    },
    [max],
  )

  const log = useCallback((text: string) => push(text, "info"), [push])
  const logError = useCallback((text: string) => push(text, "error"), [push])
  const clear = useCallback(() => setEntries([]), [])

  /** Run an async SDK call, logging its label, result, and any error. */
  const run = useCallback(
    async (label: string, fn: () => Promise<unknown> | unknown) => {
      log(`▶ ${label}`)
      try {
        const result = await fn()
        if (result === undefined || result === null) {
          log(`✓ ${label}`)
        } else if (typeof result === "object") {
          log(`✓ ${label} → ${JSON.stringify(result)}`)
        } else {
          log(`✓ ${label} → ${String(result)}`)
        }
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logError(`✗ ${label} → ${message}`)
        return undefined
      }
    },
    [log, logError],
  )

  return {entries, log, logError, clear, run}
}
