// Bluetooth SDK Event Types
export type GlassesNotReadyEvent = {
  type: "glasses_not_ready"
  message: string
}

// NOTE: unlike most events below, the native module does NOT include a `type`
// field on the button_press payload 闂?it sends only {buttonId, pressType,
// timestamp} (see BluetoothSdkModule on both iOS and Android). Consumers must
// filter on `pressType` / the "button_press" listener name, never `event.type`.
export type ButtonPressEvent = {
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

export type AccelEvent = {
  type: "accel_event"
  x: number
  y: number
  z: number
  timestamp: number
}

export type HeadUpEvent = {
  up: boolean
}

export type VoiceActivityDetectionStatusEvent = {
  type: "voice_activity_detection_status"
  voiceActivityDetectionEnabled: boolean
}

export const DEFAULT_VOICE_ACTIVITY_DETECTION_ENABLED = false

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
  | {state: "disconnected"}
  | {state: "scanning"}
  | {state: "connecting"}
  | {state: "bonding"}
  | {state: "connected"; fullyBooted: boolean}

export type ConnectedGlassesConnectionStatus = Extract<GlassesConnectionStatus, {state: "connected"}>

export function isConnectedGlassesConnectionStatus(
  status: GlassesConnectionStatus,
): status is ConnectedGlassesConnectionStatus {
  return status.state === "connected"
}

export function isReadyGlassesConnectionStatus(status: GlassesConnectionStatus): boolean {
  return status.state === "connected" && status.fullyBooted
}

export function isBusyGlassesConnectionStatus(status: GlassesConnectionStatus): boolean {
  return status.state === "scanning" || status.state === "connecting" || status.state === "bonding"
}

export function createDisconnectedGlassesStatus(): Partial<GlassesStatus> {
  return {
    connection: {state: "disconnected"},
    hotspot: {state: "disabled"},
    voiceActivityDetectionEnabled: DEFAULT_VOICE_ACTIVITY_DETECTION_ENABLED,
    wifi: {state: "disconnected"},
  }
}

/** K900 `sr_getvol` response (Mentra Live glasses media step volume 0闂?5). */
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

export type WifiStatus = {state: "disconnected"} | {state: "connected"; ssid: string; localIp?: string}

export type ConnectedWifiStatus = Extract<WifiStatus, {state: "connected"}>

export function isConnectedWifiStatus(status: WifiStatus): status is ConnectedWifiStatus {
  return status.state === "connected"
}

export type WifiStatusChangeEvent = WifiStatus & {
  type: "wifi_status_change"
  /**
   * Glasses-reported provisioning failure reason when THIS event is the verdict of a
   * failed connect attempt; absent on routine link-state updates. An attempt property,
   * not a link property 闂?which is why it lives on the event, not on WifiStatus:
   * "connect_timeout" arrives on a disconnected status (never associated), while
   * "connected_to_other_network" arrives on a *connected* status (the attempt failed
   * and the glasses ended up on / fell back to a different SSID than requested).
   * Requires ASG client v40+ 闂?older glasses never send it.
   */
  error?: string
}

export type HotspotStatus = {state: "disabled"} | {state: "enabled"; ssid: string; password: string; localIp: string}

export type EnabledHotspotStatus = Extract<HotspotStatus, {state: "enabled"}>

export function isEnabledHotspotStatus(status: HotspotStatus): status is EnabledHotspotStatus {
  return status.state === "enabled"
}

export type HotspotStatusChangeEvent = HotspotStatus & {
  type: "hotspot_status_change"
}

export type HotspotErrorEvent = {
  type: "hotspot_error"
  errorMessage: string
  timestamp: number
}

export type VersionInfoResult = {
  androidVersion: string
  firmwareVersion: string
  besFirmwareVersion: string
  mtkFirmwareVersion: string
  buildNumber: string
  systemTimeMs?: number
  otaVersionUrl: string
  appVersion: string
}

export type VersionInfoEvent = VersionInfoResult & {
  type: "version_info"
}

export type WifiScanResultEvent = {
  type: "wifi_scan_result"
  networks: WifiSearchResult[]
  scanComplete?: boolean
}

export type PhotoResponseEvent =
  | {
      type: "photo_response"
      state: "success"
      requestId: string
      uploadUrl: string
      photoUrl?: string
      statusUrl?: string
      contentType?: string
      fileSizeBytes?: number
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

export type PhotoSuccessResponseEvent = Extract<PhotoResponseEvent, {state: "success"}>

export type PhotoStatusState =
  | "accepted"
  | "queued"
  | "configuring"
  | "capturing"
  | "captured"
  | "compressing"
  | "ble_fallback_compression"
  | "uploading"
  | "uploaded"
  | "ready_for_transfer"
  | "transferring"
  | "failed"

export type PhotoResolvedConfig = {
  format?: "jpeg" | string
  width?: number
  height?: number
  quality?: number
  requestedSize?: PhotoSize | string
  source?: "sdk" | "button" | string
  transferMethod?: "webhook" | "ble" | "local" | string
  compression?: PhotoCompression | string
  saveToGallery?: boolean
  exposureTimeNs?: number
  iso?: number
}

export type PhotoFpsRange = {
  min?: number
  max?: number
}

export type PhotoRequestedCaptureConfig = {
  manual?: boolean
  exposureTimeNs?: number
  iso?: number
  frameDurationNs?: number
  aeMode?: number
  aeLock?: boolean
  aeExposureCompensation?: number
  aeTargetFpsRange?: PhotoFpsRange
  noiseReductionMode?: number
  edgeMode?: number
  afMode?: number
  zsl?: boolean
}

export type PhotoMeteredPreview = {
  exposureTimeNs?: number
  iso?: number
  totalLightProxy?: number
}

export type PhotoCaptureMetadata = {
  manual?: boolean
  exposureTimeNs?: number
  iso?: number
  frameDurationNs?: number
  aeMode?: number
  aeState?: number
  aeStateName?: string
  noiseReductionMode?: number
  edgeMode?: number
  zsl?: boolean
  sensorTimestampNs?: number
  totalLightProxy?: number
  mfnrLikely?: boolean
  mfnrApplied?: boolean
  width?: number
  height?: number
  noiseReductionWarning?: "not_implemented" | string
  ispDigitalGainWarning?: "not_implemented" | string
  ispAnalogGainWarning?: "not_implemented" | string
  [key: string]: unknown
}

export type PhotoStatusEvent = {
  type: "photo_status"
  requestId: string
  status: PhotoStatusState | string
  timestamp: number
  resolvedConfig?: PhotoResolvedConfig
  requestedCaptureConfig?: PhotoRequestedCaptureConfig
  meteredPreview?: PhotoMeteredPreview
  captureMetadata?: PhotoCaptureMetadata
  errorCode?: string
  errorMessage?: string
}

export type CameraStatusEvent = {
  type: "camera_status"
  requestId: string
  state: "warming" | "ready" | "stopped" | "error" | string
  timestamp: number
  errorCode?: string
  errorMessage?: string
}

export type VideoRecordingStatusEvent = {
  type: "video_recording_status"
  requestId?: string
  success: boolean
  status: VideoRecordingStatusState
  details?: string | null
  timestamp: number
  data?: {
    recording?: boolean
    duration_ms?: number
    duration_formatted?: string
    [key: string]: unknown
  }
}

export type VideoRecordingStatusState =
  | "recording_started"
  | "recording_status"
  | "already_recording"
  | "recording_stopped"
  | "not_recording"
  | "request_id_mismatch"
  | "service_unavailable"
  | "json_error"
  | "battery_low"
  | "camera_busy"
  | "storage_unavailable"
  | "integrity_failed"
  | "error"

export type VideoRecordingStartedStatusEvent = Omit<VideoRecordingStatusEvent, "success" | "status"> & {
  success: true
  status: "recording_started"
}

export type VideoRecordingStoppedStatusEvent = Omit<VideoRecordingStatusEvent, "success" | "status"> & {
  success: true
  status: "recording_stopped"
}

export type VideoRecordingSuccessStatusEvent = VideoRecordingStartedStatusEvent | VideoRecordingStoppedStatusEvent

export type MediaUploadSuccessEvent = {
  type: "media_success"
  requestId: string
  mediaUrl: string
  mediaType: number
  timestamp: number
}

export type MediaUploadErrorEvent = {
  type: "media_error"
  requestId: string
  errorMessage: string
  mediaType: number
  timestamp: number
}

export type MediaUploadEvent = MediaUploadSuccessEvent | MediaUploadErrorEvent

export type GalleryStatusEvent = {
  type: "gallery_status"
  photos: number
  videos: number
  total: number
  totalSize?: number
  hasContent: boolean
  cameraBusy: boolean
  cameraBusyReason?: "video" | "stream" | (string & {})
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

export type RgbLedControlSuccessResponseEvent = Extract<RgbLedControlResponseEvent, {state: "success"}>

export type SettingsAckStatus = "applied" | "ready" | "error" | "failed" | "failure" | "rejected"

export type SettingsAckSetting =
  | "gallery_mode"
  | "button_photo"
  | "button_video_recording"
  | "button_max_recording_time"
  | "camera_fov"
  | "camera_fov_override"
  | "camera_tuning"

export type SettingsAckEvent = {
  type: "settings_ack"
  requestId: string
  setting: SettingsAckSetting
  status: SettingsAckStatus
  timestamp: number
  fov?: number
  roiPosition?: CameraRoiPositionValue
  hardwareApplied?: boolean
  leaseId?: string
  active?: boolean
  size?: ButtonPhotoSize | string
  width?: number
  height?: number
  fps?: number
  enabled?: boolean
  minutes?: number
  /** ANR enabled flag; present when setting === "camera_tuning" */
  anr?: boolean
  /** Stock-gain flag; present when setting === "camera_tuning" */
  gain?: boolean
  errorCode?: string
  errorMessage?: string
}

export type SettingsAckSuccessStatus = Exclude<SettingsAckStatus, "error" | "failed" | "failure" | "rejected">

export type SettingsAckSuccessEvent = Omit<SettingsAckEvent, "status"> & {
  status: SettingsAckSuccessStatus
}

export type RgbLedAction = "on" | "off"
export type RgbLedColor = "red" | "green" | "blue" | "orange" | "white"
export type PhotoSize = "low" | "medium" | "high" | "max"
export type PhotoMode = "photo" | "text"
export type PhotoTransferMethod = "auto" | "direct" | "ble"
export type ButtonPhotoSize = "low" | "medium" | "high" | "max"

/**
 * @deprecated Sticky action-button photo presets via {@link BluetoothSdkPublicModule.setPhotoCaptureDefaults}
 * are deprecated. Prefer per-request {@link BluetoothSdkPublicModule.requestPhoto} options
 * (e.g. `mode: "text"` for text sensor size/crop, or explicit `aeExposureDivisor`) instead of
 * persisting button-photo tuning on the glasses.
 */
export type PhotoCaptureDefaults = {
  size?: PhotoSize
  /** ZSL preview buffering for physical camera-button photos. */
  zsl?: boolean
  /** MFNR still capture for physical camera-button photos. */
  mfnr?: boolean
  noiseReduction?: boolean
  edgeEnhancement?: boolean
  ispDigitalGain?: number
  ispAnalogGain?: string
  aeExposureDivisor?: number
  isoCap?: number
  compress?: PhotoCompression
  sound?: boolean
  /** When true, clears stored NR/edge/ISP presets on the glasses before applying other fields. */
  resetCaptureTuning?: boolean
}
export type PhotoCompression = "none" | "medium" | "heavy"

export type VideoRecordingDefaults = {
  width: number
  height: number
  fps: number
}

/**
 * Optional per-recording video settings for {@link startVideoRecording}. When
 * omitted, the glasses fall back to their saved video recording defaults. Any
 * field left undefined is omitted from the BLE command (glasses default applies).
 */
export interface VideoRecordingSettings {
  width?: number
  height?: number
  fps?: number
  /**
   * Optional auto-stop timer in minutes, sent on `start_video_recording`.
   * `0` (the default) means record until stopped or interrupted
   * (battery/storage/thermal/error).
   */
  maxRecordingTimeMinutes?: number
}
export const DeviceModels = {
  Simulated: "Simulated Glasses",
  G1: "Even Realities G1",
  G2: "Even Realities G2",
  MentraLive: "Mentra Live",
  MentraNex: "Mentra Display",
  Mach1: "Mentra Mach1",
  Z100: "Vuzix Z100",
  Frame: "Brilliant Frame",
  Nimo: "NIMO",
  Ar99: "AR99",
  R1: "Even Realities R1",
} as const

export type DeviceModel = (typeof DeviceModels)[keyof typeof DeviceModels]
export type ObservableStoreCategory = "glasses" | "bluetooth" | "core"

export type DashboardMenuItem = {
  title: string
  packageName: string
  values?: Record<string, unknown>
}

export const CAMERA_FOV_MIN = 62
export const CAMERA_FOV_MAX = 118
export const CAMERA_FOV_DEFAULT = CAMERA_FOV_MAX

export type CameraRoiPosition = "center" | "bottom" | "top"
export type CameraRoiPositionValue = 0 | 1 | 2
export type CameraFovPreset = "narrow" | "standard" | "wide"

export type CameraFovRequest =
  | {
      fov: number
      roiPosition?: CameraRoiPosition
    }
  | {
      preset: CameraFovPreset
    }

export type CameraFovResult = {
  requestId: string
  fov: number
  roiPosition: CameraRoiPosition
  timestamp: number
}

export type CameraFovOverrideRequest = CameraFovRequest & {
  /** Phone-owned lease used to make delayed releases safe. */
  leaseId: string
  /** Safety TTL; refresh the same lease/configuration to extend without a HAL restart. */
  ttlMs?: number
}

export type CameraFovSetting = {
  fov: number
  roiPosition: CameraRoiPositionValue
}

type NativeCameraFovSetting = {
  fov: number
  roi_position: CameraRoiPositionValue
}

export type MicPreference = "auto" | "phone" | "glasses" | "bluetooth"
export type MicMode = "phone" | "glasses" | "bluetoothClassic" | "bluetooth"

export type PhotoRequestParams = {
  requestId?: string
  appId?: string
  size: PhotoSize
  mode?: PhotoMode
  /** `direct` disables BLE fallback; `ble` skips direct upload and forces phone-relayed transfer. */
  transferMethod?: PhotoTransferMethod
  webhookUrl: string | null
  authToken: string | null
  compress: PhotoCompression
  save?: boolean
  sound: boolean
  exposureTimeNs?: number | null
  /** Sensor ISO for this capture only. Only used when exposureTimeNs enables manual exposure. */
  iso?: number | null
  /** After AE convergence, divide metered exposure by this factor (scan mode). */
  aeExposureDivisor?: number
  /** Cap ISO after AE metering (scan mode). */
  isoCap?: number
  /** Requested on wire; glasses may log not_implemented. */
  noiseReduction?: boolean
  edgeEnhancement?: boolean
  /** ZSL buffering. Forced off for manual/scan stills because fixed sensor controls take priority. */
  zsl?: boolean
  /** MFNR still capture. Forced off for manual/scan stills because fixed sensor controls take priority. */
  mfnr?: boolean
  ispDigitalGain?: number
  ispAnalogGain?: string
}

export type WarmUpCameraParams = {
  /** Supply this when the owner needs to call stopCameraWarmUp during teardown. */
  requestId?: string
  size: PhotoSize
  mode?: PhotoMode
  exposureTimeNs?: number | null
  /** Ready-state hold; defaults to 15 seconds and is capped at 60 seconds by ASG. */
  durationMs?: number
  /** ZSL preview buffering for the warm-up session. */
  zsl?: boolean
  /** MFNR still capture for the warm-up session. */
  mfnr?: boolean
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

/** Effective stream settings reported by the glasses after defaults and clamps. */
export type StreamResolvedConfig = {
  transport?: "rtmp" | "srt" | "whip"
  video?: {
    /** Encoded output width sent to the stream endpoint. */
    width: number
    /** Encoded output height sent to the stream endpoint. */
    height: number
    /** Native camera buffer width selected before crop/downscale. */
    captureWidth?: number
    /** Native camera buffer height selected before crop/downscale. */
    captureHeight?: number
    /** Encoded video bitrate in bits per second. */
    bitrate: number
    /** Resolved capture/encode frame rate. */
    fps: number
  }
  audio?: {
    /** Encoded audio bitrate in bits per second. */
    bitrate?: number
    /** Audio sample rate in Hz. */
    sampleRate?: number
    echoCancellation?: boolean
    noiseSuppression?: boolean
  }
}

/** Live encoder and device telemetry emitted periodically by supported glasses firmware. */
export type StreamLiveStats = {
  /** Current encoded video bitrate in bits per second. */
  bitrate?: number
  /** Current encode frame rate. */
  fps?: number
  droppedFrames?: number
  /** Seconds since the stream started. */
  duration?: number
  /** Device temperature in 闂佺娅ｉ悡? if the hardware reports it. */
  temperatureC?: number
}

type StreamStatusCommon = {
  type: "stream_status"
  streamId?: string
  timestamp?: number
  resolvedConfig?: StreamResolvedConfig
  stats?: StreamLiveStats
}

export type StreamStatusEvent =
  | (StreamStatusCommon & {
      kind: "lifecycle"
      status: StreamStatusLifecycleState
    })
  | (StreamStatusCommon & {
      kind: "reconnect"
      status: "reconnecting"
      attempt: number
      maxAttempts: number
      reason: string
    })
  | (StreamStatusCommon & {
      kind: "reconnect"
      status: "reconnected"
      attempt: number
    })
  | (StreamStatusCommon & {
      kind: "reconnect"
      status: "reconnect_failed"
      maxAttempts: number
    })
  | (StreamStatusCommon & {
      kind: "error"
      status: "error"
      errorDetails: string
    })
  | (StreamStatusCommon & {
      kind: "snapshot"
      status: "streaming" | "reconnecting" | "stopped"
      streaming: boolean
      reconnecting: boolean
      attempt?: number
    })

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

/**
 * The glasses process restarted while the BES kept the BLE link alive (its `sid`
 * changed, or first appeared after an update from a pre-sid build). There is no
 * physical disconnect for this — treat it as the logical reconnect edge.
 */
export type GlassesSessionChangedEvent = {
  type: "glasses_session_changed"
  previous_sid: string
  sid: string
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
  step_type: "apk" | "mtk" | "bes"
  phase: "download" | "install"
  step_percent: number
  overall_percent: number
  status: "in_progress" | "step_complete" | "complete" | "failed" | "idle"
  error_message?: string
}

export type OtaQueryResult = OtaStatusEvent

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
  accel_event: (event: AccelEvent) => void
  head_up: (event: HeadUpEvent) => void
  voice_activity_detection_status: (event: VoiceActivityDetectionStatusEvent) => void
  speaking_status: (event: SpeakingStatusEvent) => void
  battery_status: (event: BatteryStatusEvent) => void
  local_transcription: (event: LocalTranscriptionEvent) => void
  phone_notification: (event: PhoneNotificationEvent) => void
  phone_notification_dismissed: (event: PhoneNotificationDismissedEvent) => void
  wifi_status_change: (event: WifiStatusChangeEvent) => void
  wifi_scan_result: (event: WifiScanResultEvent) => void
  hotspot_status_change: (event: HotspotStatusChangeEvent) => void
  hotspot_error: (event: HotspotErrorEvent) => void
  photo_response: (event: PhotoResponseEvent) => void
  photo_status: (event: PhotoStatusEvent) => void
  camera_status: (event: CameraStatusEvent) => void
  video_recording_status: (event: VideoRecordingStatusEvent) => void
  media_success: (event: MediaUploadSuccessEvent) => void
  media_error: (event: MediaUploadErrorEvent) => void
  gallery_status: (event: GalleryStatusEvent) => void
  compatible_glasses_search_stop: (event: CompatibleGlassesSearchStopEvent) => void
  heartbeat_sent: (event: HeartbeatSentEvent) => void
  heartbeat_received: (event: HeartbeatReceivedEvent) => void
  swipe_volume_status: (event: SwipeVolumeStatusEvent) => void
  switch_status: (event: SwitchStatusEvent) => void
  rgb_led_control_response: (event: RgbLedControlResponseEvent) => void
  settings_ack: (event: SettingsAckEvent) => void
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
  glasses_session_changed: (event: GlassesSessionChangedEvent) => void
  ota_start_ack: (event: OtaStartAckEvent) => void
  ota_status: (event: OtaStatusEvent) => void
  ar99_ota_status: (event: Ar99OtaStatusEvent) => void
  version_info: (event: VersionInfoEvent) => void
  send_command_to_ble: (event: BleCommandTraceEvent) => void
  receive_command_from_ble: (event: BleCommandTraceEvent) => void
  miniapp_selected: (event: MiniappSelectedEvent) => void
  extraction_progress: (event: ExtractionProgressEvent) => void
}

export interface ExtractionProgressEvent {
  percentage: number
  bytesRead: number
  totalBytes: number
}

export interface Ar99OtaStatusEvent {
  type: "ar99_ota_status"
  phase: string
  progress: number
  offset: number
  total: number
  errorMessage?: string
  error_message?: string
}

export interface PhoneNotificationEvent {
  notificationId: string
  app: string
  title: string
  content: string
  priority: string
  timestamp: number
  packageName: string
}

export interface PhoneNotificationDismissedEvent {
  notificationId: string
  notificationKey: string
  packageName: string
  timestamp: number
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
  accel_event: AccelEvent
  head_up: HeadUpEvent
  voice_activity_detection_status: VoiceActivityDetectionStatusEvent
  speaking_status: SpeakingStatusEvent
  battery_status: BatteryStatusEvent
  local_transcription: LocalTranscriptionEvent
  wifi_status_change: WifiStatusChangeEvent
  wifi_scan_result: WifiScanResultEvent
  hotspot_status_change: HotspotStatusChangeEvent
  hotspot_error: HotspotErrorEvent
  photo_response: PhotoResponseEvent
  photo_status: PhotoStatusEvent
  camera_status: CameraStatusEvent
  video_recording_status: VideoRecordingStatusEvent
  media_success: MediaUploadSuccessEvent
  media_error: MediaUploadErrorEvent
  gallery_status: GalleryStatusEvent
  compatible_glasses_search_stop: CompatibleGlassesSearchStopEvent
  swipe_volume_status: SwipeVolumeStatusEvent
  switch_status: SwitchStatusEvent
  rgb_led_control_response: RgbLedControlResponseEvent
  settings_ack: SettingsAckEvent
  pair_failure: PairFailureEvent
  audio_pairing_needed: AudioPairingNeededEvent
  audio_connected: AudioConnectedEvent
  audio_disconnected: AudioDisconnectedEvent
  mic_pcm: MicPcmEvent
  mic_lc3: MicLc3Event
  stream_status: StreamStatusEvent
  ota_start_ack: OtaStartAckEvent
  ota_status: OtaStatusEvent
  ar99_ota_status: Ar99OtaStatusEvent
  version_info: VersionInfoEvent
  extraction_progress: ExtractionProgressEvent
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
  setImuEnabled(enabled: boolean): Promise<void>
  setScreenDisabled(disabled: boolean): Promise<void>

  requestWifiScan(): Promise<WifiSearchResult[]>
  sendWifiCredentials(ssid: string, password: string): Promise<WifiStatusChangeEvent>
  forgetWifiNetwork(ssid: string): Promise<WifiStatusChangeEvent>
  setHotspotState(enabled: boolean): Promise<HotspotStatusChangeEvent>
  /** Enable or disable Wi-Fi ADB on Mentra Live (no-op on other devices). */
  setWifiAdbState(enabled: boolean): Promise<void>

  setGalleryModeEnabled(enabled: boolean): Promise<SettingsAckSuccessEvent>
  setVoiceActivityDetectionEnabled(enabled: boolean): Promise<void>
  setLoudnessGateEnabled(enabled: boolean): Promise<void>
  /**
   * @deprecated Sticky action-button photo presets are deprecated. Prefer per-request
   * `requestPhoto(...)` options (e.g. `mode: "text"` for text sensor size/crop, or explicit per-shot
   * fields). Still functional until removed in a future release.
   */
  setPhotoCaptureDefaults(settings: PhotoCaptureDefaults): Promise<SettingsAckSuccessEvent>
  setVideoRecordingDefaults(settings: VideoRecordingDefaults): Promise<SettingsAckSuccessEvent>
  setMaxVideoRecordingDuration(minutes: number): Promise<SettingsAckSuccessEvent>
  setCameraFov(request: CameraFovRequest): Promise<CameraFovResult>
  /** One-way FOV command for legacy ASG clients that do not send settings acknowledgements. */
  setLegacyCameraFov(request: CameraFovRequest): Promise<CameraFovResult>
  setCameraFovOverride(request: CameraFovOverrideRequest): Promise<CameraFovResult>
  releaseCameraFovOverride(leaseId: string): Promise<SettingsAckSuccessEvent>
  /**
   * Configure camera HAL tuning (ANR / gain) on Mentra Live glasses.
   *
   * The phone sends a {@code camera_tuning_config} BLE command; the glasses relay it as a
   * {@code camconfig} broadcast to the camera HAL so parameters take effect without a reboot.
   *
   * **Scan-mode convention**: call with `(false, false)` when activating scan mode to disable ANR
   * and pixsmart gain for sharper text/barcode captures. Call with `(true, true)` to restore
   * defaults when exiting scan mode.
   *
   * @param anrOn  `true` = ANR enabled (default), `false` = ANR disabled
   * @param gainOn `true` = stock gain params (default), `false` = pixsmart gain-off params
   */
  setCameraTuningConfig(anrOn: boolean, gainOn: boolean): Promise<SettingsAckSuccessEvent>
  queryGalleryStatus(): Promise<GalleryStatusEvent>
  requestPhoto(params: PhotoRequestParams): Promise<PhotoSuccessResponseEvent>
  warmUpCamera(params: WarmUpCameraParams): Promise<CameraStatusEvent>
  /** Release one request-owned warm-up. Opening requests reject with camera_warm_up_cancelled. */
  stopCameraWarmUp(requestId: string): Promise<void>
  startVideoRecording(
    requestId: string,
    save: boolean,
    sound: boolean,
    settings?: VideoRecordingSettings,
  ): Promise<VideoRecordingStartedStatusEvent>
  /**
   * Stop the active recording. When {@link webhookUrl} is provided, the glasses
   * upload the recorded video to it (multipart) using {@link authToken}. These
   * are supplied at stop time (not start) so the token is fresh when the upload
   * runs 闂?a recording can last arbitrarily long. An empty/omitted webhook keeps
   * the video on device (no upload).
   */
  stopVideoRecording(
    requestId: string,
    webhookUrl?: string,
    authToken?: string,
  ): Promise<VideoRecordingStoppedStatusEvent>

  startStream(params: StreamStartRequest): Promise<StreamStatusEvent>
  stopStream(): Promise<StreamStatusEvent>

  setMicState(enabled: boolean, useGlassesMic?: boolean, sendTranscript?: boolean, sendLc3Data?: boolean): Promise<void>
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
  ): Promise<RgbLedControlSuccessResponseEvent>

  requestVersionInfo(): Promise<VersionInfoResult>
  /** Fetch the configured OTA manifest and return whether any ASG/BES/MTK update is available. */
  checkForOtaUpdate(): Promise<boolean>
  /** Start the OTA flow with the same configured manifest URL used by checkForOtaUpdate(). */
  startOtaUpdate(): Promise<OtaStartAckEvent>
  startAr99OtaFromFile(path: string): Promise<boolean>
  cancelAr99Ota(): Promise<void>
  sendAr99FactoryReset(): Promise<void>
  buildAr99OtaSignature(secret: string, appName: string, currentVersion: string, serialNumber: string, nonce: string): string

  // // stt commands (MOVE TO CRUST)
  // setSttModelDetails(path: string, languageCode: string): Promise<void>
  // getSttModelPath(): Promise<string>
  // checkSttModelAvailable(): Promise<boolean>
  // validateSttModel(path: string): Promise<boolean>
  // extractTarBz2(sourcePath: string, destinationPath: string): Promise<boolean>

  // // tts commands (MOVE TO CRUST)
  // setTtsModelDetails(path: string, languageCode: string): Promise<void>
  // getTtsModelPath(): Promise<string>
  // getTtsModelLanguage(): Promise<string>
  // checkTtsModelAvailable(): Promise<boolean>
  // validateTtsModel(path: string): Promise<boolean>
  // generateTtsAudio(text: string, path: string, outputPath: string, speakerId: number, speed: number): Promise<boolean>

  // STT Commands (TODO: MOVE TO CRUST)
  setSttModelDetails(path: string, languageCode: string): Promise<void>
  getSttModelPath(): Promise<string>
  checkSttModelAvailable(): Promise<boolean>
  validateSttModel(path: string): Promise<boolean>
  extractTarBz2(sourcePath: string, destinationPath: string): Promise<boolean>
  restartTranscriber(): Promise<void>

  // TTS Commands (TODO: MOVE TO CRUST)
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
}

// OTA update status types
export type OtaStage = "download" | "install"
export type OtaProgressStatus = "STARTED" | "PROGRESS" | "FINISHED" | "FAILED"

export interface OtaStatus {
  sessionId: string
  totalSteps: number
  currentStep: number
  stepType: "apk" | "mtk" | "bes"
  phase: "download" | "install"
  stepPercent: number
  overallPercent: number
  status: "in_progress" | "step_complete" | "complete" | "failed" | "idle"
  error?: string
}

export interface OtaUpdateInfo {
  available: boolean
  versionCode: number
  versionName: string
  updates: string[] // ["apk", "mtk", "bes"]
  totalSize: number
  cacheReady?: boolean
  /** True when the APK step installs an older build than the glasses currently run (exact-pin manifests only). */
  isDowngrade?: boolean
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
  /** Glasses System.currentTimeMillis() from last version_info (clock skew detection). */
  systemTimeMs?: number
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

export interface CalendarEvent {
  title: string
  location?: string
  time: string
  endDate: number
}

export interface CoreSettings {
  menu_apps: CoreDashboardMenuItem[]
  calendar_events: CalendarEvent[]
}

export interface Device {
  /**
   * Stable app-facing key for this scan result, within the limits of the
   * platform identifier available to the SDK. Do not parse this value; use the
   * typed model, name, address, projectName, and rssi fields instead.
   */
  id: string
  model: DeviceModel
  name: string
  /** Platform address/identifier when available: Android Bluetooth address, iOS CoreBluetooth identifier. */
  address?: string
  /** Optional AR99 project discriminator. Supported value: AR99. */
  projectName?: string
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
  /** Frequency in MHz (from glasses scan). 5 GHz band is typically 5170闂?825. Omitted if unknown. */
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
  imu_enabled: boolean
  brightness: number
  auto_brightness: boolean
  dashboard_height: number
  dashboard_depth: number
  menu_apps: DashboardMenuItem[] | CoreDashboardMenuItem[] | Array<Record<string, unknown>> | null
  calendar_events: CalendarEvent[]
  metric_system: boolean
  twelve_hour_time: boolean
  gallery_mode: boolean
  voice_activity_detection_enabled: boolean
  loudness_gate_enabled: boolean
  button_photo_size: ButtonPhotoSize
  button_video_settings: {width: number; height: number; fps: number}
  button_video_width: number
  button_video_height: number
  button_video_fps: number
  button_max_recording_time: number
  camera_fov: NativeCameraFovSetting
  should_send_pcm: boolean
  should_send_lc3: boolean
  should_send_transcript: boolean
  offline_mode: boolean
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
