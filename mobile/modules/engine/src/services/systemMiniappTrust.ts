import type {IslandConfigValues} from "../runtime/bootstrap"

/**
 * Host-trusted provenance for a build-owned (bundled) package: the bundled ZIP
 * itself, or a release the build's assigned Store installed over it. Shared by
 * runtime privileges, organization visibility and Store install authority.
 * Never derived from a manifest, a signature or a dev server.
 */
export function isTrustedSystemMiniappRelease(
  config: IslandConfigValues,
  packageName: string,
  identity?: {source: string; storePackageName?: string} | null,
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
  const owner = identity?.storePackageName
  return Boolean(
    identity?.source === "system_store" &&
      owner &&
      config.bundledSystemMiniappPackages.includes(owner) &&
      config.bundledStoreMiniappPackages?.includes(owner) &&
      config.bundledSystemMiniappStoreOwners?.[packageName] === owner,
  )
}
