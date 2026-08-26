import {isNewerVersion} from "./catalog"
import {isManagedByStore, type InstalledApp, type StoreApp} from "../shared/types"

/** Automatic updates are limited to this Store's releases and host-assigned SYSTEM bundles. */
export function isAutomaticUpdateOwnedRelease(
  app: StoreApp,
  installed: InstalledApp | undefined,
  storePackageName: string,
): boolean {
  if (!installed || !app.release.installable || app.packageName === storePackageName) return false
  if (!isNewerVersion(app.release.version, installed.version)) return false
  return installed.system
    ? installed.systemStoreOwnerPackageName === storePackageName
    : isManagedByStore(installed, storePackageName)
}

export function isAutomaticUpdateCandidate(
  app: StoreApp,
  installed: InstalledApp | undefined,
  storePackageName: string,
): boolean {
  return (
    isAutomaticUpdateOwnedRelease(app, installed, storePackageName) &&
    app.release.installCompatibility?.compatible === true
  )
}
