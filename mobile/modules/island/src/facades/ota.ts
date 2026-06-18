/**
 * ota facade — `toolkit.ota`: the OEM-facing OTA read/observe surface. Island's
 * OtaService projects the glasses' OTA BLE events into the island store; this facade
 * exposes the snapshot + change subscriptions the host renders its update prompt and
 * progress UI from. No host-injected UI — the host owns all alerts/navigation/i18n.
 *
 * Install ACTIONS (check/install/retry) land in Phase 2 (the install orchestration
 * moves out of the host progress screen; bootloop-risk, needs on-device verification).
 */
import type {OtaStatus, OtaUpdateInfo} from "@mentra/bluetooth-sdk/internal"
import {useGlassesStore} from "../stores/glasses"

export const ota = {
  /** Current available-update info (versionName/updates/totalSize/cacheReady), or null. */
  updateAvailable: (): OtaUpdateInfo | null => useGlassesStore.getState().otaUpdateAvailable,
  /** Current OTA install status (stepType/phase/percent/status/error), or null. */
  status: (): OtaStatus | null => useGlassesStore.getState().otaStatus,

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
}
