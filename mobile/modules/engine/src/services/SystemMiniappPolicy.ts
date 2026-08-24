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
