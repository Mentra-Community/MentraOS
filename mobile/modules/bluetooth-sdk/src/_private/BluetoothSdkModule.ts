import {NativeModule, requireNativeModule} from "expo"

import {
  BluetoothSettingsUpdate,
  BluetoothSdkModuleEvents,
  BluetoothStatus,
  PhotoCaptureDefaults,
  CalendarEvent,
  CAMERA_FOV_DEFAULT,
  CAMERA_FOV_MAX,
  CAMERA_FOV_MIN,
  CameraFovPreset,
  CameraFovRequest,
  CameraFovResult,
  CameraFovSetting,
  CameraRoiPosition,
  ConnectOptions,
  DashboardMenuItem,
  Device,
  DeviceModel,
  GlassesMediaVolumeGetResult,
  GlassesMediaVolumeSetResult,
  GlassesStatus,
  GalleryStatusEvent,
  HotspotStatusChangeEvent,
  MicPreference,
  ObservableStoreCategory,
  OtaQueryResult,
  OtaStartAckEvent,
  PhotoRequestParams,
  PhotoSuccessResponseEvent,
  PublicBluetoothStatus,
  RgbLedAction,
  RgbLedColor,
  RgbLedControlSuccessResponseEvent,
  ScanModelOptions,
  ScanOptions,
  SettingsAckSuccessEvent,
  StreamKeepAliveRequest,
  StreamStartRequest,
  StreamStatusEvent,
  VideoRecordingStartedStatusEvent,
  VideoRecordingSettings,
  VideoRecordingStoppedStatusEvent,
  VersionInfoResult,
  WifiSearchResult,
  WifiStatusChangeEvent,
} from "../BluetoothSdk.types"
import {photoRequestParamsForNative} from "./photoRequestPayload"

/**
 * Private React Native native-module facade.
 *
 * This file intentionally lives under `_private` so the package root can expose
 * a small SDK surface while MentraOS uses its monorepo-only internal alias
 * during migration. Raw status getters/listeners stay here so React hooks can
 * shape native store snapshots before app code sees them.
 */

type GlassesListener = (changed: Partial<GlassesStatus>) => void
type BluetoothStatusListener = (changed: Partial<PublicBluetoothStatus>) => void
type MaybePromise<T> = T | Promise<T>

declare class BluetoothSdkNativeModule extends NativeModule<BluetoothSdkModuleEvents> {
  // Observable Store Functions (native)
  getGlassesStatus(): Promise<GlassesStatus>
  getBluetoothStatus(): Promise<PublicBluetoothStatus>
  getDefaultDevice(): Promise<Device | null>
  update(category: ObservableStoreCategory, values: object): Promise<void>

  // Display Commands
  displayEvent(params: Record<string, unknown>): Promise<void>
  displayText(text: string, x?: number, y?: number, size?: number): Promise<void>
  clearDisplay(): Promise<void>

  // Connection Commands
  requestStatus(): Promise<void>
  connectDefault(options?: ConnectOptions): Promise<void>
  connectDefaultWithOptions(options: Required<ConnectOptions>): Promise<void>
  setDefaultDevice(device: Device | null): Promise<void>
  clearDefaultDevice(): Promise<void>
  startScan(model: DeviceModel): Promise<void>
  stopScan(): Promise<void>
  scan(options: ScanOptions): Promise<Device[]>
  scan(model: DeviceModel, options?: ScanModelOptions): Promise<Device[]>
  connect(device: Device, options?: ConnectOptions): Promise<void>
  connectWithOptions(device: Device, options: Required<ConnectOptions>): Promise<void>
  cancelConnectionAttempt(): Promise<void>
  connectDefaultController(): Promise<void>
  disconnectController(): Promise<void>
  connectSimulated(): Promise<void>
  disconnect(): Promise<void>
  forget(): Promise<void>
  forgetController(): Promise<void>
  showDashboard(): Promise<void>
  setBrightness(level: number, autoMode?: boolean | null): Promise<void>
  setAutoBrightness(enabled: boolean): Promise<void>
  setDashboardPosition(height: number, depth: number): Promise<void>
  setDashboardMenu(items: DashboardMenuItem[]): Promise<void>
  setCalendarEvents(events: CalendarEvent[]): Promise<void>
  setHeadUpAngle(angleDegrees: number): Promise<void>
  setImuEnabled(enabled: boolean): Promise<void>
  setScreenDisabled(disabled: boolean): Promise<void>
  ping(): Promise<void>
  dbg1(): Promise<void>
  dbg2(): Promise<void>

