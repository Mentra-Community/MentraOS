import {getConfigValues} from "../runtime/bootstrap"
import {isTrustedSystemMiniappRelease} from "./systemMiniappTrust"

/**
 * Build-owned miniapp identity and Store update ownership.
 *
 * A package is build-owned when this Mentra App build ships its ZIP; the host
 * generates that list from its assets, never from miniapp.json. A bundled Store
 * is a build-owned package the build selects as a Store. Ownership decides which
 * Store may update an installed release automatically; it grants no runtime
 * privileges by itself.
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

/** One bundled Store cannot update a package the build assigns to another Store. */
export function canStoreUpdateSystemMiniapp(storePackageName: string, targetPackageName: string): boolean {
  return isTrustedSystemMiniappRelease(getConfigValues(), targetPackageName, {source: "system_store", storePackageName})
}

/** The Store the host build assigns to update this bundled package, if any. */
export function systemMiniappStoreOwner(packageName: string): string | undefined {
  const owner = getConfigValues().bundledSystemMiniappStoreOwners?.[packageName]
  return owner && canStoreUpdateSystemMiniapp(owner, packageName) ? owner : undefined
}

/**
 * Releases from Core's retired preinstall registry were Mentra-curated, digest-
 * verified consumer installs. The build's Store adopts them, so retiring that
 * registry does not leave them without updates.
 */
function legacyRegistryStoreOwner(): string | undefined {
  if (getConfigValues().localMiniappPolicy) return undefined
  return configuredPackages("bundledStoreMiniappPackages").find(isStoreMiniappPackage)
}

/**
 * The Store allowed to replace this active release automatically, or undefined
 * for a manual, development or organization-managed release.
 */
export function automaticUpdateOwner(
  packageName: string,
  identity: {source?: string; storePackageName?: string} | null | undefined,
): string | undefined {
  if (!identity?.source) return undefined
  if (isSystemMiniappPackage(packageName)) {
    if (identity.source === "bundled_asset" || identity.source === "preinstalled_registry") {
      return systemMiniappStoreOwner(packageName)
    }
    if (identity.source === "system_store" && identity.storePackageName) {
      return canStoreUpdateSystemMiniapp(identity.storePackageName, packageName) ? identity.storePackageName : undefined
    }
    return undefined
  }
  if (identity.source === "store") return identity.storePackageName
  if (identity.source === "preinstalled_registry") return legacyRegistryStoreOwner()
  return undefined
}

/** A Store manages apps from the phone, so it runs without connected glasses. */
export function requiresConnectedGlasses(packageName: string): boolean {
  return !isStoreMiniappPackage(packageName)
}

/**
 * SYSTEM trust binds the build's package list to host-owned provenance. A dev
 * server or downloaded bundle that reuses a bundled package name is not trusted.
 */
export function isHostTrustedSystemMiniapp(
  packageName: string,
  releaseIdentity?: {source?: string; storePackageName?: string; sourceUrl?: string} | null,
): boolean {
  return isTrustedSystemMiniappRelease(
    getConfigValues(),
    packageName,
    releaseIdentity?.source
      ? {
          source: releaseIdentity.source,
          storePackageName: releaseIdentity.storePackageName,
          sourceUrl: releaseIdentity.sourceUrl,
        }
      : null,
  )
}
