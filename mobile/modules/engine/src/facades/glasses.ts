/**
 * glasses facade — the core `engine.glasses.*` surface: connection actions (over
 * the bluetooth-sdk passthrough), a curated status/info read-model (projected from
 * the engine-owned glasses store), capabilities (from the model table), and the
 * discrete input events. The `wifi` sub-facade is nested here.
 *
 * Read-models project the raw glasses store into the stable shape OEM UIs consume,
 * so the device store's field layout doesn't leak into every screen.
 */
// Internal btsdk surface — connectSimulated/reconnect/controller live on the full
// surface, not the public entry. Relative path (the alias doesn't resolve in engine's
// standalone build); jest moduleNameMapper + tsconfig both resolve it.
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {ButtonPressEvent, TouchEvent} from "@mentra/bluetooth-sdk/internal"
import {useGlassesStore} from "../stores/glasses"
import {useSettingsStore, SETTINGS} from "../stores/settings"
import {hasDefaultDevice} from "../services/DeviceStoreHydration"
import {projectPairingIdentity} from "../services/PairingIdentity"
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

function projectControllerStatus() {
  const s = useGlassesStore.getState()
  return {
    connected: s.controllerConnected,
    fullyBooted: s.controllerFullyBooted,
    battery: s.controllerBatteryLevel,
    signal: s.controllerSignalStrength,
  }
}

function projectInfo() {
  const s = useGlassesStore.getState()
  return {
    model: s.deviceModel,
    style: s.style,
    color: s.color,
    bluetoothName: s.bluetoothName,
    firmwareVersion: s.firmwareVersion,
    mtkFirmware: s.mtkFirmwareVersion,
    besFirmware: s.besFirmwareVersion,
    appVersion: s.appVersion,
    androidVersion: s.androidVersion,
    serialNumber: s.serialNumber,
    buildNumber: s.buildNumber,
    btMac: s.bluetoothMacAddress,
    leftMac: s.leftMacAddress,
    rightMac: s.rightMacAddress,
    // Copy: the snapshot must not hand callers a mutable reference into the store.
    wifi: {...s.wifi},
  }
}

export type GlassesStatusSnapshot = ReturnType<typeof projectStatus>
export type ControllerStatusSnapshot = ReturnType<typeof projectControllerStatus>
export type GlassesInfoSnapshot = ReturnType<typeof projectInfo>

export const glasses = {
  // --- connection (bluetooth-sdk passthrough) ---
  /**
   * Reconnect the default wearable. Seeds the phone's current device settings to
   * native first, so they're primed before the connect handshake replays them to
   * the glasses (this used to be a host-side step before `connectDefault`).
   */
  connectDefault: async (): Promise<void> => {
    await pushAllBluetoothSettings()
    return BluetoothSdk.connectDefault()
  },
  disconnect: (): Promise<void> => BluetoothSdk.disconnect(),
  forget: (): Promise<void> => BluetoothSdk.forget(),
  /** Connect to a specific (discovered) device. */
  connect: async (...args: Parameters<typeof BluetoothSdk.connect>): Promise<void> => {
    await pushAllBluetoothSettings()
    return BluetoothSdk.connect(...args)
  },
  /** Connect the built-in simulated glasses (dev/testing). */
  connectSimulated: (): Promise<void> => BluetoothSdk.connectSimulated(),
  /** Set a device as the `connectDefault()` target. */
  setDefault: (...args: Parameters<typeof BluetoothSdk.setDefaultDevice>) => BluetoothSdk.setDefaultDevice(...args),
  /**
   * Reconnect to the saved default glasses. Resolves `false` when there's nothing to
   * reconnect to (no default paired) or the connect attempt fails (e.g. BLE powered
   * off), `true` when already connected or after kicking off the connect. Never
   * rejects — the boolean contract holds. The host gates connectivity/permissions
   * (its UI) before calling.
   */
  reconnect: async (): Promise<boolean> => {
    const defaultWearable = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
    if (!defaultWearable) return false
    if (isGlassesConnected(useGlassesStore.getState().connection)) return true
    try {
      await pushAllBluetoothSettings()
      await BluetoothSdk.connectDefault()
    } catch (error) {
      console.warn("engine.glasses.reconnect failed:", error)
      return false
    }
    return true
  },
  /** True when no glasses has ever been paired NOR selected (the pairing-identity
   * lifecycle is in its `none` state) — e.g. to route a first-run host into the
   * pairing/onboarding flow. A pending selection is not "first" — the host should
   * offer finish-pairing (see `engine.pairing.identity()`). */
  isFirstPairing: (): boolean => projectPairingIdentity().kind === "none",
  /**
   * True when the SDK has an actual default DEVICE to reconnect to. Distinct from
   * `default_wearable` (a model string that a pending or orphaned selection can
   * hold without any paired device): connectDefault() throws without a device, so
   * hosts should route to the pairing flow when this is false.
   *
   * Hydration-aware: awaits the device-store seed internally, so a cold-start
   * read can't see a false "absent" for genuinely-paired users. Rejects if
   * hydration failed — callers guarding destructive or routing decisions must
   * fail open (treat as "has a device").
   */
  hasDefaultDevice: (): Promise<boolean> => hasDefaultDevice(),

  // --- read-model (projected from the engine-owned glasses store) ---
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
  onInfo: (cb: (info: GlassesInfoSnapshot) => void): (() => void) => {
    let last = JSON.stringify(projectInfo())
    return useGlassesStore.subscribe(() => {
      const snap = projectInfo()
      const key = JSON.stringify(snap)
      if (key === last) return
      last = key
      cb(snap)
    })
  },
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
    status: (): ControllerStatusSnapshot => projectControllerStatus(),
    onStatus: (cb: (status: ControllerStatusSnapshot) => void): (() => void) => {
      let last = JSON.stringify(projectControllerStatus())
      return useGlassesStore.subscribe(() => {
        const snap = projectControllerStatus()
        const key = JSON.stringify(snap)
        if (key === last) return
        last = key
        cb(snap)
      })
    },
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
