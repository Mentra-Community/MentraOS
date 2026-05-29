// Bluetooth SDK Event Types
export type GlassesNotReadyEvent = {
  type: "glasses_not_ready"
  message: string
}

export type ButtonPressEvent = {
  type: "button_press"
  buttonId: string
  pressType: "long" | "short"
  timestamp: number
}

export type TouchEvent = {
  type: "touch_event"
  deviceModel: DeviceModel
  gestureName: string
  timestamp: number
}

export type HeadUpEvent = {
  up: boolean
}

export type VoiceActivityDetectionStatusEvent = {
  type: "voice_activity_detection_status"
  voiceActivityDetectionEnabled: boolean
}

export type SpeakingStatusEvent = {
  type: "speaking_status"
  speaking: boolean
  timestamp: number
}

export type BatteryStatusEvent = {
  type: "battery_status"
  level: number
  charging: boolean
  timestamp: number
}

export type GlassesConnectionStatus =
  | {state: 'disconnected'}
  | {state: 'scanning'}
  | {state: 'connecting'}
  | {state: 'bonding'}
  | {state: 'connected'; fullyBooted: boolean}

export type ConnectedGlassesConnectionStatus = Extract<GlassesConnectionStatus, {state: 'connected'}>

export function isConnectedGlassesConnectionStatus(
  status: GlassesConnectionStatus,
): status is ConnectedGlassesConnectionStatus {
  return status.state === 'connected'
}

export function isReadyGlassesConnectionStatus(status: GlassesConnectionStatus): boolean {
  return status.state === 'connected' && status.fullyBooted
}

export function isBusyGlassesConnectionStatus(status: GlassesConnectionStatus): boolean {
  return status.state === 'scanning' || status.state === 'connecting' || status.state === 'bonding'
}

export function createDisconnectedGlassesStatus(): Partial<GlassesStatus> {
  return {
    connection: {state: 'disconnected'},
    hotspot: {state: 'disabled'},
    voiceActivityDetectionEnabled: true,
    wifi: {state: 'disconnected'},
  }
}

/** K900 `sr_getvol` response (Mentra Live glasses media step volume 0–15). */
export type GlassesMediaVolumeGetResult = {
  level: number
  statusCode: number
}

/** K900 `sr_vol` acknowledgment. */
export type GlassesMediaVolumeSetResult = {
  statusCode: number
}

export type LocalTranscriptionEvent = {
  text: string
  isFinal?: boolean
  transcribeLanguage?: string
}

export type LogEvent = {
  message: string
}

export type WifiStatus = {state: 'disconnected'} | {state: 'connected'; ssid: string; localIp?: string}

export type ConnectedWifiStatus = Extract<WifiStatus, {state: 'connected'}>

export function isConnectedWifiStatus(status: WifiStatus): status is ConnectedWifiStatus {
  return status.state === 'connected'
}

export type WifiStatusChangeEvent = WifiStatus & {
  type: "wifi_status_change"
}

export type HotspotStatus = {state: 'disabled'} | {state: 'enabled'; ssid: string; password: string; localIp: string}

export type EnabledHotspotStatus = Extract<HotspotStatus, {state: 'enabled'}>

export function isEnabledHotspotStatus(status: HotspotStatus): status is EnabledHotspotStatus {
  return status.state === 'enabled'
}

export type HotspotStatusChangeEvent = HotspotStatus & {
  type: "hotspot_status_change"
}

export type HotspotErrorEvent = {
  type: "hotspot_error"
  errorMessage: string
  timestamp: number
}

export type PhotoResponseEvent =
  | {
      type: "photo_response"
      state: "success"
      requestId: string
      uploadUrl: string
      timestamp: number
    }
  | {
      type: "photo_response"
      state: "error"
      requestId: string
      timestamp: number
      errorCode?: string
      errorMessage: string
    }

export type GalleryStatusEvent = {
  type: "gallery_status"
  photos: number
  videos: number
  total: number
  totalSize?: number
  hasContent: boolean
  cameraBusy: boolean
}

export type CompatibleGlassesSearchStopEvent = {
  type: "compatible_glasses_search_stop"
  deviceModel: DeviceModel
}

export type HeartbeatSentEvent = {
  type: "heartbeat_sent"
  heartbeat_sent: {
    timestamp: number
  }
}

