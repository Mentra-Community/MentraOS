/**
 * LocalDisplayManager
 *
 * Phone-side arbiter for display requests originating from LOCAL miniapps
 * (the @mentra/miniapp SDK). Mirrors the user-facing behavior of the cloud
 * DisplayManager (cloud/packages/cloud/src/services/layout/DisplayManager6.1.ts)
 * for the features that matter on the phone:
 *
 *   - boot message ("Starting <AppName>…") with a bounded window
 *   - durationMs auto-clear
 *   - core-app vs background-app arbitration with a background lock
 *
 * Scope is deliberately local-only. Cloud-originated displays are untouched
 * and may race with local displays during dev; that's acceptable per plan
 * (agents/local-display-manager-plan.md).
 *
 * Display pacing is NOT done here. A JS-side ~300ms throttle used to live in
 * this class, but JS timers (and therefore the throttle's trailing flush) do
 * not fire on schedule while the iOS app is suspended in the background — so
 * under streaming captions, updates accumulated and then flushed in a burst on
 * the next wake. Pacing + last-wins coalescing now live in the native per-device
 * queue (e.g. G2's event-driven EvenHub queue), which drains off the same BLE
 * events that wake the process. This class forwards every request straight
 * through; the native layer collapses redundant frames per display target.
 *
 * The remaining BgTimer use (boot window, durationMs expiry) is timing that
 * does not need sub-second background fidelity.
 */

import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
import displayProcessor from "./DisplayProcessor"
import {useDisplayStore} from "../stores/display"
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
  /** Whatever was on the glasses when this boot started, so a boot that times
   * out without the app rendering can restore it instead of blanking a frame
   * another (e.g. foreground) app owns. Null if the glasses were empty. */
  preBoot: ActiveDisplay | null
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

    // Snapshot whatever's on the glasses BEFORE the boot text overwrites it.
    // registerApp fires onMount for every spawn — including a background app or
    // a crash-respawn while another app is foreground — so a boot that times out
    // without rendering must put the prior frame back rather than blank it.
    const preBoot = this.currentDisplay

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
      preBoot,
    }
    this.bootQueue.clear()
  }

  /**
   * Mark which miniapp is the "core" (foreground) app. Pass null when no local
   * miniapp is foreground.
   */
  public onCoreAppChange(packageName: string | null): void {
    if (this.coreApp === packageName) return
    console.log(`${LOG_TAG}: onCoreAppChange(${packageName ?? "null"})`)

    this.coreApp = packageName

    // No core app means no saved frame to restore on the next unmount.
    // Without this, the previous core's last frame can flicker back onto
    // the glasses when the user-initiated clear is followed by an
    // onUnmount that still finds a populated coreAppDisplay.
    if (packageName === null) {
      this.coreAppDisplay = null
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

      this.sendNow(packageName, payload)
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

    this.sendNow(packageName, payload)
  }

  // ===========================================================================
  // Internals — send
  // ===========================================================================

  private sendNow(packageName: string, payload: DisplayPayload): void {
    const rawEvent: Record<string, unknown> = {
      view: payload.view ?? "main",
      layout: payload.layout,
    }
    if (payload.durationMs !== undefined) {
      rawEvent.durationMs = payload.durationMs
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
      // The display output path is a direct btsdk call now (was a host sendDisplayEvent
      // hook) so a bare OEM renders to the glasses without wiring it.
      void Promise.resolve(BluetoothSdk.displayEvent(processedEvent)).catch((err) => {
        console.error(`${LOG_TAG}: native display failed:`, err)
      })
      // The mirror store also lives in island, so display requests update the
      // phone-side preview without any host hook.
      useDisplayStore.getState().setDisplayEvent(JSON.stringify(processedEvent))
    } catch (err) {
      console.error(`${LOG_TAG}: native display failed:`, err)
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
    const preBoot = this.bootingApp.preBoot
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

    // Boot ended on the timeout with nothing queued and no first display — the
    // app just never rendered. Restore whatever was on the glasses before the
    // boot text so a background app or crash-respawn can't blank a foreground
    // app's frame (registerApp fires onMount for every spawn, and the core app
    // isn't wired on the local path yet). If the glasses were empty before,
    // clear the lingering "Starting …" instead — otherwise a miniapp that never
    // renders (e.g. audio-only) would strand it.
    if (!triggeredByFirstDisplay && queued.length === 0) {
      // Only restore a frame that's still valid — one whose duration elapsed
      // during the boot window should clear, not come back.
      if (preBoot && (preBoot.expiresAt === null || preBoot.expiresAt > this.now())) {
        this.restoreDisplay(preBoot)
      } else {
        this.sendClear()
      }
    }
  }

  /**
   * Re-push a previously-captured on-glasses frame (e.g. the display a boot
   * window overwrote). Mirrors tryRestoreCoreDisplay: the saved event is already
   * processed, and any remaining duration is recomputed from its expiry.
   */
  private restoreDisplay(saved: ActiveDisplay): void {
    const remaining = saved.expiresAt !== null ? Math.max(0, saved.expiresAt - this.now()) : undefined
    this.sendNow(saved.packageName, {
      view: "main",
      layout: saved.processedEvent.layout as DisplayPayload["layout"],
      durationMs: remaining,
    })
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
    this.coreApp = null
    this.coreAppDisplay = null
    this.currentDisplay = null
    this.backgroundLock = null
    this.bootQueue.clear()
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