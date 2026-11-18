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
    // A service app before 39 can't take a manifest URL, so with an override set these glasses are where it took them
    // (an older set): every check says up to date until the override is cleared, then they follow production.
    if (trimmed(developerOverride)) return null
    return trimmed(glassesUrl) || OTA_VERSION_URL_LEGACY_PROD
  }
  return selectModernOtaManifestPin({developerOverride, hostReleasePin, engineReleasePin})
}

export function resolveDeploymentAwareOtaManifestPolicy({
  hostPolicyConfigured,
  ...policy
}: Parameters<typeof resolveOtaManifestPolicy>[0] & {hostPolicyConfigured: boolean}): string | null {
  // A selected deployment is authoritative for every glasses generation. An
  // explicit null is a deliberate OTA-off policy, not permission to inherit a
  // device-reported URL or Mentra's legacy public default.
  if (hostPolicyConfigured) return trimmed(policy.developerOverride) || trimmed(policy.hostReleasePin)
  return resolveOtaManifestPolicy(policy)
}
