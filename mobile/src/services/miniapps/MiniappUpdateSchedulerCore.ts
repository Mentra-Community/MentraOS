import {MaintenanceSchedulerCore} from "./MaintenanceSchedulerCore"

export interface MiniappUpdateSchedulerDependencies {
  /** Check every installed miniapp's own URL. */
  checkAll(): Promise<unknown>
  subscribeForeground(handler: () => void): () => void
  subscribeReconnect(handler: () => void): () => void
  /** A miniapp whose automatic update waited for it has stopped, or was opened again after Not now. */
  subscribeDeferredUpdateReady(handler: () => void): () => void
  setInterval(handler: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
  warn(message: string, error: unknown): void
}

export const MINIAPP_UPDATE_INTERVAL_MS = 15 * 60_000

const INSTALLED = "installed"

/**
 * When the Mentra App checks its miniapps' URLs: engine start, foreground,
 * reconnect, a deferred update becoming possible, and every 15 minutes, with
 * simultaneous triggers coalescing into one more pass. A miniapp that is
 * about to start is checked by the engine itself, which holds the start for it.
 */
export class MiniappUpdateSchedulerCore {
  private readonly scheduler: MaintenanceSchedulerCore<typeof INSTALLED>

  constructor(private readonly deps: MiniappUpdateSchedulerDependencies) {
    this.scheduler = new MaintenanceSchedulerCore({
      run: () => deps.checkAll(),
      triggers: [deps.subscribeForeground, deps.subscribeReconnect, deps.subscribeDeferredUpdateReady],
      intervalMs: MINIAPP_UPDATE_INTERVAL_MS,
      setInterval: deps.setInterval,
      clearInterval: deps.clearInterval,
      warn: (_target, error) => deps.warn("Miniapp update check failed", error),
    })
  }

  start(): Promise<void> {
    return this.scheduler.start([INSTALLED])
  }

  stop(): void {
    this.scheduler.stop()
  }

  trigger(): Promise<void> {
    return this.scheduler.trigger()
  }

  waitForIdle(): Promise<void> {
    return this.scheduler.waitForIdle()
  }
}
