/**
 * LocalDisplayManager
 *
 * Phone-side arbiter for display requests originating from LOCAL miniapps
 * (the @mentra/miniapp SDK). Mirrors the user-facing behavior of the cloud
 * DisplayManager (cloud/packages/cloud/src/services/layout/DisplayManager6.1.ts)
 * for the features that matter on the phone:
 *
 *   - boot message ("Starting <AppName>…") with a bounded window
 *   - per-request throttle (leading + trailing, ~300 ms, last-write-wins)
 *   - durationMs auto-clear
 *   - core-app vs background-app arbitration with a background lock
 *
 * Scope is deliberately local-only. Cloud-originated displays are untouched
 * and may race with local displays during dev; that's acceptable per plan
 * (agents/local-display-manager-plan.md).
 *
 * All timers use BgTimer so they keep firing when the phone screen
 * is off.
 */

import displayProcessor from "./DisplayProcessor"
import {getRuntimeHooks} from "../runtime/config"
import {BgTimer} from "../utils/timers"

// =============================================================================
// Types
// =============================================================================

export interface DisplayPayload {
  view?: "main" | "dashboard" | string
  layout: {layoutType: string; [key: string]: unknown}
  durationMs?: number
}

interface ActiveDisplay {
  packageName: string
  processedEvent: Record<string, unknown>
  expiresAt: number | null
}

interface BootingApp {
  packageName: string
  displayName: string
  startedAt: number
  timerId: number
}

interface BackgroundLock {
  packageName: string
  acquiredAt: number
  expiresAt: number
  lastActiveTime: number
}

// =============================================================================
// Constants
// =============================================================================

const LOG_TAG = "LOCAL_DISPLAY"
const BOOT_DURATION_MS = 1500
const THROTTLE_MS = 300
// Mirrors cloud lease for a bg app holding the display. The bg app has to
// keep driving the display to hold the lock; if it goes quiet and the core
// app wants the screen, we release.
const BACKGROUND_LOCK_TIMEOUT_MS = 10_000
// Sentinel package name used as the "source" of the system boot message.
const SYSTEM_BOOT_PKG = "system.boot"

// =============================================================================
// LocalDisplayManager
// =============================================================================

class LocalDisplayManager {
  private static instance: LocalDisplayManager | null = null

  private coreApp: string | null = null
  private coreAppDisplay: ActiveDisplay | null = null
  private currentDisplay: ActiveDisplay | null = null
  private backgroundLock: BackgroundLock | null = null

  private bootingApp: BootingApp | null = null
  private bootQueue: Map<string, DisplayPayload> = new Map()

  private pendingThrottledByApp: Map<string, DisplayPayload> = new Map()
  private throttleTimerId: number | null = null
  private lastSendAt = 0

  private expiryTimerId: number | null = null

  /** Injectable for tests. */
  private now: () => number = () => Date.now()

  private constructor() {}

  public static getInstance(): LocalDisplayManager {
    if (!LocalDisplayManager.instance) {
      LocalDisplayManager.instance = new LocalDisplayManager()
    }
    return LocalDisplayManager.instance
  }

  // ===========================================================================
  // Lifecycle API (called from MiniappHost)
  // ===========================================================================

  /**
   * A new local miniapp just mounted. Start the boot window.
   * Calling this for a different pkg while another is booting cancels the
   * previous boot.
   */
  public onMount(packageName: string, displayName: string): void {
    console.log(`${LOG_TAG}: onMount(${packageName}, "${displayName}")`)

    // Cancel any in-flight boot for a prior app.
    this.cancelBoot()

    // Send the boot message directly (bypass throttle + arbitration — this is
    // a system display).
    const bootEvent: Record<string, unknown> = {
      view: "main",
      layout: {layoutType: "text_wall", text: `Starting ${displayName}…`},
    }
    this.sendToNative(SYSTEM_BOOT_PKG, bootEvent, null)

    const timerId = BgTimer.setTimeout(() => {
      this.endBoot(/* triggeredByFirstDisplay */ false)
    }, BOOT_DURATION_MS)

    this.bootingApp = {
      packageName,
      displayName,
      startedAt: this.now(),
      timerId,
    }
    this.bootQueue.clear()
  }

