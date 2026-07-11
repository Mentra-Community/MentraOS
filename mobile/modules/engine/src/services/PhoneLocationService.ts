/**
 * Phone location service — engine-owned. Owns the background phone-GPS task: the
 * accuracy-tier control (`setLocationTier`), the accuracy mapping, and the
 * `expo-task-manager` background task that fans each fix to the v2 cloud
 * local miniapps (`location_update`). Cloud upload was V1 (removed).
 *
 * This used to be the host-injected `locationTier` runtime hook + a MantleManager
 * `TaskManager.defineTask`. It's device/OS plumbing (no UI), so it moved into engine:
 * the runtime drives `setLocationTier` directly off miniapp demand, and any host —
 * including a bare OEM — gets phone location without wiring a hook. The host keeps the
 * permission *UI* (it gates `setLocationTier` on the OS permission before calling).
 *
 * The task is registered at module load (the export from `index.ts` evaluates this
 * file as soon as `@mentra/engine` is imported), matching the old MantleManager
 * top-level `defineTask` timing — including on a headless background relaunch.
 */
import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"

import localMiniappRuntime from "./LocalMiniappRuntime"

export const LOCATION_TASK_NAME = "handleLocationUpdates"

// Background location task — sends each fix to the v2 cloud (RestComms) + local
// miniapps. (The v1 SocketComms leg was already removed/commented before the move.)
TaskManager.defineTask<{locations?: Location.LocationObject[]}>(LOCATION_TASK_NAME, async ({data, error}) => {
  if (error) {
    // OS-level failure (permission revoked, GPS unavailable, …) — log it so
    // background location dropouts are diagnosable.
    console.warn("ISLAND: LOCATION: background task error:", error)
    return
  }
  const locs = data?.locations ?? []
  if (locs.length === 0) {
    console.log("ISLAND: LOCATION: No locations received")
    return
  }
  const first = locs[0]!
  // Cloud path (relayMessageToApps) never reaches __phone__, so local miniapps rely
  // on this direct push.
  // Local miniapps get the update directly (the cloud relay never reaches
  // __phone__). The Cloud V1 upload that used to run here was removed with the
  // V1 ripout (issue #3392); a V2 location channel is separate product work.
  localMiniappRuntime.forwardEvent("location_update", {
    lat: first.coords.latitude,
    lng: first.coords.longitude,
    accuracy: first.coords.accuracy ?? undefined,
    timestamp: first.timestamp,
  })
})

/** Map a MentraOS location tier/accuracy string to an expo-location accuracy. */
export function getLocationAccuracy(accuracy: string | undefined): Location.LocationAccuracy {
  switch (accuracy) {
    // Aggregate miniapp tiers (LocalMiniappRuntime.recomputeLocation → "passive" |
    // "low" | "high" | "realtime"). Previously only "realtime" mapped; "passive"/"low"/
    // "high" fell through to Lowest, so a miniapp asking for high-rate GPS got the
    // coarsest accuracy.
    case "realtime":
      return Location.LocationAccuracy.BestForNavigation
    case "high":
      return Location.LocationAccuracy.High
    case "low":
      return Location.LocationAccuracy.Low
    case "passive":
      return Location.LocationAccuracy.Lowest
    // Accuracy-string vocabulary (persisted location_tier setting / boot path).
    case "tenMeters":
      return Location.LocationAccuracy.High
    case "hundredMeters":
      return Location.LocationAccuracy.Balanced
    case "kilometer":
      return Location.LocationAccuracy.Low
    case "threeKilometers":
      return Location.LocationAccuracy.Lowest
    case "reduced":
      return Location.LocationAccuracy.Lowest
    default:
      return Location.LocationAccuracy.Lowest
  }
}

/**
 * Apply a location tier (the aggregate of what miniapps request). "off" means no app
 * is asking — stop the task so the OS can power GPS down; anything else (re)starts the
 * background task at the matching accuracy. Callers gate this on the OS location
 * permission (host UI concern).
 */
export async function setLocationTier(
  tier: "off" | "passive" | "low" | "high" | "realtime" | string,
): Promise<void> {
  console.log("ISLAND: setLocationTier()", tier)
  try {
    const isRegistered = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => false)
    if (isRegistered) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
    }
    if (tier === "off") {
      console.log("ISLAND: setLocationTier() stopped — no active subscribers")
      return
    }
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: getLocationAccuracy(tier),
      pausesUpdatesAutomatically: false,
    })
    console.log("ISLAND: setLocationTier() success —", tier)
  } catch (error) {
    console.log("ISLAND: Error setting location tier", error)
  }
}

/** Stop the background location task (host cleanup). */
export function stopPhoneLocation(): void {
  Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => {})
}

export const phoneLocationService = {
  LOCATION_TASK_NAME,
  getLocationAccuracy,
  setLocationTier,
  stopPhoneLocation,
}
