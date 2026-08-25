import type {InstalledApp, StoreApp, StoreRelease} from "../shared/types"
import {isNewerVersion} from "../background/catalog"

export type StoreAction = "install" | "open"

export function isStoreActionDisabled(
  action: StoreAction,
  installed?: InstalledApp,
  installCompatibility?: StoreRelease["installCompatibility"],
): boolean {
  if (action === "install" && installCompatibility?.compatible === false) return true
  return action === "open" && installed?.compatibility.isCompatible === false
}

export function resolveSelectedApp(apps: StoreApp[], packageName: string | null): StoreApp | null {
  if (!packageName) return null
  return apps.find((app) => app.packageName === packageName) ?? null
}

export function selectCompatibleUpdates(
  apps: StoreApp[],
  installedByPackage: ReadonlyMap<string, InstalledApp>,
): StoreApp[] {
  return apps.filter((app) => {
    const installed = installedByPackage.get(app.packageName)
    return (
      installed !== undefined &&
      isNewerVersion(app.release.version, installed.version) &&
      !isStoreActionDisabled("install", installed, app.release.installCompatibility)
    )
  })
}

export function filterStoreCategory(
  apps: StoreApp[],
  category: string | null,
  query: string,
  storeTab: boolean,
): StoreApp[] {
  if (!category || !storeTab || query.trim()) return apps
  return apps.filter((app) => app.categories.includes(category))
}
