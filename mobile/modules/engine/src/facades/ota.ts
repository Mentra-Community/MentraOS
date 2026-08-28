/**
 * ota facade — `engine.ota`: the OEM-facing OTA read/observe surface. Engine's
 * OtaService projects the glasses' OTA BLE events into the engine store; this facade
 * exposes the snapshot + change subscriptions behind the shared OTA flow exported by
 * `@mentra/engine/ota`. Hosts retain only their surrounding navigation and theme/i18n adapters.
 *
 * Availability checks live in engine. Install orchestration lives in engine too:
 * `installSession` fronts the OtaInstallCoordinator state machine (WP 8B) — the host
 * progress screen is a pure renderer over its snapshot + attach/detach/retry/finish.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk"
import type {
  OtaProgress,
  OtaProgressStatus,
  OtaStartAckEvent,
  OtaStatus,
  OtaUpdateInfo,
  ReleaseChangelog,
} from "@mentra/bluetooth-sdk"
import {isGlassesConnected, useGlassesStore} from "../stores/glasses"
import {resolveOtaManifestUrl} from "../services/otaManifestUrl"
import {otaInstallCoordinator, type OtaInstallSnapshot} from "../services/OtaInstallCoordinator"
import {startGlassesStatusProjection} from "../services/GlassesStatusProjection"
import {startOtaService} from "../services/OtaService"
import {
  checkCurrentGlassesForUpdate,
  type OtaCheckCurrentGlassesOptions,
  type OtaCheckCurrentGlassesResult,
} from "../services/OtaUpdateCheckService"

function projectSnapshot() {
  const s = useGlassesStore.getState()
  return {
    connected: isGlassesConnected(s.connection),
    buildNumber: s.buildNumber || null,
    appVersion: s.appVersion || null,
    mtkFirmwareVersion: s.mtkFirmwareVersion || null,
    besFirmwareVersion: s.besFirmwareVersion || null,
    batteryLevel: s.batteryLevel >= 0 ? s.batteryLevel : null,
    hotspotOtaVersion: s.hotspotOtaVersion ?? 0,
    wifiConnected: s.wifi.state === "connected",
    wifiStatusKnown: s.wifiStatusKnown,
    manifestUrl: resolveOtaManifestUrl(s.otaVersionUrl, s.buildNumber),
    updateAvailable: s.otaUpdateAvailable,
    status: s.otaStatus,
    legacyProgress: s.otaProgress,
    inProgress: s.otaInProgress,
    mtkUpdatedThisSession: s.mtkUpdatedThisSession,
  }
}

export type OtaSnapshot = ReturnType<typeof projectSnapshot>
export type {
  OtaProgress,
  OtaProgressStatus,
  OtaStatus,
  OtaUpdateInfo,
  ReleaseChangelog,
  OtaInstallSnapshot,
  OtaCheckCurrentGlassesOptions,
  OtaCheckCurrentGlassesResult,
}

export const ota = {
  // --- actions ---
  /**
   * Start the device-status and OTA projections without starting the authenticated
   * cloud/miniapp runtime. This is the explicit entry point for Bluetooth-only hosts.
   * Idempotent and safe when the full engine runtime is already running.
   */
  initialize: async () => {
    const hydrated = startGlassesStatusProjection()
    startOtaService()
    await hydrated
  },
  /**
   * Start the firmware install with the resolved OTA manifest URL. Progress lands on
   * `status()`/`onStatus()`. (The host resolves the manifest URL — developer override,
   * host pin, or Engine release pin resolution stays with the OTA config; the stuck/retry watchdog is its own
   * resilience layer on top of this command.)
   */
  install: (otaVersionUrl?: string | null): Promise<OtaStartAckEvent> => BluetoothSdk.startOtaUpdate(otaVersionUrl),
  // Deferred: this facade entry was intended to become the engine-owned retry/check
  // action, but BluetoothSdk.checkForOtaUpdate() only returns a boolean. Exposing it
  // here would make callers think the rich otaUpdateAvailable read model is refreshed,
  // while the original view still depends on the host-side manifest compare to build
  // versionName/updates/totalSize. Keep that behavior unchanged until the whole rich
  // availability check moves into engine.
  // retry: () => BluetoothSdk.checkForOtaUpdate(),
  /**
   * Keep glasses awake while an OTA session is actively progressing.
   * @deprecated Legacy progress route (build < 37) only — removed with WP 8D.
   */
  ping: () => BluetoothSdk.ping(),
  /** Resolve and compare the current glasses against the OTA manifest, then update the OTA snapshot. */
  checkForUpdates: (options?: OtaCheckCurrentGlassesOptions) => checkCurrentGlassesForUpdate(options),
  /** Return bundled release changelogs crossed between two coordinated product versions, newest first. */
  getReleaseChangelogs: (fromVersion?: string | null, toVersion?: string | null): ReleaseChangelog[] =>
    BluetoothSdk.getReleaseChangelogs(fromVersion, toVersion),
  /** Clear the available-update prompt state. */
  clearUpdateAvailable: () => useGlassesStore.getState().setOtaUpdateAvailable(null),
  /** Clear active progress/status before entering a fresh install flow. */
  clearProgress: () => {
    const store = useGlassesStore.getState()
    store.setOtaProgress(null)
    store.setOtaStatus(null)
  },
  /**
   * Replace the pending update sequence after an in-flow firmware revalidation.
   * Kept as a named OTA policy operation so host screens do not mutate the raw
   * glasses store.
   * @deprecated Legacy progress route (build < 37) only — removed with WP 8D.
   */
  replacePendingUpdateSequence: (updates: OtaUpdateInfo["updates"]): OtaUpdateInfo | null => {
    const store = useGlassesStore.getState()
    const current = store.otaUpdateAvailable
    if (!current) return null
    const next = {...current, updates}
    store.setOtaUpdateAvailable(next)
    return next
  },
  /**
   * Clear stale build metadata before returning to the update-check screen.
   * This forces the next version_info event through both the native observable
   * store and the engine projection after an APK reboot.
   * @deprecated Legacy progress route (build < 37) only — removed with WP 8D.
   */
  clearBuildNumberForNextCheck: () => {
    useGlassesStore.getState().setGlassesInfo({buildNumber: ""})
  },
  /**
   * Mark MTK as already applied during this app session until the glasses reboot/disconnect.
   * @deprecated Legacy progress route (build < 37) only — removed with WP 8D.
   */
  markMtkUpdatedThisSession: (updated: boolean) => useGlassesStore.getState().setMtkUpdatedThisSession(updated),

  /**
   * The OTA install state machine (unified `ota_status` sessions, build >= 37).
   * The host progress screen attaches on mount, detaches on unmount, and renders
   * the snapshot; every watchdog/retry/reconnect rule lives in the coordinator.
   */
  installSession: {
    /** Select Wi-Fi or capability-gated hotspot transport for this checked manifest. */
    prepare: (result: OtaCheckCurrentGlassesResult) => otaInstallCoordinator.prepare(result),
    /** Bind the machine to the mounted progress screen. Idempotent per attach/detach cycle. */
    attach: () => otaInstallCoordinator.attach(),
    /** Unbind on unmount: clears all timers/listeners and resets session state. */
    detach: () => otaInstallCoordinator.detach(),
    /** Retry after a failure: clear state and re-send ota_start (if connected). */
    retry: () => otaInstallCoordinator.retry(),
    /** Terminal cleanup for Continue/Done, including hotspot route teardown. */
    finish: () => otaInstallCoordinator.finish(),
    /** Abandon an interrupted session: await finish() then drop the session's status/progress. */
    discard: () => otaInstallCoordinator.discard(),
    /** Current install read model (displayState/errorMsg/lockout + glasses OTA data). */
    snapshot: (): OtaInstallSnapshot => otaInstallCoordinator.snapshot(),
    /** Subscribe to install snapshot changes (deduped on projected JSON). Returns an unsubscribe. */
    onSnapshot: (cb: (snapshot: OtaInstallSnapshot) => void): (() => void) => otaInstallCoordinator.onSnapshot(cb),
  },

  /** Current available-update info (versionName/updates/totalSize), or null. */
  updateAvailable: (): OtaUpdateInfo | null => useGlassesStore.getState().otaUpdateAvailable,
  /** Current OTA install status (stepType/phase/percent/status/error), or null. */
  status: (): OtaStatus | null => useGlassesStore.getState().otaStatus,
  /** Current OTA read model for update prompt/progress screens. */
  snapshot: (): OtaSnapshot => projectSnapshot(),

  /** Subscribe to OTA availability changes (info or null when cleared). Returns an unsubscribe. */
  onUpdateAvailable: (cb: (info: OtaUpdateInfo | null) => void): (() => void) => {
    let last = useGlassesStore.getState().otaUpdateAvailable
    return useGlassesStore.subscribe(() => {
      const info = useGlassesStore.getState().otaUpdateAvailable
      if (info === last) return
      last = info
      cb(info)
    })
  },

  /** Subscribe to OTA install status changes. Returns an unsubscribe. */
  onStatus: (cb: (status: OtaStatus | null) => void): (() => void) => {
    let last = useGlassesStore.getState().otaStatus
    return useGlassesStore.subscribe(() => {
      const status = useGlassesStore.getState().otaStatus
      if (status === last) return
      last = status
      cb(status)
    })
  },

  /** Subscribe to OTA snapshot changes. Returns an unsubscribe. */
  onSnapshot: (cb: (snapshot: OtaSnapshot) => void): (() => void) => {
    let last = JSON.stringify(projectSnapshot())
    return useGlassesStore.subscribe(() => {
      const snap = projectSnapshot()
      const key = JSON.stringify(snap)
      if (key === last) return
      last = key
      cb(snap)
    })
  },
}
