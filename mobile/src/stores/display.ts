import {create} from "zustand"
import {extractDisplayText, logE2EMetric} from "@/utils/e2eMetrics"
// import
// TODO: import view types from cloud

interface DisplayStore {
  currentEvent: any
  dashboardEvent: any
  mainEvent: any
  setDisplayEvent: (eventString: string) => void
  view: string
  setView: (view: string) => void
}

export const useDisplayStore = create<DisplayStore>((set, get) => ({
  currentEvent: {} as any,
  dashboardEvent: {} as any,
  mainEvent: {} as any,
  view: "main",
  setDisplayEvent: (eventString: string) => {
    const event = JSON.parse(eventString)
    const currentView = get().view

    const updates: any = {
      [event.view === "dashboard" ? "dashboardEvent" : "mainEvent"]: event,
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
}))
