import {parsePhotoCompression} from "@mentra/cloud-protocol/photo-compression"
import PrivateBluetoothSdkModule from "./_private/BluetoothSdkModule"
import {publicGlassesStatus} from "./BluetoothSdk.types"
import type {
  BluetoothSdkEventListener,
  BluetoothSdkEventName,
  BluetoothSdkPublicModule,
  HoldCameraWarmParams,
  PhotoCaptureDefaults,
  PhotoCapture,
  PhotoCaptureParams,
  PublicBluetoothStatus,
  PublicGlassesStatus,
  VideoRecordingDefaults,
} from "./BluetoothSdk.types"
import {holdCameraWarm} from "./camera-warm"
import {delay} from "./glasses-wifi/native"
import {getReleaseChangelogs} from "./changelogs"
import {runContinuousCapture} from "./glasses-wifi/continuous"
import {createLink} from "./glasses-wifi/link"

/** The app's own links to the glasses, and its hold on the fast link. */
const link = createLink("app fast link")

const PUBLIC_EVENT_NAMES = new Set<BluetoothSdkEventName>([
  "native_notification_status",
  "native_notification_delivery",
  "log",
  "device_discovered",
  "default_device_changed",
  "glasses_not_ready",
  "button_press",
  "touch_event",
  "accel_event",
  "head_up",
  "voice_activity_detection_status",
  "speaking_status",
  "battery_status",
  "local_transcription",
  "wake_word",
  "speech_activity",
  "wifi_status_change",
  "wifi_scan_result",
  "wifi_forget_result",
  "saved_wifi_networks",
  "photo_response",
  "photo_status",
  "camera_status",
  "video_recording_status",
  "media_success",
  "media_error",
  "gallery_status",
  "compatible_glasses_search_stop",
  "swipe_volume_status",
  "switch_status",
  "rgb_led_control_response",
  "settings_ack",
  "pair_failure",
  "pairing_info",
  "entering_pairing_mode",
  "pairing_mode_ended",
  "pairing_state_changed",
  "audio_setup_changed",
  "owner_replaced",
  "audio_pairing_needed",
  "audio_connected",
  "audio_disconnected",
  "mic_pcm",
  "mic_lc3",
  "mic_health",
  "stream_status",
  "mtk_update_complete",
  "glasses_session_changed",
  "ota_start_ack",
  "ota_status",
  "ar99_ota_status",
  "bes_crash_detected",
  "version_info",
  "extraction_progress",
])

const addListener: BluetoothSdkPublicModule["addListener"] = (eventName, listener) => {
  if (!PUBLIC_EVENT_NAMES.has(eventName)) {
    throw new Error(`Unsupported BluetoothSdk event "${eventName}". Use @mentra/bluetooth-sdk/react for status state.`)
  }
  return PrivateBluetoothSdkModule.addListener(eventName, listener as BluetoothSdkEventListener<BluetoothSdkEventName>)
}

const startOtaUpdate: BluetoothSdkPublicModule["startOtaUpdate"] = (otaVersionUrl) => {
  return PrivateBluetoothSdkModule.startOtaUpdate(otaVersionUrl)
}

const queryOtaStatus: BluetoothSdkPublicModule["queryOtaStatus"] = () => {
  return PrivateBluetoothSdkModule.sendOtaQueryStatus()
}

const bindPublicMethod = <K extends keyof BluetoothSdkPublicModule>(name: K): BluetoothSdkPublicModule[K] => {
  const method = (PrivateBluetoothSdkModule as unknown as Record<string, unknown>)[name]
  if (typeof method === "function") {
    return method.bind(PrivateBluetoothSdkModule) as BluetoothSdkPublicModule[K]
  }

  return (async () => {
    throw new Error(`BluetoothSdk.${String(name)} is not available in this native build. Rebuild the app.`)
  }) as unknown as BluetoothSdkPublicModule[K]
}

