/**
 * glasses facade — the core `toolkit.glasses.*` surface: connection actions (over
 * the bluetooth-sdk passthrough), a curated status/info read-model (projected from
 * the island-owned glasses store), capabilities (from the model table), and the
 * discrete input events. The `wifi` sub-facade is nested here.
 *
 * Read-models project the raw glasses store into the stable shape OEM UIs consume,
 * so the device store's field layout doesn't leak into every screen.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk"
import type {ButtonPressEvent, TouchEvent} from "@mentra/bluetooth-sdk"
import {useGlassesStore} from "../stores/glasses"
import {isGlassesReady} from "../services/GlassesReadiness"
import {getModelCapabilities, type DeviceTypes} from "../types"
import {glassesWifi} from "./glassesWifi"
import {glassesSettings} from "./glassesSettings"

function projectStatus() {
  const s = useGlassesStore.getState()
  return {
    state: s.connection.state,
    fullyBooted: isGlassesReady(s.connection),
    battery: s.batteryLevel,
    charging: s.charging,
    case: {battery: s.caseBatteryLevel, charging: s.caseCharging, open: s.caseOpen, removed: s.caseRemoved},
    signal: s.signalStrength,
    micEnabled: s.micEnabled,
    vadEnabled: s.voiceActivityDetectionEnabled,
    btClassic: s.bluetoothClassicConnected,
  }
}

function projectInfo() {
  const s = useGlassesStore.getState()
  return {
    model: s.deviceModel,
    style: s.style,
    color: s.color,
    firmwareVersion: s.firmwareVersion,
    mtkFirmware: s.mtkFirmwareVersion,
    besFirmware: s.besFirmwareVersion,
    serialNumber: s.serialNumber,
    buildNumber: s.buildNumber,
    btMac: s.bluetoothMacAddress,
  }
}

export type GlassesStatusSnapshot = ReturnType<typeof projectStatus>
export type GlassesInfoSnapshot = ReturnType<typeof projectInfo>

export const glasses = {
  // --- connection (bluetooth-sdk passthrough) ---
  connectDefault: (): Promise<void> => BluetoothSdk.connectDefault(),
  disconnect: (): Promise<void> => BluetoothSdk.disconnect(),
  forget: (): Promise<void> => BluetoothSdk.forget(),

  // --- read-model (projected from the island-owned glasses store) ---
  status: (): GlassesStatusSnapshot => projectStatus(),
  onStatus: (cb: (status: GlassesStatusSnapshot) => void): (() => void) => {
    // Dedupe: the glasses store updates on many fields; only fire when the
    // projected status snapshot actually changes.
    let last = JSON.stringify(projectStatus())
    return useGlassesStore.subscribe(() => {
      const snap = projectStatus()
      const key = JSON.stringify(snap)
      if (key === last) return
      last = key
      cb(snap)
    })
  },
  info: (): GlassesInfoSnapshot => projectInfo(),
  capabilities: () => getModelCapabilities(useGlassesStore.getState().deviceModel as DeviceTypes),
  /** Ask the glasses to report fresh firmware/version info (updates the store). */
  requestVersionInfo: () => BluetoothSdk.requestVersionInfo(),

  // --- discrete input events (passthrough listeners) ---
  onButtonPress: (cb: (event: ButtonPressEvent) => void): (() => void) => {
    const sub = BluetoothSdk.addListener("button_press", cb)
    return () => sub.remove()
  },
  onTouchGesture: (cb: (event: TouchEvent) => void): (() => void) => {
    const sub = BluetoothSdk.addListener("touch_event", cb)
    return () => sub.remove()
  },

  // --- sub-facades ---
  wifi: glassesWifi,
  settings: glassesSettings,
}