  // Incident Reporting
  sendIncidentId(incidentId: string, apiBaseUrl?: string | null): Promise<void>

  // WiFi Commands
  requestWifiScan(): Promise<WifiSearchResult[]>
  sendWifiCredentials(ssid: string, password: string): Promise<WifiStatusChangeEvent>
  forgetWifiNetwork(ssid: string): Promise<WifiStatusChangeEvent>
  setHotspotState(enabled: boolean): Promise<HotspotStatusChangeEvent>
  /** Set glasses system clock (Mentra Live only) when phone detects clock skew. */
  setSystemTime(timestampMs: number): Promise<void>
  /** Logs current WiFi frequency (MHz) and 5 GHz band to Android logcat. */
  logCurrentWifiFrequency(): Promise<void>

  // Gallery Commands
  setGalleryModeEnabled(enabled: boolean): Promise<SettingsAckSuccessEvent>
  setVoiceActivityDetectionEnabled(enabled: boolean): Promise<void>
  setPhotoCaptureDefaults(settings: PhotoCaptureDefaults): Promise<SettingsAckSuccessEvent>
  setVideoRecordingDefaults(width: number, height: number, fps: number): Promise<SettingsAckSuccessEvent>
  setMaxVideoRecordingDuration(minutes: number): Promise<SettingsAckSuccessEvent>
  setCameraFov(request: CameraFovRequest): Promise<CameraFovResult>
  queryGalleryStatus(): Promise<GalleryStatusEvent>
  requestPhoto(params: PhotoRequestParams): Promise<PhotoSuccessResponseEvent>

  // OTA Commands
  setOtaVersionUrl(otaVersionUrl: string): void
  getOtaVersionUrl(): string
  checkForOtaUpdate(): Promise<boolean>
  startOtaUpdate(otaVersionUrl?: string | null): Promise<OtaStartAckEvent>
  sendOtaQueryStatus(): Promise<OtaQueryResult>
  /** Re-run glasses-side OTA version check (called after a clock fix invalidates a TLS failure). */
  retryOtaVersionCheck(): Promise<OtaQueryResult>

  // Version Info Commands
  requestVersionInfo(): Promise<VersionInfoResult>

  // Video Recording Commands
  startVideoRecording(
    requestId: string,
    save: boolean,
    sound: boolean,
    settings?: VideoRecordingSettings,
  ): Promise<VideoRecordingStartedStatusEvent>
  stopVideoRecording(
    requestId: string,
    webhookUrl?: string,
    authToken?: string,
  ): Promise<VideoRecordingStoppedStatusEvent>

  // Stream Commands
  startStream(params: StreamStartRequest): Promise<StreamStatusEvent>
  startExternallyManagedStream(params: StreamStartRequest): Promise<StreamStatusEvent>
  stopStream(): Promise<StreamStatusEvent>
  sendExternallyManagedStreamKeepAlive(params: StreamKeepAliveRequest): Promise<void>

  // Microphone Commands
  setMicState(enabled: boolean, useGlassesMic?: boolean, sendTranscript?: boolean, sendLc3Data?: boolean): Promise<void>
  setPreferredMic(preferredMic: MicPreference): Promise<void>
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
    onDurationMs: number,
    offDurationMs: number,
    count: number,
  ): Promise<RgbLedControlSuccessResponseEvent>

  // STT Commands
  setSttModelDetails(path: string, languageCode: string): Promise<void>
  getSttModelPath(): Promise<string>
  checkSttModelAvailable(): Promise<boolean>
  validateSttModel(path: string): Promise<boolean>
  extractTarBz2(sourcePath: string, destinationPath: string): Promise<boolean>

  // TTS Commands
  setTtsModelDetails(path: string, languageCode: string): Promise<void>
  getTtsModelPath(): Promise<string>
  getTtsModelLanguage(): Promise<string>
  checkTtsModelAvailable(): Promise<boolean>
  validateTtsModel(path: string): Promise<boolean>
  generateTtsAudio(
    text: string,
    modelPath: string,
    outputPath: string,
    speakerId: number,
    speed: number,
  ): Promise<boolean>

  // Helper methods for type-safe observable store access
  updateGlasses(values: Partial<GlassesStatus>): Promise<void>
  updateBluetoothSettings(values: BluetoothSettingsUpdate): Promise<void>
  onGlassesStatus(callback: GlassesListener): () => void
  onBluetoothStatus(callback: BluetoothStatusListener): () => void

  // Process resident-set-size in MB. iOS-only; Android stub returns 0.
  getMemoryMB(): number
}

