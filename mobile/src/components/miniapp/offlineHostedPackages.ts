/**
 * Package names of built-in offline apps that render inside the Compositor
 * overlay via <OfflineAppHost /> instead of pushing their offlineRoute onto
 * the root expo-router stack.
 *
 * Kept separate from offlineAppRegistry so launch-decision call sites
 * (MiniappCatalog, AppSwitcher) don't transitively import every hosted
 * screen component.
 *
 * Deliberately excludes captions / notify — no offlineRoute, nothing to render.
 */
import {
  cameraPackageName,
  feedbackPackageName,
  lmaInstallerPackageName,
  mirrorPackageName,
  settingsPackageName,
  storePackageName,
} from "@/constants/miniapps"

export const OFFLINE_HOSTED_PACKAGES = new Set([
  settingsPackageName,
  storePackageName,
  mirrorPackageName,
  cameraPackageName,
  feedbackPackageName,
  lmaInstallerPackageName,
])

export const isOfflineHosted = (packageName: string) => OFFLINE_HOSTED_PACKAGES.has(packageName)