  /**
   * Mark which miniapp is the "core" (foreground) app. Pass null when no local
   * miniapp is foreground. When the core app flips, any pending throttled
   * request from the previous core is dropped.
   */
  public onCoreAppChange(packageName: string | null): void {
    if (this.coreApp === packageName) return
    console.log(`${LOG_TAG}: onCoreAppChange(${packageName ?? "null"})`)

    const prevCore = this.coreApp
    this.coreApp = packageName

    // Drop stale throttle pending for the old core — new core starts clean.
    if (prevCore) {
      this.pendingThrottledByApp.delete(prevCore)
    }
  }

  /**
   * A local miniapp is going away. Clean up all state associated with it.
   */
  public onUnmount(packageName: string): void {
    console.log(`${LOG_TAG}: onUnmount(${packageName})`)

    // If this was the booting app, cancel boot.
    if (this.bootingApp?.packageName === packageName) {
      this.cancelBoot()
    }
    this.bootQueue.delete(packageName)
    this.pendingThrottledByApp.delete(packageName)

    // Release bg lock if this app held it.
    if (this.backgroundLock?.packageName === packageName) {
      this.backgroundLock = null
    }

    // Clear saved core app display if the core is going away.
    if (this.coreApp === packageName) {
      this.coreAppDisplay = null
      this.coreApp = null
    }

    // If this app owned the current on-glasses display, clear it (and maybe
    // restore the core app's display if it still has time left).
    if (this.currentDisplay?.packageName === packageName) {
      this.clearExpiryTimer()
      this.currentDisplay = null
      this.tryRestoreCoreDisplay()
      if (!this.currentDisplay) {
        // Nothing to restore → clear the glasses.
        this.sendClear()
      }
    }
  }

  // ===========================================================================
  // Display request API (called from LocalMiniappRuntime.handleDisplay)
  // ===========================================================================

  /**
   * A miniapp requested a display. Routes through boot queue, arbitration,
   * and throttle. This is the only public entry point for miniapp display
   * traffic on the local path.
   */
  public request(packageName: string, payload: DisplayPayload): void {
    // Dashboard view: pass straight through (no throttle/arbitration). Local
    // dashboard rendering is currently a stub on the phone anyway.
    if (payload.view === "dashboard") {
      this.sendNow(packageName, payload)
      return
    }

    // During boot, any app's requests go into the queue. If the booting app
    // itself makes its first display call, end boot early and drain.
    if (this.bootingApp) {
      this.bootQueue.set(packageName, payload)
      if (this.bootingApp.packageName === packageName) {
        this.endBoot(/* triggeredByFirstDisplay */ true)
      }
      return
    }

    this.arbitrateAndSend(packageName, payload)
  }

  // ===========================================================================
  // Internals — arbitration
  // ===========================================================================

  private arbitrateAndSend(packageName: string, payload: DisplayPayload): void {
    const now = this.now()

    // Expire a stale bg lock before arbitrating.
    if (this.backgroundLock && now > this.backgroundLock.expiresAt) {
      this.backgroundLock = null
    }

    const isCore = packageName === this.coreApp

    if (isCore) {
      // Save so we can restore later.
      this.coreAppDisplay = {
        packageName,
        processedEvent: {}, // filled by sendNow
        expiresAt: payload.durationMs ? now + payload.durationMs : null,
      }

      // If a bg app holds the lock AND is currently on the glasses, core is
      // blocked. The saved coreAppDisplay surfaces when the bg app expires
      // or unmounts.
      const bgHoldsAndDisplays =
        this.backgroundLock &&
        this.currentDisplay &&
        this.currentDisplay.packageName === this.backgroundLock.packageName
      if (bgHoldsAndDisplays) {
        return
      }

      // Core can display. If a bg lock exists but holder isn't actively on
      // the glasses, release it.
      if (this.backgroundLock && !bgHoldsAndDisplays) {
        this.backgroundLock = null
      }

      this.throttledSend(packageName, payload)
      return
    }

    // Non-core: this is a background app.
    if (this.backgroundLock && this.backgroundLock.packageName !== packageName) {
      // Another bg app already holds the lock — drop.
      return
    }

    // Acquire or bump the lock.
    if (!this.backgroundLock) {
      this.backgroundLock = {
        packageName,
        acquiredAt: now,
        expiresAt: now + BACKGROUND_LOCK_TIMEOUT_MS,
        lastActiveTime: now,
      }
    } else {
      this.backgroundLock.lastActiveTime = now
      this.backgroundLock.expiresAt = now + BACKGROUND_LOCK_TIMEOUT_MS
    }

    this.throttledSend(packageName, payload)
  }

