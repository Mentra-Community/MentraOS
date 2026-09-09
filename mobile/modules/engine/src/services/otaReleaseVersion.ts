const COORDINATED_RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-(?:dev|beta)\.[1-9]\d*)?$/

type OtaReleaseVersionInput = {
  manifestReleaseVersion?: string | null
  manifestUrl: string
  packagedManifestUrl?: string | null
  packagedReleaseIdentity?: string | null
}

function validReleaseVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim()
  return trimmed && COORDINATED_RELEASE_VERSION.test(trimmed) ? trimmed : null
}

/** Resolve the label for the selected OTA pin, including stable promotion of exact beta OTA bytes. */
export function resolveOtaReleaseVersion(input: OtaReleaseVersionInput): string | null {
  const packagedRelease = validReleaseVersion(input.packagedReleaseIdentity)
  if (packagedRelease && input.packagedManifestUrl?.trim() === input.manifestUrl.trim()) {
    return packagedRelease
  }
  return validReleaseVersion(input.manifestReleaseVersion)
}
