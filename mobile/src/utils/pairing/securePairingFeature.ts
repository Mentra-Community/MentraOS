import {Platform} from "react-native"

/**
 * Secure Mentra Live ownership is coordinated with BES firmware and remains
 * disabled unless a release explicitly opts in on both sides.
 */
export const isMentraLiveSecurePairingEnabled = (): boolean =>
  process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING === "true"

/**
 * Keeps the previous owner until the new phone confirms. Requires secure
 * pairing as well; anything other than exact `true` stays off.
 */
export const isMentraLiveOwnershipTransferEnabled = (): boolean =>
  isMentraLiveSecurePairingEnabled() && process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER === "true"

/**
 * Ownership transfer is Android-only for now. The iOS flow is Classic-first
 * (Settings audio pairing before BLE), which deadlocks against transfer-ON
 * firmware: it refuses new Classic pairing until the phone confirms over BLE.
 * iOS stays transfer-OFF until spike B0 (iPhone confirm-before-Settings) passes.
 * Route and render the transfer flow with this, never the raw flag.
 */
export const isMentraLiveOwnershipTransferSupported = (): boolean =>
  isMentraLiveOwnershipTransferEnabled() && Platform.OS === "android"

/**
 * Expo Router stores route params as strings, so a legacy advertisement's
 * `false` arrives as `"false"`. Missing means the scan did not say.
 */
export const parseOptionalBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return undefined
}

/**
 * Prefer the device payload. JSON keeps the original boolean when the separate
 * route flag is dropped or stringified.
 */
export const advertisedSecurePairingCapable = (routeValue: unknown, deviceValue: unknown): boolean | undefined =>
  parseOptionalBoolean(deviceValue) ?? parseOptionalBoolean(routeValue)