export type HeartbeatReceivedEvent = {
  type: "heartbeat_received"
  heartbeat_received: {
    timestamp: number
  }
}

export type SwipeVolumeStatusEvent = {
  type: "swipe_volume_status"
  enabled: boolean
  timestamp: number
}

export type SwitchStatusEvent = {
  type: "switch_status"
  switchType?: number
  switchValue?: number
  timestamp: number
}

export type RgbLedControlResponseEvent =
  | {
      type: "rgb_led_control_response"
      state: "success"
      requestId: string
    }
  | {
      type: "rgb_led_control_response"
      state: "error"
      requestId: string
      errorCode: string
    }

export type RgbLedAction = "on" | "off"
export type RgbLedColor = "red" | "green" | "blue" | "orange" | "white"
export type PhotoSize = "small" | "medium" | "large" | "full"
export type ButtonPhotoSize = "small" | "medium" | "large"
export type PhotoCompression = "none" | "medium" | "heavy"
export const DeviceModels = {
  Simulated: "Simulated Glasses",
  G1: "Even Realities G1",
  G2: "Even Realities G2",
  MentraLive: "Mentra Live",
  MentraNex: "Mentra Display",
  Mach1: "Mentra Mach1",
  Z100: "Vuzix Z100",
  Frame: "Brilliant Frame",
  R1: "Even Realities R1",
} as const

export type DeviceModel = (typeof DeviceModels)[keyof typeof DeviceModels]
export type ObservableStoreCategory = "glasses" | "bluetooth" | "core"

export type DashboardMenuItem = {
  title: string
  packageName: string
  values?: Record<string, unknown>
}

export type CameraFov = "standard" | "wide"

export type CameraFovSetting = {
  fov: number
  roiPosition: number
}

type NativeCameraFovSetting = {
  fov: number
  roi_position: number
}

export type MicPreference = "auto" | "phone" | "glasses" | "bluetooth"
export type MicMode = "phone" | "glasses" | "bluetoothClassic" | "bluetooth"

export type PhotoRequestParams = {
  requestId: string
  appId: string
  size: PhotoSize
  webhookUrl: string | null
  authToken: string | null
  compress: PhotoCompression
  sound: boolean
  exposureTimeNs?: number | null
}

export type StreamVideoConfig = {
  width?: number
  height?: number
  bitrate?: number
  fps?: number
}

export type StreamAudioConfig = {
  bitrate?: number
  sampleRate?: number
  echoCancellation?: boolean
  noiseSuppression?: boolean
}

export type StreamStartRequest = {
  type?: "start_stream"
  streamUrl: string
  streamId?: string
  keepAlive?: boolean
  keepAliveIntervalSeconds?: number
  sound?: boolean
  video?: StreamVideoConfig
  audio?: StreamAudioConfig
}

export type StreamKeepAliveRequest = {
  type?: "keep_stream_alive"
  streamId: string
  ackId: string
}

export type PairFailureEvent = {
  type: "pair_failure"
  error: string
}

export type AudioPairingNeededEvent = {
  type: "audio_pairing_needed"
  deviceName: string
}

export type AudioConnectedEvent = {
  type: "audio_connected"
  deviceName: string
}

export type AudioDisconnectedEvent = {
  type: "audio_disconnected"
}

export type SaveSettingEvent = {
  type: "save_setting"
  key: string
  value: any
}

export type WsTextEvent = {
  type: "ws_text"
  text: string
}

export type WsBinEvent = {
  type: "ws_bin"
  base64: string
}

export type MicPcmEvent = {
  type: "mic_pcm"
  pcm: ArrayBuffer
  sampleRate: 16000
  bitsPerSample: 16
  channels: 1
  encoding: "pcm_s16le"
  voiceActivityDetectionEnabled: boolean
}

export type MicLc3Event = {
  type: "mic_lc3"
  lc3: ArrayBuffer
  sampleRate: 16000
  channels: 1
  encoding: "lc3"
  frameDurationMs: 10
  frameSizeBytes: number
  bitrate: number
  packetizedFromGlasses: boolean
  voiceActivityDetectionEnabled: boolean
}

export type StreamStatusLifecycleState = "initializing" | "streaming" | "stopping" | "stopped"
export type StreamStatusReconnectState = "reconnecting" | "reconnected" | "reconnect_failed"
export type StreamStatusState = StreamStatusLifecycleState | StreamStatusReconnectState | "error"

