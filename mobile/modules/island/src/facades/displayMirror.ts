/**
 * glasses display mirror — island's read-model of the latest display event sent
 * to the glasses, for a phone-side preview (`toolkit.display.mirror`).
 *
 * This is the additive "facade" half of inverting the mirror: island owns this
 * read-model and is fed every processed display event (from the local miniapp
 * display path and the cloud display path), in PARALLEL with the legacy host
 * `useDisplayStore`. Nothing has to read island yet, so no consumer/test churn.
 *
 * The follow-up "callback" half flips the preview UI (`GlassesDisplayMirror`,
 * `SimulatedGlassesControls`) onto `onMirror`/`current`, adds view tracking here,
 * deletes the host `useDisplayStore` + the `setDisplayEvent` RuntimeHooks adapter,
 * and migrates the display tests. That part is test-coupled to v1 `SocketComms`
 * and `MantleManager`, so it's isolated to its own PR.
 */
export type DisplayMirrorEvent = Record<string, unknown> & {view?: string}

let latestEvent: DisplayMirrorEvent | null = null
const listeners = new Set<(event: DisplayMirrorEvent) => void>()

export const displayMirror = {
  /** Feed a processed display event (the object `DisplayProcessor` produces). */
  ingest(event: DisplayMirrorEvent): void {
    latestEvent = event
    for (const cb of listeners) cb(event)
  },

  /** The most recent processed display event, or null before the first one. */
  current(): DisplayMirrorEvent | null {
    return latestEvent
  },

  /** Subscribe to display events; returns an unsubscribe. */
  onMirror(cb: (event: DisplayMirrorEvent) => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
}
