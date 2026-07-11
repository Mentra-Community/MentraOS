/**
 * Glasses status projection — engine-owned. Subscribes to the native bluetooth-sdk
 * status events and projects them into the engine device stores, so engine's own
 * services (which react to those stores) work for ANY host — not just the first-party
 * Mentra app, where this used to live in MantleManager.
 *
 * This is the INBOUND mirror of GlassesSettingsSync: that pushes the settings store
 * OUT to the device; this pulls device status IN to the stores. It's the feed that
 * the rest of the engine runtime depends on (MicStateCoordinator, the settings-sync
 * on-connect trigger, the facade read-models all read these stores).
 *
 * Started by `engine.start()`. Idempotent.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {useCoreStore} from "../stores/core"
import {useGlassesStore} from "../stores/glasses"
import localMiniappRuntime from "./LocalMiniappRuntime"

let unsubs: Array<() => void> = []
let projectionRunId = 0

export function startGlassesStatusProjection(): void {
  if (unsubs.length) return

  const runId = ++projectionRunId
  let bluetoothEventSeen = false
  let glassesEventSeen = false

  void BluetoothSdk.getBluetoothStatus()
    .then((status) => {
      if (runId !== projectionRunId || bluetoothEventSeen) return
      useCoreStore.getState().setCoreInfo(status)
    })
    .catch((error) => {
      console.warn("GlassesStatusProjection: getBluetoothStatus failed", error)
    })

  void BluetoothSdk.getGlassesStatus()
    .then((status) => {
      if (runId !== projectionRunId || glassesEventSeen) return
      useGlassesStore.getState().setGlassesInfo(status)
    })
    .catch((error) => {
      console.warn("GlassesStatusProjection: getGlassesStatus failed", error)
    })

  // Bluetooth-adapter status -> core store.
  unsubs.push(
    BluetoothSdk.onBluetoothStatus((changed) => {
      bluetoothEventSeen = true
      useCoreStore.getState().setCoreInfo(changed)
    }),
  )

  // Glasses status -> glasses store (+ forward to local miniapps; clear any stale
  // OTA-available flag on disconnect).
  unsubs.push(
    BluetoothSdk.onGlassesStatus((changed) => {
      glassesEventSeen = true
      useGlassesStore.getState().setGlassesInfo(changed)
      localMiniappRuntime.forwardEvent("glasses_connection_state", changed)
      if (changed.connection?.state === "disconnected") {
        useGlassesStore.getState().setOtaUpdateAvailable(null)
      }
    }),
  )
}

export function stopGlassesStatusProjection(): void {
  projectionRunId++
  unsubs.forEach((unsub) => unsub())
  unsubs = []
}
