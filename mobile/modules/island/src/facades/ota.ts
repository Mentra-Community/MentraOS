/**
 * ota facade — `toolkit.ota`: the OEM-facing OTA read/observe surface. Island's
 * OtaService projects the glasses' OTA BLE events into the island store; this facade
 * exposes the snapshot + change subscriptions the host renders its update prompt and
 * progress UI from. No host-injected UI — the host owns all alerts/navigation/i18n.
 *
 * Availability checks live in toolkit. Install orchestration and UI retry
 * decisions still stay in the host progress screen until that behavior can move
 * without changing the OTA flow.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {OtaProgress, OtaStatus, OtaUpdateInfo} from "@mentra/bluetooth-sdk/internal"
import {isGlassesConnected, useGlassesStore} from "../stores/glasses"
import {getAsgOtaVersionUrl} from "../services/asgOtaVersionUrl"
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
    mtkFirmwareVersion: s.mtkFirmwareVersion || null,
    besFirmwareVersion: s.besFirmwareVersion || null,
    wifiConnected: s.wifi.state === "connected",
    wifiStatusKnown: s.wifiStatusKnown,
    manifestUrl: getAsgOtaVersionUrl(s.otaVersionUrl, s.buildNumber),
    updateAvailable: s.otaUpdateAvailable,
    status: s.otaStatus,
    legacyProgress: s.otaProgress,
    inProgress: s.otaInProgress,
    mtkUpdatedThisSession: s.mtkUpdatedThisSession,
  }
}

export type OtaSnapshot = ReturnType<typeof projectSnapshot>
export type {OtaProgress, OtaStatus, OtaUpdateInfo, OtaCheckCurrentGlassesOptions, OtaCheckCurrentGlassesResult}

export const ota = {
  // --- actions ---
  /**
   * Start the firmware install with the resolved OTA manifest URL. Progress lands on
   * `status()`/`onStatus()`. (The host resolves the manifest URL — dev-override/env/prod
   * resolution stays with the OTA config; the host-side stuck/retry watchdog is its own
   * resilience layer on top of this command.)
   */
  install: (...args: Parameters<typeof BluetoothSdk.startOtaUpdate>) => BluetoothSdk.startOtaUpdate(...args),
  // Deferred: this facade entry was intended to become the toolkit-owned retry/check
  // action, but BluetoothSdk.checkForOtaUpdate() only returns a boolean. Exposing it
  // here would make callers think the rich otaUpdateAvailable read model is refreshed,
  // while the original view still depends on the host-side manifest compare to build
  // versionName/updates/totalSize. Keep that behavior unchanged until the whole rich
  // availability check moves into island.
  // retry: () => BluetoothSdk.checkForOtaUpdate(),
  /** Ask glasses for their active OTA session/status after reconnect or remount. */
  queryStatus: () => BluetoothSdk.sendOtaQueryStatus(),
  /** Keep glasses awake while an OTA session is actively progressing. */
  ping: () => BluetoothSdk.ping(),
  /** Resolve and compare the current glasses against the OTA manifest, then update the OTA snapshot. */
  checkForUpdates: (options?: OtaCheckCurrentGlassesOptions) => checkCurrentGlassesForUpdate(options),
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
   * store and the island projection after an APK reboot.
   */
  clearBuildNumberForNextCheck: () => {
    BluetoothSdk.updateGlasses({buildNumber: ""})
    useGlassesStore.getState().setGlassesInfo({buildNumber: ""})
  },
  /** Mark MTK as already applied during this app session until the glasses reboot/disconnect. */
  markMtkUpdatedThisSession: (updated: boolean) => useGlassesStore.getState().setMtkUpdatedThisSession(updated),

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
