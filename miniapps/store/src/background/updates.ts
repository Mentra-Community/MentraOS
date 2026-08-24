import {isNewerVersion} from "./catalog"
import {isManagedByStore, type InstalledApp, type StoreApp} from "../shared/types"

/** Automatic updates are limited to this Store's releases and host-assigned SYSTEM bundles. */
export function isAutomaticUpdateCandidate(
  app: StoreApp,
  installed: InstalledApp | undefined,
  storePackageName: string,
): boolean {
  if (!installed || app.packageName === storePackageName) return false
  if (!isNewerVersion(app.release.version, installed.version)) return false
  if (app.release.installCompatibility?.compatible !== true) return false
  return installed.system || isManagedByStore(installed, storePackageName)
}
