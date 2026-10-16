/**
 * `pair_failure.code` the SDK sends when iOS holds a stale Bluetooth pairing for the glasses during
 * an explicit attempt. The user must remove it in Settings > Bluetooth before pairing again.
 */
export const IOS_FORGET_PAIRING_CODE = "ios_forget_pairing"

/** The route of the "Forget the old pairing" screen. Only the pairing loading screen opens it. */
export const FORGET_IOS_PAIRING_ROUTE = "/pairing/forget-ios-pairing"

/** True when a `pair_failure` asks the user to forget the old pairing on iPhone. */
export const isIosForgetPairingFailure = (event: {code?: string}, platform: string): boolean =>
  platform === "ios" && event.code === IOS_FORGET_PAIRING_CODE

/**
 * The name shown on the forget-in-Settings screen. Underscores wrap mid-token, so
 * `Mentra_Live_E511` was clipping to `Mentra_Live_` and hiding the code.
 */
export function iosBluetoothDeviceLabel(name: string | undefined, fallback: string): string {
  const raw = name?.trim()
  if (!raw) return fallback
  return raw.replace(/_/g, " ")
}