  // ===========================================================================
  // Internals — throttle
  // ===========================================================================

  private throttledSend(packageName: string, payload: DisplayPayload): void {
    const now = this.now()
    const elapsed = now - this.lastSendAt

    if (elapsed >= THROTTLE_MS) {
      this.sendNow(packageName, payload)
      return
    }

    // Queue (replace any pending request from the same app — last wins).
    this.pendingThrottledByApp.set(packageName, payload)
    if (this.throttleTimerId === null) {
      const delay = THROTTLE_MS - elapsed
      this.throttleTimerId = BgTimer.setTimeout(() => {
        this.throttleTimerId = null
        this.flushThrottled()
      }, delay)
    }
  }

  private flushThrottled(): void {
    // Prefer the core app if it has something pending. Otherwise, the current
    // bg lock holder. Otherwise, skip.
    let candidate: {pkg: string; payload: DisplayPayload} | null = null

    if (this.coreApp) {
      const p = this.pendingThrottledByApp.get(this.coreApp)
      if (p) candidate = {pkg: this.coreApp, payload: p}
    }
    if (!candidate && this.backgroundLock) {
      const p = this.pendingThrottledByApp.get(this.backgroundLock.packageName)
      if (p) candidate = {pkg: this.backgroundLock.packageName, payload: p}
    }
    if (!candidate) {
      this.pendingThrottledByApp.clear()
      return
    }

    this.pendingThrottledByApp.delete(candidate.pkg)
    this.sendNow(candidate.pkg, candidate.payload)

    // If more requests accumulated from other apps during the window, they've
    // been overwritten by later ones anyway; anything left behind (e.g. a
    // stale bg request while core is live) we drop.
    this.pendingThrottledByApp.clear()
  }

  // ===========================================================================
  // Internals — send
  // ===========================================================================

  private sendNow(packageName: string, payload: DisplayPayload): void {
    const rawEvent: Record<string, unknown> = {
      view: payload.view ?? "main",
      layout: payload.layout,
      durationMs: payload.durationMs,
    }
    const expiresAt = payload.durationMs ? this.now() + payload.durationMs : null
    this.sendToNative(packageName, rawEvent, expiresAt)

    // If core app fired, refresh the saved snapshot with the actual processed
    // event so restore uses the wrapped text.
    if (packageName === this.coreApp && this.currentDisplay) {
      this.coreAppDisplay = {
        packageName,
        processedEvent: this.currentDisplay.processedEvent,
        expiresAt: this.currentDisplay.expiresAt,
      }
    }
  }

  private sendToNative(packageName: string, rawEvent: Record<string, unknown>, expiresAt: number | null): void {
    let processedEvent: Record<string, unknown>
    try {
      processedEvent = displayProcessor.processDisplayEvent(rawEvent as any)
    } catch (err) {
      console.error(`${LOG_TAG}: DisplayProcessor error, using raw event:`, err)
      processedEvent = rawEvent
    }

    try {
      const sendDisplayEvent = getRuntimeHooks().sendDisplayEvent
      if (sendDisplayEvent) {
        void Promise.resolve(sendDisplayEvent(processedEvent)).catch((err) => {
          console.error(`${LOG_TAG}: native display failed:`, err)
        })
      }
      getRuntimeHooks().setDisplayEvent?.(JSON.stringify(processedEvent))
    } catch (err) {
      console.error(`${LOG_TAG}: native display failed:`, err)
    }

    // System-originated displays (boot message, clear) don't count toward the
    // user-throttle budget — they're forced, not requested by a miniapp.
    const isSystem = packageName === SYSTEM_BOOT_PKG || packageName === "system.clear"
    if (!isSystem) {
      this.lastSendAt = this.now()
    }
    this.currentDisplay = {packageName, processedEvent, expiresAt}

    this.clearExpiryTimer()
    if (expiresAt !== null) {
      const delay = Math.max(0, expiresAt - this.now())
      this.expiryTimerId = BgTimer.setTimeout(() => {
        this.expiryTimerId = null
        this.handleExpiry(packageName)
      }, delay)
    }
  }