export type StreamStatusEvent =
  | {
      type: "stream_status"
      kind: "lifecycle"
      status: StreamStatusLifecycleState
      streamId?: string
      timestamp?: number
    }
  | {
      type: "stream_status"
      kind: "reconnect"
      status: "reconnecting"
      streamId?: string
      attempt: number
      maxAttempts: number
      reason: string
      timestamp?: number
    }
  | {
      type: "stream_status"
      kind: "reconnect"
      status: "reconnected"
      streamId?: string
      attempt: number
      timestamp?: number
    }
  | {
      type: "stream_status"
      kind: "reconnect"
      status: "reconnect_failed"
      streamId?: string
      maxAttempts: number
      timestamp?: number
    }
  | {
      type: "stream_status"
      kind: "error"
      status: "error"
      streamId?: string
      errorDetails: string
      timestamp?: number
    }
  | {
      type: "stream_status"
      kind: "snapshot"
      status: "streaming" | "reconnecting" | "stopped"
      streaming: boolean
      reconnecting: boolean
      streamId?: string
      attempt?: number
      timestamp?: number
    }

export type KeepAliveAckEvent = {
  type: "keep_alive_ack"
  streamId: string
  ackId: string
  timestamp?: number
}

export type MtkUpdateCompleteEvent = {
  type: "mtk_update_complete"
  message: string
  timestamp: number
}

export type OtaUpdateAvailableEvent = {
  type: "ota_update_available"
  version_code?: number
  version_name?: string
  updates?: string[]
  total_size?: number
  cache_ready?: boolean
}

/** @deprecated Glasses no longer emit ota_progress; use {@link OtaStatusEvent} and status-store mapping. */
export type OtaProgressEvent = {
  type: "ota_progress"
  stage?: OtaStage
  status?: OtaProgressStatus
  progress?: number
  bytes_downloaded?: number
  total_bytes?: number
  current_update?: string
  error_message?: string
}

export type OtaStartAckEvent = {
  type: "ota_start_ack"
  timestamp: number
}

export type OtaStatusEvent = {
  type: "ota_status"
  session_id: string
  total_steps: number
  current_step: number
  step_type: 'apk' | 'mtk' | 'bes'
  phase: 'download' | 'install'
  step_percent: number
  overall_percent: number
  status: 'in_progress' | 'step_complete' | 'complete' | 'failed' | 'idle'
  error_message?: string
}

/** Nex BLE protobuf trace (NexEventUtils); payload matches native Map keys. */
export type BleCommandTraceEvent = {
  command: string
  commandText: string
  timestamp: number
}

export type MiniappSelectedEvent = {
  type: "miniapp_selected"
  packageName: string
}

// Union type of all native/internal Bluetooth SDK events.
export type BluetoothSdkInternalEvent = Parameters<BluetoothSdkModuleEvents[keyof BluetoothSdkModuleEvents]>[0]

export type BluetoothSdkModuleEvents = {
  glasses_status: (changed: Partial<GlassesStatus>) => void
  bluetooth_status: (changed: Partial<BluetoothStatus>) => void
  log: (event: LogEvent) => void
  device_discovered: (device: Device) => void
  default_device_changed: (event: {device?: Device}) => void
  // Individual event handlers
  glasses_not_ready: (event: GlassesNotReadyEvent) => void
  button_press: (event: ButtonPressEvent) => void
  touch_event: (event: TouchEvent) => void
  head_up: (event: HeadUpEvent) => void
  voice_activity_detection_status: (event: VoiceActivityDetectionStatusEvent) => void
  speaking_status: (event: SpeakingStatusEvent) => void
  battery_status: (event: BatteryStatusEvent) => void
  local_transcription: (event: LocalTranscriptionEvent) => void
  wifi_status_change: (event: WifiStatusChangeEvent) => void
  hotspot_status_change: (event: HotspotStatusChangeEvent) => void
  hotspot_error: (event: HotspotErrorEvent) => void
  photo_response: (event: PhotoResponseEvent) => void
  gallery_status: (event: GalleryStatusEvent) => void
  compatible_glasses_search_stop: (event: CompatibleGlassesSearchStopEvent) => void
  heartbeat_sent: (event: HeartbeatSentEvent) => void
  heartbeat_received: (event: HeartbeatReceivedEvent) => void
  swipe_volume_status: (event: SwipeVolumeStatusEvent) => void
  switch_status: (event: SwitchStatusEvent) => void
  rgb_led_control_response: (event: RgbLedControlResponseEvent) => void
  pair_failure: (event: PairFailureEvent) => void
  audio_pairing_needed: (event: AudioPairingNeededEvent) => void
  audio_connected: (event: AudioConnectedEvent) => void
  audio_disconnected: (event: AudioDisconnectedEvent) => void
  save_setting: (event: SaveSettingEvent) => void
  ws_text: (event: WsTextEvent) => void
  ws_bin: (event: WsBinEvent) => void
  mic_pcm: (event: MicPcmEvent) => void
  mic_lc3: (event: MicLc3Event) => void
  stream_status: (event: StreamStatusEvent) => void
  keep_alive_ack: (event: KeepAliveAckEvent) => void
  mtk_update_complete: (event: MtkUpdateCompleteEvent) => void
  ota_update_available: (event: OtaUpdateAvailableEvent) => void
  ota_start_ack: (event: OtaStartAckEvent) => void
  ota_status: (event: OtaStatusEvent) => void
  send_command_to_ble: (event: BleCommandTraceEvent) => void
  receive_command_from_ble: (event: BleCommandTraceEvent) => void
  miniapp_selected: (event: MiniappSelectedEvent) => void
}

