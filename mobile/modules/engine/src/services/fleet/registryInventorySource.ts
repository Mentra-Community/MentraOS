/**
 * Fleet's inventory source over the app registry: each installed miniapp's release (development builds are not
 * inventory), its digest and why the phone holds it.
 *
 * The digest is the release identity's `bundleSha256`. A release installed without one (bundled assets and release-QR
 * installs record none) is listed without a digest, and the collector leaves it out of the record.
 */
import type {FleetInstallReason} from "@mentra/cloud-protocol"

import appRegistry from "../AppRegistry"
import type {InstalledMiniapp, InventorySource} from "./fleetCollector"

/** The part of the registry the source reads. */
export interface InventoryRegistry {
  isLoaded(): boolean
  getPackageNames(): string[]
  getActiveReleaseVersion(packageName: string): string | null
  getReleaseIdentity(packageName: string, version: string): {source: string; bundleSha256?: string} | null
  getInstallReasons(packageName: string): readonly FleetInstallReason[]
  /** Fires after installs, uninstalls, updates, reason and access changes, and once the registry has loaded. */
  subscribe(listener: () => void): () => void
}

function scan(registry: InventoryRegistry): InstalledMiniapp[] {
  const out: InstalledMiniapp[] = []
  for (const packageName of registry.getPackageNames()) {
    const versionName = registry.getActiveReleaseVersion(packageName)
    if (versionName === null) continue
    const identity = registry.getReleaseIdentity(packageName, versionName)
    if (identity?.source === "dev_snapshot") continue
    out.push({
      packageName,
      versionName,
      digest: identity?.bundleSha256 ?? "",
      reasons: registry.getInstallReasons(packageName),
    })
  }
  return out
}

/** The registry's inventory: null until it has loaded, then a listing cached until the registry changes. */
export function createRegistryInventorySource(registry: InventoryRegistry): InventorySource {
  let cached: readonly InstalledMiniapp[] | null = null
  let subscribers = 0
  return {
    list() {
      if (!registry.isLoaded()) return null
      if (cached && subscribers > 0) return cached
      try {
        cached = scan(registry)
      } catch (error) {
        console.warn("Fleet: could not list the installed miniapps", error)
        return null
      }
      return cached
    },
    subscribe(listener) {
      subscribers += 1
      cached = null
      const unsubscribe = registry.subscribe(() => {
        cached = null
        listener()
      })
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        subscribers -= 1
        unsubscribe()
      }
    },
  }
}

export const registryInventorySource: InventorySource = createRegistryInventorySource(appRegistry)
