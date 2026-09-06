/**
 * apps store refresh orchestration — pulled out of `apps.ts` so the
 * fetch → project → cache → error-capture sequence (#1222) is testable
 * without pulling in the apps store's full singleton graph (AppRegistry,
 * MiniappLauncher, MiniappRunningRegistry, ...). Every effect is injected.
 */

import type {ClientApp} from "../types/applet"

export interface AppsRefreshResult {
  /** Omitted on failure — the caller keeps its previous `apps` snapshot. */
  apps?: ClientApp[]
  /** Message from this attempt; null on success. */
  refreshError: string | null
}

/**
 * Runs one refresh attempt: fetch installed apps, project them, and persist
 * the result via `saveCache`. Never throws — a failure from either callback
 * is captured into `refreshError` instead, so the caller can always flip
 * `initialized`/`loading` and move on rather than hanging on a rejected
 * promise (the bug behind #1222: a failed load with no visible outcome).
 */
export async function runAppsRefresh(
  getInstalledApps: () => Promise<ClientApp[]>,
  project: (apps: ClientApp[]) => ClientApp[],
  saveCache: (apps: ClientApp[]) => void,
): Promise<AppsRefreshResult> {
  try {
    const projected = project(await getInstalledApps())
    saveCache(projected)
    return {apps: projected, refreshError: null}
  } catch (error) {
    console.error("ISLAND: refresh() failed", error)
    return {refreshError: error instanceof Error ? error.message : String(error)}
  }
}