export const BluetoothSdk: BluetoothSdkPublicModule = Object.freeze({
  configureNativeNotifications: bindPublicMethod("configureNativeNotifications"),
  getNativeNotificationStatus: bindPublicMethod("getNativeNotificationStatus"),
  addListener,
  getGlassesStatus: async () => publicGlassesStatus(await PrivateBluetoothSdkModule.getGlassesStatus()),
  getBluetoothStatus: bindPublicMethod("getBluetoothStatus"),
  subscribeGlassesStatus: (listener: (changed: Partial<PublicGlassesStatus>) => void) =>
    PrivateBluetoothSdkModule.onGlassesStatus((changed) => listener(publicGlassesStatus(changed))),
  subscribeBluetoothStatus: (listener: (changed: Partial<PublicBluetoothStatus>) => void) =>
    PrivateBluetoothSdkModule.onBluetoothStatus(listener),
  getDefaultDevice: bindPublicMethod("getDefaultDevice"),
  setDefaultDevice: bindPublicMethod("setDefaultDevice"),
  startScan: bindPublicMethod("startScan"),
  stopScan: bindPublicMethod("stopScan"),
  scan: bindPublicMethod("scan") as BluetoothSdkPublicModule["scan"],
  connect: bindPublicMethod("connect"),
  connectDefault: bindPublicMethod("connectDefault"),
  cancelConnectionAttempt: bindPublicMethod("cancelConnectionAttempt"),
  disconnect: bindPublicMethod("disconnect"),
  forget: bindPublicMethod("forget"),
  unpair: bindPublicMethod("unpair"),
  displayText: bindPublicMethod("displayText"),
  clearDisplay: bindPublicMethod("clearDisplay"),
  setDashboardContent: bindPublicMethod("setDashboardContent"),
  showDashboard: bindPublicMethod("showDashboard"),
  setDashboardPosition: bindPublicMethod("setDashboardPosition"),
  setHeadUpAngle: bindPublicMethod("setHeadUpAngle"),
  setImuEnabled: bindPublicMethod("setImuEnabled"),
  setScreenDisabled: bindPublicMethod("setScreenDisabled"),
  ping: bindPublicMethod("ping"),
  requestWifiScan: bindPublicMethod("requestWifiScan"),
  getSavedWifiNetworks: bindPublicMethod("getSavedWifiNetworks"),
  sendWifiCredentials: bindPublicMethod("sendWifiCredentials"),
  forgetWifiNetwork: bindPublicMethod("forgetWifiNetwork"),
  setSystemTime: bindPublicMethod("setSystemTime"),
  setWifiAdbState: bindPublicMethod("setWifiAdbState"),
  setGalleryServerEnabled: bindPublicMethod("setGalleryServerEnabled"),
  setTouchGestureDefaultBehaviorEnabled: bindPublicMethod("setTouchGestureDefaultBehaviorEnabled"),
  setGalleryModeEnabled: bindPublicMethod("setGalleryModeEnabled"),
  setVoiceActivityDetectionEnabled: bindPublicMethod("setVoiceActivityDetectionEnabled"),
  setLoudnessGateEnabled: bindPublicMethod("setLoudnessGateEnabled"),
  setAutoPowerOffEnabled: bindPublicMethod("setAutoPowerOffEnabled"),
  /**
   * @deprecated Sticky action-button photo presets are deprecated. Prefer per-request
   * `uploadPhoto(...)` options (e.g. `mode: "text"` for text sensor size/crop, or explicit per-shot
   * fields). Still functional until removed in a future release.
   */
  setPhotoCaptureDefaults: (settings: PhotoCaptureDefaults) => {
    if (settings.compress !== undefined) parsePhotoCompression(settings.compress)
    return bindPublicMethod("setPhotoCaptureDefaults")(settings)
  },
  setVideoRecordingDefaults: ({width, height, fps}: VideoRecordingDefaults) => {
    const method = (PrivateBluetoothSdkModule as unknown as Record<string, unknown>).setVideoRecordingDefaults
    if (typeof method !== "function") {
      return Promise.reject(
        new Error("BluetoothSdk.setVideoRecordingDefaults is not available in this native build. Rebuild the app."),
      )
    }
    return PrivateBluetoothSdkModule.setVideoRecordingDefaults(width, height, fps)
  },
  setMaxVideoRecordingDuration: bindPublicMethod("setMaxVideoRecordingDuration"),
  setCameraFov: bindPublicMethod("setCameraFov"),
  setLegacyCameraFov: bindPublicMethod("setLegacyCameraFov"),
  setCameraFovOverride: bindPublicMethod("setCameraFovOverride"),
  releaseCameraFovOverride: bindPublicMethod("releaseCameraFovOverride"),
  setCameraTuningConfig: bindPublicMethod("setCameraTuningConfig"),
  queryGalleryStatus: bindPublicMethod("queryGalleryStatus"),
  uploadPhoto: bindPublicMethod("uploadPhoto"),
  capturePhoto: bindPublicMethod("capturePhoto"),
  takePhoto: bindPublicMethod("takePhoto"),
  link,
  captureContinuous: (options: PhotoCaptureParams & {maxPending?: number}) =>
    runContinuousCapture(
      (params: PhotoCaptureParams, released): PhotoCapture => {
        const capture = PrivateBluetoothSdkModule.capturePhoto(params)
        // The run counts the photos still on the glasses: this one stops counting once released.
        return {
          requestId: capture.requestId,
          get captured() {
            return capture.captured
          },
          get preview() {
            return capture.preview
          },
          photo: () => capture.photo(),
          release: () => capture.release().finally(released),
        }
      },
      options,
      "app continuous capture",
    ),
  warmUpCamera: bindPublicMethod("warmUpCamera"),
  stopCameraWarmUp: bindPublicMethod("stopCameraWarmUp"),
  // Renewals wait natively, so they keep running while Android has the app in the background.
  holdCameraWarm: (params: HoldCameraWarmParams) => holdCameraWarm(BluetoothSdk, params, delay),
  startVideoRecording: bindPublicMethod("startVideoRecording"),
  stopVideoRecording: bindPublicMethod("stopVideoRecording"),
  queryVideoRecordingStatus: bindPublicMethod("queryVideoRecordingStatus"),
  startStream: bindPublicMethod("startStream"),
  stopStream: bindPublicMethod("stopStream"),
  setMicState: bindPublicMethod("setMicState"),
  setPreferredMic: bindPublicMethod("setPreferredMic"),
  setOwnAppAudioPlaying: bindPublicMethod("setOwnAppAudioPlaying"),
  getGlassesMediaVolume: bindPublicMethod("getGlassesMediaVolume"),
  setGlassesMediaVolume: bindPublicMethod("setGlassesMediaVolume"),
  rgbLedControl: bindPublicMethod("rgbLedControl"),
  requestVersionInfo: bindPublicMethod("requestVersionInfo"),
  setOtaVersionUrl: bindPublicMethod("setOtaVersionUrl"),
  getOtaVersionUrl: bindPublicMethod("getOtaVersionUrl"),
  checkForOtaUpdate: bindPublicMethod("checkForOtaUpdate"),
  getReleaseChangelogs,
  startOtaUpdate,
  queryOtaStatus,
  startAr99OtaFromFile: bindPublicMethod("startAr99OtaFromFile"),
  cancelAr99Ota: bindPublicMethod("cancelAr99Ota"),
  sendAr99FactoryReset: bindPublicMethod("sendAr99FactoryReset"),
  buildAr99OtaSignature: bindPublicMethod("buildAr99OtaSignature"),
  setSttModelDetails: bindPublicMethod("setSttModelDetails"),
  getSttModelPath: bindPublicMethod("getSttModelPath"),
  checkSttModelAvailable: bindPublicMethod("checkSttModelAvailable"),
  validateSttModel: bindPublicMethod("validateSttModel"),
  extractTarBz2: bindPublicMethod("extractTarBz2"),
  setWakeWordDetection: bindPublicMethod("setWakeWordDetection"),
  finishTranscription: bindPublicMethod("finishTranscription"),
  restartTranscriber: bindPublicMethod("restartTranscriber"),
  setSpeechActivityDetection: bindPublicMethod("setSpeechActivityDetection"),
  setTtsModelDetails: bindPublicMethod("setTtsModelDetails"),
  getTtsModelPath: bindPublicMethod("getTtsModelPath"),
  getTtsModelLanguage: bindPublicMethod("getTtsModelLanguage"),
  checkTtsModelAvailable: bindPublicMethod("checkTtsModelAvailable"),
  validateTtsModel: bindPublicMethod("validateTtsModel"),
  generateTtsAudio: bindPublicMethod("generateTtsAudio"),
})

