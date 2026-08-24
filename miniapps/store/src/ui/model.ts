import type {InstalledApp, StoreApp} from "../shared/types"

export type StoreAction = "install" | "open"

export function isStoreActionDisabled(action: StoreAction, installed?: InstalledApp): boolean {
  return action === "open" && installed?.compatibility.isCompatible === false
}

export function resolveSelectedApp(apps: StoreApp[], packageName: string | null): StoreApp | null {
  if (!packageName) return null
  return apps.find((app) => app.packageName === packageName) ?? null
}
