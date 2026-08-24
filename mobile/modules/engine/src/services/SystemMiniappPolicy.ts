import semver from "semver"

import {getConfigValues} from "../runtime/bootstrap"

/**
 * SYSTEM identity comes from the host build's generated bundled-ZIP catalog,
 * never miniapp.json. Merely installing a bundle with the same package name
 * does not add an identity to this set.
 */
function configuredPackages(key: "bundledSystemMiniappPackages" | "bundledStoreMiniappPackages"): readonly string[] {
  return getConfigValues()[key] ?? []
}

export function isSystemMiniappPackage(packageName: string): boolean {
  return configuredPackages("bundledSystemMiniappPackages").includes(packageName)
}

export function isStoreMiniappPackage(packageName: string): boolean {
  return isSystemMiniappPackage(packageName) && configuredPackages("bundledStoreMiniappPackages").includes(packageName)
}

/** Build-selected ownership prevents one bundled Store from replacing another Store's SYSTEM apps. */
export function canStoreUpdateSystemMiniapp(storePackageName: string, targetPackageName: string): boolean {
  return (
    isStoreMiniappPackage(storePackageName) &&
    isSystemMiniappPackage(targetPackageName) &&
    getConfigValues().bundledSystemMiniappStoreOwners?.[targetPackageName] === storePackageName
  )
}

/** Store selected by the host build to update this SYSTEM package, if any. */
export function systemMiniappStoreOwner(packageName: string): string | undefined {
  if (!isSystemMiniappPackage(packageName)) return undefined
  return getConfigValues().bundledSystemMiniappStoreOwners?.[packageName]
}

/**
 * Central install authority for protected package identities.
 *
 * A bundled provenance claim is accepted only on the local bundled-asset path;
 * remote/direct/dev callers cannot manufacture it. SYSTEM Store updates must
 * come from the exact Store selected by the host build.
 */
export function canInstallMiniappRelease(
  packageName: string,
  releaseIdentity: {source?: string; storePackageName?: string},
  localBundledAsset: boolean,
): boolean {
  if (!isSystemMiniappPackage(packageName)) return true
  if (releaseIdentity.source === "bundled_asset") return localBundledAsset
  return (
    releaseIdentity.source === "system_store" &&
    typeof releaseIdentity.storePackageName === "string" &&
    canStoreUpdateSystemMiniapp(releaseIdentity.storePackageName, packageName)
  )
}

/** Keep a newer trusted SYSTEM release active when an older ZIP ships in a later host build. */
export function shouldActivateBundledVersion(
  bundledVersion: string,
  activeVersion: string | undefined,
  activeIsTrustedSystem: boolean,
): boolean {
  if (!activeVersion || !activeIsTrustedSystem) return true
  if (!semver.valid(bundledVersion) || !semver.valid(activeVersion)) return true
  return !semver.gt(activeVersion, bundledVersion)
}

/** Store management is a phone surface and remains available without glasses. */
export function requiresConnectedGlasses(packageName: string): boolean {
  return !isStoreMiniappPackage(packageName)
}

/**
 * The remotely managed preinstalled registry must never replace a build-owned
 * SYSTEM package. SYSTEM updates use the narrower bundled-Store channel;
 * treating ordinary registry provenance as bundled would let a downloaded
 * replacement inherit privileged APIs.
 */
export function isPreinstalledMiniappPackageAllowed(packageName: string): boolean {
  return !isSystemMiniappPackage(packageName)
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
  if (!isSystemMiniappPackage(packageName)) return false
  if (releaseIdentity?.source === "bundled_asset") return true
  return (
    releaseIdentity?.source === "system_store" &&
    typeof releaseIdentity.storePackageName === "string" &&
    canStoreUpdateSystemMiniapp(releaseIdentity.storePackageName, packageName)
  )
}
