import {OTA_VERSION_URL_LEGACY_PROD, OTA_VERSION_URL_PROD} from "@/config/ota"
import {SETTINGS, toolkit} from "@mentra/engine"

function isLegacyAsgOtaStartBuild(glassesBuildNumber?: string | null): boolean {
  const buildNumber = Number.parseInt(glassesBuildNumber ?? "", 10)
  // ASG builds before 39 ignore ota_start.ota_version_url, so the phone-side
  // availability check must match the manifest those glasses will actually use.
  return Number.isFinite(buildNumber) && buildNumber < 39
}

function getOtaVersionUrlDevOverride(): string | null {
  // Super mode only: a wrong OTA manifest can brick glasses, so a saved
  // override is inert unless super mode is currently enabled.
  if (!toolkit.settings.get(SETTINGS.super_mode.key)) {
    return null
  }
  const value = toolkit.settings.get(SETTINGS.ota_version_url.key)
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed || null
}

export function getAsgOtaVersionUrl(glassesUrl?: string | null, glassesBuildNumber?: string | null): string {
  const deviceUrl = glassesUrl?.trim()
  if (isLegacyAsgOtaStartBuild(glassesBuildNumber)) {
    return OTA_VERSION_URL_LEGACY_PROD
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
