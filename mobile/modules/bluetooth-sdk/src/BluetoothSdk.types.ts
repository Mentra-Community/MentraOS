// Core Event Types
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
  device_model?: string
  gesture_name?: string
  timestamp: number
}

export type HeadUpEvent = {
  up: boolean
}

export type VadStatusEvent = {
  type: "vad_status"
  status: boolean
}

export type BatteryStatusEvent = {
  type: "battery_status"
  level: number
  charging: boolean
  timestamp: number
}

/** K900 `sr_getvol` response (Mentra Live glasses media step volume 0–15). */
export type GlassesMediaVolumeGetResult = {
  vol: number
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

export type WifiStatus =
  | {state: "disconnected"}
  | {state: "connected"; ssid: string; localIp?: string}

export type ConnectedWifiStatus = Extract<WifiStatus, {state: "connected"}>

export function isConnectedWifiStatus(status: WifiStatus): status is ConnectedWifiStatus {
  return status.state === "connected"
}

export type WifiStatusChangeEvent = WifiStatus & {
  type: "wifi_status_change"
}

export type HotspotStatus =
  | {state: "disabled"}
  | {state: "enabled"; ssid: string; password: string; localIp: string}

export type EnabledHotspotStatus = Extract<HotspotStatus, {state: "enabled"}>

export function isEnabledHotspotStatus(status: HotspotStatus): status is EnabledHotspotStatus {
  return status.state === "enabled"
}

export type HotspotStatusChangeEvent = HotspotStatus & {
  type: "hotspot_status_change"
}

export type HotspotErrorEvent = {
  type: "hotspot_error"
  error_message: string
  timestamp: number
}

export type PhotoResponseEvent =
  | {
      type: "photo_response"
      state: "success"
      requestId: string
      photoUrl: string
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
  has_content: boolean
  camera_busy: boolean
}

export type CompatibleGlassesSearchStopEvent = {
  type: "compatible_glasses_search_stop"
  device_model: string
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
  switch_type?: number
  switchType?: number
  switch_value?: number
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
/** `"auto"` enables local button photo/video capture; `"manual"` reports button events without local gallery capture. */
export type GalleryMode = "auto" | "manual"
export type PhotoSize = "small" | "medium" | "large" | "full"
export type ButtonPhotoSize = "small" | "medium" | "large"
export type PhotoCompression = "none" | "medium" | "heavy"

export type StreamVideoConfig = {
  width?: number
  height?: number
  bitrate?: number
  frameRate?: number
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
  flash?: boolean
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
  device_name: string
}

export type AudioConnectedEvent = {
  type: "audio_connected"
  device_name: string
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
}

export type MicLc3Event = {
  type: "mic_lc3"
  lc3: ArrayBuffer
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

/** @deprecated Glasses no longer emit ota_progress; use {@link OtaStatusEvent} and legacy store mapping. */
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

// Union type of all core events
export type CoreEvent = Parameters<CoreModuleEvents[keyof CoreModuleEvents]>[0]

export type CoreModuleEvents = {
  glasses_status: (changed: Partial<GlassesStatus>) => void
  core_status: (changed: Partial<CoreStatus>) => void
  log: (event: LogEvent) => void
  device_discovered: (device: Device) => void
  default_device_changed: (event: {device?: Device}) => void
  // Individual event handlers
  glasses_not_ready: (event: GlassesNotReadyEvent) => void
  button_press: (event: ButtonPressEvent) => void
  touch_event: (event: TouchEvent) => void
  head_up: (event: HeadUpEvent) => void
  vad_status: (event: VadStatusEvent) => void
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

export type GlassesConnectionState = "disconnected" | "connected" | "connecting"

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
  fullyBooted: boolean
  connected: boolean
  micEnabled: boolean
  connectionState: string
  btcConnected: boolean
  signalStrength: number
  /** Milliseconds since epoch when signalStrength was last refreshed by the phone BLE stack. */
  signalStrengthUpdatedAt: number
  // device info
  deviceModel: string
  androidVersion: string
  fwVersion: string
  besFwVersion: string
  mtkFwVersion: string
  btMacAddress: string
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

interface DashboardMenuItem {
  name: string
  packageName: string
  running: boolean
}

export interface CoreSettings {
  menu_apps: DashboardMenuItem[]
}

export type MicRanking = "auto" | "phone" | "glasses" | "bluetooth"

export interface Device {
  id: string
  model: string
  name: string
  address?: string
  rssi?: number
}

export interface DeviceScanRequest {
  model: string
}

export interface ConnectOptions {
  saveAsDefault?: boolean
  cancelExistingConnectionAttempt?: boolean
}

export interface WifiSearchResult {
  ssid: string
  requiresPassword: boolean
  signalStrength: number
  /** Frequency in MHz (from glasses scan). 5 GHz band is typically 5170–5825. Omitted if unknown. */
  frequency?: number
}

export interface CoreStatus {
  // state:
  searching: boolean
  searchingController: boolean
  default_wearable?: string
  device_name?: string
  device_address?: string
  systemMicUnavailable: boolean
  micRanking: MicRanking[]
  currentMic: MicRanking | null
  searchResults: Device[]
  wifiScanResults: WifiSearchResult[]
  lastLog: string[]
  otherBtConnected: boolean
  // desired settings the SDK sends to compatible connected glasses:
  gallery_mode: boolean
}