export type PublicGlassesStatus = Omit<
  GlassesStatus,
  "otaUpdateAvailable" | "otaProgress" | "otaInProgress" | "otaVersionUrl"
>

export type PublicBluetoothStatus = Pick<
  BluetoothStatus,
  | "searching"
  | "searchingController"
  | "systemMicUnavailable"
  | "micRanking"
  | "currentMic"
  | "searchResults"
  | "wifiScanResults"
  | "lastLog"
  | "otherBtConnected"
  | "galleryModeEnabled"
>

export type BluetoothSdkEventMap = {
  log: LogEvent
  device_discovered: Device
  default_device_changed: {device?: Device}
  glasses_not_ready: GlassesNotReadyEvent
  button_press: ButtonPressEvent
  touch_event: TouchEvent
  head_up: HeadUpEvent
  voice_activity_detection_status: VoiceActivityDetectionStatusEvent
  speaking_status: SpeakingStatusEvent
  battery_status: BatteryStatusEvent
  local_transcription: LocalTranscriptionEvent
  wifi_status_change: WifiStatusChangeEvent
  hotspot_status_change: HotspotStatusChangeEvent
  hotspot_error: HotspotErrorEvent
  photo_response: PhotoResponseEvent
  gallery_status: GalleryStatusEvent
  compatible_glasses_search_stop: CompatibleGlassesSearchStopEvent
  swipe_volume_status: SwipeVolumeStatusEvent
  switch_status: SwitchStatusEvent
  rgb_led_control_response: RgbLedControlResponseEvent
  pair_failure: PairFailureEvent
  audio_pairing_needed: AudioPairingNeededEvent
  audio_connected: AudioConnectedEvent
  audio_disconnected: AudioDisconnectedEvent
  mic_pcm: MicPcmEvent
  mic_lc3: MicLc3Event
  stream_status: StreamStatusEvent
  keep_alive_ack: KeepAliveAckEvent
}

export type BluetoothSdkEventName = keyof BluetoothSdkEventMap

export type BluetoothSdkEventListener<EventName extends BluetoothSdkEventName> = (
  event: BluetoothSdkEventMap[EventName],
) => void

export type BluetoothSdkSubscription = {
  remove(): void
}

export type BluetoothSdkEvent = BluetoothSdkEventMap[BluetoothSdkEventName]

export interface BluetoothSdkPublicModule {
  addListener<EventName extends BluetoothSdkEventName>(
    eventName: EventName,
    listener: BluetoothSdkEventListener<EventName>,
  ): BluetoothSdkSubscription

  getDefaultDevice(): Promise<Device | null>
  setDefaultDevice(device: Device | null): Promise<void>
  clearDefaultDevice(): Promise<void>

  startScan(model: DeviceModel): Promise<void>
  stopScan(): Promise<void>
  scan(options: ScanOptions): Promise<Device[]>
  scan(model: DeviceModel, options?: ScanModelOptions): Promise<Device[]>
  connect(device: Device, options?: ConnectOptions): Promise<void>
  connectDefault(options?: ConnectOptions): Promise<void>
  cancelConnectionAttempt(): Promise<void>
  disconnect(): Promise<void>
  forget(): Promise<void>

