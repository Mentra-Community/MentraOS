const OTA_VERSION_URL_LEGACY_PROD = "https://ota.mentraglass.com/prod_live_version.json"

function trimmed(value?: string | null): string | null {
  const result = value?.trim()
  return result || null
}

export function isLegacyAsgOtaStartBuild(glassesBuildNumber?: string | null): boolean {
  const buildNumber = Number.parseInt(glassesBuildNumber ?? "", 10)
  return Number.isFinite(buildNumber) && buildNumber < 39
}

export function selectModernOtaManifestPin({
  developerOverride,
  hostReleasePin,
  engineReleasePin,
}: {
  developerOverride?: string | null
  hostReleasePin?: string | null
  engineReleasePin?: string | null
}): string | null {
  return trimmed(developerOverride) || trimmed(hostReleasePin) || trimmed(engineReleasePin)
}

export function resolveOtaManifestPolicy({
  glassesUrl,
  glassesBuildNumber,
  developerOverride,
  hostReleasePin,
  engineReleasePin,
}: {
  glassesUrl?: string | null
  glassesBuildNumber?: string | null
  developerOverride?: string | null
  hostReleasePin?: string | null
  engineReleasePin?: string | null
}): string | null {
  if (isLegacyAsgOtaStartBuild(glassesBuildNumber)) {
    return trimmed(glassesUrl) || OTA_VERSION_URL_LEGACY_PROD
  }
  return selectModernOtaManifestPin({developerOverride, hostReleasePin, engineReleasePin})
}
