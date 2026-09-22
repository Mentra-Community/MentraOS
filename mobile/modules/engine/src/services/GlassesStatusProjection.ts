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
import BluetoothSdk, {type PublicGlassesStatus} from "@mentra/bluetooth-sdk"
import {useCoreStore} from "../stores/core"
import {useGlassesStore} from "../stores/glasses"
import {isGlassesConnected} from "./GlassesReadiness"

/** Miniapp `session.glasses.onConnection` payload. */
export type MiniappConnectionData = {
  connected: boolean
  modelName?: string
}

/**
 * Native `glasses_status` is a store delta (`connection.state`, battery, wifi…).
 * Miniapps subscribe to a boolean `connected` field. Forwarding the raw status
 * makes `Boolean(data.connected)` false on every heartbeat while the Mentra App
 * still shows the glasses linked.
 */
export function toMiniappConnectionData(status: unknown): MiniappConnectionData | null {
  if (!status || typeof status !== "object") return null
  const rec = status as Partial<PublicGlassesStatus> & {connected?: boolean; modelName?: string}
  if (typeof rec.connected === "boolean") {
    const modelName = rec.modelName || rec.deviceModel
    return {connected: rec.connected, ...(modelName ? {modelName} : {})}
  }
  if (!rec.connection) return null
  const modelName = rec.deviceModel
  return {
    connected: isGlassesConnected(rec.connection),
    ...(modelName ? {modelName} : {}),
  }
}

let unsubs: Array<() => void> = []
let projectionRunId = 0
let glassesStatusForwarder: ((status: Partial<PublicGlassesStatus>) => void) | null = null
let hydrationPromise: Promise<void> | null = null

export function startGlassesStatusProjection(
  forwarder?: (status: Partial<PublicGlassesStatus>) => void,
): Promise<void> {
  if (forwarder) glassesStatusForwarder = forwarder
  if (unsubs.length) return hydrationPromise ?? Promise.resolve()

  const runId = ++projectionRunId
  let bluetoothEventSeen = false
  let glassesEventSeen = false

  const bluetoothHydration = BluetoothSdk.getBluetoothStatus()
    .then((status) => {
      if (runId !== projectionRunId || bluetoothEventSeen) return
      useCoreStore.getState().setCoreInfo(status)
    })
    .catch((error) => {
      console.warn("GlassesStatusProjection: getBluetoothStatus failed", error)
    })

  const glassesHydration = BluetoothSdk.getGlassesStatus()
    .then((status) => {
      if (runId !== projectionRunId || glassesEventSeen) return
      useGlassesStore.getState().setGlassesInfo(status)
    })
    .catch((error) => {
      console.warn("GlassesStatusProjection: getGlassesStatus failed", error)
    })

  // Bluetooth-adapter status -> core store.
  unsubs.push(
    BluetoothSdk.subscribeBluetoothStatus((changed) => {
      bluetoothEventSeen = true
      useCoreStore.getState().setCoreInfo(changed)
    }),
  )

  // Glasses status -> glasses store (+ optional full-runtime forwarding to local
  // miniapps; clear any stale OTA-available flag on disconnect).
  unsubs.push(
    BluetoothSdk.subscribeGlassesStatus((changed) => {
      glassesEventSeen = true
      useGlassesStore.getState().setGlassesInfo(changed)
      glassesStatusForwarder?.(changed)
      if (changed.connection?.state === "disconnected") {
        useGlassesStore.getState().setOtaUpdateAvailable(null)
      }
    }),
  )

  hydrationPromise = Promise.allSettled([bluetoothHydration, glassesHydration]).then(() => undefined)
  return hydrationPromise
}

export function stopGlassesStatusProjection(): void {
  projectionRunId++
  unsubs.forEach((unsub) => unsub())
  unsubs = []
  glassesStatusForwarder = null
  hydrationPromise = null
}
