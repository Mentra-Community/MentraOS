/**
 * Gallery notices — engine-owned. The gallery sync emits STRUCTURED notice codes
 * (never localized strings or alerts) when it hits a user-actionable precondition;
 * the host renders its own alert / settings deep-link from the code. This keeps the
 * sync (engine runtime) free of host UI/i18n/navigation — exposed as
 * `engine.gallery.onNotice(cb)`.
 */
export type GalleryNoticeCode =
  | "glasses_disconnected"
  | "bluetooth_off"
  | "insufficient_storage"
  | "wifi_initializing"
  | "wifi_off"
  | "location_services_off"
  | "camera_roll_permission_required"
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

/**
 * Emit a notice to all subscribers; returns how many SUCCESSFULLY received it
 * (0 = nobody listening, or every listener threw). Callers use 0 as the
 * "no host will act on this" signal — e.g. gallery sync auto-proceeds on the
 * blocking connect_to_glasses notice — so a throwing listener must not count
 * as a delivery.
 */
export function emitGalleryNotice(notice: GalleryNotice): number {
  let delivered = 0
  listeners.forEach((l) => {
    // Isolate listeners: one throwing host handler must not break delivery to the
    // others or bubble an exception into the gallery sync.
    try {
      l(notice)
      delivered += 1
    } catch (error) {
      console.error("galleryNotices: onNotice listener threw:", error)
    }
  })
  return delivered
}

/** Subscribe to gallery notices; returns an unsubscribe. */
export function onGalleryNotice(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
