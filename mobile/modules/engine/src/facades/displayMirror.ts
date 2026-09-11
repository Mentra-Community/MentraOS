/**
 * glasses display mirror — the typed read facade over the (now engine-owned)
 * display store, for a phone-side preview of the glasses screen
 * (`engine.display.mirror`). The store is fed by the display paths
 * (LocalDisplayManager + the cloud path) via `setDisplayEvent`; this facade is the
 * read side: `current()` (snapshot) + `onMirror(cb)` (subscribe). The raw store is
 * also exposed as `engine.displayStore` (the Mentra-app escape hatch).
 */
import {useDisplayStore} from "../stores/display"

export type DisplayMirrorEvent = Record<string, unknown> & {view?: string; layout?: any}

export const displayMirror = {
  /** The display event currently shown on the previewed view (snapshot). */
  current(): DisplayMirrorEvent {
    // Copy: the snapshot must not hand callers a mutable reference into the store.
    return {...useDisplayStore.getState().currentEvent}
  },

  /** Subscribe to changes of the previewed display event; returns an unsubscribe. */
  onMirror(cb: (event: DisplayMirrorEvent) => void): () => void {
    return useDisplayStore.subscribe((s) => s.currentEvent, cb)
  },

  /** Which view is previewed — the main screen or the dashboard. */
  view(): string {
    return useDisplayStore.getState().view
  },
  /** Switch the previewed view between `"main"` and `"dashboard"`. */
  setView(view: "main" | "dashboard"): void {
    useDisplayStore.getState().setView(view)
  },
}
