import {BgTimer} from "../utils/timers"

/**
 * The one retry schedule for on-device speech models: a failed download and a
 * failed load both retry after 30 s, 1 min, 2 min, then every 5 min, for as
 * long as a miniapp still needs the model. Callers also retry right away on
 * their next load attempt (a new subscription, a model change).
 */
export const MODEL_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000] as const

export class ModelRetry {
  private attempt = 0
  private timer: number | null = null

  constructor(
    private readonly timers: {
      setTimeout: (callback: () => void, delay: number) => number
      clearTimeout: (id: number) => void
    } = BgTimer,
  ) {}

  get pending(): boolean {
    return this.timer !== null
  }

  /** Schedule `run` after the next backoff step; returns the delay used. */
  schedule(run: () => void): number {
    this.cancel()
    const delay = MODEL_RETRY_DELAYS_MS[Math.min(this.attempt, MODEL_RETRY_DELAYS_MS.length - 1)]
    this.attempt++
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      run()
    }, delay)
    return delay
  }

  cancel(): void {
    if (this.timer === null) return
    this.timers.clearTimeout(this.timer)
    this.timer = null
  }

  /** Forget earlier failures (success, or the need went away). */
  reset(): void {
    this.cancel()
    this.attempt = 0
  }
}
