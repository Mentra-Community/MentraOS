/**
 * SDK-pinned OTA manifest URL derivation.
 *
 * Each Bluetooth SDK release publishes an immutable manifest
 * (`bluetooth-sdk-<version>-version.json`) pinning the exact ASG artifact paired with that SDK
 * version. The URL is derived from this package's own version — the version is frozen into the
 * published artifact, so this is equivalent to baking the URL at release time while keeping the
 * manifest itself replaceable as an operational escape hatch (asset moves, CDN migration).
 *
 * Mirrors the native derivation in `OtaManifestDefaults.defaultOtaVersionUrl()` (Kotlin) /
 * `BluetoothSdkDefaults` (Swift).
 */

const SDK_OTA_RELEASE_BASE_URL = "https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota"

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require("../../package.json") as {version?: string}

/** This Bluetooth SDK package's own version, as published. */
export const BLUETOOTH_SDK_VERSION: string = (packageJson.version ?? "").trim()

/**
 * The immutable manifest URL pinning the ASG artifact paired with this SDK version, or null when
 * the package version is unavailable (malformed workspace state).
 */
export function sdkPinnedOtaManifestUrl(): string | null {
  if (!BLUETOOTH_SDK_VERSION) {
    return null
  }
  return `${SDK_OTA_RELEASE_BASE_URL}/bluetooth-sdk-${BLUETOOTH_SDK_VERSION}-version.json`
}
