import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

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

export interface DisplayStore {
  currentEvent: any
  dashboardEvent: any
  mainEvent: any
  setDisplayEvent: (eventString: string) => void
  view: string
  setView: (view: string) => void
}

export const useDisplayStore = create<DisplayStore>()(
  subscribeWithSelector((set, get) => ({
    currentEvent: {} as any,
    dashboardEvent: {} as any,
    mainEvent: {} as any,
    view: "main",
    setDisplayEvent: (eventString: string) => {
      const event = JSON.parse(eventString)
      const currentView = get().view
      const targetBucket = event.view === "dashboard" ? "dashboardEvent" : "mainEvent"

      const updates: any = {
        [targetBucket]: event,
      }

      // also update the current event if the view is the same:
      if (event.view === currentView) {
        updates.currentEvent = event
      }

      const visibleEvent = updates.currentEvent ?? event
      const textLines = extractDisplayText(visibleEvent)
      if (textLines.some((line) => line.trim() !== "")) {
        logE2EMetric("display_store_update", {
          view: visibleEvent.view ?? currentView,
          layout_type: visibleEvent.layout?.layoutType ?? "",
          text_lines: textLines,
        })
      }

      set(updates)
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
