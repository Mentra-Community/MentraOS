import {OTA_VERSION_URL_PROD} from "@/config/ota"
import {SETTINGS, useSettingsStore} from "@/stores/settings"

function isLegacyAsgOtaStartBuild(glassesBuildNumber?: string | null): boolean {
  const buildNumber = Number.parseInt(glassesBuildNumber ?? "", 10)
  // Pre-wall-clock ASG builds ignore ota_start.ota_version_url, but MentraOS should
  // still check v2: ota_start will run their compiled rescue manifest first, then
  // the upgraded ASG client continues on v2.
  return Number.isFinite(buildNumber) && buildNumber < 100000
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

export function getAsgOtaVersionUrl(glassesUrl?: string | null, glassesBuildNumber?: string | null): string {
  const deviceUrl = glassesUrl?.trim()
  if (isLegacyAsgOtaStartBuild(glassesBuildNumber)) {
    // Legacy glasses may still advertise the previous production manifest, but
    // the phone-side availability check must use v2 so users enter the rescue flow.
    return OTA_VERSION_URL_PROD
  }

  const devOverrideUrl = getOtaVersionUrlDevOverride()
  if (devOverrideUrl) {
    return devOverrideUrl
  }

  const envUrl = process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL?.trim()
  if (envUrl) {
    return envUrl
  }
  return deviceUrl || OTA_VERSION_URL_PROD
}
