import {NativeModule, requireNativeModule} from "expo"

import {
  ConnectOptions,
  CoreModuleEvents,
  CoreStatus,
  DeviceScanRequest,
  GalleryMode,
  GlassesMediaVolumeGetResult,
  GlassesMediaVolumeSetResult,
  GlassesStatus,
  MentraDevice,
  PhotoCompression,
  PhotoSize,
  RgbLedAction,
  RgbLedColor,
  StreamKeepAliveRequest,
  StreamStartRequest,
  WifiStatus,
} from "./BluetoothSdk.types"

type GlassesListener = (changed: Partial<GlassesStatus>) => void
type CoreStatusListener = (changed: Partial<CoreStatus>) => void

declare class CoreModule extends NativeModule<CoreModuleEvents> {
  // Observable Store Functions (native)
  getGlassesStatus(): GlassesStatus
  getCoreStatus(): CoreStatus
  getDefaultDevice(): MentraDevice | null
  update(category: string, values: Record<string, any>): Promise<void>

  // Display Commands
  displayEvent(params: Record<string, any>): Promise<void>
  displayText(params: Record<string, any>): Promise<void>
  clearDisplay(): Promise<void>

  // Connection Commands
  requestStatus(): Promise<void>
  connectDefault(options?: ConnectOptions): Promise<void>
  connectDefaultWithOptions(options: Required<ConnectOptions>): Promise<void>
  setDefaultDevice(device: MentraDevice | null): Promise<void>
  clearDefaultDevice(): Promise<void>
  startScan(params: DeviceScanRequest): Promise<void>
  connect(device: MentraDevice, options?: ConnectOptions): Promise<void>
  connectWithOptions(device: MentraDevice, options: Required<ConnectOptions>): Promise<void>
  cancelConnectionAttempt(): Promise<void>
  connectDefaultController(): Promise<void>
  disconnectController(): Promise<void>
  connectSimulated(): Promise<void>
  disconnect(): Promise<void>
  forget(): Promise<void>
  forgetController(): Promise<void>
  showDashboard(): Promise<void>
  ping(): Promise<void>

  // Incident Reporting
  sendIncidentId(incidentId: string, apiBaseUrl?: string | null): Promise<void>

  // WiFi Commands
  requestWifiScan(): Promise<void>
  sendWifiCredentials(ssid: string, password: string): Promise<void>
  forgetWifiNetwork(ssid: string): Promise<void>
  setHotspotState(enabled: boolean): Promise<void>
  /** Logs current WiFi frequency (MHz) and 5 GHz band to Android logcat. */
  logCurrentWifiFrequency(): Promise<void>

  // Gallery Commands
  setGalleryMode(mode: GalleryMode): Promise<void>
  queryGalleryStatus(): Promise<void>
  photoRequest(
    requestId: string,
    appId: string,
    size: PhotoSize,
    webhookUrl: string | null,
    authToken: string | null,
    compress: PhotoCompression,
    flash: boolean,
    sound: boolean,
  ): Promise<void>

  // OTA Commands
  sendOtaStart(): Promise<void>
  sendOtaQueryStatus(): Promise<void>

  // Version Info Commands
  requestVersionInfo(): Promise<void>

  // Video Recording Commands
  startVideoRecording(requestId: string, save: boolean, flash: boolean, sound: boolean): Promise<void>
  stopVideoRecording(requestId: string): Promise<void>

  // Stream Commands
  startStream(params: StreamStartRequest): Promise<void>
  stopStream(): Promise<void>
  keepStreamAlive(params: StreamKeepAliveRequest): Promise<void>

  // Microphone Commands
  setMicState(sendPcmData: boolean, sendTranscript: boolean, bypassVad: boolean): Promise<void>
  restartTranscriber(): Promise<void>

  // Audio Playback Monitoring
  // Notify native side when our app starts/stops playing audio
  // Used to suspend LC3 mic during audio playback to avoid MCU overload
  setOwnAppAudioPlaying(playing: boolean): Promise<void>

  /** Mentra Live only: K900 `cs_getvol` / `sr_getvol`. */
  getGlassesMediaVolume(): Promise<GlassesMediaVolumeGetResult>
  /** Mentra Live only: K900 `cs_vol` / `sr_vol`; level clamped 0–15 on native. */
  setGlassesMediaVolume(level: number): Promise<GlassesMediaVolumeSetResult>

  // RGB LED Control
  rgbLedControl(
    requestId: string,
    packageName: string | null,
    action: RgbLedAction,
    color: RgbLedColor | null,
    ontime: number,
    offtime: number,
    count: number,
  ): Promise<void>

