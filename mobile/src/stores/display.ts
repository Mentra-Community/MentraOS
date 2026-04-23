import {create} from "zustand"
import {extractDisplayText, logE2EMetric} from "@/utils/e2eMetrics"
// import
// TODO: import view types from cloud

const summarizeDisplayStoreEvent = (event: any) => {
  const textLines = extractDisplayText(event)
  return {
    view: event?.view ?? "missing",
    layoutType: event?.layout?.layoutType ?? "unknown",
    lineCount: textLines.length,
    nonEmptyLineCount: textLines.filter((line) => line.trim() !== "").length,
    textPreview: textLines.join(" | ").slice(0, 160),
  }
}

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
    const targetBucket = event.view === "dashboard" ? "dashboardEvent" : "mainEvent"

    console.log("DISPLAY_STORE: received display event", {
      currentView,
      targetBucket,
      eventSummary: summarizeDisplayStoreEvent(event),
    })

    const updates: any = {
      [targetBucket]: event,
    }

    // also update the current event if the view is the same:
    if (event.view === currentView) {
      updates.currentEvent = event
    }

    console.log("DISPLAY_STORE: computed updates", {
      currentView,
      eventView: event.view,
      currentEventWillUpdate: Boolean(updates.currentEvent),
      targetBucket,
    })

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

    const nextState = get()
    console.log("DISPLAY_STORE: state applied", {
      selectedView: nextState.view,
      currentEventSummary: summarizeDisplayStoreEvent(nextState.currentEvent),
      mainEventSummary: summarizeDisplayStoreEvent(nextState.mainEvent),
      dashboardEventSummary: summarizeDisplayStoreEvent(nextState.dashboardEvent),
    })
  },
  setView: (view: string) => {
    const currentView = get().view
    if (view === currentView) {
      console.log("DISPLAY_STORE: setView ignored (already selected)", {view})
      return
    }

    // update the view and the currentEvent with the corresponding event:
    let newEvent
    if (view === "dashboard") {
      newEvent = get().dashboardEvent
    } else {
      newEvent = get().mainEvent
    }
    console.log("DISPLAY_STORE: setView switching", {
      previousView: currentView,
      nextView: view,
      nextEventSummary: summarizeDisplayStoreEvent(newEvent),
    })
    logE2EMetric("display_view_changed", {view})
    set({view, currentEvent: newEvent})
  },
}))
