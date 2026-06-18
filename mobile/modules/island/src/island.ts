/**
 * `toolkit` — the namespaced OEM-facing toolkit API (the "(A) host API" from the
 * Phase-1 contract). Host UI calls `toolkit.<domain>.<method>()`; each domain is a
 * typed facade over the runtime. (Exported from the `@mentra/island` module, whose
 * name stays `island` in code; the public API surface is `toolkit`.)
 *
 * This is additive: it grows one facade at a time and lives *alongside* the flat
 * named exports in `index.ts` during the migration. The flat exports (and the
 * `BluetoothSdk` passthrough) stay until every screen has moved onto `island.*`.
 */
import {configure, start as bootstrapStart, stop as bootstrapStop} from "./runtime/bootstrap"
import {cloudClientService} from "./services/CloudClientService"
import {startGlassesSettingsSync, stopGlassesSettingsSync} from "./services/GlassesSettingsSync"
import {startGlassesStatusProjection, stopGlassesStatusProjection} from "./services/GlassesStatusProjection"
import {startOtaService, stopOtaService} from "./services/OtaService"
import {startPhoneNotificationsSync, stopPhoneNotificationsSync} from "./services/PhoneNotificationsSync"
import {glasses} from "./facades/glasses"
import {display} from "./facades/display"
import {speech} from "./facades/speech"
import {session} from "./facades/session"
import {settings} from "./facades/settings"
import {dev} from "./facades/dev"
import {incidents} from "./facades/incidents"
import {ota} from "./facades/ota"
import {miniapps} from "./facades/miniapps"
import {pairing} from "./facades/pairing"
import {phoneNotifications} from "./facades/phoneNotifications"
import {permissions} from "./facades/permissions"
import {notifications} from "./facades/notifications"
import {useGlassesStore} from "./stores/glasses"
import {useDisplayStore} from "./stores/display"
import {useCoreStore} from "./stores/core"
import {useConnectionStore} from "./stores/connection"
import {useGallerySyncStore} from "./stores/gallerySync"
import {useCloudClientStatusStore} from "./stores/cloudClientStatus"
import {useSettingsStore} from "./stores/settings"

export const toolkit = {
  /** Front door — hand island auth + config, then start/stop the runtime. */
  configure,
  /** Start the runtime: mark started + construct/connect the cloud client + begin
   * syncing device settings to the glasses. */
  async start() {
    await bootstrapStart()
    // Construct + connect the cloud client so the documented configure()+start()
    // lifecycle yields a live toolkit.session for OEMs. Idempotent — when the
    // Mentra app has already called cloudClient.init() (synchronously, right after
    // start()), THIS call is the no-op.
    cloudClientService.init()
    // Project native device status -> the island stores (the inbound feed the rest
    // of the runtime reads). Established first so the stores are live before the
    // syncs below react to them.
    startGlassesStatusProjection()
    // Project the glasses' OTA events into the store for the toolkit.ota read surface.
    startOtaService()
    // Push device-setting changes to the glasses for ANY host, so
    // toolkit.glasses.settings.set() reaches the device (not just the Mentra app).
    startGlassesSettingsSync()
    // Same for phone-notification config -> the native listener (Android).
    startPhoneNotificationsSync()
  },
  /** Stop the runtime: tear down the settings sync + cloud client + mark stopped. */
  async stop() {
    stopGlassesSettingsSync()
    stopGlassesStatusProjection()
    stopOtaService()
    stopPhoneNotificationsSync()
    cloudClientService.stop()
    await bootstrapStop()
  },
  glasses,
  speech,
  /** Cloud (cloud-v2) live-session status + account ops — island owns the client. */
  session,
  /** Typed keyed user settings over the island-owned settings store. */
  settings,
  /** Developer/debug surface (backend+cloud URL overrides, reconnect, min version). */
  dev,
  /** Bug-report / feedback submission (island-owned RestComms). */
  incidents,
  /** Firmware OTA read/observe surface (updateAvailable/status + on* subscriptions). */
  ota,
  /** Miniapp lifecycle (the WebView bridge primitives are exported separately). */
  miniapps,
  /** First-time glasses discovery + pairing. */
  pairing,
  /** Phone→glasses notification forwarding (Android). */
  phoneNotifications,
  /** OS permissions (check/request/openSettings + per-miniapp requirements). */
  permissions,
  /** Inbound alerts island→host (crashloop, version-incompatible, connection loss). */
  notifications,
  display,
  /**
   * Escape hatches — the raw device-state zustand stores, grouped under `stores`,
   * exposed so the Mentra app keeps using them directly instead of rewriting every
   * screen onto typed facades. These are Mentra-app convenience, NOT the OEM
   * contract — OEMs use the typed facades above. Prefer a facade where one exists.
   */
  stores: {
    glasses: useGlassesStore,
    display: useDisplayStore,
    core: useCoreStore,
    connection: useConnectionStore,
    gallerySync: useGallerySyncStore,
    cloudClientStatus: useCloudClientStatusStore,
    settings: useSettingsStore,
  },
}
