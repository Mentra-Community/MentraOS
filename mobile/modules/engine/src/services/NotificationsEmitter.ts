/**
 * Engine notifications emitter — the engine→host alert channel behind
 * `engine.notifications`. Engine-detected conditions the host should surface
 * (miniapp crashloop, version-incompatible miniapp, persistent connection loss)
 * are pushed here; the facade fans them out to host subscribers.
 *
 * A plain listener set (not Node's EventEmitter) to avoid the `events` typings
 * gap in engine's standalone build.
 */
export type IslandNotificationKind =
  | "miniapp_crashloop"
  | "version_incompatible"
  | "missing_speech_model"
  | "connection_failed_persistent"

export interface IslandNotification {
  kind: IslandNotificationKind
  /** The miniapp this concerns, when applicable. */
  packageName?: string
  /** Epoch millis when raised. */
  timestamp: number
  /** Human-readable summary the host can show. */
  reason: string
  /** Kind-specific extras (versions, attempt counts, …). */
  metadata?: Record<string, unknown>
}

const listeners = new Set<(n: IslandNotification) => void>()

export const islandNotifications = {
  /** Raise a notification to all host subscribers. */
  emit(notification: IslandNotification): void {
    for (const l of listeners) {
      try {
        l(notification)
      } catch (err) {
        console.warn(`islandNotifications: listener threw: ${(err as Error)?.message ?? err}`)
      }
    }
  },
  /** Subscribe to engine notifications; returns an unsubscribe. */
  subscribe(cb: (n: IslandNotification) => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
}
