// Core Event Types
export type GlassesNotReadyEvent = {
  type: "glasses_not_ready"
  message: string
}

export type ButtonPressEvent = {
  type: "button_press"
  buttonId: string
  pressType: "long" | "short"
  timestamp: string
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

export type BatteryStatusEvent = {
  level: number
  charging: boolean
  timestamp: number
}

export type LocalTranscriptionEvent = {
  text: string
  isFinal?: boolean
  transcribeLanguage?: string
}

export type LogEvent = {
  message: string
}

export type WifiStatusChangeEvent = {
  type: "wifi_status_change"
  connected: boolean
  ssid: string
}

export type HotspotStatusChangeEvent = {
  type: "hotspot_status_change"
  enabled: boolean
  ssid: string
  password: string
  local_ip: string
}

export type HotspotErrorEvent = {
  type: "hotspot_error"
  error_message: string
  timestamp: string
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
    timestamp: string
  }
}

export type HeartbeatReceivedEvent = {
  type: "heartbeat_received"
  heartbeat_received: {
    timestamp: string
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

export type RgbLedControlResponseEvent = {
  type: "rgb_led_control_response"
  requestId: string
  success: boolean
  error?: string
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

export type PhoneNotificationEvent = {
  type: "phone_notification"
  notificationId: string
  app: string
  title: string
  content: string
  priority: number
  timestamp: string
  packageName: string
}

export type PhoneNotificationDismissedEvent = {
  type: "phone_notification_dismissed"
  notificationKey: string
  packageName: string
  notificationId: string
}

export type WsTextEvent = {
  type: "ws_text"
  text: string
}

export type WsBinEvent = {
  type: "ws_bin"
  base64: string
}

export type MicDataEvent = {
  type: "mic_data"
  base64: string
}

export type RtmpStreamStatusEvent = {
  type: "rtmp_stream_status"
  [key: string]: any
}

export type KeepAliveAckEvent = {
  type: "keep_alive_ack"
  [key: string]: any
}

export type MtkUpdateCompleteEvent = {
  type: "mtk_update_complete"
  message: string
  timestamp: string
}

export type OtaUpdateAvailableEvent = {
  type: "ota_update_available"
  version_code?: number
  version_name?: string
  updates?: string[]
  total_size?: number
}

export type OtaProgressEvent = {
  type: "ota_progress"
  stage?: OtaStage
  status?: OtaStatus
  progress?: number
  bytes_downloaded?: number
  total_bytes?: number
  current_update?: string
  error_message?: string
}

// Union type of all core events
export type CoreEvent =
  | ButtonPressEvent
  | TouchEvent
  | HeadUpEvent
  | LocalTranscriptionEvent
  | LogEvent
  | WifiStatusChangeEvent
  | HotspotStatusChangeEvent
  | HotspotErrorEvent
  | GalleryStatusEvent
  | CompatibleGlassesSearchStopEvent
  | HeartbeatSentEvent
  | HeartbeatReceivedEvent
  | SwipeVolumeStatusEvent
  | SwitchStatusEvent
  | RgbLedControlResponseEvent
  | PairFailureEvent
  | AudioPairingNeededEvent
  | AudioConnectedEvent
  | AudioDisconnectedEvent
  | SaveSettingEvent
  | PhoneNotificationEvent
  | PhoneNotificationDismissedEvent
  | WsTextEvent
  | WsBinEvent
  | MicDataEvent
  | RtmpStreamStatusEvent
  | KeepAliveAckEvent
  | MtkUpdateCompleteEvent
  | OtaUpdateAvailableEvent
  | OtaProgressEvent
  | GlassesNotReadyEvent

export type CoreModuleEvents = {
  glasses_status: (changed: Partial<GlassesStatus>) => void
  core_status: (changed: Partial<CoreStatus>) => void
  log: (event: LogEvent) => void
  // Individual event handlers
  glasses_not_ready: (event: GlassesNotReadyEvent) => void
  button_press: (event: ButtonPressEvent) => void
  touch_event: (event: TouchEvent) => void
  head_up: (event: HeadUpEvent) => void
  battery_status: (event: BatteryStatusEvent) => void
  local_transcription: (event: LocalTranscriptionEvent) => void
  wifi_status_change: (event: WifiStatusChangeEvent) => void
  hotspot_status_change: (event: HotspotStatusChangeEvent) => void
  hotspot_error: (event: HotspotErrorEvent) => void
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
  phone_notification: (event: PhoneNotificationEvent) => void
  phone_notification_dismissed: (event: PhoneNotificationDismissedEvent) => void
  ws_text: (event: WsTextEvent) => void
  ws_bin: (event: WsBinEvent) => void
  mic_data: (event: MicDataEvent) => void
  rtmp_stream_status: (event: RtmpStreamStatusEvent) => void
  keep_alive_ack: (event: KeepAliveAckEvent) => void
  mtk_update_complete: (event: MtkUpdateCompleteEvent) => void
  ota_update_available: (event: OtaUpdateAvailableEvent) => void
  ota_progress: (event: OtaProgressEvent) => void
}

export type GlassesConnectionState = "disconnected" | "connected" | "connecting"

// OTA update status types
export type OtaStage = "download" | "install"
export type OtaStatus = "STARTED" | "PROGRESS" | "FINISHED" | "FAILED"

export interface OtaUpdateInfo {
  available: boolean
  versionCode: number
  versionName: string
  updates: string[] // ["apk", "mtk", "bes"]
  totalSize: number
}

export interface OtaProgress {
  stage: OtaStage
  status: OtaStatus
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
  // device info
  deviceModel: string
  androidVersion: string
  fwVersion: string
  besFwVersion: string
  mtkFwVersion: string
  btMacAddress: string
  buildNumber: string
  otaVersionUrl: string
  appVersion: string
  bluetoothName: string
  serialNumber: string
  style: string
  color: string
  // wifi info
  wifiConnected: boolean
  wifiSsid: string
  wifiLocalIp: string
  // battery info
  batteryLevel: number
  charging: boolean
  caseBatteryLevel: number
  caseCharging: boolean
  caseOpen: boolean
  caseRemoved: boolean
  // hotspot info
  hotspotEnabled: boolean
  hotspotSsid: string
  hotspotPassword: string
  hotspotGatewayIp: string
  // OTA update info
  otaUpdateAvailable: OtaUpdateInfo | null
  otaProgress: OtaProgress | null
  otaInProgress: boolean
}

export type MicRanking = "auto" | "phone" | "glasses" | "bluetooth"

export interface DeviceSearchResult {
  deviceModel: string
  deviceName: string
  deviceAddress?: string
}

export interface WifiSearchResult {
  ssid: string
  requiresPassword: boolean
  signalStrength: number
}

export interface CoreStatus {
  // state:
  searching: boolean
  systemMicUnavailable: boolean
  micRanking: MicRanking[]
  currentMic: MicRanking | null
  searchResults: DeviceSearchResult[]
  wifiScanResults: WifiSearchResult[]
  lastLog: string[]
  otherBtConnected: boolean
}
