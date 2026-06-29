/**
 * ota facade — `toolkit.ota`: the OEM-facing OTA read/observe surface. Island's
 * OtaService projects the glasses' OTA BLE events into the island store; this facade
 * exposes the snapshot + change subscriptions the host renders its update prompt and
 * progress UI from. No host-injected UI — the host owns all alerts/navigation/i18n.
 *
 * The rich availability check/retry flow is still host-owned: the OTA check screen
 * fetches the manifest, compares APK/MTK/BES versions, writes otaUpdateAvailable,
 * and drives its local UI state from that result. Moving that full check behind
 * toolkit.ota is deferred until we can preserve that contract end-to-end.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {OtaStatus, OtaUpdateInfo} from "@mentra/bluetooth-sdk/internal"
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
  // Deferred: this facade entry was intended to become the toolkit-owned retry/check
  // action, but BluetoothSdk.checkForOtaUpdate() only returns a boolean. Exposing it
  // here would make callers think the rich otaUpdateAvailable read model is refreshed,
  // while the original view still depends on the host-side manifest compare to build
  // versionName/updates/totalSize. Keep that behavior unchanged until the whole rich
  // availability check moves into island.
  // retry: () => BluetoothSdk.checkForOtaUpdate(),

  /** Current available-update info (versionName/updates/totalSize/cacheReady), or null. */
  updateAvailable: (): OtaUpdateInfo | null => useGlassesStore.getState().otaUpdateAvailable,
  /** Current OTA install status (stepType/phase/percent/status/error), or null. */
  status: (): OtaStatus | null => useGlassesStore.getState().otaStatus,

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
}