  private handleExpiry(packageName: string): void {
    // Someone else is on the glasses now — ignore.
    if (!this.currentDisplay || this.currentDisplay.packageName !== packageName) {
      return
    }

    // Release the lock if it belonged to this (bg) app.
    if (this.backgroundLock?.packageName === packageName) {
      this.backgroundLock = null
    }

    this.currentDisplay = null
    this.tryRestoreCoreDisplay()
    if (!this.currentDisplay) {
      this.sendClear()
    }
  }

  private tryRestoreCoreDisplay(): void {
    if (!this.coreAppDisplay) return
    // If the core snapshot has a duration and it's already elapsed, skip.
    if (this.coreAppDisplay.expiresAt !== null && this.now() >= this.coreAppDisplay.expiresAt) {
      this.coreAppDisplay = null
      return
    }
    // Re-send the core's saved display.
    const saved = this.coreAppDisplay
    const remaining = saved.expiresAt !== null ? Math.max(0, saved.expiresAt - this.now()) : undefined
    this.sendNow(saved.packageName, {
      view: "main",
      layout: saved.processedEvent.layout as DisplayPayload["layout"],
      durationMs: remaining,
    })
  }

  private sendClear(): void {
    const clearEvent: Record<string, unknown> = {
      view: "main",
      layout: {layoutType: "clear_view"},
    }
    this.sendToNative("system.clear", clearEvent, null)
    this.currentDisplay = null
  }

  // ===========================================================================
  // Internals — boot
  // ===========================================================================

  private cancelBoot(): void {
    if (!this.bootingApp) return
    BgTimer.clearTimeout(this.bootingApp.timerId)
    this.bootingApp = null
  }

  private endBoot(triggeredByFirstDisplay: boolean): void {
    if (!this.bootingApp) return
    const bootedPkg = this.bootingApp.packageName
    BgTimer.clearTimeout(this.bootingApp.timerId)
    this.bootingApp = null

    // Drain the queue: core first, then everyone else. Per-app last wins
    // because the map holds one payload per packageName.
    const queued = Array.from(this.bootQueue.entries())
    this.bootQueue.clear()

    const corePayload = this.coreApp ? queued.find(([pkg]) => pkg === this.coreApp) : undefined
    if (corePayload) {
      this.arbitrateAndSend(corePayload[0], corePayload[1])
    }
    for (const [pkg, payload] of queued) {
      if (pkg === this.coreApp) continue
      this.arbitrateAndSend(pkg, payload)
    }

    // If the booting app itself never queued a display and was just waiting
    // on the timeout, clear the boot text so we don't leave "Starting …"
    // stuck on the glasses.
    if (!triggeredByFirstDisplay && queued.length === 0 && bootedPkg === this.coreApp) {
      this.sendClear()
    }
  }

  // ===========================================================================
  // Internals — timer helpers
  // ===========================================================================

  private clearExpiryTimer(): void {
    if (this.expiryTimerId !== null) {
      BgTimer.clearTimeout(this.expiryTimerId)
      this.expiryTimerId = null
    }
  }

  // ===========================================================================
  // Test hooks
  // ===========================================================================

  /** Injected clock — tests only. */
  public _setNowForTest(fn: () => number): void {
    this.now = fn
  }

  /** Wipe state — tests only. */
  public _resetForTest(): void {
    this.cancelBoot()
    this.clearExpiryTimer()
    if (this.throttleTimerId !== null) {
      BgTimer.clearTimeout(this.throttleTimerId)
      this.throttleTimerId = null
    }
    this.coreApp = null
    this.coreAppDisplay = null
    this.currentDisplay = null
    this.backgroundLock = null
    this.bootQueue.clear()
    this.pendingThrottledByApp.clear()
    this.lastSendAt = 0
    this.now = () => Date.now()
  }

  /** Read-only state snapshot — tests only. */
  public _peekForTest(): {
    coreApp: string | null
    currentDisplayPkg: string | null
    bgLockPkg: string | null
    isBooting: boolean
  } {
    return {
      coreApp: this.coreApp,
      currentDisplayPkg: this.currentDisplay?.packageName ?? null,
      bgLockPkg: this.backgroundLock?.packageName ?? null,
      isBooting: this.bootingApp !== null,
    }
  }
}

const localDisplayManager = LocalDisplayManager.getInstance()
export default localDisplayManager
export {LocalDisplayManager}
