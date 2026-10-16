import {MaintenanceSchedulerCore} from "./MaintenanceSchedulerCore"

export interface StoreUpdateSchedulerDependencies {
  invoke(packageName: string): Promise<unknown>
  subscribeForeground(handler: () => void): () => void
  subscribeReconnect(handler: () => void): () => void
  /** A miniapp whose automatic update waited for it has stopped. */
  subscribeDeferredUpdateReady(handler: () => void): () => void
  setInterval(handler: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
  warn(message: string, error: unknown): void
}

export const STORE_UPDATE_INTERVAL_MS = 15 * 60_000

/**
 * Host triggers for the bundled Stores' background maintenance: engine start,
 * foreground, reconnect, a deferred update becoming possible, and a periodic
 * interval. Simultaneous triggers coalesce into one more pass.
 */
export class StoreUpdateSchedulerCore extends MaintenanceSchedulerCore<string> {
  constructor(deps: StoreUpdateSchedulerDependencies) {
    super({
      run: (packageName) => deps.invoke(packageName),
      triggers: [deps.subscribeForeground, deps.subscribeReconnect, deps.subscribeDeferredUpdateReady],
      intervalMs: STORE_UPDATE_INTERVAL_MS,
      setInterval: deps.setInterval,
      clearInterval: deps.clearInterval,
      warn: (packageName, error) => deps.warn(`Store update reconciliation failed for ${packageName}`, error),
    })
  }
}
