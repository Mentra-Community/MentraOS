/** iOS CoreBluetooth error 14: the glasses removed the BLE bond and this phone still has it. */
export const IOS_FORGET_GLASSES_BLUETOOTH_ERROR = "errors:iosForgetGlassesBluetooth"

/**
 * The name shown on the forget-in-Settings screen. Underscores wrap mid-token, so
 * `Mentra_Live_E511` was clipping to `Mentra_Live_` and hiding the code.
 */
export function iosBluetoothDeviceLabel(name: string | undefined, fallback: string): string {
  const raw = name?.trim()
  if (!raw) return fallback
  return raw.replace(/_/g, " ")
}
