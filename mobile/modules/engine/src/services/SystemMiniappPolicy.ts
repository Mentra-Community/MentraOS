import {getConfigValues} from "../runtime/bootstrap"
import {isTrustedSystemMiniappRelease} from "./systemMiniappTrust"

/**
 * Build-owned miniapp identity.
 *
 * A package is build-owned when this Mentra App build ships its ZIP; the host
 * generates that list from its assets, never from miniapp.json. Each one
 * updates from its URL, like every installed miniapp; being build-owned grants
 * no runtime privileges by itself.
 */
export function isSystemMiniappPackage(packageName: string): boolean {
  return (getConfigValues().bundledSystemMiniappPackages ?? []).includes(packageName)
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
