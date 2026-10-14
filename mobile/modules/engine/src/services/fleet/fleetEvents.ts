/**
 * The seam between the engine's lifecycle hooks and the Fleet reporter.
 *
 * Hooks in the miniapp, photo and pairing paths call `fleetEvents.launch` and `fleetEvents.photo`. With no reporter
 * running, which is the case for most users most of the time, an emit is one `Set.size` check. With one running,
 * the collector hears the event on the caller's own stack, so a listener must be cheap, and an emit never throws
 * into the caller: a listener that fails is logged by name and skipped. A hook can therefore never break or slow
 * the path it sits in.
 *
 * This module imports nothing at run time, so the hot paths that import it carry no Fleet weight.
 */
import type {FleetRecord} from "@mentra/cloud-protocol"

/** A miniapp start the engine attempted, and how it went. */
export type FleetLaunchEvent = Extract<FleetRecord, {kind: "miniapp_launch"}>["payload"]

/**
 * One stage of a photo operation. `operationId` is the managed photo request ID, shared by every stage of the one
 * photo. `failedStage` is the last stage the operation reached before it failed.
 */
export type FleetPhotoEvent = {operationId: string} & Extract<FleetRecord, {kind: "photo_operation"}>["payload"]

export interface FleetEventListener {
  launch?: (event: FleetLaunchEvent) => void
  photo?: (event: FleetPhotoEvent) => void
}

const listeners = new Set<FleetEventListener>()

function warnListenerFailed(error: unknown): void {
  // The event is left out of the warning: it names a package or an operation.
  console.warn("fleetEvents: a listener failed:", error instanceof Error ? error.message : "unknown error")
}

export const fleetEvents = {
  /** Listens for events until the returned function is called. */
  subscribe(listener: FleetEventListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  /** A miniapp start was attempted. Never throws. */
  launch(event: FleetLaunchEvent): void {
    if (listeners.size === 0) return
    for (const listener of [...listeners]) {
      try {
        listener.launch?.(event)
      } catch (error) {
        warnListenerFailed(error)
      }
    }
  },

  /** A photo operation reached a stage. Never throws. */
  photo(event: FleetPhotoEvent): void {
    if (listeners.size === 0) return
    for (const listener of [...listeners]) {
      try {
        listener.photo?.(event)
      } catch (error) {
        warnListenerFailed(error)
      }
    }
  },
}
