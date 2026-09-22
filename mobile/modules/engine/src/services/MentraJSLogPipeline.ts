/**
 * MentraJSLogPipeline — the three log-side utilities that
 * MentraJSRouter's `__log` handler runs every miniapp log line through:
 *
 *   1. redactSecrets — walks a value (string / array / object) and
 *      replaces anything matching the secret-key regex
 *      (token|password|secret|auth|bearer|key|api[_-]?key) with
 *      "[REDACTED]". Conservative: over-redaction is preferable to
 *      leaking a real secret into Sentry breadcrumbs.
 *
 *   2. MentraJSLogThrottle — token-bucket rate limiter, 100 lines/min
 *      sustained with a 500-line burst, per miniapp. Excess is dropped
 *      and surfaced once as a `[throttled N]` summary. Stops a
 *      misbehaving miniapp from drowning the host's log stream.
 *
 *   3. MentraJSLogRingBuffer — fixed-size circular buffer (default 200)
 *      holding the most recent log lines per miniapp. Dumped into the
 *      crash report so post-mortem tooling sees the miniapp's last words.
 *
 * All three are pure (no React Native imports) and unit-tested in
 * MentraJSLogPipeline.test.ts.
 */

const SECRET_KEY_PATTERN = /\b(token|password|secret|auth|bearer|key|api[_-]?key)\b/i

/**
 * Redact obvious secret-like strings from a log line. Walks the JSON
 * argument list, replacing any value that looks like a secret with
 * `[REDACTED]`. Conservative — false negatives are fine, false positives
 * are bad (devs lose visibility into their own data).
 *
 * Heuristics:
 *   1. Top-level strings matching SECRET_KEY_PATTERN get the entire value
 *      redacted (e.g. `console.log("token=abc123")` → `[REDACTED]`).
 *   2. Object keys matching the pattern get their values replaced.
 *   3. Arrays are walked element-by-element.
 *
 * Returns a new structure — never mutates the input.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_KEY_PATTERN.test(value) ? "[REDACTED]" : value
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v))
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]"
      } else {
        out[k] = redactSecrets(v)
      }
    }
    return out
  }
  return value
}

/**
 * Token bucket throttler. Per-package: 100 logs/min sustained with a 500
 * burst. Excess lines are dropped; the first drop in each refill window
 * emits a `[throttled N]` synthetic line so the dev knows messages
 * were lost.
 */
export interface ThrottleOptions {
  /** Tokens added per second. Default 100/60 = ~1.67. */
  tokensPerSecond?: number
  /** Bucket capacity. Default 500. */
  bucketCapacity?: number
  /** Clock override for tests. */
  now?: () => number
}

/** A per-package override of the shared budget. Both fields are absolute, not multipliers. */
export interface PackageLogBudget {
  tokensPerSecond: number
  bucketCapacity: number
}

/**
 * Budgets for miniapps under active diagnosis.
 *
 * The default ceiling protects the host from a miniapp that logs in a render loop, and it is the
 * right default. It is the wrong ceiling for a miniapp someone is actively debugging: a single
 * instrumented call join emits several hundred lines in its first few seconds, which exhausts the
 * burst and then drops everything that follows — and the drops land exactly where the interesting
 * part is. A log with silent holes in the failure window is worse than no log, because it is read
 * as complete.
 *
 * So the ceiling is raised for named packages rather than lowered for everyone. Anything not
 * listed here keeps the protective default.
 */
export const DIAGNOSTIC_LOG_BUDGETS: Readonly<Record<string, PackageLogBudget>> = {
  // Mentra Call is instrumented end to end — UI, background, and the host call path — so the
  // whole of a join, a cancel, and a teardown can be read back from one capture.
  "com.mentra.call": {tokensPerSecond: 200, bucketCapacity: 5_000},
}

/** Ring-buffer window for a package in {@link DIAGNOSTIC_LOG_BUDGETS}. See `capacityFor`. */
export const DIAGNOSTIC_RING_CAPACITY = 2_000

interface PackageBucket {
  tokens: number
  lastRefillAtMs: number
  /** Drops accumulated since the last `[throttled N]` synthetic line. */
  pendingDrops: number
}

