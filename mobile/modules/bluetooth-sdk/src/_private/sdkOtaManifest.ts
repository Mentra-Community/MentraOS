/**
 * Release CI embeds one immutable OTA manifest URL into every SDK distribution.
 * Source builds remain unpinned and must opt in through the debug configuration API.
 */

import {BLUETOOTH_SDK_RELEASE_METADATA} from "../generated/releaseMetadata"

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require("../../package.json") as {version?: string}

/** This Bluetooth SDK package's own version, as published. */
export const BLUETOOTH_SDK_VERSION: string = (packageJson.version ?? "").trim()

/**
 * The immutable manifest URL embedded by release CI, or null for an unpinned source build.
 */
export function sdkPinnedOtaManifestUrl(): string | null {
  return BLUETOOTH_SDK_RELEASE_METADATA.otaManifestUrl
}
