import type {IslandConfigValues} from "../runtime/bootstrap"

import {isPackageNameAllowedForUrl} from "./miniappDomainRule"

/** `<firstPartyMiniappsUrl><packageName>/`: where Mentra hosts this bundled package, if configured. */
export function firstPartyMiniappUrl(config: IslandConfigValues, packageName: string): string | undefined {
  const base = config.firstPartyMiniappsUrl?.trim()
  if (!base) return undefined
  try {
    const url = new URL(packageName + "/", base.endsWith("/") ? base : base + "/")
    return url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Host-trusted provenance for a build-owned (bundled) package: the bundled ZIP
 * itself, a release the engine installed for it from a Mentra host, or one
 * the build's assigned Store installed over it. Shared by runtime privileges,
 * organization visibility and install authority. Never derived from a
 * manifest, a signature or a dev server.
 */
export function isTrustedSystemMiniappRelease(
  config: IslandConfigValues,
  packageName: string,
  identity?: {source: string; storePackageName?: string; sourceUrl?: string} | null,
): boolean {
  if (!config.bundledSystemMiniappPackages?.includes(packageName)) return false
  const policy = config.localMiniappPolicy
  if (policy) {
    // An organization pin owns the package; neither the bundle nor a Store may stand in for it.
    if (policy.managed.some((entry) => entry.packageName === packageName)) return false
    if (policy.systemPackageNames !== null && !policy.systemPackageNames.includes(packageName)) return false
  } else if (config.localMiniappAllowlist && !config.localMiniappAllowlist.includes(packageName)) {
    return false
  }
  if (identity?.source === "bundled_asset") return true
  // Installed from a Mentra host: only Mentra serves its package names, so this
  // holds when a later deployment names another host, or none.
  if (identity?.source === "url") {
    return typeof identity.sourceUrl === "string" && isPackageNameAllowedForUrl(packageName, identity.sourceUrl)
  }
  const owner = identity?.storePackageName
  return Boolean(
    identity?.source === "system_store" &&
      owner &&
      config.bundledSystemMiniappPackages.includes(owner) &&
      config.bundledStoreMiniappPackages?.includes(owner) &&
      config.bundledSystemMiniappStoreOwners?.[packageName] === owner,
  )
}