export class MentraJSLogThrottle {
  private readonly tokensPerSecond: number
  private readonly bucketCapacity: number
  private readonly now: () => number
  private readonly buckets: Map<string, PackageBucket> = new Map()
  private readonly budgets: Map<string, PackageLogBudget> = new Map(Object.entries(DIAGNOSTIC_LOG_BUDGETS))

  constructor(opts: ThrottleOptions = {}) {
    this.tokensPerSecond = opts.tokensPerSecond ?? 100 / 60
    this.bucketCapacity = opts.bucketCapacity ?? 500
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * Raise (or lower) one package's budget at runtime.
   *
   * Exists so a support session can widen the pipe for the miniapp being investigated without a
   * rebuild, and so tests can exercise a budget without depending on the shipped table.
   */
  setPackageBudget(packageName: string, budget: PackageLogBudget | null): void {
    if (budget) this.budgets.set(packageName, budget)
    else this.budgets.delete(packageName)
    // The bucket holds a capacity snapshot, so a stale one would keep enforcing the old ceiling
    // until it happened to refill. Dropping it re-derives from the new budget on the next line.
    this.buckets.delete(packageName)
  }

  private budgetFor(packageName: string): PackageLogBudget {
    return (
      this.budgets.get(packageName) ?? {
        tokensPerSecond: this.tokensPerSecond,
        bucketCapacity: this.bucketCapacity,
      }
    )
  }

  /**
   * Try to consume one token for the named package. Returns either:
   *   - `{allowed: true}` — caller emits the original log line.
   *   - `{allowed: false, throttledLine}` — caller may emit the
   *     synthetic throttled line (the first drop in each window).
   *     If `throttledLine` is undefined the caller drops silently
   *     (subsequent drops in the same window).
   */
  consume(packageName: string): {allowed: true} | {allowed: false; throttledLine?: string} {
    const at = this.now()
    const budget = this.budgetFor(packageName)
    let bucket = this.buckets.get(packageName)
    if (!bucket) {
      bucket = {
        tokens: budget.bucketCapacity,
        lastRefillAtMs: at,
        pendingDrops: 0,
      }
      this.buckets.set(packageName, bucket)
    } else {
      const elapsedSec = (at - bucket.lastRefillAtMs) / 1000
      bucket.tokens = Math.min(budget.bucketCapacity, bucket.tokens + elapsedSec * budget.tokensPerSecond)
      bucket.lastRefillAtMs = at
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      if (bucket.pendingDrops > 0) {
        const dropped = bucket.pendingDrops
        bucket.pendingDrops = 0
        return {allowed: false, throttledLine: `[throttled ${dropped}]`}
      }
      return {allowed: true}
    }
    bucket.pendingDrops += 1
    return {allowed: false}
  }

  /** Test/dev — reset all buckets. */
  resetForTests(): void {
    this.buckets.clear()
  }
}

/**
 * In-memory ring buffer holding the last N lines per package. Useful as a
 * "last words" context attached to crash reports.
 */
export class MentraJSLogRingBuffer {
  private readonly capacity: number
  private readonly buffers: Map<string, string[]> = new Map()

  constructor(capacityPerPackage = 200) {
    this.capacity = capacityPerPackage
  }

  /**
   * Capacity for a package under diagnosis.
   *
   * This buffer is the miniapp's last words in a crash report, and 200 lines of a heavily
   * instrumented miniapp is a couple of seconds — so the report would arrive holding the
   * aftermath and none of the cause. A package with a raised log budget needs a window long
   * enough to contain whatever produced the crash.
   */
  private capacityFor(packageName: string): number {
    const budget = DIAGNOSTIC_LOG_BUDGETS[packageName]
    return budget ? Math.max(this.capacity, DIAGNOSTIC_RING_CAPACITY) : this.capacity
  }

  push(packageName: string, line: string): void {
    let buf = this.buffers.get(packageName)
    if (!buf) {
      buf = []
      this.buffers.set(packageName, buf)
    }
    buf.push(line)
    const capacity = this.capacityFor(packageName)
    while (buf.length > capacity) buf.shift()
  }

  snapshot(packageName: string): string[] {
    return [...(this.buffers.get(packageName) ?? [])]
  }

  clear(packageName: string): void {
    this.buffers.delete(packageName)
  }
}
