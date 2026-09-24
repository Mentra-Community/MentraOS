export interface StoreUpdateSchedulerDependencies {
  invoke(packageName: string): Promise<unknown>
  subscribeForeground(handler: () => void): () => void
  subscribeReconnect(handler: () => void): () => void
  setInterval(handler: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
  warn(message: string, error: unknown): void
}

/** Host lifecycle triggers around the Store's transient reconcile action. */
export class StoreUpdateSchedulerCore {
  private packages: string[] = []
  private running: Promise<void> | null = null
  private queued = false
  private started = false
  private unsubscribeForeground: (() => void) | null = null
  private unsubscribeReconnect: (() => void) | null = null
  private interval: unknown = null

  constructor(private readonly deps: StoreUpdateSchedulerDependencies) {}

  start(packages: readonly string[]): Promise<void> {
    this.packages = [...new Set(packages)]
    if (this.started) {
      return this.trigger()
    }
    this.started = true
    this.unsubscribeForeground = this.deps.subscribeForeground(() => void this.trigger())
    this.unsubscribeReconnect = this.deps.subscribeReconnect(() => void this.trigger())
    this.interval = this.deps.setInterval(() => void this.trigger(), 15 * 60_000)
    return this.trigger()
  }

  stop(): void {
    this.started = false
    this.queued = false
    this.unsubscribeForeground?.()
    this.unsubscribeReconnect?.()
    this.unsubscribeForeground = null
    this.unsubscribeReconnect = null
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

  /** Join the current drain without enqueueing another reconciliation. */
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
