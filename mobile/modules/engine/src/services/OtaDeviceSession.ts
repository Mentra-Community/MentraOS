import BluetoothSdk, {type Device} from "@mentra/bluetooth-sdk"
import {useGlassesStore} from "../stores/glasses"

// Physical pairing ownership outlives a link disconnect or ASG process restart.
// A revision also fences A -> forgotten -> A: that requires fresh approval.
let deviceKey: string | null | undefined
let revision = 0
const listeners = new Set<() => void>()
let subscription: {remove: () => void} | null = null
let hydration: Promise<void> | null = null
let runId = 0

export const otaDeviceSessionRevision = (): number => revision

export function subscribeOtaDeviceSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function updateDevice(device?: Device | null): void {
  const key = device ? JSON.stringify([device.model, (device.address || device.id).trim().toLowerCase()]) : null
  if (deviceKey === undefined) {
    deviceKey = key
    return
  }
  if (key === deviceKey) return
  deviceKey = key
  revision += 1
  // Stop old coordinator work before clearing the store: its reaction to an
  // empty OTA status must never start that attempt on the newly paired glasses.
  listeners.forEach((listener) => listener())
  const store = useGlassesStore.getState()
  store.clearOtaState()
  store.setOtaStatus(null)
  store.setMtkUpdatedThisSession(false)
}

/** Uses the public SDK so Bluetooth-only Engine hosts get the same ownership boundary. */
export function startOtaDeviceSession(): Promise<void> {
  if (subscription) return hydration ?? Promise.resolve()
  const currentRun = ++runId
  let eventSeen = false
  subscription = BluetoothSdk.addListener("default_device_changed", ({device}) => {
    eventSeen = true
    updateDevice(device)
  })
  hydration = Promise.resolve(BluetoothSdk.getDefaultDevice())
    .then((device) => {
      if (currentRun === runId && !eventSeen) updateDevice(device)
    })
    .catch((error) => console.warn("OTA: default device hydration failed", error))
  return hydration
}

export function stopOtaDeviceSession(): void {
  runId += 1
  subscription?.remove()
  subscription = null
  hydration = null
}
