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

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import displayProcessor from "./DisplayProcessor"
import {useDisplayStore} from "../stores/display"
import sceneRenderer from "./SceneRenderer"
import {isGlassesConnected} from "./GlassesReadiness"
import {useGlassesStore} from "../stores/glasses"
import type {SceneElementInput} from "../utils/display/scene"
import {BgTimer} from "../utils/timers"

// =============================================================================
// Types
// =============================================================================

export interface DisplayPayload {
  view?: "main" | "dashboard" | string
  /** Legacy layout (sugar / old bundles / cloud shapes). Either this or `scene`. */
  layout?: {layoutType: string; [key: string]: unknown}
  /** Scene elements from display.render(). Either this or `layout`. */
  scene?: SceneElementInput[]
  durationMs?: number
}

/** Outcome delivered to an awaiting render() call (REQUEST_RESULT payload). */
export interface DisplayRequestResult {
  status: "displayed" | "blocked"
  degraded?: boolean
  dropped?: string[]
  reason?: string
}

export type DisplayRequestResolver = (result: DisplayRequestResult) => void

interface ActiveDisplay {
  packageName: string
  processedEvent: Record<string, unknown>
  /** Set when this display is a scene — restore goes through SceneRenderer replay. */
  scene?: SceneElementInput[]
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

/** "Render nothing" — an empty scene or an explicit clear_view layout. */
function isClearPayload(payload: DisplayPayload): boolean {
  if (payload.scene) return payload.scene.length === 0
  return payload.layout?.layoutType === "clear_view"
}

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
  private bootQueue: Map<string, {payload: DisplayPayload; resolve?: DisplayRequestResolver}> = new Map()

  private expiryTimerId: number | null = null

  /** Reconnect-replay subscription state (attachToRuntime). */
  private runtimeAttached = false
  private glassesWasConnected = false
  private unsubscribeGlassesStatus: (() => void) | null = null

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

    // Snapshot whatever's on the glasses BEFORE the boot text overwrites it.
    // registerApp fires onMount for every spawn — including a background app or
    // a crash-respawn while another app is foreground — so a boot that times out
    // without rendering must put the prior frame back rather than blank it.
    // Never snapshot the boot text itself: back-to-back mounts (the autostart
    // restore loop, crash-respawn chains) land while the previous app's
    // "Starting X…" is still on the glasses, and endBoot would "restore" that
    // stale, expiry-less frame permanently. Across chained boots, inherit the
    // original pre-boot frame instead.
    const inherited = this.bootingApp ? this.bootingApp.preBoot : this.currentDisplay
    const preBoot = inherited?.packageName === SYSTEM_BOOT_PKG ? null : inherited

    // Cancel any in-flight boot for a prior app.
    this.cancelBoot()

    // Send the boot message directly (bypass arbitration — this is a system
    // display). Goes through sendNow so scene devices render it as a scene:
    // otherwise every app start would be a legacy→scene transition on the
    // glasses (which costs a blanking clear).
    this.sendNow(SYSTEM_BOOT_PKG, {
      view: "main",
      layout: {layoutType: "text_wall", text: `Starting ${displayName}…`},
    })

