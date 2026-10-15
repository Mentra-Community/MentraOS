/**
 * The seam between the engine's lifecycle hooks and the Fleet reporter.
 *
 * Hooks in the miniapp, photo and pairing paths call `fleetEvents.launch` and `fleetEvents.photo`. With a reporter
 * running, the collector hears the event on the caller's own stack, so a listener must be cheap, and an emit never
 * throws into the caller: a listener that fails is logged by name and skipped. A hook can therefore never break or
 * slow the path it sits in.
 *
 * Every start of a miniapp is one launch. The apps store's `start` reports its own, and claims the miniapp while it
 * runs (`claimLaunch`); every other path that starts one (the launcher, for restores, miniapps started by other
 * miniapps and screens opened directly; built-ins restored running) reports through `launchUnlessClaimed`, so a spawn
 * a `start` causes elsewhere is not a second launch.
 *
 * A launch heard while nothing listens is kept, with the time it happened, for the collector to take when it starts:
 * the engine restores miniapps while the account it collects for may still be being resolved, and those launches are
 * that account's. The reporter discards them when the account changes. Photo stages are not kept.
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

/** A launch heard while nothing listened, and when it happened (epoch milliseconds). */
export interface UndeliveredLaunch {
  event: FleetLaunchEvent
  observedAt: number
}

export interface FleetEventListener {
  launch?: (event: FleetLaunchEvent) => void
  photo?: (event: FleetPhotoEvent) => void
}

/** More launches than this before the collector starts are not one boot's restores; the oldest go first. */
const MAX_UNDELIVERED_LAUNCHES = 32

const listeners = new Set<FleetEventListener>()
const undelivered: UndeliveredLaunch[] = []
/** Starts under way that report their own launch, by package. */
const claims = new Map<string, number>()

function warnListenerFailed(error: unknown): void {
  // The event is left out of the warning: it names a package or an operation.
  console.warn("fleetEvents: a listener failed:", error instanceof Error ? error.message : "unknown error")
}

function deliverLaunch(event: FleetLaunchEvent): void {
  if (listeners.size === 0) {
    undelivered.push({event, observedAt: Date.now()})
    if (undelivered.length > MAX_UNDELIVERED_LAUNCHES) undelivered.shift()
    return
  }
  for (const listener of [...listeners]) {
    try {
      listener.launch?.(event)
    } catch (error) {
      warnListenerFailed(error)
    }
  }
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
    deliverLaunch(event)
  },

  /**
   * A miniapp start was attempted somewhere other than the apps store's `start`: reported unless a `start` of the
   * same miniapp is under way, which reports it. Never throws.
   */
  launchUnlessClaimed(event: FleetLaunchEvent): void {
    if ((claims.get(event.packageName) ?? 0) > 0) return
    deliverLaunch(event)
  },

  /** A start of `packageName` that reports its own launch is under way, until the returned function is called. */
  claimLaunch(packageName: string): () => void {
    claims.set(packageName, (claims.get(packageName) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (claims.get(packageName) ?? 1) - 1
      if (left > 0) claims.set(packageName, left)
      else claims.delete(packageName)
    }
  },

  /** The launches heard while nothing listened, oldest first; they are forgotten here. */
  takeUndeliveredLaunches(): UndeliveredLaunch[] {
    return undelivered.splice(0)
  },

  /** Forgets the launches heard while nothing listened: they are no one's to report now. */
  discardUndeliveredLaunches(): void {
    undelivered.length = 0
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
