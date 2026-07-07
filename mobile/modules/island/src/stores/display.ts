import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

import {BgTimer} from "../utils/timers"
import {logE2EMetric} from "../utils/e2eMetrics"

function extractDisplayText(displayEvent: any): string[] {
  const layout = displayEvent?.layout
  if (!layout || typeof layout !== "object") {
    return []
  }
  switch (layout.layoutType) {
    case "text_wall":
    case "text_line":
      return typeof layout.text === "string" ? layout.text.split("\n") : []
    case "double_text_wall":
      return [layout.topText, layout.bottomText].filter((value): value is string => typeof value === "string")
    case "text_rows":
      return Array.isArray(layout.text)
        ? layout.text.filter((value: unknown): value is string => typeof value === "string")
        : []
    default:
      return []
  }
}

/** Coalesce rapid caption updates (~3.3 Hz) into one store write per window. */
const DISPLAY_COALESCE_MS = 150

type DisplayEvent = Record<string, unknown> & {view?: string}

function applyDisplayEvent(
  set: (partial: Partial<DisplayStore>) => void,
  get: () => DisplayStore,
  event: DisplayEvent,
) {
  const currentView = get().view
  const targetBucket = event.view === "dashboard" ? "dashboardEvent" : "mainEvent"

  const updates: Partial<DisplayStore> = {
    [targetBucket]: event,
  }

  // also update the current event if the view is the same:
  if (event.view === currentView) {
    updates.currentEvent = event
  }

  const visibleEvent = (updates.currentEvent ?? event) as DisplayEvent
  const textLines = extractDisplayText(visibleEvent)
  if (textLines.some((line) => line.trim() !== "")) {
    logE2EMetric("display_store_update", {
      view: visibleEvent.view ?? currentView,
      layout_type: (visibleEvent.layout as {layoutType?: string} | undefined)?.layoutType ?? "",
      text_lines: textLines,
    })
  }

  set(updates)
}

export interface DisplayStore {
  currentEvent: any
  dashboardEvent: any
  mainEvent: any
  setDisplayEvent: (event: DisplayEvent | string) => void
  view: string
  setView: (view: string) => void
}

let pendingDisplayEvent: DisplayEvent | null = null
let displayCoalesceTimer: ReturnType<typeof BgTimer.setTimeout> | null = null

export const useDisplayStore = create<DisplayStore>()(
  subscribeWithSelector((set, get) => ({
    currentEvent: {} as any,
    dashboardEvent: {} as any,
    mainEvent: {} as any,
    view: "main",
    setDisplayEvent: (event: DisplayEvent | string) => {
      const parsed: DisplayEvent = typeof event === "string" ? JSON.parse(event) : event
      pendingDisplayEvent = parsed
      if (displayCoalesceTimer) return
      displayCoalesceTimer = BgTimer.setTimeout(() => {
        displayCoalesceTimer = null
        const next = pendingDisplayEvent
        pendingDisplayEvent = null
        if (next) applyDisplayEvent(set, get, next)
      }, DISPLAY_COALESCE_MS)
    },
    setView: (view: string) => {
      const currentView = get().view
      if (view === currentView) {
        return
      }

      // update the view and the currentEvent with the corresponding event:
      let newEvent
      if (view === "dashboard") {
        newEvent = get().dashboardEvent
      } else {
        newEvent = get().mainEvent
      }
      logE2EMetric("display_view_changed", {view})
      set({view, currentEvent: newEvent})
    },
  })),
)

/** Test helper — flush any pending coalesced display update immediately. */
export function flushDisplayCoalesceForTests(): void {
  if (displayCoalesceTimer) {
    BgTimer.clearTimeout(displayCoalesceTimer)
    displayCoalesceTimer = null
  }
  if (pendingDisplayEvent) {
    const event = pendingDisplayEvent
    pendingDisplayEvent = null
    applyDisplayEvent(useDisplayStore.setState, useDisplayStore.getState, event)
  }
}
