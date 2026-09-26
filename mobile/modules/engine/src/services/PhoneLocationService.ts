/**
 * Phone location service — engine-owned. Owns the background phone-GPS task: the
 * accuracy-tier control (`setLocationTier`), the accuracy mapping, and the
 * `expo-task-manager` background task that forwards the first fix in each batch
 * to subscribed local miniapps (`location_update`). Cloud upload was V1 (removed).
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
import {AppState, Platform} from "react-native"

import localMiniappRuntime from "./LocalMiniappRuntime"

export const LOCATION_TASK_NAME = "handleLocationUpdates"

// Background location task — forwards the first fix from each non-empty batch.
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
  // Deliver directly to local miniapps. The Cloud V1 upload that used to run
  // here was removed with the V1 ripout (issue #3392).
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

let pendingLocationRequest: {tier: string} | null = null
let locationWork: Promise<void> = Promise.resolve()
let foregroundRetrySubscription: ReturnType<typeof AppState.addEventListener> | null = null

function queueLocationReconciliation(): Promise<void> {
  // Each job reads the latest demand, not the tier that originally queued it.
  // Native operations stay serial so an in-flight start cannot overtake off.
  locationWork = locationWork.then(reconcileLocationTier, reconcileLocationTier)
  return locationWork
}

async function reconcileLocationTier(): Promise<void> {
  try {
    const request = pendingLocationRequest
    if (!request) return
    const {tier} = request
    const isAndroid = Platform.OS === "android"

    // Expo rejects foreground-service registration while the Activity is inactive.
    // Keep any existing service running until the requested tier can be applied.
    if (isAndroid && tier !== "off" && AppState.currentState !== "active") return

    if (tier === "off" || !isAndroid) {
      const isRegistered = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME).catch((error) => {
        if (isAndroid) throw error
        return false // Preserve iOS's existing start-on-query-failure behavior.
      })
      if (pendingLocationRequest !== request) return
      if (isRegistered) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
      }
      if (pendingLocationRequest !== request) return
    }

    if (tier === "off") {
      console.log("ISLAND: setLocationTier() stopped — no active subscribers")
    } else {
      // Android's task manager updates an existing consumer's options in place.
      // Do not unregister first: a native foreground-gate rejection must leave
      // the previously running service intact. Preserve iOS's stop/start above.
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: getLocationAccuracy(tier),
        pausesUpdatesAutomatically: false,
        // Android deliberately blocks ACCESS_BACKGROUND_LOCATION. Expo requires
        // its foreground-service mode even when Mentra's own service is running.
        // Keep the notification brand-only; Android supplies the location-service
        // indicator, without introducing untranslated engine-owned UI copy.
        ...(isAndroid
          ? {foregroundService: {notificationTitle: "Mentra", notificationBody: "", killServiceOnDestroy: true}}
          : {}),
      })
      console.log("ISLAND: setLocationTier() success —", tier)
    }

    if (pendingLocationRequest === request) {
      pendingLocationRequest = null
      foregroundRetrySubscription?.remove()
      foregroundRetrySubscription = null
    }
  } catch (error) {
    // Retain demand for the next active transition or explicit request, without
    // spinning on permission failures or a JS/native foreground-state race.
    console.log("ISLAND: Error setting location tier", error)
  }
}

/**
 * Apply the latest aggregate miniapp tier. "off" stops updates on any platform
 * immediately after in-flight work. Android non-off requests may remain pending
 * until the Activity is active; the returned promise does not wait for foreground.
 * Callers own the OS permission UI.
 */
export function setLocationTier(tier: "off" | "passive" | "low" | "high" | "realtime" | string): Promise<void> {
  console.log("ISLAND: setLocationTier()", tier)
  pendingLocationRequest = {tier}
  try {
    if (Platform.OS === "android" && !foregroundRetrySubscription) {
      foregroundRetrySubscription = AppState.addEventListener("change", (state) => {
        if (state === "active" && pendingLocationRequest) void queueLocationReconciliation()
      })
    }
  } catch (error) {
    // Still reconcile active/off requests; a later request can retry registration.
    console.log("ISLAND: Error observing foreground location state", error)
  }
  return queueLocationReconciliation()
}

/** Stop the background location task (host cleanup). */
export function stopPhoneLocation(): void {
  void setLocationTier("off")
}

export const phoneLocationService = {
  LOCATION_TASK_NAME,
  getLocationAccuracy,
  setLocationTier,
  stopPhoneLocation,
}
