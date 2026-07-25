import {sdkPinnedOtaManifestUrl} from "@mentra/bluetooth-sdk/internal"

import {SETTINGS, useSettingsStore} from "../stores/settings"

// Legacy production manifest — pre-39 glasses install from this (they ignore ota_start's URL).
const OTA_VERSION_URL_LEGACY_PROD = "https://ota.mentraglass.com/prod_live_version.json"
// Modern production fleet manifest (v2). Only a last-resort fallback when the SDK-derived pin
// URL is somehow unavailable; modern glasses honor ota_start's URL, so this must be the v2
// artifact, not the legacy v1 rescue manifest.
const OTA_VERSION_URL_PROD = "https://ota.mentraglass.com/prod_live_version_v2.json"

function isLegacyAsgOtaStartBuild(glassesBuildNumber?: string | null): boolean {
  const buildNumber = Number.parseInt(glassesBuildNumber ?? "", 10)
  // ASG builds before 39 ignore ota_start.ota_version_url, so compare against
  // the URL they will actually use.
  return Number.isFinite(buildNumber) && buildNumber < 39
}

function getOtaVersionUrlDevOverride(): string | null {
  // Super mode only: a wrong OTA manifest can brick glasses, so a saved
  // override is inert unless super mode is currently enabled.
  if (!useSettingsStore.getState().getSetting(SETTINGS.super_mode.key)) {
    return null
  }
  const value = useSettingsStore.getState().getSetting(SETTINGS.ota_version_url.key)
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed || null
}

export function resolveOtaManifestUrl(glassesUrl?: string | null, glassesBuildNumber?: string | null): string {
  const deviceUrl = glassesUrl?.trim()
  if (isLegacyAsgOtaStartBuild(glassesBuildNumber)) {
    // Legacy glasses ignore ota_start.ota_version_url and install from their
    // compiled default, so the developer override does not apply to them either.
    return deviceUrl || OTA_VERSION_URL_LEGACY_PROD
  }

  const devOverrideUrl = getOtaVersionUrlDevOverride()
  if (devOverrideUrl) {
    return devOverrideUrl
  }

  const envUrl = process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL?.trim()
  if (envUrl) {
    return envUrl
  }

  // The phone owns manifest selection: modern glasses are driven with the manifest pinned to
  // this app's Bluetooth SDK version. Modern ASG builds report no manifest URL of their own;
  // a glasses-reported URL (older modern builds advertising their baked fleet default) is only
  // a last resort when the SDK version is somehow unavailable.
  return sdkPinnedOtaManifestUrl() || deviceUrl || OTA_VERSION_URL_PROD
}