export default BluetoothSdk

export type {GlassesLink, LinkState} from "./glasses-wifi/link"
export type {ContinuousCapture, ContinuousState} from "./glasses-wifi/continuous"

export {
  CAMERA_FOV_DEFAULT,
  CAMERA_FOV_MAX,
  CAMERA_FOV_MIN,
  DeviceModels,
  isBusyGlassesConnectionStatus,
  isConnectedGlassesConnectionStatus,
  isConnectedWifiStatus,
  isReadyGlassesConnectionStatus,
} from "./BluetoothSdk.types"

export type {
  AccelEvent,
  Ar99OtaStatusEvent,
  AudioConnectedEvent,
  AudioDisconnectedEvent,
  AudioPairingNeededEvent,
  BatteryStatusEvent,
  BesCrashDetectedEvent,
  BesCrashEviction,
  BesCrashIncidentState,
  BesCrashSummary,
  BluetoothSdkEvent,
  BluetoothSdkEventListener,
  BluetoothSdkEventMap,
  BluetoothSdkEventName,
  BluetoothSdkPublicModule as BluetoothSdkModule,
  BluetoothSdkSubscription,
  ButtonPhotoSize,
  PhotoCaptureDefaults,
  ButtonPressEvent,
  CameraFovPreset,
  CameraWarmHold,
  HoldCameraWarmParams,
  CameraFovRequest,
  CameraFovResult,
  CameraRoiPosition,
  CompatibleGlassesSearchStopEvent,
  ConnectOptions,
  ConnectedGlassesConnectionStatus,
  ConnectedWifiStatus,
  Device,
  DeviceModel,
  GalleryStatusEvent,
  GlassesConnectionStatus,
  GlassesMediaVolumeGetResult,
  GlassesMediaVolumeSetResult,
  GlassesNotReadyEvent,
  HeadUpEvent,
  GlassesSessionChangedEvent,
  KeepAliveAckEvent,
  LocalTranscriptionEvent,
  WakeWordEvent,
  SpeechActivityEvent,
  LogEvent,
  MicLc3Event,
  MicHealthEvent,
  MicMode,
  MicPcmEvent,
  MicPreference,
  OtaStartAckEvent,
  OtaProgress,
  OtaProgressStatus,
  OtaStage,
  OtaStatus,
  OtaStatusEvent,
  OtaQueryResult,
  OtaUpdateInfo,
  ReleaseChangelog,
  MtkUpdateCompleteEvent,
  PairFailureCode,
  PairFailureEvent,
  PairingInfoEvent,
  EnteringPairingModeEvent,
  MentraLivePairingState,
  PairingModeEndedEvent,
  PairingModeEndedReason,
  PairingStateChangedEvent,
  GlassesAudioSetupState,
  AudioSetupChangedEvent,
  OwnerReplacedEvent,
  PhotoCaptureMetadata,
  PhotoResolvedConfig,
  PhotoCompression,
  PhotoFpsRange,
  PhotoMeteredPreview,
  PhotoMode,
  PublicBluetoothStatus,
  PublicGlassesStatus,
  PhotoTransferMethod,
  PhotoResponseEvent,
  PhotoRequestedCaptureConfig,
  PhotoCapture,
  PhotoCaptureParams,
  PhotoPreview,
  PhotoTaken,
  PhotoUploadParams,
  PhotoSize,
  PhotoStatusEvent,
  PhotoStatusState,
  PhotoSuccessResponseEvent,
  RgbLedAction,
  RgbLedColor,
  RgbLedControlResponseEvent,
  RgbLedControlSuccessResponseEvent,
  ScanModelOptions,
  ScanDiagnostic,
  ScanOptions,
  ScanResultsCallback,
  SpeakingStatusEvent,
  SettingsAckEvent,
  SettingsAckSetting,
  SettingsAckSuccessEvent,
  SettingsAckSuccessStatus,
  SettingsAckStatus,
  StreamAudioConfig,
  StreamDegradationPreference,
  StreamResolvedConfig,
  StreamStartRequest,
  StreamStatusEvent,
  StreamStatusLifecycleState,
  StreamStatusReconnectState,
  StreamStatusState,
  StreamVideoConfig,
  SwipeVolumeStatusEvent,
  SwitchStatusEvent,
  TouchEvent,
  TouchGesture,
  VideoRecordingDefaults,
  VideoRecordingStartedStatusEvent,
  VideoRecordingStatusEvent,
  VideoRecordingStatusState,
  VideoRecordingStoppedStatusEvent,
  VideoRecordingSuccessStatusEvent,
  VersionInfoEvent,
  VersionInfoResult,
  SavedWifiNetworksEvent,
  SavedWifiNetworksOutcome,
  SavedWifiNetworksResult,
  WifiForgetOutcome,
  WifiForgetResult,
  WifiForgetResultEvent,
  LegacyWifiForgetResultEvent,
  ModernWifiForgetResultEvent,
  WifiScanResultEvent,
  VoiceActivityDetectionStatusEvent,
  WifiSearchResult,
  WifiStatus,
  WifiStatusChangeEvent,
} from "./BluetoothSdk.types"

export type {NativeNotificationConfig, NativeNotificationStatus, NativeNotificationDelivery} from "./BluetoothSdk.types"
