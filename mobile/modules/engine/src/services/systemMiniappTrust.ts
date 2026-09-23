import type {IslandConfigValues} from "../runtime/bootstrap"

/** Shared by install authorization, workspace visibility and runtime privileges. */
export function isTrustedSystemMiniappRelease(
  config: IslandConfigValues,
  packageName: string,
  identity?: {source: string; storePackageName?: string} | null,
): boolean {
  if (!config.bundledSystemMiniappPackages?.includes(packageName)) return false
  const policy = config.localMiniappPolicy
  if (policy) {
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
