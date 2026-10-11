import {BgTimer} from "@mentra/engine"

import {MaintenanceSchedulerCore} from "@/services/miniapps/MaintenanceSchedulerCore"
import {subscribeAppForeground, subscribeCloudReconnect} from "@/services/miniapps/maintenanceTriggers"

import {refreshWorkspaceManifest, type RefreshWorkspaceManifestOptions} from "./refresh"

/** The same cadence as the Store's update checks. */
export const WORKSPACE_MANIFEST_CHECK_INTERVAL_MS = 15 * 60_000

type RunningSession = Pick<RefreshWorkspaceManifestOptions, "isRunning" | "reconcile">

let session: RunningSession | null = null

const scheduler = new MaintenanceSchedulerCore<string>({
  run: async () => {
    if (!session) return
    console.log(`DEPLOYMENT: workspace manifest check: ${await refreshWorkspaceManifest(session)}`)
  },
  triggers: [subscribeAppForeground, subscribeCloudReconnect],
  intervalMs: WORKSPACE_MANIFEST_CHECK_INTERVAL_MS,
  // Launch has just checked; the next check waits for a trigger.
  runOnStart: false,
  setInterval: (handler, intervalMs) => BgTimer.setInterval(handler, intervalMs),
  clearInterval: (handle) => BgTimer.clearInterval(handle as number),
  warn: (workspaceOrigin, error) =>
    console.warn(`DEPLOYMENT: workspace manifest check failed for ${workspaceOrigin}`, error),
})

/**
 * Re-check the selected workspace's manifest while the app runs, like the
 * Store's update checks: when the app comes to the foreground, when the cloud
 * reconnects, and every 15 minutes.
 */
export const workspaceManifestScheduler = {
  start(workspaceOrigin: string, runningSession: RunningSession): Promise<void> {
    session = runningSession
    return scheduler.start([workspaceOrigin])
  },
  stop(): void {
    scheduler.stop()
    session = null
  },
}
