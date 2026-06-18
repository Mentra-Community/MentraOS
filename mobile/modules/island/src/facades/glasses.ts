/**
 * glasses facade — the core `toolkit.glasses.*` surface: connection actions (over
 * the bluetooth-sdk passthrough), a curated status/info read-model (projected from
 * the island-owned glasses store), capabilities (from the model table), and the
 * discrete input events. The `wifi` sub-facade is nested here.
 *
 * Read-models project the raw glasses store into the stable shape OEM UIs consume,
 * so the device store's field layout doesn't leak into every screen.
 */
// Internal btsdk surface — connectSimulated/reconnect/controller live on the full
// surface, not the public entry. Relative path (the alias doesn't resolve in island's
// standalone build); jest moduleNameMapper + tsconfig both resolve it.
import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
import type {ButtonPressEvent, TouchEvent} from "../../../bluetooth-sdk/build/_internal"
import {useGlassesStore} from "../stores/glasses"
import {useSettingsStore, SETTINGS} from "../stores/settings"
import {isGlassesConnected, isGlassesReady} from "../services/GlassesReadiness"
import {pushAllBluetoothSettings} from "../services/GlassesSettingsSync"
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
  /**
   * Reconnect the default wearable. Seeds the phone's current device settings to
   * native first, so they're primed before the connect handshake replays them to
   * the glasses (this used to be a host-side step before `connectDefault`).
   */
  connectDefault: (): Promise<void> => {
    pushAllBluetoothSettings()
    return BluetoothSdk.connectDefault()
  },
  disconnect: (): Promise<void> => BluetoothSdk.disconnect(),
  forget: (): Promise<void> => BluetoothSdk.forget(),
  /** Connect to a specific (discovered) device. */
  connect: (...args: Parameters<typeof BluetoothSdk.connect>) => BluetoothSdk.connect(...args),
  /** Connect the built-in simulated glasses (dev/testing). */
  connectSimulated: (): Promise<void> => BluetoothSdk.connectSimulated(),
  /** Set a device as the `connectDefault()` target. */
  setDefault: (...args: Parameters<typeof BluetoothSdk.setDefaultDevice>) => BluetoothSdk.setDefaultDevice(...args),
  /**
   * Reconnect to the saved default glasses. Resolves `false` when there's nothing to
   * reconnect to (no default paired), `true` when already connected or after kicking
   * off the connect. The host gates connectivity/permissions (its UI) before calling.
   */
  reconnect: async (): Promise<boolean> => {
    const defaultWearable = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
    if (!defaultWearable) return false
    if (isGlassesConnected(useGlassesStore.getState().connection)) return true
    pushAllBluetoothSettings()
    await BluetoothSdk.connectDefault()
    return true
  },
  /** True when no glasses has ever been paired (no saved default wearable) — e.g. to
   * route a first-run host into the pairing/onboarding flow. */
  isFirstPairing: (): boolean => !useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key),

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

  // --- ring controller (optional input device) ---
  controller: {
    connectDefault: (): Promise<void> => BluetoothSdk.connectDefaultController(),
    disconnect: (): Promise<void> => BluetoothSdk.disconnectController(),
    forget: (): Promise<void> => BluetoothSdk.forgetController(),
  },

  // --- audio (glasses media-volume + own-app playback hint) ---
  audio: {
    /** Read the glasses' current media volume. */
    getMediaVolume: () => BluetoothSdk.getGlassesMediaVolume(),
    /** Set the glasses' media volume. */
    setMediaVolume: (level: number) => BluetoothSdk.setGlassesMediaVolume(level),
    /** Tell native whether THIS app is currently playing audio (for ducking). */
    setOwnAppPlaying: (playing: boolean): Promise<void> => BluetoothSdk.setOwnAppAudioPlaying(playing),
  },

  // --- sub-facades ---
  wifi: glassesWifi,
  settings: glassesSettings,
}