  displayText(text: string, x?: number, y?: number, size?: number): Promise<void>
  clearDisplay(): Promise<void>
  showDashboard(): Promise<void>
  setDashboardPosition(height: number, depth: number): Promise<void>
  setHeadUpAngle(angleDegrees: number): Promise<void>
  setScreenDisabled(disabled: boolean): Promise<void>

  requestWifiScan(): Promise<void>
  sendWifiCredentials(ssid: string, password: string): Promise<void>
  forgetWifiNetwork(ssid: string): Promise<void>
  setHotspotState(enabled: boolean): Promise<void>

  setGalleryModeEnabled(enabled: boolean): Promise<void>
  setVoiceActivityDetectionEnabled(enabled: boolean): Promise<void>
  setButtonPhotoSettings(size: ButtonPhotoSize): Promise<void>
  setButtonVideoRecordingSettings(width: number, height: number, fps: number): Promise<void>
  setButtonCameraLed(enabled: boolean): Promise<void>
  setButtonMaxRecordingTime(minutes: number): Promise<void>
  setCameraFov(fov: CameraFov): Promise<void>
  queryGalleryStatus(): Promise<void>
  requestPhoto(params: PhotoRequestParams): Promise<void>
  startVideoRecording(requestId: string, save: boolean, sound: boolean): Promise<void>
  stopVideoRecording(requestId: string): Promise<void>

  startStream(params: StreamStartRequest): Promise<void>
  stopStream(): Promise<void>
  keepStreamAlive(params: StreamKeepAliveRequest): Promise<void>

  setMicState(
    enabled: boolean,
    useGlassesMic?: boolean,
    sendTranscript?: boolean,
    sendLc3Data?: boolean,
  ): Promise<void>
  setPreferredMic(preferredMic: MicPreference): Promise<void>
  setOwnAppAudioPlaying(playing: boolean): Promise<void>
  getGlassesMediaVolume(): Promise<GlassesMediaVolumeGetResult>
  setGlassesMediaVolume(level: number): Promise<GlassesMediaVolumeSetResult>

  rgbLedControl(
    requestId: string,
    packageName: string | null,
    action: RgbLedAction,
    color: RgbLedColor | null,
    onDurationMs: number,
    offDurationMs: number,
    count: number,
  ): Promise<void>

  requestVersionInfo(): Promise<void>
}

// OTA update status types
export type OtaStage = "download" | "install"
export type OtaProgressStatus = "STARTED" | "PROGRESS" | "FINISHED" | "FAILED"

export interface OtaStatus {
  sessionId: string
  totalSteps: number
  currentStep: number
  stepType: 'apk' | 'mtk' | 'bes'
  phase: 'download' | 'install'
  stepPercent: number
  overallPercent: number
  status: 'in_progress' | 'step_complete' | 'complete' | 'failed' | 'idle'
  error?: string
}

export interface OtaUpdateInfo {
  available: boolean
  versionCode: number
  versionName: string
  updates: string[] // ["apk", "mtk", "bes"]
  totalSize: number
  cacheReady?: boolean
}

export interface OtaProgress {
  stage: OtaStage
  status: OtaProgressStatus
  progress: number
  bytesDownloaded: number
  totalBytes: number
  currentUpdate: string
  errorMessage?: string
}

export interface GlassesStatus {
  // state:
  connection: GlassesConnectionStatus
  micEnabled: boolean
  voiceActivityDetectionEnabled: boolean
  bluetoothClassicConnected: boolean
  signalStrength: number
  /** Milliseconds since epoch when signalStrength was last refreshed by the phone BLE stack. */
  signalStrengthUpdatedAt: number
  // device info
  deviceModel: string
  androidVersion: string
  firmwareVersion: string
  besFirmwareVersion: string
  mtkFirmwareVersion: string
  bluetoothMacAddress: string
  leftMacAddress: string
  rightMacAddress: string
  buildNumber: string
  otaVersionUrl: string
  appVersion: string
  bluetoothName: string
  serialNumber: string
  style: string
  color: string
  // wifi info
  wifi: WifiStatus
  // battery info
  batteryLevel: number
  charging: boolean
  caseBatteryLevel: number
  caseCharging: boolean
  caseOpen: boolean
  caseRemoved: boolean
  // hotspot info
  hotspot: HotspotStatus
  // OTA update info
  otaUpdateAvailable: OtaUpdateInfo | null
  otaProgress: OtaProgress | null
  otaInProgress: boolean
  // ring info
  controllerConnected: boolean
  controllerFullyBooted: boolean
  controllerMacAddress: string
  controllerBatteryLevel: number
  controllerSignalStrength: number
}

