/**
 * `engine` — the namespaced OEM-facing engine API (the "(A) host API" from the
 * Phase-1 contract). Host UI calls `engine.<domain>.<method>()`; each domain is a
 * typed facade over the runtime. (Exported from the `@mentra/engine` module, whose
 * name stays `engine` in code; the public API surface is `engine`.)
 *
 * It grows one facade at a time. The migration-era flat store/service exports
 * remain in a private MentraOS host package; they shrink as screens move onto
 * `engine.*`.
 */
import {configure, start as bootstrapStart, stop as bootstrapStop, updateUiSeams} from "./runtime/bootstrap"
import {cloudClientService} from "./services/CloudClientService"
import {hydrateDeviceStore, demoteOrphanedDefaultWearable} from "./services/DeviceStoreHydration"
import {startGlassesSettingsSync, stopGlassesSettingsSync} from "./services/GlassesSettingsSync"
import {startGlassesStatusProjection, stopGlassesStatusProjection} from "./services/GlassesStatusProjection"
import {startOtaService, stopOtaService} from "./services/OtaService"
import {startAudioCloudUplink, stopAudioCloudUplink} from "./services/AudioCloudUplink"
import {startSupportProfileSync, stopSupportProfileSync} from "./services/SupportProfileSync"
import {startDeviceEventRouter, stopDeviceEventRouter} from "./services/DeviceEventRouter"
import {startPhoneNotificationsSync, stopPhoneNotificationsSync} from "./services/PhoneNotificationsSync"
import {startCaptionsTesterReportService, stopCaptionsTesterReportService} from "./services/CaptionsTesterReportService"
import {
  startMentraJSCrashloopReportService,
  stopMentraJSCrashloopReportService,
} from "./services/MentraJSCrashloopReportService"
import {ensureMiniappEngine, stopMiniappEngine} from "./services/MiniappEngine"
import localMiniappRuntime from "./services/LocalMiniappRuntime"
import displayProcessor from "./services/DisplayProcessor"
import {gallerySyncService} from "./services/asg/gallerySyncService"
import {glasses} from "./facades/glasses"
import {display} from "./facades/display"
import {speech} from "./facades/speech"
import {session} from "./facades/session"
import {settings} from "./facades/settings"
import {dev} from "./facades/dev"
import {reports} from "./facades/reports"
import {ota} from "./facades/ota"
import {gallery} from "./facades/gallery"
import {miniapps} from "./facades/miniapps"
import {pairing} from "./facades/pairing"
import {phoneNotifications} from "./facades/phoneNotifications"
import {permissions} from "./facades/permissions"
import {notifications} from "./facades/notifications"
import {logBuffer} from "./utils/devLogging"

