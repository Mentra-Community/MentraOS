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
export class StoreUpdateSchedulerCore {
  private packages: string[] = []
  private running: Promise<void> | null = null
  private queued = false
  private started = false
  private unsubscribers: Array<() => void> = []
  private interval: unknown = null

  constructor(private readonly deps: StoreUpdateSchedulerDependencies) {}

  start(packages: readonly string[]): Promise<void> {
    this.packages = [...new Set(packages)]
    if (this.packages.length === 0) {
      this.stop()
      return Promise.resolve()
    }
    if (this.started) return this.trigger()
    this.started = true
    const trigger = () => void this.trigger()
    this.unsubscribers = [
      this.deps.subscribeForeground(trigger),
      this.deps.subscribeReconnect(trigger),
      this.deps.subscribeDeferredUpdateReady(trigger),
    ]
    this.interval = this.deps.setInterval(trigger, STORE_UPDATE_INTERVAL_MS)
    return this.trigger()
  }

  stop(): void {
    this.started = false
    this.queued = false
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers = []
    if (this.interval !== null) this.deps.clearInterval(this.interval)
    this.interval = null
  }

  trigger(): Promise<void> {
    if (!this.started || this.packages.length === 0) return Promise.resolve()
    this.queued = true
    if (this.running) return this.running
    this.running = this.drain().finally(() => {
      this.running = null
      if (this.queued && this.started) void this.trigger()
    })
    return this.running
  }

  /** Join the current pass without requesting another one. */
  waitForIdle(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  private async drain(): Promise<void> {
    while (this.queued && this.started) {
      this.queued = false
      for (const packageName of this.packages) {
        if (!this.started) return
        try {
          await this.deps.invoke(packageName)
        } catch (error) {
          this.deps.warn(`Store update reconciliation failed for ${packageName}`, error)
        }
      }
    }
  }
}
