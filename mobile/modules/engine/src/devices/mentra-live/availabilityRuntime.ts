import BluetoothSdk, {type Device} from "@mentra/bluetooth-sdk"
import {fetchVersionInfo} from "../../services/OtaUpdateCheckService"
import {deviceIntegrations} from "../builtins"
import {LiveAvailabilityMonitor} from "./availability"
import {hasManagedLiveOwner} from "./ownership"
import {liveOtaPorts} from "./ports"

let currentDevice: Device | null = null
let deviceGeneration = 0
let identitySubscription: {remove(): void} | null = null

export const liveAvailability = new LiveAvailabilityMonitor({
  snapshot: liveOtaPorts.snapshot,
  subscribe: (listener) => liveOtaPorts.onSnapshot(listener),
  check: (options) => liveOtaPorts.checkForUpdates(options),
  fetchManifest: fetchVersionInfo,
  clearMtkSession: () => liveOtaPorts.markMtkUpdatedThisSession(false),
  owned: hasManagedLiveOwner,
  target: () =>
    currentDevice && deviceIntegrations.forModel(currentDevice.model)?.firmware?.entryPoints.includes("background")
      ? currentDevice.id
      : null,
})

export async function startLiveAvailability(): Promise<void> {
  if (identitySubscription) return
  const generation = ++deviceGeneration
  identitySubscription = BluetoothSdk.addListener("default_device_changed", (event) => {
    deviceGeneration++
    currentDevice = event.device ?? null
    liveAvailability.refresh()
  })
  liveAvailability.start()
  try {
    const device = await BluetoothSdk.getDefaultDevice()
    if (deviceGeneration !== generation) return
    currentDevice = device
    liveAvailability.refresh()
  } catch (error) {
    console.warn("OTA: could not resolve background update target", error)
  }
}

export function stopLiveAvailability(): void {
  deviceGeneration++
  identitySubscription?.remove()
  identitySubscription = null
  currentDevice = null
  liveAvailability.stop()
}
