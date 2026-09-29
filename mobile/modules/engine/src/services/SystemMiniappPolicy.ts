import semver from "semver"

import {getConfigValues, isInstalledMiniappAllowed, isLocalMiniappPackageAllowed} from "../runtime/bootstrap"
import {isTrustedSystemMiniappRelease} from "./systemMiniappTrust"

/**
 * SYSTEM identity comes from the host build's generated bundled-ZIP catalog,
 * never miniapp.json. Merely installing a bundle with the same package name
 * does not add an identity to this set.
 */
function configuredPackages(key: "bundledSystemMiniappPackages" | "bundledStoreMiniappPackages"): readonly string[] {
  return getConfigValues()[key] ?? []
}

function managedMiniapp(packageName: string) {
  return getConfigValues().localMiniappPolicy?.managed.find((entry) => entry.packageName === packageName)
}

export function isSystemMiniappPackage(packageName: string): boolean {
  return configuredPackages("bundledSystemMiniappPackages").includes(packageName)
}

export function isStoreMiniappPackage(packageName: string): boolean {
  return isSystemMiniappPackage(packageName) && configuredPackages("bundledStoreMiniappPackages").includes(packageName)
}

/** Build-selected ownership prevents one bundled Store from replacing another Store's SYSTEM apps. */
export function canStoreUpdateSystemMiniapp(storePackageName: string, targetPackageName: string): boolean {
  return isTrustedSystemMiniappRelease(getConfigValues(), targetPackageName, {source: "system_store", storePackageName})
}

/** Explicit consumer QR/URL installs are allowed, without granting SYSTEM authority. */
export function canUseManualMiniappRelease(packageName: string): boolean {
  return !getConfigValues().localMiniappPolicy && isLocalMiniappPackageAllowed(packageName)
}

/** Store selected by the host build to update this SYSTEM package, if any. */
export function systemMiniappStoreOwner(packageName: string): string | undefined {
  const owner = getConfigValues().bundledSystemMiniappStoreOwners?.[packageName]
  return owner && canStoreUpdateSystemMiniapp(owner, packageName) ? owner : undefined
}

/**
 * Central install authority for protected package identities.
 *
 * A bundled provenance claim is accepted only on the local bundled-asset path;
 * remote/direct/dev callers cannot manufacture it. SYSTEM Store updates must
 * come from the exact Store selected by the host build.
 * Workspace pins instead require locally verified bytes and exact deployment
 * provenance; they never acquire SYSTEM authority or Store ownership.
 */
export function canInstallMiniappRelease(
  packageName: string,
  releaseIdentity: {
    source: string
    storePackageName?: string
    bundleSha256?: string
    deploymentId?: string
    deploymentOrigin?: string
  },
  localBundledAsset: boolean,
  candidate?: {version: string; verifiedBundleSha256?: string},
): boolean {
  const managed = managedMiniapp(packageName)
  if (
    getConfigValues().localMiniappPolicy &&
    !isInstalledMiniappAllowed(packageName, candidate?.version, releaseIdentity)
  ) {
    return false
  }
  if (managed || releaseIdentity.source === "deployment_manifest") {
    return Boolean(
      managed &&
        localBundledAsset &&
        !isStoreMiniappPackage(packageName) &&
        releaseIdentity.source === "deployment_manifest" &&
        candidate?.version === managed.version &&
        candidate.verifiedBundleSha256 === managed.sha256 &&
        releaseIdentity.bundleSha256?.toLowerCase() === managed.sha256 &&
        releaseIdentity.deploymentId === managed.deploymentId &&
        releaseIdentity.deploymentOrigin === managed.deploymentOrigin,
    )
  }
  if (!isSystemMiniappPackage(packageName)) return true
  if (releaseIdentity.source === "bundled_asset") return localBundledAsset
  if (releaseIdentity.source === "direct_download" || releaseIdentity.source === "dev_snapshot") {
    return canUseManualMiniappRelease(packageName)
  }
  return (
    releaseIdentity.source === "system_store" &&
    typeof releaseIdentity.storePackageName === "string" &&
    canStoreUpdateSystemMiniapp(releaseIdentity.storePackageName, packageName)
  )
}

/** Keep a newer trusted or manually selected release when the host ships an older ZIP. */
export function shouldActivateBundledVersion(
  bundledVersion: string,
  activeVersion: string | undefined,
  preserveNewerRelease: boolean,
): boolean {
  if (!activeVersion || !preserveNewerRelease) return true
  if (!semver.valid(bundledVersion) || !semver.valid(activeVersion)) return true
  return !semver.gt(activeVersion, bundledVersion)
}

/** Store management is a phone surface and remains available without glasses. */
export function requiresConnectedGlasses(packageName: string): boolean {
  return !isStoreMiniappPackage(packageName)
}

/**
 * Bind SYSTEM authority to both the build-owned package allowlist and the
 * host-owned bundle provenance. A dev server or downloaded bundle that copies
 * a SYSTEM package name must never inherit privileged host APIs.
 */
export function isHostTrustedSystemMiniapp(
  packageName: string,
  releaseIdentity?: {source?: string; storePackageName?: string} | null,
): boolean {
  return isTrustedSystemMiniappRelease(
    getConfigValues(),
    packageName,
    releaseIdentity?.source
      ? {source: releaseIdentity.source, storePackageName: releaseIdentity.storePackageName}
      : null,
  )
}
