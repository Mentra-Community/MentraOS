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
 * The Store miniapp that Mentra App betas bundled before 3.3. A release it
 * installed (`system_store`) came from Mentra's Store, so it keeps its trust
 * until an update from a Mentra host replaces it. Nothing installs as a Store
 * any more; these releases are only read.
 */
const RETIRED_MENTRA_STORE = "com.mentra.store"

/** A bundled package this deployment lets run with the build's privileges. */
function isApprovedSystemPackage(config: IslandConfigValues, packageName: string): boolean {
  if (!config.bundledSystemMiniappPackages?.includes(packageName)) return false
  const policy = config.localMiniappPolicy
  if (policy) {
    // An organization pin owns the package; the bundle may not stand in for it.
    if (policy.managed.some((entry) => entry.packageName === packageName)) return false
    if (policy.systemPackageNames !== null && !policy.systemPackageNames.includes(packageName)) return false
  } else if (config.localMiniappAllowlist && !config.localMiniappAllowlist.includes(packageName)) {
    return false
  }
  return true
}

/**
 * Host-trusted provenance for a build-owned (bundled) package: the bundled ZIP
 * itself, a release the engine installed for it from a Mentra host, or one the
 * retired Mentra Store installed over it. Shared by runtime privileges and
 * organization visibility. Never derived from a manifest, a signature or a dev
 * server, and never a local-network or development build, which may claim any
 * name.
 */
export function isTrustedSystemMiniappRelease(
  config: IslandConfigValues,
  packageName: string,
  identity?: {source: string; storePackageName?: string; sourceUrl?: string} | null,
): boolean {
  if (identity?.source === "local" || identity?.source === "dev_snapshot") return false
  if (!isApprovedSystemPackage(config, packageName)) return false
  if (identity?.source === "bundled_asset") return true
  // Installed from a URL whose domain owns the name, which for Mentra's names is
  // a mentraglass.com host: only that domain serves them, so this holds when a
  // later deployment names another host, or none.
  if (identity?.source === "url") {
    return typeof identity.sourceUrl === "string" && isPackageNameAllowedForUrl(packageName, identity.sourceUrl)
  }
  return identity?.source === "system_store" && identity.storePackageName === RETIRED_MENTRA_STORE
}
