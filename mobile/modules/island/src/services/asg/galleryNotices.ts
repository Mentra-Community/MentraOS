/**
 * Gallery notices — island-owned. The gallery sync emits STRUCTURED notice codes
 * (never localized strings or alerts) when it hits a user-actionable precondition;
 * the host renders its own alert / settings deep-link from the code. This keeps the
 * sync (island runtime) free of host UI/i18n/navigation — exposed as
 * `toolkit.gallery.onNotice(cb)`.
 */
export type GalleryNoticeCode =
  | "glasses_disconnected"
  | "insufficient_storage"
  | "wifi_initializing"
  | "wifi_off"
  | "location_services_off"
  | "connect_to_glasses"

export interface GalleryNotice {
  code: GalleryNoticeCode
  /** Optional extra context (e.g. ssid/platform) for the host's message. */
  data?: Record<string, unknown>
  /**
   * Present only on notices the sync BLOCKS on (currently the one-time wifi-join
   * explanation): the host calls this when the user acknowledges, letting the sync
   * proceed. If no host is listening, the emitter's return value lets the sync fall
   * through instead of hanging.
   */
  ack?: () => void
}

type Listener = (notice: GalleryNotice) => void

const listeners = new Set<Listener>()

/** Emit a notice to all subscribers; returns how many received it (0 = nobody listening). */
export function emitGalleryNotice(notice: GalleryNotice): number {
  listeners.forEach((l) => {
    // Isolate listeners: one throwing host handler must not break delivery to the
    // others or bubble an exception into the gallery sync.
    try {
      l(notice)
    } catch (error) {
      console.error("galleryNotices: onNotice listener threw:", error)
    }
  })
  return listeners.size
}

/** Subscribe to gallery notices; returns an unsubscribe. */
export function onGalleryNotice(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
