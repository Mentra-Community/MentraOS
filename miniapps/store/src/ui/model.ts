import type {InstalledApp, StoreApp, StoreRelease} from "../shared/types"

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