export type BluetoothSdkInternalModule = BluetoothSdkNativeModule

// This call loads the native module object from the JSI.
// NativeModule<BluetoothSdkModuleEvents> already extends EventEmitter<BluetoothSdkModuleEvents>
const NativeBluetoothSdkModule = requireNativeModule<BluetoothSdkNativeModule>("BluetoothSdk")

const DEFAULT_CONNECT_OPTIONS: Required<ConnectOptions> = {
  saveAsDefault: true,
  cancelExistingConnectionAttempt: true,
}

const DEFAULT_SCAN_TIMEOUT_MS = 15_000

function bindNativeMethod<T extends (...args: never[]) => unknown>(
  module: Record<string, unknown>,
  name: string,
): T {
  const method = module[name]
  if (typeof method !== "function") {
    console.warn(`[BluetoothSdk] Native method "${name}" is unavailable — rebuild the app (bun android / bun ios)`)
    return (async () => {
      throw new Error(`BluetoothSdk.${name} is not available in this native build. Rebuild the app.`)
    }) as T
  }
  return method.bind(module) as T
}

const CAMERA_ROI_MIN = 0
const CAMERA_ROI_MAX = 2
const CAMERA_ROI_POSITION_VALUES: Record<CameraRoiPosition, CameraFovSetting["roiPosition"]> = {
  center: 0,
  bottom: 1,
  top: 2,
}

// Named presets are a convenience layer over the numeric {fov, roiPosition} API.
// "narrow" uses 82, a device-tested FOV; "standard" matches CAMERA_FOV_DEFAULT.
const CAMERA_FOV_PRESETS: Record<CameraFovPreset, CameraFovSetting> = {
  narrow: {fov: 82, roiPosition: 0},
  standard: {fov: CAMERA_FOV_DEFAULT, roiPosition: 0},
  wide: {fov: CAMERA_FOV_MAX, roiPosition: 0},
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)))
}

function normalizeCameraFov(request: CameraFovRequest): CameraFovSetting {
  if ("preset" in request) {
    return CAMERA_FOV_PRESETS[request.preset] ?? CAMERA_FOV_PRESETS.standard
  }

  const roiPosition = request.roiPosition ?? "center"

  return {
    fov: clampInteger(
      Number.isFinite(request.fov) ? request.fov : CAMERA_FOV_DEFAULT,
      CAMERA_FOV_MIN,
      CAMERA_FOV_MAX,
    ),
    roiPosition: clampInteger(CAMERA_ROI_POSITION_VALUES[roiPosition] ?? 0, CAMERA_ROI_MIN, CAMERA_ROI_MAX) as
      | 0
      | 1
      | 2,
  }
}

function searchResultsForModel(status: Partial<PublicBluetoothStatus>, model: DeviceModel): Device[] {
  return status.searchResults?.filter((device) => device.model === model) ?? []
}

function normalizeScanArgs(modelOrOptions: DeviceModel | ScanOptions, options?: ScanModelOptions): ScanOptions {
  if (typeof modelOrOptions === "string") {
    return {model: modelOrOptions, ...options}
  }
  return modelOrOptions
}

function normalizeTimeoutMs(timeoutMs: number | undefined, defaultTimeoutMs: number): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs
}

function dashboardMenuItemToNative(item: DashboardMenuItem): Record<string, unknown> {
  return {
    ...(item.values ?? {}),
    title: item.title,
    packageName: item.packageName,
  }
}

function adaptConnectionStatusToNative(connection: GlassesStatus["connection"]): Record<string, unknown> {
  switch (connection.state) {
    case "connected":
      return {connectionState: "CONNECTED", connected: true, fullyBooted: connection.fullyBooted}
    case "scanning":
      return {connectionState: "SCANNING", connected: false, fullyBooted: false}
    case "connecting":
      return {connectionState: "CONNECTING", connected: false, fullyBooted: false}
    case "bonding":
      return {connectionState: "BONDING", connected: false, fullyBooted: false}
    case "disconnected":
      return {connectionState: "DISCONNECTED", connected: false, fullyBooted: false}
  }
}

