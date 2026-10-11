export interface MaintenanceSchedulerDependencies<T> {
  /** One target's maintenance pass. */
  run(target: T): Promise<unknown>
  /** Events that request another pass. Each returns an unsubscribe function. */
  triggers: ReadonlyArray<(handler: () => void) => () => void>
  intervalMs: number
  /** Also run a pass as soon as it starts (default true). */
  runOnStart?: boolean
  setInterval(handler: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
  warn(target: T, error: unknown): void
}

/**
 * Background maintenance for a set of targets: a pass at start, on each
 * trigger and on an interval. Simultaneous triggers coalesce into one more pass.
 */
export class MaintenanceSchedulerCore<T> {
  private targets: T[] = []
  private running: Promise<void> | null = null
  private queued = false
  private started = false
  private unsubscribers: Array<() => void> = []
  private interval: unknown = null

  constructor(private readonly deps: MaintenanceSchedulerDependencies<T>) {}

  start(targets: readonly T[]): Promise<void> {
    this.targets = [...new Set(targets)]
    if (this.targets.length === 0) {
      this.stop()
      return Promise.resolve()
    }
    if (this.started) return this.trigger()
    this.started = true
    const trigger = () => void this.trigger()
    this.unsubscribers = this.deps.triggers.map((subscribe) => subscribe(trigger))
    this.interval = this.deps.setInterval(trigger, this.deps.intervalMs)
    return this.deps.runOnStart === false ? Promise.resolve() : this.trigger()
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
    if (!this.started || this.targets.length === 0) return Promise.resolve()
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
      for (const target of this.targets) {
        if (!this.started) return
        try {
          await this.deps.run(target)
        } catch (error) {
          this.deps.warn(target, error)
        }
      }
    }
  }
}
