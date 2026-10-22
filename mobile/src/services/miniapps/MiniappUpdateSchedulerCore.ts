import {MaintenanceSchedulerCore} from "./MaintenanceSchedulerCore"

export interface MiniappUpdateSchedulerDependencies {
  /** Check every installed miniapp's own URL. */
  checkAll(): Promise<unknown>
  /** Check one miniapp the user just opened. */
  checkOpened(packageName: string): Promise<unknown>
  subscribeForeground(handler: () => void): () => void
  subscribeReconnect(handler: () => void): () => void
  /** A miniapp whose automatic update waited for it has stopped. */
  subscribeDeferredUpdateReady(handler: () => void): () => void
  /** A miniapp started running. */
  subscribeOpened(handler: (packageName: string) => void): () => void
  setInterval(handler: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
  warn(message: string, error: unknown): void
}

export const MINIAPP_UPDATE_INTERVAL_MS = 15 * 60_000

const INSTALLED = "installed"

/**
 * When the Mentra App checks its miniapps' URLs: engine start, foreground,
 * reconnect, a deferred update becoming possible, and every 15 minutes, with
 * simultaneous triggers coalescing into one more pass. A miniapp the user
 * opens is checked on its own.
 */
export class MiniappUpdateSchedulerCore {
  private readonly scheduler: MaintenanceSchedulerCore<typeof INSTALLED>
  private unsubscribeOpened: (() => void) | null = null

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
    this.unsubscribeOpened ??= this.deps.subscribeOpened((packageName) => {
      this.deps.checkOpened(packageName).catch((error) => {
        this.deps.warn(`Miniapp update check failed for ${packageName}`, error)
      })
    })
    return this.scheduler.start([INSTALLED])
  }

  stop(): void {
    this.unsubscribeOpened?.()
    this.unsubscribeOpened = null
    this.scheduler.stop()
  }

  trigger(): Promise<void> {
    return this.scheduler.trigger()
  }

  waitForIdle(): Promise<void> {
    return this.scheduler.waitForIdle()
  }
}
