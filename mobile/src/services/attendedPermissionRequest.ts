import {BgTimer, engine, type AppPermissionReceipt, type AppPermissionStatus} from "@mentra/engine"
import {AppState} from "react-native"

const FEATURES = ["camera", "microphone", "location", "bluetooth"] as const
export type AttendedPermissionFeature = (typeof FEATURES)[number]
export type AttendedPermissionRequest = {
  requestId: string
  readbackId: string
  features: AttendedPermissionFeature[]
  timeoutMs: number
}
export type AttendedPermissionAction = {
  feature: AttendedPermissionFeature
  action: "requested" | "request-failed" | "not-requested"
  nextAction?:
    | "already-granted"
    | "enable-location-services"
    | "open-app-settings"
    | "system-restriction"
    | "unverified-status"
}
export type AttendedPermissionResult = {
  requestId: string
  actions: AttendedPermissionAction[]
  missing: {feature: AttendedPermissionFeature; nextAction: AttendedPermissionAction["nextAction"]}[]
  receipt: AppPermissionReceipt
}

export function parseAttendedPermissionRequest(link: string): AttendedPermissionRequest {
  const url = new URL(link)
  const keys = ["request_id", "readback_id", "features", "timeout_ms"]
  const requestId = url.searchParams.get("request_id") ?? ""
  const readbackId = url.searchParams.get("readback_id") ?? ""
  const featureNames = (url.searchParams.get("features") ?? "").split(",")
  const isFeature = (feature: string): feature is AttendedPermissionFeature =>
    FEATURES.some((known) => known === feature)
  const features = featureNames.filter(isFeature)
  const timeout = url.searchParams.get("timeout_ms") ?? ""
  const validId = (id: string) => id.trim() === id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)
  if (
    url.protocol !== "com.mentra:" ||
    url.hostname !== "test" ||
    url.pathname !== "/request-permissions" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !keys.includes(key)) ||
    keys.some((key) => url.searchParams.getAll(key).length !== 1) ||
    !validId(requestId) ||
    !validId(readbackId) ||
    requestId === readbackId ||
    features.length !== featureNames.length ||
    features.length > FEATURES.length ||
    new Set(features).size !== features.length ||
    !/^[1-9][0-9]*$/.test(timeout) ||
    Number(timeout) < 1000 ||
    Number(timeout) > 125000
  ) {
    throw new Error(
      "Expected an attended permission link with distinct bounded IDs, selected features, and 1000–125000ms budget",
    )
  }
  return {requestId, readbackId, features, timeoutMs: Number(timeout)}
}

function nextAction(state: AppPermissionStatus): AttendedPermissionAction["nextAction"] {
  if (state.status === "granted") return "already-granted"
  if (state.rawStatus === "denied") return "open-app-settings"
  if (state.rawStatus === "restricted") return "system-restriction"
  return "unverified-status"
}

// Native consent requests cannot be cancelled. Keep ownership until actual
// settlement, even when the caller's deadline has already rejected.
let activeBatch: Promise<AttendedPermissionResult> | undefined

/** Explicit commissioning only. Status observation and ordinary product routes
 * never call this. No capture, Bluetooth scan, network association, or Settings UI. */
export async function requestAttendedPermissions(link: string): Promise<AttendedPermissionResult> {
  const input = parseAttendedPermissionRequest(link)
  if (activeBatch) throw new Error("An attended app permission request is still settling")
  if (AppState.currentState !== "active")
    throw new Error("Keep the Mentra App foregrounded for attended permission requests")
  const deadline = Date.now() + input.timeoutMs
  let deadlineReached = false
  const deadlineError = new Error(
    "Attended permission deadline reached; native consent may still be outstanding. No final readback is promised",
  )
  const assertWithinDeadline = () => {
    if (deadlineReached || Date.now() >= deadline) throw deadlineError
  }
  let timer: number | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = BgTimer.setTimeout(() => {
      deadlineReached = true
      reject(deadlineError)
    }, input.timeoutMs)
  })
  const operation = (async (): Promise<AttendedPermissionResult> => {
    // The initial nonce identifies a raw before-request observation, not completion.
    let snapshot = await engine.permissions.writeStatusReceipt(input.requestId)
    const actions: AttendedPermissionAction[] = []
    for (const [index, feature] of input.features.entries()) {
      assertWithinDeadline()
      if (index > 0) snapshot = {...(await engine.permissions.status()), requestId: input.requestId}
      assertWithinDeadline()
      if (AppState.currentState !== "active")
        throw new Error("Keep the Mentra App foregrounded for attended permission requests")
      const state = snapshot.permissions[feature]
      if (feature === "location" && !snapshot.locationServicesEnabled) {
        actions.push({feature, action: "not-requested", nextAction: "enable-location-services"})
      } else if (state.rawStatus !== "notDetermined" || state.status !== "denied") {
        actions.push({feature, action: "not-requested", nextAction: nextAction(state)})
      } else {
        // The native request's boolean is not grant evidence. The correlated
        // native snapshot below supplies actual authorization for every feature.
        try {
          await engine.permissions.request(feature)
          actions.push({feature, action: "requested"})
        } catch {
          actions.push({feature, action: "request-failed", nextAction: "unverified-status"})
        }
      }
    }
    assertWithinDeadline()
    const receipt = await engine.permissions.writeStatusReceipt(input.readbackId)
    assertWithinDeadline()
    const missing = input.features.flatMap((feature) => {
      const disabledLocation = feature === "location" && !receipt.locationServicesEnabled
      if (receipt.permissions[feature].status === "granted" && !disabledLocation) return []
      return [
        {
          feature,
          nextAction: disabledLocation
            ? ("enable-location-services" as const)
            : nextAction(receipt.permissions[feature]),
        },
      ]
    })
    return {requestId: input.requestId, actions, missing, receipt}
  })()
  activeBatch = operation
  void operation.then(
    () => {
      if (activeBatch === operation) activeBatch = undefined
    },
    () => {
      if (activeBatch === operation) activeBatch = undefined
    },
  )
  try {
    return await Promise.race([operation, expired])
  } finally {
    if (timer !== undefined) BgTimer.clearTimeout(timer)
  }
}