export const engine = {
  /** Front door — hand engine auth + config, then start/stop the runtime. */
  configure,
  /** Merge host-UI seams on a running runtime (scan overlay, wifi setup, …). */
  updateUiSeams,
  /** Start the runtime: mark started + construct/connect the cloud client + begin
   * syncing device settings to the glasses. */
  async start() {
    // Reports attach recent phone logs, so engine owns console interception for
    // OEM hosts too. Idempotent; the Mentra host may start it earlier.
    logBuffer.startConsoleInterception()
    await bootstrapStart()
    // Construct + connect the cloud client so the documented configure()+start()
    // lifecycle yields a live engine.session for OEMs. Idempotent for repeated
    // start() calls.
    cloudClientService.init()
    // Project native device status -> the engine stores (the inbound feed the rest
    // of the runtime reads). Established first so the stores are live before the
    // syncs below react to them.
    startGlassesStatusProjection((changed) => localMiniappRuntime.forwardEvent("glasses_connection_state", changed))
    // Route the rest of the inbound device events (wifi/hotspot/gallery -> stores+bus,
    // photo/stream -> coordinators, button/touch/accel/head -> miniapps, save_setting ->
    // store, miniapp_selected -> launcher) so a bare OEM gets device data, not just the
    // Mentra app's MantleManager.
    startDeviceEventRouter()
    // Hydration contract: the native DeviceStore is in-memory and starts empty
    // every launch; seed it from the persisted settings BEFORE start() resolves
    // so every post-start getDefaultDevice() read is a trustworthy two-state
    // answer (no false "absent" for genuinely-paired users at cold start).
    // Ordered before startGlassesSettingsSync so the settings load can't
    // double-push through the change subscription. A failed hydration must not
    // brick the runtime: start() continues, and the guards that consume
    // hasDefaultDevice() see the rejection and fail open.
    try {
      await hydrateDeviceStore()
      // Boot repair: a persisted default_wearable without a native default
      // device (identity abandoned mid-pairing, or resurrected from the server
      // before identity stopped syncing) demotes to pending_wearable so hosts
      // render finish-pairing instead of a connect that would throw.
      await demoteOrphanedDefaultWearable()
    } catch (error) {
      console.warn("engine.start: device-store hydration failed:", error instanceof Error ? error.message : error)
    }
    // Project the glasses' OTA events into the store for the engine.ota read surface.
    startOtaService()
    // Forward glasses mic_lc3 frames to the v2 cloud session so cloud transcription
    // works for any host (not just the Mentra app's host-side MantleManager fork).
    startAudioCloudUplink()
    try {
      await cloudClientService.syncCoreTokenToBluetooth()
    } catch (error) {
      console.warn(
        "engine.start: initial Cloud V2 core token sync failed:",
        error instanceof Error ? error.message : error,
      )
    }
    startSupportProfileSync()
    // Push device-setting changes to the glasses for ANY host, so
    // engine.glasses.settings.set() reaches the device (not just the Mentra app).
    startGlassesSettingsSync()
    // Same for phone-notification config -> the native listener (Android).
    startPhoneNotificationsSync()
    // Android internal/e2e: laptop captions tester can broadcast a failure intent;
    // engine owns turning that into a Cloud V2 report.
    startCaptionsTesterReportService()
    // MentraJS crashloop-disabled is runtime state; engine owns filing the
    // automatic report while hosts only render alert/telemetry side effects.
    startMentraJSCrashloopReportService()
    // Bring up the local-miniapp engine so a bare OEM can run MentraJS miniapps:
    // the LocalMiniappRuntime (registry + WebView bridge), the MentraJS router
    // (crust-bound spawn/dispatch pump + launcher wiring), the DisplayProcessor
    // (layout arbitration over the engine stores), and the gallery-sync service.
    // All idempotent — when the Mentra app's host bootstrap also calls these, the
    // second call is a no-op. Host-only crashloop telemetry is attached
    // separately by the Mentra app.
    localMiniappRuntime.initialize()
    ensureMiniappEngine()
    displayProcessor.attachToRuntime()
    gallerySyncService.initialize()
  },
  /** Stop the runtime: tear down the settings sync + cloud client + mark stopped.
   * Each step is guarded so one failing teardown can't skip the rest and leak
   * the remaining runtime services. */
  async stop() {
    const safely = async (label: string, step: () => unknown): Promise<void> => {
      try {
        await step()
      } catch (error) {
        console.warn(`engine.stop: ${label} failed:`, error)
      }
    }
    await safely("glasses settings sync", stopGlassesSettingsSync)
    await safely("glasses status projection", stopGlassesStatusProjection)
    await safely("device event router", stopDeviceEventRouter)
    await safely("ota service", stopOtaService)
    await safely("audio cloud uplink", stopAudioCloudUplink)
    await safely("support profile sync", stopSupportProfileSync)
    await safely("phone notifications sync", stopPhoneNotificationsSync)
    await safely("captions tester report service", stopCaptionsTesterReportService)
    await safely("mentrajs crashloop report service", stopMentraJSCrashloopReportService)
    await safely("miniapp engine", stopMiniappEngine)
    await safely("local miniapp runtime", () => localMiniappRuntime.cleanup())
    await safely("display processor", () => displayProcessor.detachFromRuntime())
    await safely("gallery sync service", () => gallerySyncService.cleanup())
    await safely("cloud client", () => cloudClientService.stop())
    await safely("bootstrap", bootstrapStop)
  },
  glasses,
  speech,
  /** Cloud (cloud-v2) live-session status + account ops — engine owns the client. */
  session,
  /** Typed keyed user settings over the engine-owned settings store. */
  settings,
  /** Developer/debug surface (backend+cloud URL overrides, reconnect, min version). */
  dev,
  /** Bug-report, automatic runtime report, and feedback submission. */
  reports,
  /** Firmware OTA read/observe surface (updateAvailable/status + on* subscriptions). */
  ota,
  /** Gallery sync: status/onStatus · onNotice (host renders) · sync/cancel. */
  gallery,
  /** Miniapp lifecycle (the WebView bridge primitives are exported separately). */
  miniapps,
  /** First-time glasses discovery + pairing. */
  pairing,
  /** Phone→glasses notification forwarding (Android). */
  phoneNotifications,
  /** OS permissions (check/request/openSettings + per-miniapp requirements). */
  permissions,
  /** Inbound alerts engine→host (crashloop, version-incompatible, connection loss). */
  notifications,
  display,
}