    const timerId = BgTimer.setTimeout(() => {
      this.endBoot()
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

  /** Report-safe ownership snapshot for incident diagnostics. */
  public getDiagnosticSnapshot(): Record<string, unknown> {
    return {
      coreAppPackageName: this.coreApp,
      currentDisplayPackageName: this.currentDisplay?.packageName ?? null,
      backgroundLockPackageName: this.backgroundLock?.packageName ?? null,
      bootingPackageName: this.bootingApp?.packageName ?? null,
    }
  }

  /**
   * A local miniapp is going away. Clean up all state associated with it.
   */
  public onUnmount(packageName: string): void {
    console.log(`${LOG_TAG}: onUnmount(${packageName})`)

    // If this was the booting app, cancel boot — and don't strand its
    // "Starting X…" text (a system frame with no expiry): put back what the
    // boot covered, or clear.
    if (this.bootingApp?.packageName === packageName) {
      const preBoot = this.bootingApp.preBoot
      this.cancelBoot()
      if (this.currentDisplay?.packageName === SYSTEM_BOOT_PKG) {
        // The preBoot owner may have forfeited its frame during the boot
        // window (a clear parked in the boot queue) — don't resurrect it.
        const ownerQueued = preBoot ? this.bootQueue.get(preBoot.packageName) : undefined
        const preBootForfeited = ownerQueued !== undefined && isClearPayload(ownerQueued.payload)
        if (preBoot && !preBootForfeited && (preBoot.expiresAt === null || preBoot.expiresAt > this.now())) {
          this.restoreDisplay(preBoot)
        } else {
          this.sendClear()
        }
      }
    }
    this.bootQueue.get(packageName)?.resolve?.({status: "blocked", reason: "app stopped"})
    this.bootQueue.delete(packageName)

    // Forget the app's retained scenes — nothing left to replay for it.
    sceneRenderer.clearApp(packageName)

    // Release bg lock if this app held it.
    if (this.backgroundLock?.packageName === packageName) {
      this.backgroundLock = null
    }

    // Drop the saved core frame if the core's context is going away — the
    // frame belongs to a dead context and must not be restored later. The
    // coreApp POINTER itself is NOT cleared here: it is derived state owned
    // by the apps-store reconciler. A liveness/crash respawn tears the
    // context down (this path) without any store change — the app is still
    // "running" — and clearing the pointer here would leave the respawned
    // foreground app arbitrating as background until an unrelated store
    // write happened to re-run the reconciler. Real stops release the slot
    // via the store (running → false → reconciler → onCoreAppChange(null)).
    if (this.coreApp === packageName) {
      this.coreAppDisplay = null
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
   *
   * `resolve`, when provided (render() requests), is guaranteed to be called
   * exactly once with the request's outcome — including for requests parked in
   * the boot queue (resolved when drained or superseded).
   */
  public request(packageName: string, payload: DisplayPayload, resolve?: DisplayRequestResolver): void {
    // Dashboard view: pass straight through (no throttle/arbitration). Local
    // dashboard rendering is currently a stub on the phone anyway.
    if (payload.view === "dashboard") {
      this.sendNow(packageName, payload, resolve)
      return
    }

    // During boot, any app's requests go into the queue. If the booting app
    // itself makes its first display call, end boot early and drain.
    if (this.bootingApp) {
      const superseded = this.bootQueue.get(packageName)
      superseded?.resolve?.({status: "blocked", reason: "superseded by a newer frame"})
      this.bootQueue.set(packageName, {payload, resolve})
      if (this.bootingApp.packageName === packageName) {
        this.endBoot()
      }
      return
    }

    this.arbitrateAndSend(packageName, payload, resolve)
  }

  /**
   * End a package's temporary display early. If it currently owns the main
   * view, release its background lock and restore the foreground miniapp's
   * saved frame. A dismissal for a package that is no longer visible is a
   * no-op.
   */
  public dismiss(packageName: string): void {
    this.handleExpiry(packageName)
  }

  // ===========================================================================
  // Internals — arbitration
  // ===========================================================================

  private arbitrateAndSend(packageName: string, payload: DisplayPayload, resolve?: DisplayRequestResolver): void {
    const now = this.now()

    // Expire a stale bg lock before arbitrating.
    if (this.backgroundLock && now > this.backgroundLock.expiresAt) {
      this.backgroundLock = null
    }

    // A clear ("render nothing") means "I'm done with the display" — it is a
    // forfeit, not a frame. A background app releases its lock and the core
    // app's still-valid display comes back; treating it as a render instead
    // would RENEW the lock with an empty frame and blank the glasses while
    // still blocking everyone else.
    if (isClearPayload(payload)) {
      this.handleAppClear(packageName, resolve)
      return
    }

    const isCore = packageName === this.coreApp

    if (isCore) {
      // Save so we can restore later.
      this.coreAppDisplay = {
        packageName,
        processedEvent: {}, // filled by sendNow
        scene: payload.scene,
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
        resolve?.({status: "blocked", reason: "a background app holds the display"})
        return
      }

      // Core can display. If a bg lock exists but holder isn't actively on
      // the glasses, release it.
      if (this.backgroundLock && !bgHoldsAndDisplays) {
        this.backgroundLock = null
      }

      this.sendNow(packageName, payload, resolve)
      return
    }

    // Non-core: this is a background app.
    if (this.backgroundLock && this.backgroundLock.packageName !== packageName) {
      // Another bg app already holds the lock — drop.
      resolve?.({status: "blocked", reason: "another background app holds the display"})
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

    this.sendNow(packageName, payload, resolve)
  }

  /**
   * An app cleared its display ("render nothing"). Same semantics as its
   * frame expiring: give up ownership, restore the core app's still-valid
   * display if there is one, otherwise clear the glasses.
   */
  private handleAppClear(packageName: string, resolve?: DisplayRequestResolver): void {
    // Forget the app's retained scene state — its next render starts fresh.
    sceneRenderer.clearApp(packageName)

    if (this.backgroundLock?.packageName === packageName) {
      this.backgroundLock = null
    }
    if (this.coreApp === packageName) {
      this.coreAppDisplay = null
    }

    if (this.currentDisplay?.packageName === packageName) {
      this.clearExpiryTimer()
      this.currentDisplay = null
      this.tryRestoreCoreDisplay()
      if (!this.currentDisplay) {
        this.sendClear()
      }
    }
    resolve?.({status: "displayed"})
  }

  // ===========================================================================
  // Internals — send
  // ===========================================================================

  private sendNow(packageName: string, payload: DisplayPayload, resolve?: DisplayRequestResolver): void {
    const expiresAt = payload.durationMs ? this.now() + payload.durationMs : null
    const view = (payload.view === "dashboard" ? "dashboard" : "main") as "main" | "dashboard"

    // Scene requests — and legacy layouts a positioning device can render as a
    // scene (sugar, old bundles) — go through the scene pipeline. Everything
    // else stays on the legacy path.
    let sceneElements = payload.scene ?? null
    if (!sceneElements && payload.layout) {
      const caps = sceneRenderer.currentCapabilities()
      if (caps?.canPosition) {
        sceneElements = sceneRenderer.convertLegacyLayout(payload.layout, caps)
      }
    }

    if (sceneElements) {
      this.sendScene(packageName, view, sceneElements, expiresAt, resolve)
    } else if (payload.layout) {
      // This layout bypasses the scene pipeline (clear_view, dashboard_card,
      // unknown types, or a non-positioning device). If this (app, view) had a
      // retained scene, the glasses no longer match it — reset the diff
      // baseline so the next render() repaints from empty instead of skipping
      // "unchanged" elements.
      sceneRenderer.resetBaseline(packageName, view)
      const rawEvent: Record<string, unknown> = {
        view: payload.view ?? "main",
        layout: payload.layout,
      }
      if (payload.durationMs !== undefined) {
        rawEvent.durationMs = payload.durationMs
      }
      this.sendToNative(packageName, rawEvent, expiresAt)
      resolve?.({status: "displayed"})
    } else {
      // A scene payload on a device with no display block at all.
      resolve?.({status: "blocked", reason: "no display connected"})
      return
    }

    // If core app fired, refresh the saved snapshot with the actual processed
    // event so restore uses the wrapped text (legacy) / the retained scene.
    if (packageName === this.coreApp && this.currentDisplay) {
      this.coreAppDisplay = {
        packageName,
        processedEvent: this.currentDisplay.processedEvent,
        scene: this.currentDisplay.scene,
        expiresAt: this.currentDisplay.expiresAt,
      }
    }
  }

  /**
   * Send a scene through SceneRenderer. On positioning devices this emits a
   * SceneFrame; on degrade devices SceneRenderer hands back a legacy layout
   * that rides the existing (unchanged) DisplayProcessor path.
   */
  private sendScene(
    packageName: string,
    view: "main" | "dashboard",
    elements: SceneElementInput[],
    expiresAt: number | null,
    resolve?: DisplayRequestResolver,
  ): void {
    const result = sceneRenderer.emitScene(packageName, view, elements)

    if (result.kind === "no-display") {
      resolve?.({status: "blocked", reason: "no display connected"})
      return
    }

    if (result.kind === "legacy") {
      if (result.layout) {
        this.sendToNative(packageName, {view, layout: result.layout}, expiresAt)
      } else {
        // Scene degraded to nothing (e.g. all-image scene on a text-only
        // device). render() replaces the frame, so nothing means clear.
        this.sendClear()
      }
      resolve?.({status: "displayed", degraded: result.degraded, dropped: result.dropped})
      return
    }

    this.currentDisplay = {packageName, processedEvent: {}, scene: elements, expiresAt}
    this.clearExpiryTimer()
    if (expiresAt !== null) {
      const delay = Math.max(0, expiresAt - this.now())
      this.expiryTimerId = BgTimer.setTimeout(() => {
        this.expiryTimerId = null
        this.handleExpiry(packageName)
      }, delay)
    }
    resolve?.({status: "displayed", degraded: result.degraded, dropped: result.dropped})
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
      // The mirror store also lives in engine, so display requests update the
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
    this.restoreDisplay(this.coreAppDisplay)
  }

  private sendClear(): void {
    const clearEvent: Record<string, unknown> = {
      view: "main",
      layout: {layoutType: "clear_view"},
    }
    this.sendToNative("system.clear", clearEvent, null)
    this.currentDisplay = null
    // The glasses main view is now blank: every app's retained scene is
    // replay-only until it re-renders — diffing against it would skip
    // "unchanged" elements onto the blank screen.
    sceneRenderer.markViewStale("main")
  }

  // ===========================================================================
  // Internals — boot
  // ===========================================================================

  private cancelBoot(): void {
    if (!this.bootingApp) return
    BgTimer.clearTimeout(this.bootingApp.timerId)
    this.bootingApp = null
  }

  private endBoot(): void {
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
      this.arbitrateAndSend(corePayload[0], corePayload[1].payload, corePayload[1].resolve)
    }
    for (const [pkg, entry] of queued) {
      if (pkg === this.coreApp) continue
      this.arbitrateAndSend(pkg, entry.payload, entry.resolve)
    }

    // If the boot text is still on the glasses — nothing was queued, or every
    // drained request lost arbitration — it must not strand: it's a system
    // frame with no expiry. Restore whatever was on the glasses before the
    // boot, else clear. Two reasons NOT to restore: the frame's duration
    // elapsed during the boot window, or its owner FORFEITED it during the
    // window (its final queued intent — the queue keeps last-wins per app —
    // was a clear, which the drain above processed as a forfeit; restoring
    // would resurrect content the clear removed).
    if (this.currentDisplay?.packageName === SYSTEM_BOOT_PKG) {
      const ownerEntry = preBoot ? queued.find(([pkg]) => pkg === preBoot.packageName) : undefined
      const preBootForfeited = ownerEntry !== undefined && isClearPayload(ownerEntry[1].payload)
      if (preBoot && !preBootForfeited && (preBoot.expiresAt === null || preBoot.expiresAt > this.now())) {
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

    // Scene restores must REPLAY (create-based, epoch-bumped): re-emitting the
    // scene through the normal diff would come back all-"unchanged" and the
    // device would skip every element (spec §4 — replay is always create-based).
    if (saved.scene) {
      const expiresAt = remaining !== undefined ? this.now() + remaining : null
      if (sceneRenderer.replayApp(saved.packageName, "main")) {
        this.currentDisplay = {packageName: saved.packageName, processedEvent: {}, scene: saved.scene, expiresAt}
        this.clearExpiryTimer()
        if (expiresAt !== null) {
          const delay = Math.max(0, expiresAt - this.now())
          this.expiryTimerId = BgTimer.setTimeout(() => {
            this.expiryTimerId = null
            this.handleExpiry(saved.packageName)
          }, delay)
        }
      } else {
        // Retained state gone (app stopped since) — re-render the saved
        // elements as a fresh scene instead.
        this.sendNow(saved.packageName, {view: "main", scene: saved.scene, durationMs: remaining})
      }
      return
    }

    this.sendNow(saved.packageName, {
      view: "main",
      layout: saved.processedEvent.layout as DisplayPayload["layout"],
      durationMs: remaining,
    })
  }

  // ===========================================================================
  // Reconnect replay (design doc §3.4.7 — recovery = replay, host-driven)
  // ===========================================================================

  /**
   * Subscribe to glasses connection state so the current owner's frame is
   * replayed after a reconnect. Safe to call repeatedly; attaches once. Wired
   * from MantleManager next to displayProcessor.attachToRuntime().
   */
  public attachToRuntime(): void {
    if (this.runtimeAttached) return
    // dev wired this through the (since-removed) glassesStatus runtime hooks;
    // engine reads its own glasses store directly.
    this.glassesWasConnected = isGlassesConnected(useGlassesStore.getState().connection)
    this.unsubscribeGlassesStatus = useGlassesStore.subscribe(() => {
      const connected = isGlassesConnected(useGlassesStore.getState().connection)
      if (connected === this.glassesWasConnected) return
      this.glassesWasConnected = connected
      if (connected) {
        this.replayCurrent()
      }
    })
    this.runtimeAttached = true
  }

  /**
   * Re-push the current on-glasses frame after a device recovery. Scenes replay
   * from SceneRenderer's retained state (create-based, epoch-bumped); legacy
   * frames re-send their processed event. Expired frames don't come back.
   */
  public replayCurrent(): void {
    const current = this.currentDisplay
    if (!current) return
    if (current.expiresAt !== null && this.now() >= current.expiresAt) return

    console.log(`${LOG_TAG}: replayCurrent(${current.packageName})`)
    if (current.scene) {
      if (!sceneRenderer.replayApp(current.packageName, "main")) {
        // Retained state gone (app stopped between disconnect and reconnect).
        this.sendClear()
      }
    } else if (current.processedEvent.layout) {
      this.sendToNative(current.packageName, current.processedEvent, current.expiresAt)
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
    this.coreApp = null
    this.coreAppDisplay = null
    this.currentDisplay = null
    this.backgroundLock = null
    this.bootQueue.clear()
    this.now = () => Date.now()
    this.unsubscribeGlassesStatus?.()
    this.unsubscribeGlassesStatus = null
    this.runtimeAttached = false
    this.glassesWasConnected = false
    sceneRenderer._resetForTest()
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
