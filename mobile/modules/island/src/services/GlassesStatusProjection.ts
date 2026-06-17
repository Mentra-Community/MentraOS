/**
 * Glasses status projection — island-owned. Subscribes to the native bluetooth-sdk
 * status events and projects them into the island device stores, so island's own
 * services (which react to those stores) work for ANY host — not just the first-party
 * Mentra app, where this used to live in MantleManager.
 *
 * This is the INBOUND mirror of GlassesSettingsSync: that pushes the settings store
 * OUT to the device; this pulls device status IN to the stores. It's the feed that
 * the rest of the island runtime depends on (MicStateCoordinator, the settings-sync
 * on-connect trigger, the facade read-models all read these stores).
 *
 * Started by `toolkit.start()`. Idempotent.
 */
import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
import {useCoreStore} from "../stores/core"
import {useGlassesStore} from "../stores/glasses"
import localMiniappRuntime from "./LocalMiniappRuntime"

let unsubs: Array<() => void> = []

export function startGlassesStatusProjection(): void {
  if (unsubs.length) return

  // Bluetooth-adapter status -> core store.
  unsubs.push(
    BluetoothSdk.onBluetoothStatus((changed) => {
      useCoreStore.getState().setCoreInfo(changed)
    }),
  )

  // Glasses status -> glasses store (+ forward to local miniapps; clear any stale
  // OTA-available flag on disconnect).
  unsubs.push(
    BluetoothSdk.onGlassesStatus((changed) => {
      useGlassesStore.getState().setGlassesInfo(changed)
      localMiniappRuntime.forwardEvent("glasses_connection_state", changed)
      if (changed.connection?.state === "disconnected") {
        useGlassesStore.getState().setOtaUpdateAvailable(null)
      }
    }),
  )
}

export function stopGlassesStatusProjection(): void {
  unsubs.forEach((unsub) => unsub())
  unsubs = []
}