  // STT Commands
  setSttModelDetails(path: string, languageCode: string): Promise<void>
  getSttModelPath(): Promise<string>
  checkSttModelAvailable(): Promise<boolean>
  validateSttModel(path: string): Promise<boolean>
  extractTarBz2(sourcePath: string, destinationPath: string): Promise<boolean>

  // Helper methods for type-safe observable store access
  updateGlasses(values: Partial<GlassesStatus>): Promise<void>
  updateCore(values: Record<string, any>): Promise<void>
  onGlassesStatus(callback: GlassesListener): () => void
  onCoreStatus(callback: CoreStatusListener): () => void

  // Process resident-set-size in MB. iOS-only; Android stub returns 0.
  getMemoryMB(): number
}

// This call loads the native module object from the JSI.
// NativeModule<CoreModuleEvents> already extends EventEmitter<CoreModuleEvents>
const NativeCoreModule = requireNativeModule<CoreModule>("Core")

const DEFAULT_CONNECT_OPTIONS: Required<ConnectOptions> = {
  saveAsDefault: true,
  cancelExistingConnectionAttempt: true,
}

type NativeWifiFields = {
  wifi?: WifiStatus
  wifiConnected?: boolean
  wifiSsid?: string
  wifiLocalIp?: string
}

function wifiStatusFromNative(values: NativeWifiFields): WifiStatus {
  if (values.wifi) {
    return values.wifi
  }
  if (values.wifiConnected === true) {
    const ssid = values.wifiSsid?.trim()
    const localIp = values.wifiLocalIp?.trim()
    return ssid && localIp ? {state: "connected", ssid, localIp} : {state: "unknown"}
  }
  if (values.wifiConnected === false) {
    return {state: "disconnected"}
  }
  return {state: "unknown"}
}

function normalizeGlassesStatus<T extends NativeWifiFields>(values: T): Omit<T, keyof NativeWifiFields> & {wifi: WifiStatus} {
  const {wifi, wifiConnected, wifiSsid, wifiLocalIp, ...rest} = values
  return {
    ...rest,
    wifi: wifiStatusFromNative({wifi, wifiConnected, wifiSsid, wifiLocalIp}),
  }
}

function denormalizeGlassesUpdate(values: Partial<GlassesStatus>): Record<string, any> {
  const {wifi, ...rest} = values
  if (!wifi) {
    return rest
  }
  if (wifi.state === "connected") {
    return {
      ...rest,
      wifiConnected: true,
      wifiSsid: wifi.ssid,
      wifiLocalIp: wifi.localIp,
    }
  }
  if (wifi.state === "unknown") {
    return rest
  }
  return {
    ...rest,
    wifiConnected: false,
    wifiSsid: "",
    wifiLocalIp: "",
  }
}

// Add helper methods to the module
const nativeGetGlassesStatus = NativeCoreModule.getGlassesStatus.bind(NativeCoreModule)
NativeCoreModule.getGlassesStatus = function () {
  const result = nativeGetGlassesStatus() as unknown
  if (result && typeof (result as Promise<unknown>).then === "function") {
    return (result as Promise<NativeWifiFields & Record<string, any>>).then(normalizeGlassesStatus) as unknown as GlassesStatus
  }
  return normalizeGlassesStatus(result as NativeWifiFields & Record<string, any>) as GlassesStatus
}

NativeCoreModule.updateGlasses = function (values: Partial<GlassesStatus>) {
  return this.update("glasses", denormalizeGlassesUpdate(values))
}

NativeCoreModule.updateCore = function (values: Record<string, any>) {
  return this.update("core", values)
}

NativeCoreModule.onGlassesStatus = function (callback: GlassesListener) {
  const subscription = this.addListener("glasses_status", (changed) => {
    callback(normalizeGlassesStatus(changed as NativeWifiFields & Record<string, any>))
  })
  return () => subscription.remove()
}

NativeCoreModule.onCoreStatus = function (callback: CoreStatusListener) {
  const subscription = this.addListener("core_status", callback)
  return () => subscription.remove()
}

const nativeConnectDefault = NativeCoreModule.connectDefault.bind(NativeCoreModule)
NativeCoreModule.connectDefault = function (options?: ConnectOptions) {
  if (!options) {
    return nativeConnectDefault()
  }
  return this.connectDefaultWithOptions({...DEFAULT_CONNECT_OPTIONS, ...options})
}

NativeCoreModule.connect = function (device: MentraDevice, options?: ConnectOptions) {
  return this.connectWithOptions(device, {...DEFAULT_CONNECT_OPTIONS, ...options})
}

export default NativeCoreModule