function adaptGlassesUpdateToNative(values: Partial<GlassesStatus>): Record<string, unknown> {
  const {wifi, hotspot, connection, ...rest} = values
  let update: Record<string, unknown> = {...rest}
  if (connection) {
    update = {
      ...update,
      ...adaptConnectionStatusToNative(connection),
    }
  }
  if (wifi?.state === "connected") {
    update = {
      ...update,
      wifiConnected: true,
      wifiSsid: wifi.ssid,
      wifiLocalIp: wifi.localIp ?? "",
    }
  } else if (wifi?.state === "disconnected") {
    update = {
      ...update,
      wifiConnected: false,
      wifiSsid: "",
      wifiLocalIp: "",
    }
  }
  if (hotspot?.state === "enabled") {
    update = {
      ...update,
      hotspotEnabled: true,
      hotspotSsid: hotspot.ssid,
      hotspotPassword: hotspot.password,
      hotspotGatewayIp: hotspot.localIp,
    }
  } else if (hotspot?.state === "disabled") {
    update = {
      ...update,
      hotspotEnabled: false,
      hotspotSsid: "",
      hotspotPassword: "",
      hotspotGatewayIp: "",
    }
  }
  return update
}

// Add helper methods to the module
const nativeGetGlassesStatus = NativeBluetoothSdkModule.getGlassesStatus.bind(
  NativeBluetoothSdkModule,
) as () => MaybePromise<GlassesStatus>
NativeBluetoothSdkModule.getGlassesStatus = function () {
  return Promise.resolve(nativeGetGlassesStatus())
}

const nativeGetBluetoothStatus = NativeBluetoothSdkModule.getBluetoothStatus.bind(
  NativeBluetoothSdkModule,
) as () => MaybePromise<BluetoothStatus>
NativeBluetoothSdkModule.getBluetoothStatus = function () {
  return Promise.resolve(nativeGetBluetoothStatus())
}

const nativeGetDefaultDevice = NativeBluetoothSdkModule.getDefaultDevice.bind(
  NativeBluetoothSdkModule,
) as () => MaybePromise<Device | null>
NativeBluetoothSdkModule.getDefaultDevice = function () {
  return Promise.resolve(nativeGetDefaultDevice())
}

const nativeSetMicState = NativeBluetoothSdkModule.setMicState.bind(NativeBluetoothSdkModule) as (
  enabled: boolean,
  useGlassesMic: boolean,
  sendTranscript: boolean,
  sendLc3Data: boolean,
) => MaybePromise<void>

const nativeDisplayText = NativeBluetoothSdkModule.displayText.bind(NativeBluetoothSdkModule) as (
  text: string,
  x: number,
  y: number,
  size: number,
) => MaybePromise<void>

NativeBluetoothSdkModule.updateGlasses = function (values: Partial<GlassesStatus>) {
  return this.update("glasses", adaptGlassesUpdateToNative(values))
}

NativeBluetoothSdkModule.updateBluetoothSettings = function (values: BluetoothSettingsUpdate) {
  return this.update("bluetooth", values)
}

NativeBluetoothSdkModule.displayText = function (text: string, x?: number, y?: number, size?: number) {
  return Promise.resolve(nativeDisplayText(text, x ?? 0, y ?? 0, size ?? 24))
}

NativeBluetoothSdkModule.setBrightness = function (level: number, autoMode?: boolean | null) {
  return this.updateBluetoothSettings({
    ...(autoMode == null ? {} : {auto_brightness: autoMode}),
    brightness: level,
  })
}

NativeBluetoothSdkModule.setAutoBrightness = function (enabled: boolean) {
  return this.updateBluetoothSettings({auto_brightness: enabled})
}

NativeBluetoothSdkModule.setDashboardPosition = function (height: number, depth: number) {
  return this.updateBluetoothSettings({
    dashboard_height: height,
    dashboard_depth: depth,
  })
}

NativeBluetoothSdkModule.setDashboardMenu = function (items: DashboardMenuItem[]) {
  return this.updateBluetoothSettings({menu_apps: items.map(dashboardMenuItemToNative)})
}

NativeBluetoothSdkModule.setCalendarEvents = function (events: CalendarEvent[]) {
  return this.updateBluetoothSettings({calendar_events: events})
}

NativeBluetoothSdkModule.setHeadUpAngle = function (angleDegrees: number) {
  return this.updateBluetoothSettings({head_up_angle: angleDegrees})
}

NativeBluetoothSdkModule.setImuEnabled = function (enabled: boolean) {
  return this.updateBluetoothSettings({imu_enabled: enabled})
}

NativeBluetoothSdkModule.setScreenDisabled = function (disabled: boolean) {
  return this.updateBluetoothSettings({screen_disabled: disabled})
}

