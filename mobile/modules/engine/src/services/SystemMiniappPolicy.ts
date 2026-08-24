/**
 * Build-owned SYSTEM identity policy.
 *
 * This list is intentionally not derived from miniapp.json. A developer cannot
 * request or inherit SYSTEM by changing a manifest, installing a bundle, or
 * running in dev mode. Adding a package requires a reviewed Mentra App build.
 */
export const SYSTEM_MINIAPP_PACKAGES: ReadonlySet<string> = new Set([
  "com.mentra.camera",
  "com.mentra.gallery",
  "com.mentra.settings",
  "com.mentra.simulated",
  "com.mentra.mirror",
  "com.mentra.ai",
  "cloud.augmentos.notify",
  "com.mentra.feedback",
  "com.mentra.miniappdev",
  "com.mentra.store",
])

export function isSystemMiniappPackage(packageName: string): boolean {
  return SYSTEM_MINIAPP_PACKAGES.has(packageName)
}

/**
 * Bind SYSTEM authority to both the build-owned package allowlist and the
 * host-owned bundle provenance. A dev server or downloaded bundle that copies
 * a SYSTEM package name must never inherit privileged host APIs.
 */
export function isHostTrustedSystemMiniapp(packageName: string, releaseSource?: string): boolean {
  return isSystemMiniappPackage(packageName) && releaseSource === "bundled_asset"
}
