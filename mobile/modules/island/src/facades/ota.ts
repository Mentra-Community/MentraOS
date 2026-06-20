/**
 * ota facade — `toolkit.ota`: the OEM-facing OTA read/observe surface. Island's
 * OtaService projects the glasses' OTA BLE events into the island store; this facade
 * exposes the snapshot + change subscriptions the host renders its update prompt and
 * progress UI from. No host-injected UI — the host owns all alerts/navigation/i18n.
 *
 * Install ACTIONS (check/install/retry) land in Phase 2 (the install orchestration
 * moves out of the host progress screen; bootloop-risk, needs on-device verification).
 */
import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
import type {OtaProgress, OtaStatus, OtaUpdateInfo} from "../../../bluetooth-sdk/build/_internal"
import {useGlassesStore} from "../stores/glasses"

export const ota = {
  // --- actions ---
  /**
   * Start the firmware install with the resolved OTA manifest URL. Progress lands on
   * `status()`/`onStatus()`. (The host resolves the manifest URL — dev-override/env/prod
   * resolution stays with the OTA config; the host-side stuck/retry watchdog is its own
   * resilience layer on top of this command.)
   */
  install: (...args: Parameters<typeof BluetoothSdk.startOtaUpdate>) => BluetoothSdk.startOtaUpdate(...args),
  /** Re-query the glasses for an available update (e.g. after a clock-fix or failure). */
  retry: () => BluetoothSdk.checkForOtaUpdate(),

  /** Current available-update info (versionName/updates/totalSize), or null. */
  updateAvailable: (): OtaUpdateInfo | null => useGlassesStore.getState().otaUpdateAvailable,
  /** Current OTA install status (stepType/phase/percent/status/error), or null. */
  status: (): OtaStatus | null => useGlassesStore.getState().otaStatus,
  /** Legacy OTA progress snapshot used by the current MentraOS progress screens. */
  progress: (): OtaProgress | null => useGlassesStore.getState().otaProgress,
  /** Whether this phone session already updated MTK firmware. */
  mtkUpdatedThisSession: (): boolean => useGlassesStore.getState().mtkUpdatedThisSession,

  /** Subscribe to "an update became available" (null → info). Returns an unsubscribe. */
  onUpdateAvailable: (cb: (info: OtaUpdateInfo) => void): (() => void) => {
    let last = useGlassesStore.getState().otaUpdateAvailable
    return useGlassesStore.subscribe(() => {
      const info = useGlassesStore.getState().otaUpdateAvailable
      if (info === last) return
      last = info
      if (info) cb(info)
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

  /** Subscribe to legacy OTA progress changes. Returns an unsubscribe. */
  onProgress: (cb: (progress: OtaProgress | null) => void): (() => void) => {
    let last = useGlassesStore.getState().otaProgress
    return useGlassesStore.subscribe(() => {
      const progress = useGlassesStore.getState().otaProgress
      if (progress === last) return
      last = progress
      cb(progress)
    })
  },
}
