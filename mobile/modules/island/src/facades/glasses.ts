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
import type {GlassesState} from "../stores/glasses"
import {useSettingsStore, SETTINGS} from "../stores/settings"
import {isGlassesConnected, isGlassesReady} from "../services/GlassesReadiness"
import {pushAllBluetoothSettings} from "../services/GlassesSettingsSync"
import {getModelCapabilities, type DeviceTypes} from "../types"
import {glassesWifi} from "./glassesWifi"
import {glassesSettings} from "./glassesSettings"

type GlassesStoreSnapshot = GlassesState
type HotspotSnapshot = GlassesStoreSnapshot["hotspot"]

function projectStatusFrom(s: GlassesStoreSnapshot) {
  const connected = isGlassesConnected(s.connection)
  const ready = isGlassesReady(s.connection)
  return {
    connection: s.connection,
    state: s.connection.state,
    connected,
    ready,
    fullyBooted: ready,
    battery: s.batteryLevel,
    charging: s.charging,
    case: {battery: s.caseBatteryLevel, charging: s.caseCharging, open: s.caseOpen, removed: s.caseRemoved},
    signal: s.signalStrength,
    signalUpdatedAt: s.signalStrengthUpdatedAt,
    micEnabled: s.micEnabled,
    vadEnabled: s.voiceActivityDetectionEnabled,
    btClassic: s.bluetoothClassicConnected,
  }
}

function projectInfoFrom(s: GlassesStoreSnapshot) {
  return {
    model: s.deviceModel,
    deviceModel: s.deviceModel,
    style: s.style,
    color: s.color,
    firmwareVersion: s.firmwareVersion,
    mtkFirmware: s.mtkFirmwareVersion,
    mtkFirmwareVersion: s.mtkFirmwareVersion,
    besFirmware: s.besFirmwareVersion,
    besFirmwareVersion: s.besFirmwareVersion,
    serialNumber: s.serialNumber,
    buildNumber: s.buildNumber,
    androidVersion: s.androidVersion,
    appVersion: s.appVersion,
    bluetoothName: s.bluetoothName,
    btMac: s.bluetoothMacAddress,
    bluetoothMacAddress: s.bluetoothMacAddress,
    leftMacAddress: s.leftMacAddress,
    rightMacAddress: s.rightMacAddress,
    otaVersionUrl: s.otaVersionUrl,
  }
}

function projectControllerFrom(s: GlassesStoreSnapshot) {
  return {
    connected: s.controllerConnected,
    fullyBooted: s.controllerFullyBooted,
    macAddress: s.controllerMacAddress,
    battery: s.controllerBatteryLevel,
    signal: s.controllerSignalStrength,
  }
}

function projectDiagnosticsFrom(s: GlassesStoreSnapshot) {
  const {
    setGlassesInfo: _setGlassesInfo,
    setBatteryInfo: _setBatteryInfo,
    setWifiInfo: _setWifiInfo,
    setHotspotInfo: _setHotspotInfo,
    setOtaStatus: _setOtaStatus,
    setOtaUpdateAvailable: _setOtaUpdateAvailable,
    setOtaProgress: _setOtaProgress,
    setOtaInProgress: _setOtaInProgress,
    setMtkUpdatedThisSession: _setMtkUpdatedThisSession,
    clearOtaState: _clearOtaState,
    reset: _reset,
    ...snapshot
  } = s

  return {
    ...snapshot,
    hotspot:
      snapshot.hotspot.state === "enabled"
        ? {...snapshot.hotspot, password: snapshot.hotspot.password ? "[redacted]" : ""}
        : snapshot.hotspot,
  }
}

function projectStatus() {
  return projectStatusFrom(useGlassesStore.getState())
}

function projectInfo() {
  return projectInfoFrom(useGlassesStore.getState())
}

function projectController() {
  return projectControllerFrom(useGlassesStore.getState())
}

function projectDiagnostics() {
  return projectDiagnosticsFrom(useGlassesStore.getState())
}

export type GlassesStatusSnapshot = ReturnType<typeof projectStatus>
export type GlassesInfoSnapshot = ReturnType<typeof projectInfo>
export type GlassesControllerSnapshot = ReturnType<typeof projectController>
export type GlassesDiagnosticsSnapshot = ReturnType<typeof projectDiagnostics>

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
   * reconnect to (no default paired), `true` when already connected or after kicking
   * off the connect. The host gates connectivity/permissions (its UI) before calling.
   */
  reconnect: async (): Promise<boolean> => {
    const defaultWearable = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
    if (!defaultWearable) return false
    if (isGlassesConnected(useGlassesStore.getState().connection)) return true
    await pushAllBluetoothSettings()
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
  /**
   * Diagnostics snapshot for bug reports. This intentionally stays broader than
   * `info()`/`status()`, but excludes store mutators and redacts hotspot secrets.
   */
  diagnostics: (): GlassesDiagnosticsSnapshot => projectDiagnostics(),
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
    status: (): GlassesControllerSnapshot => projectController(),
    onStatus: (cb: (status: GlassesControllerSnapshot) => void): (() => void) => {
      let last = JSON.stringify(projectController())
      return useGlassesStore.subscribe(() => {
        const snap = projectController()
        const key = JSON.stringify(snap)
        if (key === last) return
        last = key
        cb(snap)
      })
    },
  },

  // --- hotspot (glasses-hosted network used by gallery/media sync) ---
  hotspot: {
    status: () => useGlassesStore.getState().hotspot,
    onStatus: (cb: (status: HotspotSnapshot) => void): (() => void) => {
      return useGlassesStore.subscribe((s) => s.hotspot, cb)
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
