/**
 * MentraJSCrashController — crash recovery state machine for the
 * per-miniapp JSContexts owned by MentraJSRouter.
 *
 *   RUNNING
 *     │  crash detected (uncaught exception, native bridge throw,
 *     │   ping miss, soft-watchdog kill, etc.)
 *     ▼
 *   CRASHED ──── respawn allowed? ──── no ──► CRASHLOOP_DISABLED
 *     │                                          (persistent banner)
 *     ▼ yes
 *   BACKOFF(2s → 8s → 30s)
 *     │  timer fires
 *     ▼
 *   RUNNING (and stays here on a clean 60s window;
 *            otherwise crash count increments)
 *
 * Retry policy: zero retries by default — the first crash escalates
 * straight to CRASHLOOP_DISABLED, matching how Android / iOS treat crashed
 * apps. Callers that prefer auto-respawn opt in by passing
 * `{maxRetries: 3, backoffMs: [2_000, 8_000, 30_000]}`; the BACKOFF state
 * machine and exponential delays are implemented and unit-tested for that
 * case.
 *
 * The controller is purely a policy engine — it doesn't actually call
 * mentraJsSpawn / mentraJsKill. Callers (MentraJSRouter) read the
 * Outcome returned from onCrash() and drive the host accordingly. This
 * makes the controller unit-testable with synthetic timer.
 */

export type CrashState =
  | {kind: "RUNNING"; sinceMs: number}
  | {kind: "CRASHED"; reason: string; crashedAtMs: number}
  | {kind: "BACKOFF"; until: number; attempt: number; reason: string}
  | {kind: "CRASHLOOP_DISABLED"; sinceMs: number; reason: string}

export interface CrashOutcome {
  /** Caller must call `respawn(packageName)` after this delay (ms from now). */
  scheduleRespawnAfterMs?: number
  /** Caller should surface "X restarted" toast (2nd-within-5m crash). */
  showRestartToast?: boolean
  /** Caller should surface persistent "crashloop disabled" banner. */
  surfaceCrashloopBanner?: boolean
  /** Caller may push the crash event to dev portal / Sentry as warn-level. */
  sentryLevel?: "info" | "warning" | "error"
}

export interface CrashControllerOptions {
  /** Override the wall clock for tests. Defaults to Date.now. */
  now?: () => number
  /** Backoff sequence in ms. Defaults to [2_000, 8_000, 30_000]. */
  backoffMs?: number[]
  /** Window in ms — N crashes inside this window escalates. Defaults to 5min. */
  crashWindowMs?: number
  /** Max retries before CRASHLOOP_DISABLED. Defaults to 0 — first crash
   *  escalates immediately, matching Android / iOS app conventions. */
  maxRetries?: number
  /** Clean-uptime threshold that resets the retry counter. Defaults to 60s. */
  cleanUptimeResetMs?: number
}

interface PackageState {
  state: CrashState
  /** Crash timestamps inside the current window (sorted ascending). */
  crashesInWindow: number[]
  /** Total respawns since the package was first registered (for telemetry). */
  totalRespawns: number
}

const DEFAULT_BACKOFFS = [2_000, 8_000, 30_000]
const DEFAULT_WINDOW_MS = 5 * 60_000
const DEFAULT_MAX_RETRIES = 0
const DEFAULT_CLEAN_UPTIME_RESET_MS = 60_000

export class MentraJSCrashController {
  private readonly now: () => number
  private readonly backoffMs: number[]
  private readonly crashWindowMs: number
  private readonly maxRetries: number
  private readonly cleanUptimeResetMs: number
  private readonly packages: Map<string, PackageState> = new Map()

  constructor(opts: CrashControllerOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFFS
    this.crashWindowMs = opts.crashWindowMs ?? DEFAULT_WINDOW_MS
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
    this.cleanUptimeResetMs = opts.cleanUptimeResetMs ?? DEFAULT_CLEAN_UPTIME_RESET_MS
  }

  /** Tracking starts when MentraJSRouter spawns a fresh JSContext. */
  onSpawn(packageName: string): void {
    const at = this.now()
    const prev = this.packages.get(packageName)
    if (prev) {
      // Carry forward the crash history; a respawn doesn't reset retry
      // budget unless the previous RUNNING state survived >= cleanUptimeResetMs.
      prev.state = {kind: "RUNNING", sinceMs: at}
      prev.totalRespawns += 1
    } else {
      this.packages.set(packageName, {
        state: {kind: "RUNNING", sinceMs: at},
        crashesInWindow: [],
        totalRespawns: 0,
      })
    }
  }

  /** Called when MentraJSRouter explicitly tears down (user-initiated). */
  onKill(packageName: string): void {
    this.packages.delete(packageName)
  }

  /**
   * Record a crash and return the policy outcome. Caller is responsible for
   * scheduling the respawn (timer ownership belongs at the orchestration
   * layer that holds the host context, not here).
   */
  onCrash(packageName: string, reason: string): CrashOutcome {
    const at = this.now()
    const entry = this.packages.get(packageName) ?? {
      state: {kind: "RUNNING", sinceMs: at},
      crashesInWindow: [],
      totalRespawns: 0,
    }

    // If the previous RUNNING window was long enough, reset the retry
    // counter — a crash after a stable session shouldn't burn budget.
    if (entry.state.kind === "RUNNING") {
      const uptime = at - entry.state.sinceMs
      if (uptime >= this.cleanUptimeResetMs) {
        entry.crashesInWindow = []
      }
    }

    // Drop crashes that fell out of the window before counting the new one.
    const cutoff = at - this.crashWindowMs
    entry.crashesInWindow = entry.crashesInWindow.filter((t) => t >= cutoff)
    entry.crashesInWindow.push(at)
    this.packages.set(packageName, entry)

    const crashCount = entry.crashesInWindow.length

    if (crashCount > this.maxRetries) {
      entry.state = {kind: "CRASHLOOP_DISABLED", sinceMs: at, reason}
      return {
        surfaceCrashloopBanner: true,
        sentryLevel: "error",
      }
    }

    const attempt = crashCount - 1
    const delayMs = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)]!
    entry.state = {kind: "BACKOFF", until: at + delayMs, attempt: crashCount, reason}

    return {
      scheduleRespawnAfterMs: delayMs,
      showRestartToast: crashCount >= 2,
      sentryLevel: crashCount === 1 ? "info" : "warning",
    }
  }

  /** Inspect current state — useful for tests and diagnostics. */
  stateFor(packageName: string): CrashState | null {
    return this.packages.get(packageName)?.state ?? null
  }

  /** Total respawns since registration — surfaced to Sentry as a counter. */
  respawnCount(packageName: string): number {
    return this.packages.get(packageName)?.totalRespawns ?? 0
  }

  /** Currently-disabled packages. Host UI uses this to show banners. */
  disabledPackages(): string[] {
    const out: string[] = []
    for (const [name, entry] of this.packages) {
      if (entry.state.kind === "CRASHLOOP_DISABLED") out.push(name)
    }
    return out
  }

  /** Manually re-enable a disabled package (user "Try again" tap). */
  reset(packageName: string): void {
    const entry = this.packages.get(packageName)
    if (!entry) return
    entry.crashesInWindow = []
    entry.state = {kind: "RUNNING", sinceMs: this.now()}
  }
}
