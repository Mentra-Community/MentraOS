// Test/benchmark infrastructure. Gated behind Super Mode (the stress-test
// screen is the only writer in normal flow). Empty store with zero impact
// on production code paths until a stress test is run.

import {create} from "zustand"

export interface JetsamEvent {
  packageName: string
  /** ms since epoch */
  at: number
  /** "terminate" = WebView Web Content Process kill, "memwarn" = JS memoryWarning event */
  kind: "terminate" | "memwarn" | "error"
}

interface StressTestState {
  /** Set true while a stress run is in progress; gates console.log("STRESS:", …) lines */
  active: boolean
  /** When the current run started (ms since epoch) */
  startedAt: number | null
  /** All jetsam-style events seen since boot. Capped to the last 1000. */
  events: JetsamEvent[]
  /** Process resident memory in MB, last sampled value. -1 if unknown. */
  residentMB: number
  /** Count of memory-warning events from RN AppState since boot. */
  memWarnCount: number

  start: () => void
  stop: () => void
  recordEvent: (e: JetsamEvent) => void
  setResidentMB: (mb: number) => void
}

export const useStressTestStore = create<StressTestState>((set) => ({
  active: false,
  startedAt: null,
  events: [],
  residentMB: -1,
  memWarnCount: 0,

  start: () => set({active: true, startedAt: Date.now()}),
  stop: () => set({active: false}),

  recordEvent: (e) =>
    set((s) => {
      const events = [...s.events, e].slice(-1000)
      const memWarnCount = e.kind === "memwarn" ? s.memWarnCount + 1 : s.memWarnCount
      // STRESS: structured log line so a CLI can grep these out of `log stream`
      // even when the screen isn't open. Cheap and one-line on purpose.
      // eslint-disable-next-line no-console
      console.log(
        `STRESS: event ${JSON.stringify({...e, residentMB: s.residentMB, memWarnCount})}`,
      )
      return {events, memWarnCount}
    }),

  setResidentMB: (mb) => set({residentMB: mb}),
}))