export interface CoreDashboardMenuItem {
  name: string
  packageName: string
  running: boolean
}

export interface CoreSettings {
  menu_apps: CoreDashboardMenuItem[]
}

export interface Device {
  /**
   * Stable app-facing key for this scan result, within the limits of the
   * platform identifier available to the SDK. Do not parse this value; use the
   * typed model, name, address, and rssi fields instead.
   */
  id: string
  model: DeviceModel
  name: string
  /** Platform address/identifier when available: Android Bluetooth address, iOS CoreBluetooth identifier. */
  address?: string
  /**
   * Optional scan signal strength. It may be undefined at first discovery and
   * appear in a later scan update when the platform reports RSSI metadata.
   */
  rssi?: number
}

export interface ConnectOptions {
  saveAsDefault?: boolean
  cancelExistingConnectionAttempt?: boolean
}

export type ScanResultsCallback = (devices: Device[]) => void

export interface ScanOptions {
  model: DeviceModel
  /** Defaults to 15000. */
  timeoutMs?: number
  /** Alias for `timeoutMs`, useful when mirroring native examples. */
  timeout?: number
  /** Called every time the discovered device list changes during the scan. */
  onResults?: ScanResultsCallback
}

export type ScanModelOptions = Omit<ScanOptions, "model">

export interface WifiSearchResult {
  ssid: string
  requiresPassword: boolean
  signalStrength: number
  /** Frequency in MHz (from glasses scan). 5 GHz band is typically 5170–5825. Omitted if unknown. */
  frequency?: number
}

export interface BluetoothStatus {
  // state:
  searching: boolean
  searchingController: boolean
  default_wearable?: DeviceModel | ""
  pending_wearable?: DeviceModel | ""
  device_name?: string
  device_address?: string
  default_controller?: DeviceModel | ""
  pending_controller?: DeviceModel | ""
  controller_device_name?: string
  controller_address?: string
  systemMicUnavailable: boolean
  micRanking: MicMode[]
  currentMic: MicMode | "" | null
  /**
   * Nearby glasses in stable discovery order.
   * Existing entries keep their array position as details refresh; new glasses append at the end,
   * and removals should not reorder remaining entries.
   */
  searchResults: Device[]
  wifiScanResults: WifiSearchResult[]
  lastLog: string[]
  otherBtConnected: boolean
  // desired settings the SDK sends to compatible connected glasses:
  galleryModeEnabled: boolean
}

export type BluetoothSettingsUpdate = Partial<{
  auth_email: string
  core_token: string
  sensing_enabled: boolean
  power_saving_mode: boolean
  lc3_frame_size: number
  preferred_mic: MicPreference
  screen_disabled: boolean
  contextual_dashboard: boolean
  head_up_angle: number
  brightness: number
  auto_brightness: boolean
  dashboard_height: number
  dashboard_depth: number
  menu_apps: DashboardMenuItem[] | CoreDashboardMenuItem[] | Array<Record<string, unknown>> | null
  gallery_mode: boolean
  voice_activity_detection_enabled: boolean
  button_photo_size: ButtonPhotoSize
  button_video_settings: {width: number; height: number; fps: number}
  button_video_width: number
  button_video_height: number
  button_video_fps: number
  button_camera_led: boolean
  button_max_recording_time: number
  camera_fov: NativeCameraFovSetting
  should_send_pcm: boolean
  should_send_lc3: boolean
  should_send_transcript: boolean
  offline_mode: boolean
  offline_captions_running: boolean
  local_stt_fallback_active: boolean
  pending_wearable: DeviceModel | ""
  default_wearable: DeviceModel | ""
  device_name: string
  device_address: string
  default_controller: DeviceModel | ""
  pending_controller: DeviceModel | ""
  controller_device_name: string
  controller_address: string
}>
