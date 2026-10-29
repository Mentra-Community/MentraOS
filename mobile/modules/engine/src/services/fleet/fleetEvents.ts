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
 * Phase 12 adds a miniapp's own events (`telemetry`, from `session.telemetry.capture`, attributed by the runtime to the
 * package whose bridge sent it), its crashes, install attempts, and the glasses' pairing and connection changes. None of
 * these is kept while nothing listens: with no run collecting (Fleet not installed on the phone's Core, nobody signed
 * in) they are dropped, and telemetry dropped this way is not counted.
 *
 * This module imports nothing at run time, so the hot paths that import it carry no Fleet weight.
 */
import type {
  FleetConnectionEventPayload,
  FleetLaunchFailureReason,
  FleetMiniappCrashPayload,
  FleetMiniappInstallPayload,
  FleetRecord,
} from "@mentra/cloud-protocol"

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

/** A miniapp's own event as the bridge delivered it: unchecked, the collector applies the limits. */
export interface FleetTelemetryEvent {
  packageName: string
  versionName?: string
  event: unknown
  properties: unknown
}

/** A crash: the collector adds the miniapp's execution session. */
export type FleetCrashEvent = Omit<FleetMiniappCrashPayload, "executionSessionId">
export type FleetInstallEvent = FleetMiniappInstallPayload
/** A pairing or connection change: the collector adds the glasses, their model and the Mentra App's version. */
export type FleetConnectionEvent = Pick<FleetConnectionEventPayload, "event" | "category" | "reconnectMs">

export interface FleetEventListener {
  launch?: (event: FleetLaunchEvent) => void
  photo?: (event: FleetPhotoEvent) => void
  telemetry?: (event: FleetTelemetryEvent) => void
  crash?: (event: FleetCrashEvent) => void
  install?: (event: FleetInstallEvent) => void
  connection?: (event: FleetConnectionEvent) => void
}

/** More launches than this before the collector starts are not one boot's restores; the oldest go first. */
const MAX_UNDELIVERED_LAUNCHES = 32

const listeners = new Set<FleetEventListener>()
let lastUserDisconnectAt = 0
const undelivered: UndeliveredLaunch[] = []
/** A start under way that reports its own launch: why a spawn it held back failed, if one did. */
interface LaunchClaim {
  failureReason?: FleetLaunchFailureReason
}

/** Starts under way that report their own launch, by package. */
const claims = new Map<string, Set<LaunchClaim>>()

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
    const held = claims.get(event.packageName)
    if (!held) {
      deliverLaunch(event)
      return
    }
    // The start reports this attempt as its own, so it keeps the reason the spawn failed for.
    const reason = event.failureReason
    if (reason === undefined) return
    for (const claim of held) if (claim.failureReason === undefined || claim.failureReason === "unknown") claim.failureReason = reason
  },

  /**
   * A start of `packageName` that reports its own launch is under way, until the returned function is called. That
   * function returns why a spawn the start held back failed, for the start's own report, or undefined.
   */
  claimLaunch(packageName: string): () => FleetLaunchFailureReason | undefined {
    const claim: LaunchClaim = {}
    const held = claims.get(packageName) ?? new Set<LaunchClaim>()
    held.add(claim)
    claims.set(packageName, held)
    let released = false
    return () => {
      if (!released) {
        released = true
        held.delete(claim)
        if (held.size === 0 && claims.get(packageName) === held) claims.delete(packageName)
      }
      return claim.failureReason
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
    deliver("photo", event)
  },

  /** A miniapp captured one of its own events. Never throws. */
  telemetry(event: FleetTelemetryEvent): void {
    deliver("telemetry", event)
  },

  /** A miniapp crashed. Never throws. */
  crash(event: FleetCrashEvent): void {
    deliver("crash", event)
  },

  /** An install, update or removal of a miniapp was attempted. Never throws. */
  install(event: FleetInstallEvent): void {
    deliver("install", event)
  },

  /** The person asked the glasses to disconnect (or forgot or unpaired them): the next disconnect is theirs. */
  userDisconnect(): void {
    lastUserDisconnectAt = Date.now()
  },

  /** When the person last asked the glasses to disconnect (epoch ms), or 0. */
  lastUserDisconnect(): number {
    return lastUserDisconnectAt
  },

  /** The glasses' pairing or connection changed. Never throws. */
  connection(event: FleetConnectionEvent): void {
    deliver("connection", event)
  },
}

/** Hands `event` to every listener of `kind`; with none, it is dropped. */
function deliver<K extends "photo" | "telemetry" | "crash" | "install" | "connection">(kind: K, event: Parameters<NonNullable<FleetEventListener[K]>>[0]): void {
  if (listeners.size === 0) return
  for (const listener of [...listeners]) {
    try {
      ;(listener[kind] as ((value: typeof event) => void) | undefined)?.(event)
    } catch (error) {
      warnListenerFailed(error)
    }
  }
}
