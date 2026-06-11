/**
 * Package names of built-in offline apps that render inside the Compositor
 * overlay via <OfflineAppHost /> instead of pushing their offlineRoute onto
 * the root expo-router stack.
 *
 * Kept separate from offlineAppRegistry so launch-decision call sites
 * (MiniappCatalog, AppSwitcher) don't transitively import every hosted
 * screen component.
 *
 * Deliberately excludes:
 *   - com.mentra.miniappdev (lmaInstaller) — keeps its route behavior
 *   - captions / notify — no offlineRoute, nothing to render
 */
export const OFFLINE_HOSTED_PACKAGES = new Set([
  "com.mentra.settings",
  "com.mentra.store",
  "com.mentra.mirror",
  "com.mentra.camera",
  "com.mentra.feedback",
])

export const isOfflineHosted = (packageName: string) => OFFLINE_HOSTED_PACKAGES.has(packageName)