NativeBluetoothSdkModule.setVoiceActivityDetectionEnabled = function (enabled: boolean) {
  return this.updateBluetoothSettings({voice_activity_detection_enabled: enabled})
}

const nativeSetCameraFov = bindNativeMethod<
  (fov: CameraFovSetting) => MaybePromise<CameraFovResult>
>(NativeBluetoothSdkModule as unknown as Record<string, unknown>, "setCameraFov")
NativeBluetoothSdkModule.setCameraFov = function (request: CameraFovRequest) {
  const setting = normalizeCameraFov(request)
  return Promise.resolve(nativeSetCameraFov(setting))
}

NativeBluetoothSdkModule.setMicState = function (
  enabled: boolean,
  useGlassesMic?: boolean,
  sendTranscript?: boolean,
  sendLc3Data?: boolean,
) {
  return Promise.resolve(
    nativeSetMicState(enabled, useGlassesMic ?? true, sendTranscript ?? false, sendLc3Data ?? false),
  )
}

NativeBluetoothSdkModule.setPreferredMic = function (preferredMic: MicPreference) {
  return this.updateBluetoothSettings({preferred_mic: preferredMic})
}

NativeBluetoothSdkModule.onGlassesStatus = function (callback: GlassesListener) {
  const subscription = this.addListener("glasses_status", callback)
  return () => subscription.remove()
}

NativeBluetoothSdkModule.onBluetoothStatus = function (callback: BluetoothStatusListener) {
  const subscription = this.addListener("bluetooth_status", callback)
  return () => subscription.remove()
}

const nativeConnectDefault = NativeBluetoothSdkModule.connectDefault.bind(NativeBluetoothSdkModule)
NativeBluetoothSdkModule.connectDefault = function (options?: ConnectOptions) {
  if (!options) {
    return nativeConnectDefault()
  }
  return this.connectDefaultWithOptions({...DEFAULT_CONNECT_OPTIONS, ...options})
}

NativeBluetoothSdkModule.connect = function (device: Device, options?: ConnectOptions) {
  return this.connectWithOptions(device, {...DEFAULT_CONNECT_OPTIONS, ...options})
}

NativeBluetoothSdkModule.scan = async function (modelOrOptions: DeviceModel | ScanOptions, options?: ScanModelOptions) {
  const scanOptions = normalizeScanArgs(modelOrOptions, options)
  const timeoutMs = normalizeTimeoutMs(scanOptions.timeoutMs ?? scanOptions.timeout, DEFAULT_SCAN_TIMEOUT_MS)
  let latestResults: Device[] = []

  return new Promise<Device[]>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    let removeBluetoothListener = () => {}
    let settled = false
    let scanStarted = false

    const emitResults = (devices: Device[]) => {
      latestResults = devices
      scanOptions.onResults?.([...devices])
    }

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout)
      }
      removeBluetoothListener()
      if (scanStarted) {
        void Promise.resolve(this.stopScan()).catch(() => undefined)
      }
    }

    const settle = (error?: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        reject(error)
      } else {
        resolve([...latestResults])
      }
    }

    const handleBluetoothStatus = (status: Partial<BluetoothStatus>) => {
      if (!Array.isArray(status.searchResults)) {
        return
      }
      emitResults(searchResultsForModel(status, scanOptions.model))
    }

    removeBluetoothListener = this.onBluetoothStatus(handleBluetoothStatus)
    emitResults([])

    timeout = setTimeout(() => settle(), timeoutMs)

    Promise.resolve(this.startScan(scanOptions.model))
      .then(() => {
        scanStarted = true
        return this.getBluetoothStatus()
      })
      .then(handleBluetoothStatus)
      .catch((error) => settle(error instanceof Error ? error : new Error(String(error))))
  })
}

const nativeRequestPhoto = NativeBluetoothSdkModule.requestPhoto.bind(NativeBluetoothSdkModule)
NativeBluetoothSdkModule.requestPhoto = function (params: PhotoRequestParams) {
  return nativeRequestPhoto(photoRequestParamsForNative(params) as unknown as PhotoRequestParams)
}

const nativeStartStream = NativeBluetoothSdkModule.startStream.bind(NativeBluetoothSdkModule)
NativeBluetoothSdkModule.startExternallyManagedStream = function (params: StreamStartRequest) {
  return nativeStartStream({...params, keepAliveMode: "external"} as StreamStartRequest)
}

export default NativeBluetoothSdkModule
export const BluetoothSdk = NativeBluetoothSdkModule as BluetoothSdkInternalModule
