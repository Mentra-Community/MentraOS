import {ENGINE_RELEASE_METADATA} from "../generated/releaseMetadata"
import {SETTINGS, useSettingsStore} from "../stores/settings"
import {resolveDeploymentAwareOtaManifestPolicy, selectModernOtaManifestPin} from "./otaManifestPolicy"
import {getConfigValues} from "../runtime/bootstrap"

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

function getHostReleasePin(): string | null {
  const configured = getConfigValues().otaManifestUrl
  if (configured !== undefined) return configured?.trim() || null
  const value = process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL?.trim()
  return value || null
}

function hasDeploymentOtaPolicy(): boolean {
  return getConfigValues().otaManifestUrl !== undefined
}

function getEmbeddedEngineReleasePin(): string | null {
  const value = ENGINE_RELEASE_METADATA.otaManifestUrl?.trim()
  return value || null
}

export function hasConfiguredModernOtaManifestPin(): boolean {
  return Boolean(
    selectModernOtaManifestPin({
      developerOverride: getOtaVersionUrlDevOverride(),
      hostReleasePin: getHostReleasePin(),
      engineReleasePin: getEmbeddedEngineReleasePin(),
    }),
  )
}

export function resolveOtaManifestUrl(glassesUrl?: string | null, glassesBuildNumber?: string | null): string | null {
  return resolveDeploymentAwareOtaManifestPolicy({
    hostPolicyConfigured: hasDeploymentOtaPolicy(),
    glassesUrl,
    glassesBuildNumber,
    developerOverride: getOtaVersionUrlDevOverride(),
    hostReleasePin: getHostReleasePin(),
    engineReleasePin: getEmbeddedEngineReleasePin(),
  })
}
