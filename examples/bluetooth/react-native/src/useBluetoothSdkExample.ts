import {createAudioPlayer, setAudioModeAsync, type AudioPlayer} from 'expo-audio';
import {File, Paths} from 'expo-file-system';
import {useEffect, useRef, useState} from 'react';
import {Clipboard, Linking, PermissionsAndroid, Platform} from 'react-native';
import BluetoothSdk, {
  DeviceModels,
  type AudioConnectedEvent,
  type ButtonPressEvent,
  type BluetoothSdkEventMap,
  type ButtonPhotoSettings,
  type CameraFovResult,
  type CameraRoiPosition,
  type CompatibleGlassesSearchStopEvent,
  type LogEvent,
  type Device,
  type DeviceModel,
  type MicLc3Event,
  type MicPcmEvent,
  type OtaStatusEvent,
  type PhotoRequestParams,
  type PhotoSuccessResponseEvent,
  type PhotoStatusEvent,
  type SettingsAckEvent,
  type SpeakingStatusEvent,
  type StreamStatusEvent,
  type TouchEvent,
  type VersionInfoEvent,
  type VideoRecordingStatusEvent,
  type VoiceActivityDetectionStatusEvent,
} from '@mentra/bluetooth-sdk';
import {
  useMentraBluetooth,
  type DefaultDeviceStorage,
  type GlassesRuntimeState,
  type PhoneSdkRuntimeState,
} from '@mentra/bluetooth-sdk/react';
import MentraBarcodeScanner, {
  type BarcodeScanResult,
  type ImageFovEstimate,
} from '@mentra/react-native-barcode-scanner';
import MentraPhotoReceiver, {
  type PhotoReceiverResult,
  type PhotoReceiverStatusEvent,
  type PhotoReceiverUploadEvent,
} from '@mentra/bluetooth-sdk/photo-receiver';
import MentraVideoStreamReceiver, {
  type VideoStreamFrameEvent,
  type VideoStreamFirstFrameEvent,
  type VideoStreamReceiverStatusEvent,
} from '@mentra/react-native-video-stream-receiver';
import {
  galleryHotspotPasswordLabel,
  galleryHotspotSsidLabel,
  galleryServerUrl,
  connectedWifiStatus,
  enabledHotspotStatus,
  isDisconnectedStatus,
  isGlassesConnected,
  isGlassesWifiConnected,
  supportsDisplay,
} from './sdkFormat';

export type ExampleTabKey = 'device' | 'camera' | 'stream' | 'system' | 'console';
export type BluetoothSdkExampleOptions = {
  activeTab?: ExampleTabKey;
};

export type StreamProtocol = 'rtmp' | 'srt' | 'webrtc';
export type StreamPreviewTarget = {
  kind: 'hls' | 'web';
  url: string;
};
type MediaUploadSuccessEvent = BluetoothSdkEventMap['media_success'];
type MediaUploadErrorEvent = BluetoothSdkEventMap['media_error'];

function isDisplayableOtaStatus(payload: OtaStatusEvent) {
  return payload.status !== 'idle' || Boolean(payload.error_message);
}

function isOtaEventInProgress(payload: OtaStatusEvent | null) {
  return payload?.status === 'in_progress' || payload?.status === 'step_complete';
}

function otaVersionSignature(glasses: GlassesRuntimeState) {
  if (!glasses.connected) {
    return 'disconnected';
  }
  return [
    glasses.device.buildNumber,
    glasses.firmware.buildNumber,
    glasses.device.appVersion,
    glasses.firmware.appVersion,
    glasses.firmware.source,
    glasses.firmware.version,
  ].filter(Boolean).join('|') || 'version-unknown';
}

function otaVersionInfoSignature(event: VersionInfoEvent) {
  return [
    event.buildNumber,
    event.appVersion,
    event.mtkFirmwareVersion,
    event.besFirmwareVersion,
    event.firmwareVersion,
  ].filter(Boolean).join('|') || 'version-unknown';
}

export type StreamResolvedConfig = {
  transport?: 'rtmp' | 'srt' | 'whip';
  video?: {
    width: number;
    height: number;
    captureWidth?: number;
    captureHeight?: number;
    bitrate: number;
    fps: number;
  };
  audio?: {
    bitrate?: number;
    sampleRate?: number;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
  };
};
export type PhotoRequestedCaptureConfigDetails = {
  manual?: boolean;
  exposureTimeNs?: number;
  iso?: number;
  frameDurationNs?: number;
  aeMode?: number;
  aeLock?: boolean;
  aeExposureCompensation?: number;
  aeTargetFpsRange?: {min?: number; max?: number};
  noiseReductionMode?: number;
  edgeMode?: number;
  afMode?: number;
  zsl?: boolean;
};
export type PhotoMeteredPreviewDetails = {
  exposureTimeNs?: number;
  iso?: number;
  totalLightProxy?: number;
};
export type PhotoCaptureMetadataDetails = {
  manual?: boolean;
  exposureTimeNs?: number;
  iso?: number;
  frameDurationNs?: number;
  aeMode?: number;
  aeState?: number;
  aeStateName?: string;
  noiseReductionMode?: number;
  edgeMode?: number;
  zsl?: boolean;
  sensorTimestampNs?: number;
  totalLightProxy?: number;
  mfnrLikely?: boolean;
};
export type PhotoPreviewDetails = {
  bleFallbackMessage?: string;
  bleFallbackUsed?: boolean;
  byteCount?: number;
  contentType?: string;
  error?: string;
  estimatedFov?: ImageFovEstimate | null;
  focalLength35mm?: number | null;
  height?: number;
  previewUrl?: string;
  requestId?: string | null;
  resolvedConfig?: PhotoStatusEvent['resolvedConfig'];
  requestedCaptureConfig?: PhotoRequestedCaptureConfigDetails;
  meteredPreview?: PhotoMeteredPreviewDetails;
  captureMetadata?: PhotoCaptureMetadataDetails;
  source: 'Cloud server' | 'Phone receiver' | 'Action button' | 'Glasses gallery';
  state: 'acknowledged' | 'error' | 'preview';
  timestamp?: number;
  uploadUrl?: string;
  uploadedAt?: string;
  width?: number;
};

export type VideoPreviewDetails = {
  byteCount?: number;
  contentType?: string;
  durationMs?: number;
  error?: string;
  mediaUrl?: string;
  previewUrl?: string;
  requestId?: string | null;
  source: 'Cloud server';
  state: 'recording' | 'uploading' | 'preview' | 'error';
  status?: string;
  timestamp?: number;
  uploadUrl?: string;
  uploadedAt?: string;
};

export type BarcodeScanDetails = {
  barcodes: BarcodeScanResult[];
  error?: string;
  expectedValue?: string;
  scannedAt?: string;
  sourceUri?: string;
  state: 'idle' | 'scanning' | 'found' | 'none' | 'error';
};
export type LedMode = 'Off' | 'Solid' | 'Pulse' | 'Blink';
type RgbLedAction = 'on' | 'off';
export type LedColor = 'red' | 'green' | 'blue' | 'orange' | 'white';
export type PhotoSize = 'low' | 'medium' | 'high' | 'max';
export type PhotoCompression = 'none' | 'medium' | 'heavy';
export type PhotoAeExposureDivisor = 2 | 3 | 5;
export type PhotoIsoCap = 400 | 800 | 1600;
export type PhotoIspDigitalGain = 0 | 1 | 2 | 4;
export type PhotoIspAnalogGain = 'low';
export type PhotoTuningFlag = 'unset' | 'on' | 'off';
export type ScanAeDivisor = 3 | 5;
export const SCAN_DEFAULT_AE_DIVISOR: ScanAeDivisor = 3;
export const SCAN_DEFAULT_ISO_CAP = 800;

/** Base scan fields pushed via button_photo_setting; AE divisor and ISO cap are added at sync time. */
export const SCAN_MODE_BUTTON_PRESET = {
  size: 'max' as const,
  mfnr: false,
  zsl: false,
  noiseReduction: false,
  edgeEnhancement: false,
  ispDigitalGain: 0,
  ispAnalogGain: 'low' as const,
  compress: 'none' as const,
  sound: false,
} as const;

export const SCAN_MODELS = [DeviceModels.MentraLive, DeviceModels.G2] as const;
export type ScanModel = (typeof SCAN_MODELS)[number];
type StreamStartRequest = {
  streamId: string;
  streamUrl: string;
  type: 'start_stream';
  video: {
    fps: number;
  };
};

type PersistedDefaultDevice = Device & {
  savedAt: number;
  version: 1;
};
type PersistedCloudUrls = {
  streamProtocol?: StreamProtocol;
  savedAt: number;
  streamUrl?: string;
  version: 1;
  webhookUrl?: string;
};
type ButtonPhotoSettingsOverrides = {
  aeExposureDivisor?: number | null;
  compress?: PhotoCompression;
  edgeEnhancement?: boolean;
  ispAnalogGain?: string | null;
  ispDigitalGain?: number | null;
  isoCap?: number | null;
  mfnr?: boolean;
  noiseReduction?: boolean;
  size?: ButtonPhotoSettings['size'];
  zsl?: boolean;
};

export const RGB_LED_COLORS: LedColor[] = ['red', 'green', 'blue', 'orange', 'white'];
export const PHOTO_SIZES: PhotoSize[] = ['low', 'medium', 'high', 'max'];
export const PHOTO_COMPRESSIONS: PhotoCompression[] = ['none', 'medium', 'heavy'];
export const PHOTO_AE_EXPOSURE_DIVISOR_OPTIONS: PhotoAeExposureDivisor[] = [2, 3, 5];
export const PHOTO_ISO_CAP_OPTIONS: PhotoIsoCap[] = [400, 800, 1600];
export const PHOTO_ISP_DIGITAL_GAIN_OPTIONS: PhotoIspDigitalGain[] = [0, 1, 2, 4];
export const PHOTO_ISP_ANALOG_GAIN_OPTIONS: PhotoIspAnalogGain[] = ['low'];
export const PHOTO_TUNING_FLAG_OPTIONS: PhotoTuningFlag[] = ['unset', 'on', 'off'];
export const STREAM_MIN_FPS = 1;
export const STREAM_MAX_FPS = 24;
export const STREAM_DEFAULT_FPS = 15;
export const PHOTO_EXPOSURE_MIN_NS = 1_000_000;
export const PHOTO_EXPOSURE_MAX_NS = 33_333_333;
export const PHOTO_EXPOSURE_DEFAULT_NS = 8_333_333;
export const PHOTO_ISO_MIN = 100;
export const PHOTO_ISO_MAX = 6400;
export const PHOTO_ISO_DEFAULT = 200;
const photoTuningFlagFromPreset = (value: boolean): Exclude<PhotoTuningFlag, 'unset'> =>
  value ? 'on' : 'off';
export const BARCODE_SCAN_PHOTO_PRESET = {
  ...SCAN_MODE_BUTTON_PRESET,
  exposureTimeNs: PHOTO_EXPOSURE_DEFAULT_NS,
  iso: PHOTO_ISO_DEFAULT,
  aeExposureDivisor: SCAN_DEFAULT_AE_DIVISOR,
  isoCap: SCAN_DEFAULT_ISO_CAP,
  noiseReduction: photoTuningFlagFromPreset(SCAN_MODE_BUTTON_PRESET.noiseReduction),
  edgeEnhancement: photoTuningFlagFromPreset(SCAN_MODE_BUTTON_PRESET.edgeEnhancement),
  mfnr: photoTuningFlagFromPreset(SCAN_MODE_BUTTON_PRESET.mfnr),
  zsl: photoTuningFlagFromPreset(SCAN_MODE_BUTTON_PRESET.zsl),
} as const;
export const CAMERA_FOV_MIN = 62;
export const CAMERA_FOV_MAX = 118;
export const CAMERA_FOV_DEFAULT = 102;
export const CAMERA_ROI_POSITIONS = [
  {label: 'Center', value: 'center'},
  {label: 'Bottom', value: 'bottom'},
  {label: 'Top', value: 'top'},
] as const satisfies ReadonlyArray<{label: string; value: CameraRoiPosition}>;

export const STREAM_DEFAULT_URLS: Record<StreamProtocol, string> = {
  rtmp: 'rtmp://<computer-ip>:1935/live/mentra-live',
  srt: 'srt://<computer-ip>:8890?streamid=publish:mentra-live',
  webrtc: 'http://<computer-ip>:8889/mentra-live/whip',
};

export const PHOTO_UPLOAD_DEFAULT_URL = 'http://<computer-ip>:8787/upload';

const STREAM_DEFAULT_URL_VALUES = new Set(Object.values(STREAM_DEFAULT_URLS));
const CAMERA_BUTTON_GALLERY_MODE_NOTICE =
  'Gallery mode is on. Photo stays on glasses and is not previewed.';
const CAMERA_ACTION_BUTTON_IDS = new Set(['action', 'camera', 'main', 'primary']);

type MicPcmChunk = {
  data: Uint8Array;
  index: number;
};

export type SdkConsoleEvent = {
  tag: 'LIVE' | 'STORE' | 'BLE' | 'TX';
  text: string;
  time: string;
};

export type BluetoothSdkExampleState = {
  activeAction: string | null;
  barcodeScan: BarcodeScanDetails;
  cameraButtonNotice: string | null;
  cameraStatus: string;
  defaultDevice: Device | null;
  discoveredDevices: Device[];
  events: SdkConsoleEvent[];
  galleryModeEnabled: boolean;
  galleryServerReachable: boolean | null;
  galleryServerStatus: string;
  glasses: GlassesRuntimeState;
  hotspotEnabled: boolean;
  lastAction: string;
  lastMicBytes: number;
  lastMicDurationSeconds: number | null;
  micAudioRouteStatus: string;
  ledColor: LedColor;
  ledMode: LedMode;
  micElapsedSeconds: number;
  micPlaybackHint: string | null;
  micPlaying: boolean;
  micRecording: boolean;
  otaDisplayPercent: number | null;
  otaStatus: OtaStatusEvent | null;
  otaStatusMessage: string | null;
  otaUpdateAvailable: boolean;
  pcmBytes: number;
  pcmFrames: number;
  speaking: boolean | null;
  voiceActivityDetectionEnabled: boolean;
  permissionStatus: string;
  phonePhotoReceiverRunning: boolean;
  phonePhotoUploadUrl: string | null;
  photoCompression: PhotoCompression;
  photoCloudServerEnabled: boolean;
  photoAeExposureDivisor: PhotoAeExposureDivisor | null;
  photoIsoCap: PhotoIsoCap | null;
  photoNoiseReduction: PhotoTuningFlag;
  photoEdgeEnhancement: PhotoTuningFlag;
  photoMfnr: PhotoTuningFlag;
  photoZsl: PhotoTuningFlag;
  photoIspDigitalGain: PhotoIspDigitalGain | null;
  photoIspAnalogGain: PhotoIspAnalogGain | null;
  photoExposureManual: boolean;
  photoIso: number;
  photoExposureTimeNs: number;
  photoPreviewDetails: PhotoPreviewDetails | null;
  photoPreviewUrl: string | null;
  photoStatus: PhotoStatusEvent | null;
  photoSize: PhotoSize;
  scanMode: boolean;
  scanAeDivisor: ScanAeDivisor;
  scanIsoCap: number;
  videoPreviewDetails: VideoPreviewDetails | null;
  videoPreviewUrl: string | null;
  videoRecording: boolean;
  videoStatus: VideoRecordingStatusEvent | null;
  cameraFov: number;
  cameraRoiPosition: CameraRoiPosition;
  cameraSettingsApplying: boolean;
  cameraSettingsStatus: string;
  rawJsonExpanded: boolean;
  scanActive: boolean;
  selectedDiscoveredDevice: Device | null;
  selectedScanModel: ScanModel;
  directStreamReceiverRunning: boolean;
  directStreamWhipUrl: string | null;
  streamCloudServerEnabled: boolean;
  streamFps: number;
  streamProtocol: StreamProtocol;
  streamPreviewReady: boolean;
  streamRequested: boolean;
  streamResolvedConfig: StreamResolvedConfig | null;
  streamStartPending: boolean;
  streamStartedAt: number | null;
  streamStatus: string;
  streamUrl: string;
  webhookUrl: string;
  phone: PhoneSdkRuntimeState;
};

export type BluetoothSdkExampleActions = {
  captureAndUpload: () => Promise<void>;
  clearDefaultDevice: () => Promise<void>;
  clearDisplay: () => Promise<void>;
  connect: () => Promise<void>;
  connectDevice: (device: Device) => Promise<void>;
  disconnect: () => Promise<void>;
  displayHello: () => Promise<void>;
  forgetCurrentWifiNetwork: () => Promise<void>;
  copyGalleryHotspotPassword: () => Promise<void>;
  copyGalleryServerUrl: () => Promise<void>;
  openBluetoothSettings: () => Promise<void>;
  openGalleryServer: () => Promise<void>;
  openPhotoPreview: () => Promise<void>;
  openWifiSettings: () => Promise<void>;
  checkForOtaUpdate: () => Promise<void>;
  requestWifiScan: () => Promise<void>;
  playMicRecording: () => Promise<void>;
  selectDiscoveredDevice: (device: Device) => void;
  selectScanModel: (model: ScanModel) => void;
  selectLedColor: (color: LedColor) => Promise<void>;
  selectLedMode: (mode: LedMode) => Promise<void>;
  selectProtocol: (protocol: StreamProtocol) => void;
  sendWifiCredentials: (ssid: string, password: string, requiresPassword: boolean) => Promise<void>;
  setGalleryModeEnabled: (enabled: boolean) => Promise<void>;
  setPhotoCompression: (compression: PhotoCompression) => void;
  setPhotoCloudServerEnabled: (enabled: boolean) => Promise<void>;
  setPhotoAeExposureDivisor: (divisor: PhotoAeExposureDivisor | null) => void;
  setPhotoIsoCap: (isoCap: PhotoIsoCap | null) => void;
  setPhotoNoiseReduction: (value: PhotoTuningFlag) => void;
  setPhotoEdgeEnhancement: (value: PhotoTuningFlag) => void;
  setPhotoMfnr: (value: PhotoTuningFlag) => void;
  setPhotoZsl: (value: PhotoTuningFlag) => void;
  setPhotoIspDigitalGain: (gain: PhotoIspDigitalGain | null) => void;
  setPhotoIspAnalogGain: (gain: PhotoIspAnalogGain | null) => void;
  setPhotoExposureManual: (enabled: boolean) => void;
  setPhotoIso: (iso: number) => void;
  setPhotoExposureTimeNs: (exposureTimeNs: number) => void;
  setPhotoSize: (size: PhotoSize) => void;
  setScanMode: (enabled: boolean) => void;
  setScanAeDivisor: (divisor: ScanAeDivisor) => void;
  setScanIsoCap: (isoCap: number) => void;
  setCameraFov: (fov: number) => void;
  setCameraRoiPosition: (roiPosition: CameraRoiPosition) => void;
  applyCameraSettings: () => Promise<void>;
  setRawJsonExpanded: (expanded: boolean) => void;
  setStreamCloudServerEnabled: (enabled: boolean) => Promise<void>;
  setStreamFps: (fps: number) => void;
  setStreamUrl: (url: string) => void;
  setWebhookUrl: (url: string) => void;
  setVoiceActivityDetectionEnabled: (enabled: boolean) => Promise<void>;
  startScan: () => Promise<void>;
  startOtaUpdate: () => Promise<void>;
  testWebhook: () => Promise<void>;
  toggleHotspot: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleVideoRecording: () => Promise<void>;
  toggleStream: () => Promise<void>;
};

export type BluetoothSdkExampleModel = BluetoothSdkExampleState & BluetoothSdkExampleActions;

const PHOTO_APP_ID = 'com.mentra.examples.reactnative';
const PHOTO_POLL_ATTEMPTS = 45;
const VIDEO_POLL_ATTEMPTS = 180;
const DIRECT_PHOTO_UPLOAD_TIMEOUT_MS = 75_000;
const DIRECT_WEBRTC_RECEIVER_WARMUP_MS = 1000;
const BARCODE_SCAN_VISIBLE_TIMEOUT_MS = 2_500;
const ANDROID_12_API_LEVEL = 31;
const MIC_SAMPLE_RATE = 16000;
const MIC_CHANNEL_COUNT = 1;
const MIC_BITS_PER_SAMPLE = 16;
const DEFAULT_DEVICE_FILE = 'mentra-default-device.json';
const CLOUD_URLS_FILE = 'mentra-cloud-urls.json';
const IOS_AUDIO_ROUTE_HINT =
  'Audio output: iOS cannot pair audio from the app. Open Settings > Bluetooth and connect/select the glasses before playback.';

const defaultDeviceStorage: DefaultDeviceStorage = {
  load: loadPersistedDefaultDevice,
  save: savePersistedDefaultDevice,
};

declare const process: {
  env?: {
    EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL?: string;
    EXPO_PUBLIC_MENTRA_STREAM_URL?: string;
  };
};

export function useBluetoothSdkExample(options: BluetoothSdkExampleOptions = {}): BluetoothSdkExampleModel {
  const activeTab = options.activeTab ?? 'device';
  const [events, setEvents] = useState<SdkConsoleEvent[]>([
    event('LIVE', 'SDK ready. Scan to discover glasses.'),
  ]);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState('No actions yet.');
  const [permissionStatus, setPermissionStatus] = useState(
    Platform.OS === 'android'
      ? 'Permissions: not requested'
      : 'Permissions: iOS prompts as needed',
  );
  const [webhookUrl, setWebhookUrlState] = useState(
    process.env?.EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL ?? PHOTO_UPLOAD_DEFAULT_URL,
  );
  const [photoCloudServerEnabled, setPhotoCloudServerEnabledState] = useState(false);
  const [phonePhotoReceiverRunning, setPhonePhotoReceiverRunning] = useState(false);
  const [phonePhotoUploadUrl, setPhonePhotoUploadUrl] = useState<string | null>(null);
  const [cameraStatus, setCameraStatus] = useState('Camera: ready to capture to phone');
  const [cameraButtonNotice, setCameraButtonNotice] = useState<string | null>(null);
  const [barcodeScan, setBarcodeScan] = useState<BarcodeScanDetails>({
    barcodes: [],
    state: 'idle',
  });
  const barcodeScanRef = useRef<BarcodeScanDetails>({
    barcodes: [],
    state: 'idle',
  });
  const [photoPreviewDetails, setPhotoPreviewDetails] =
    useState<PhotoPreviewDetails | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoStatus, setPhotoStatus] = useState<PhotoStatusEvent | null>(null);
  const [videoPreviewDetails, setVideoPreviewDetails] =
    useState<VideoPreviewDetails | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [videoRecording, setVideoRecording] = useState(false);
  const [videoStatus, setVideoStatus] = useState<VideoRecordingStatusEvent | null>(null);
  const [photoSize, setPhotoSize] = useState<PhotoSize>('max');
  const [photoCompression, setPhotoCompression] = useState<PhotoCompression>('none');
  const [scanMode, setScanMode] = useState(false);
  const [scanAeDivisor, setScanAeDivisor] = useState<ScanAeDivisor>(SCAN_DEFAULT_AE_DIVISOR);
  const [scanIsoCap, setScanIsoCap] = useState(SCAN_DEFAULT_ISO_CAP);
  const [photoAeExposureDivisor, setPhotoAeExposureDivisor] =
    useState<PhotoAeExposureDivisor | null>(null);
  const [photoIsoCap, setPhotoIsoCap] = useState<PhotoIsoCap | null>(null);
  const [photoNoiseReduction, setPhotoNoiseReduction] = useState<PhotoTuningFlag>('unset');
  const [photoEdgeEnhancement, setPhotoEdgeEnhancement] = useState<PhotoTuningFlag>('unset');
  const [photoMfnr, setPhotoMfnr] = useState<PhotoTuningFlag>('unset');
  const [photoZsl, setPhotoZsl] = useState<PhotoTuningFlag>('unset');
  const [photoIspDigitalGain, setPhotoIspDigitalGain] =
    useState<PhotoIspDigitalGain | null>(null);
  const [photoIspAnalogGain, setPhotoIspAnalogGain] =
    useState<PhotoIspAnalogGain | null>(null);
  const [photoExposureManual, setPhotoExposureManual] = useState(false);
  const [photoExposureTimeNs, setPhotoExposureTimeNsState] = useState(PHOTO_EXPOSURE_DEFAULT_NS);
  const [photoIso, setPhotoIsoState] = useState(PHOTO_ISO_DEFAULT);
  const [cameraFov, setCameraFovState] = useState(CAMERA_FOV_DEFAULT);
  const [cameraRoiPosition, setCameraRoiPositionState] = useState<CameraRoiPosition>('center');
  const [cameraSettingsApplying, setCameraSettingsApplying] = useState(false);
  const cameraSettingsApplyingRef = useRef(false);
  const [cameraSettingsStatus, setCameraSettingsStatus] = useState('Camera settings: default');
  const [streamCloudServerEnabled, setStreamCloudServerEnabledState] = useState(false);
  const [directStreamReceiverRunning, setDirectStreamReceiverRunning] = useState(false);
  const [directStreamWhipUrl, setDirectStreamWhipUrl] = useState<string | null>(null);
  const [streamProtocol, setStreamProtocol] =
    useState<StreamProtocol>('webrtc');
  const [streamUrl, setStreamUrlState] = useState(
    process.env?.EXPO_PUBLIC_MENTRA_STREAM_URL ?? STREAM_DEFAULT_URLS.webrtc,
  );
  const [streamFps, setStreamFps] = useState(STREAM_DEFAULT_FPS);
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [streamRequested, setStreamRequested] = useState(false);
  const [streamStartPending, setStreamStartPending] = useState(false);
  const [streamPreviewReady, setStreamPreviewReady] = useState(false);
  const [streamResolvedConfig, setStreamResolvedConfig] =
    useState<StreamResolvedConfig | null>(null);
  const [streamStatus, setStreamStatus] = useState('Ready to stream WebRTC to phone');
  const [micRecording, setMicRecording] = useState(false);
  const [micPlaying, setMicPlaying] = useState(false);
  const [micElapsedSeconds, setMicElapsedSeconds] = useState(0);
  const [pcmFrames, setPcmFrames] = useState(0);
  const [pcmBytes, setPcmBytes] = useState(0);
  const [speaking, setSpeaking] = useState<boolean | null>(null);
  const [voiceActivityDetectionEnabled, setVoiceActivityDetectionEnabledState] = useState(false);
  const [lastMicBytes, setLastMicBytes] = useState(0);
  const [lastMicDurationSeconds, setLastMicDurationSeconds] = useState<number | null>(null);
  const [micPlaybackHint, setMicPlaybackHint] = useState<string | null>(null);
  const [otaStatus, setOtaStatus] = useState<OtaStatusEvent | null>(null);
  const [otaDisplayPercent, setOtaDisplayPercent] = useState<number | null>(null);
  const [otaStatusMessage, setOtaStatusMessage] = useState<string | null>(null);
  const [otaUpdateAvailable, setOtaUpdateAvailable] = useState(false);
  const [micAudioRouteStatus, setMicAudioRouteStatus] = useState(
    Platform.OS === 'ios'
      ? IOS_AUDIO_ROUTE_HINT
      : 'Audio output: waiting for Bluetooth audio status',
  );
  const [galleryServerReachable, setGalleryServerReachable] = useState<boolean | null>(null);
  const [galleryServerStatus, setGalleryServerStatus] = useState(
    'Gallery server: enable hotspot to check',
  );
  const [ledColor, setLedColor] = useState<LedColor>('green');
  const [ledMode, setLedMode] = useState<LedMode>('Off');
  const [rawJsonExpanded, setRawJsonExpanded] = useState(false);
  const activePhotoRequestIdRef = useRef<string | null>(null);
  const activeVideoRequestIdRef = useRef<string | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const videoRecordingRef = useRef(false);
  const streamStartPendingRef = useRef(false);
  const pollGenerationRef = useRef(0);
  const videoPollGenerationRef = useRef(0);
  const photoCloudServerEnabledRef = useRef(false);
  const scanModeRef = useRef(false);
  const buttonPhotoSettingsSyncGenerationRef = useRef(0);
  const buttonPhotoSettingsSyncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const streamCloudServerEnabledRef = useRef(false);
  const activeTabRef = useRef<ExampleTabKey>('device');
  const galleryModeEnabledRef = useRef(false);
  const captureAndUploadRef = useRef<() => Promise<void>>(async () => undefined);
  const photoUploadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewHealthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const directStreamFrameStaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const barcodeScanTokenRef = useRef(0);
  const photoPreviewOpeningRef = useRef(false);
  const galleryModePhotoRequestIdsRef = useRef(new Set<string>());
  const phonePhotoReceiverRef = useRef<PhotoReceiverResult | null>(null);
  const phonePhotoReceiverStartPromiseRef = useRef<Promise<PhotoReceiverResult> | null>(null);
  const lastCameraInputCaptureAtRef = useRef(0);
  const lastMicFileUriRef = useRef<string | null>(null);
  const micElapsedSecondsRef = useRef(0);
  const micElapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const micPcmChunksRef = useRef<MicPcmChunk[]>([]);
  const micPcmChunkIndexRef = useRef(0);
  const micPcmStatsRef = useRef({bytes: 0, frames: 0});
  const micPlayerRef = useRef<AudioPlayer | null>(null);
  const micPlayerSubscriptionRef = useRef<{remove: () => void} | null>(null);
  const micPlayingRef = useRef(false);
  const micRecordingRef = useRef(false);
  const micStartedAtRef = useRef<number | null>(null);
  const didAutoConnectDefaultRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const autoOtaCheckedConnectionRef = useRef<string | null>(null);
  const autoOtaCheckInProgressRef = useRef(false);
  const latestAutoOtaCheckKeyRef = useRef<string | null>(null);
  const otaStatusRef = useRef<OtaStatusEvent | null>(null);
  const glassesConnectedRef = useRef(false);
  const glassesWifiConnectedRef = useRef(false);
  const otaDisplayProgressRef = useRef<{sessionId: string; percent: number} | null>(null);
  const postOtaCheckInProgressRef = useRef(false);
  const postOtaCheckedSessionRef = useRef<string | null>(null);
  const [autoOtaCheckRetryTick, setAutoOtaCheckRetryTick] = useState(0);
  const [latestVersionInfoSignature, setLatestVersionInfoSignature] = useState<string | null>(null);

  const bluetooth = useMentraBluetooth({
    defaultDeviceStorage,
    defaultModel: DeviceModels.MentraLive,
    onError: (error: unknown) => {
      addEvent('TX', `SDK lifecycle error: ${formatError(error)}`);
    },
    scanTimeoutMs: 10_000,
  });

  const defaultDevice = bluetooth.defaultDevice;
  const discoveredDevices = bluetooth.scan.devices;
  const glasses = bluetooth.glasses;
  const glassesConnected = glasses.connected;
  const glassesWifiConnected = isGlassesWifiConnected(glasses);
  const connectedDeviceKey = glassesConnected
    ? [
        glasses.device.bluetoothName,
        glasses.device.serialNumber,
        glasses.device.deviceModel,
      ].filter(Boolean).join('|') || 'connected'
    : null;
  const autoOtaCheckKey = connectedDeviceKey
    ? `${connectedDeviceKey}|${latestVersionInfoSignature ?? otaVersionSignature(glasses)}`
    : null;
  const otaInProgress = isOtaEventInProgress(otaStatus);
  const phone = bluetooth.sdk;
  const scanActive = bluetooth.scan.active;
  const galleryModeEnabled = phone.galleryMode.enabled;
  const hotspotEnabled = enabledHotspotStatus(glasses) !== null;
  const selectedDiscoveredDevice = bluetooth.scan.selectedDevice;
  const selectedScanModel = scanModelFromDeviceModel(bluetooth.scan.model);
  activeTabRef.current = activeTab;
  galleryModeEnabledRef.current = galleryModeEnabled;
  latestAutoOtaCheckKeyRef.current = autoOtaCheckKey;
  otaStatusRef.current = otaStatus;
  glassesConnectedRef.current = glassesConnected;
  glassesWifiConnectedRef.current = glassesWifiConnected;

  useEffect(() => {
    let cancelled = false;
    void loadPersistedCloudUrls().then((persisted) => {
      if (cancelled || !persisted) {
        return;
      }
      if (!process.env?.EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL && typeof persisted.webhookUrl === 'string') {
        setWebhookUrlState(persisted.webhookUrl);
      }
      const streamUrlOverride = process.env?.EXPO_PUBLIC_MENTRA_STREAM_URL;
      if (!streamUrlOverride && persisted.streamProtocol) {
        setStreamProtocol(persisted.streamProtocol);
      }
      if (!streamUrlOverride && typeof persisted.streamUrl === 'string') {
        setStreamUrlState(persisted.streamUrl);
      } else if (!streamUrlOverride && persisted.streamProtocol) {
        setStreamUrlState(STREAM_DEFAULT_URLS[persisted.streamProtocol]);
      }
    }).catch((error) => {
      addEvent('LIVE', `cloud URL restore failed: ${formatError(error)}`);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (didAutoConnectDefaultRef.current || glassesConnected) {
      return;
    }
    if (!defaultDevice) {
      return;
    }
    didAutoConnectDefaultRef.current = true;
    void runAction('Auto-connect default', async () => {
      if (!(await ensureAndroidPermissions('connect'))) {
        throw new Error('Bluetooth permissions are required to connect.');
      }
      await bluetooth.connectDefault();
    });
  }, [defaultDevice, glassesConnected]);

  useEffect(() => {
    if (!glassesConnected) {
      autoOtaCheckedConnectionRef.current = null;
      autoOtaCheckInProgressRef.current = false;
      latestAutoOtaCheckKeyRef.current = null;
      postOtaCheckInProgressRef.current = false;
      postOtaCheckedSessionRef.current = null;
      setLatestVersionInfoSignature(null);
      return;
    }
    if (
      !autoOtaCheckKey ||
      !glassesWifiConnected ||
      autoOtaCheckedConnectionRef.current === autoOtaCheckKey ||
      autoOtaCheckInProgressRef.current ||
      otaInProgress
    ) {
      return;
    }

    const checkedKey = autoOtaCheckKey;
    autoOtaCheckInProgressRef.current = true;
    void runAction('Auto-check OTA', async () => {
      let checkSucceeded = false;
      try {
        await checkForOtaUpdateResult();
        checkSucceeded = true;
      } finally {
        autoOtaCheckInProgressRef.current = false;
        if (!checkSucceeded) {
          return;
        }
        autoOtaCheckedConnectionRef.current = checkedKey;
        if (
          latestAutoOtaCheckKeyRef.current &&
          latestAutoOtaCheckKeyRef.current !== checkedKey &&
          !isOtaEventInProgress(otaStatusRef.current)
        ) {
          setAutoOtaCheckRetryTick((tick) => tick + 1);
        }
      }
    });
  }, [autoOtaCheckKey, autoOtaCheckRetryTick, glassesConnected, glassesWifiConnected, otaInProgress]);

  useEffect(() => {
    const subscriptions = [
      BluetoothSdk.addListener('button_press', handleButtonPress),
      BluetoothSdk.addListener('touch_event', handleTouchEvent),
      BluetoothSdk.addListener('voice_activity_detection_status', (payload: VoiceActivityDetectionStatusEvent) => {
        setVoiceActivityDetectionEnabledState(payload.voiceActivityDetectionEnabled);
        if (!payload.voiceActivityDetectionEnabled) {
          setSpeaking(null);
        }
        addEvent('LIVE', `voice activity detection ${payload.voiceActivityDetectionEnabled ? 'enabled' : 'disabled'}`);
      }),
      BluetoothSdk.addListener('speaking_status', (payload: SpeakingStatusEvent) => {
        setSpeaking(payload.speaking);
      }),
      BluetoothSdk.addListener('battery_status', (payload) => {
        addEvent('STORE', `battery ${payload.level}%${payload.charging ? ' charging' : ''}`);
      }),
      BluetoothSdk.addListener('wifi_status_change', (payload) => {
        addEvent('STORE', `Wi-Fi ${payload.state === 'connected' ? payload.ssid : payload.state}`);
      }),
      BluetoothSdk.addListener('hotspot_status_change', (payload) => {
        setGalleryServerReachable(null);
        setGalleryServerStatus(
          payload.state === 'enabled'
            ? `Gallery server: http://${payload.localIp}:8089`
            : 'Gallery server: hotspot off',
        );
        addEvent('STORE', `hotspot ${summarizeMap(payload)}`);
      }),
      BluetoothSdk.addListener('hotspot_error', (payload) => {
        setGalleryServerReachable(false);
        setGalleryServerStatus('Gallery server: hotspot error');
        addEvent('TX', `hotspot error ${summarizeMap(payload)}`);
      }),
      MentraPhotoReceiver.addListener('photoUpload', handleDirectPhotoUpload),
      MentraPhotoReceiver.addListener('receiverStatus', handlePhotoReceiverStatus),
      MentraVideoStreamReceiver.addListener('receiverStatus', handleVideoStreamReceiverStatus),
      MentraVideoStreamReceiver.addListener('streamFrame', handleDirectStreamFrame),
      MentraVideoStreamReceiver.addListener('streamFirstFrame', handleDirectStreamFirstFrame),
      BluetoothSdk.addListener('photo_status', handlePhotoStatus),
      BluetoothSdk.addListener('video_recording_status', handleVideoRecordingStatus),
      BluetoothSdk.addListener('media_success', handleMediaUpload),
      BluetoothSdk.addListener('media_error', handleMediaUpload),
      BluetoothSdk.addListener('stream_status', (payload: StreamStatusEvent) => {
        applyStreamStatus(payload);
        if (streamCloudServerEnabledRef.current) {
          setStreamStatus(JSON.stringify(payload));
        }
        addEvent('LIVE', `stream status ${summarizeMap(payload)}`);
      }),
      BluetoothSdk.addListener('version_info', (payload: VersionInfoEvent) => {
        setLatestVersionInfoSignature(otaVersionInfoSignature(payload));
      }),
      BluetoothSdk.addListener('ota_status', applyOtaStatus),
      BluetoothSdk.addListener('mic_pcm', (payload: MicPcmEvent) => {
        if (!micRecordingRef.current) {
          return;
        }
        const frame = copyPcmFrame(payload.pcm);
        if (frame.byteLength === 0) {
          return;
        }
        const isFirstFrame = micPcmStatsRef.current.frames === 0;
        micPcmChunksRef.current.push({
          data: frame,
          index: micPcmChunkIndexRef.current,
        });
        micPcmChunkIndexRef.current += 1;
        micPcmStatsRef.current.frames += 1;
        micPcmStatsRef.current.bytes += frame.byteLength;
        if (isFirstFrame) {
          addEvent('LIVE', `recording ${formatMicPcmMetadata(payload)}`);
        }
      }),
      BluetoothSdk.addListener('mic_lc3', (payload: MicLc3Event) => {
        if (micRecordingRef.current) {
          addEvent('LIVE', `received LC3 mic frame while PCM recording is enabled (${formatMicLc3Metadata(payload)})`);
        }
      }),
      BluetoothSdk.addListener('audio_connected', (payload: AudioConnectedEvent) => {
        const deviceName = payload.deviceName || 'Bluetooth audio';
        setMicAudioRouteStatus(`Audio output: connected to ${deviceName}`);
        setMicPlaybackHint(null);
        addEvent('LIVE', `audio connected ${deviceName}`);
      }),
      BluetoothSdk.addListener('audio_disconnected', () => {
        setMicAudioRouteStatus(
          Platform.OS === 'ios'
            ? IOS_AUDIO_ROUTE_HINT
            : 'Audio output: Bluetooth audio is not connected',
        );
        addEvent('LIVE', 'audio disconnected');
      }),
      BluetoothSdk.addListener(
        'compatible_glasses_search_stop',
        (payload: CompatibleGlassesSearchStopEvent) => {
          addEvent('BLE', `scan stopped for ${payload.deviceModel ?? 'glasses'}`);
        },
      ),
      BluetoothSdk.addListener('log', (payload: LogEvent) => {
        addEvent('LIVE', payload.message);
      }),
    ];

    if (webhookUrl) {
      addEvent('LIVE', 'Loaded webhook URL from env.');
    }

    void ensureAndroidPermissions('startup');

    return () => {
      subscriptions.forEach((subscription) => subscription.remove());
      clearPhotoUploadTimeout();
      stopPreviewHealthPoll();
      stopDirectStreamFrameWatchdog();
      void stopPhonePhotoReceiver().catch(() => undefined);
      void MentraVideoStreamReceiver.stopWebRtcReceiver().catch(() => undefined);
      activeStreamIdRef.current = null;
      activeVideoRequestIdRef.current = null;
      videoRecordingRef.current = false;
      streamStartPendingRef.current = false;
      activePhotoRequestIdRef.current = null;
      pollGenerationRef.current += 1;
      videoPollGenerationRef.current += 1;
      stopMicElapsedTimer();
      stopMicPlaybackSync();
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'camera' || photoCloudServerEnabled || !glassesConnected) {
      return;
    }
    void ensurePhonePhotoReceiver('camera tab').catch((error) => {
      addEvent('TX', `photo receiver prewarm failed: ${formatError(error)}`);
    });
  }, [activeTab, photoCloudServerEnabled, glassesConnected]);

  useEffect(() => {
    if (glassesConnected) {
      if (!wasConnectedRef.current && scanMode) {
        // Re-apply scan preset on reconnect so glasses button preset stays in sync.
        void syncScanCapturePreset(true, buildButtonPhotoSettings());
      }
      wasConnectedRef.current = true;
      return;
    }
    if (wasConnectedRef.current && isDisconnectedStatus(glasses)) {
      wasConnectedRef.current = false;
      applyDisconnectedState('Disconnected');
    }
  }, [glassesConnected, glasses, scanMode, scanAeDivisor, scanIsoCap]); // eslint-disable-line react-hooks/exhaustive-deps

  function addEvent(tag: SdkConsoleEvent['tag'], text: string) {
    setEvents((current) => [event(tag, text), ...current].slice(0, 30));
  }

  function handleButtonPress(payload: ButtonPressEvent) {
    addEvent('LIVE', `button ${payload.buttonId}: ${payload.pressType}`);
    if (activeTabRef.current !== 'camera' || !isCameraActionButtonPress(payload)) {
      return;
    }
    triggerCameraInputCapture('button');
  }

  function handleTouchEvent(payload: TouchEvent) {
    const gesture = payload.gestureName ?? payload.deviceModel ?? 'event';
    addEvent(
      'LIVE',
      `${gesture.toLowerCase().includes('swipe') ? 'swipe' : 'touch'} ${gesture}`,
    );
    if (activeTabRef.current !== 'camera' || !isCameraActionTouchEvent(payload)) {
      return;
    }
    triggerCameraInputCapture(gesture);
  }

  function triggerCameraInputCapture(source: string) {
    if (galleryModeEnabledRef.current) {
      showCameraButtonNotice(CAMERA_BUTTON_GALLERY_MODE_NOTICE);
      addEvent('TX', 'gallery mode kept button photo on glasses');
      return;
    }
    if (activePhotoRequestIdRef.current) {
      addEvent('LIVE', `ignoring ${source}; photo already in progress`);
      return;
    }
    const now = Date.now();
    if (now - lastCameraInputCaptureAtRef.current < 1000) {
      addEvent('LIVE', `ignoring duplicate camera input ${source}`);
      return;
    }
    lastCameraInputCaptureAtRef.current = now;
    addEvent('TX', `camera input capture ${source}`);
    void captureAndUploadRef.current();
  }

  async function runAction(label: string, action: () => Promise<void> | void) {
    setActiveAction(label);
    setLastAction(`Running: ${label}`);
    addEvent('TX', label);
    try {
      await action();
      setLastAction(`Requested: ${label}`);
    } catch (error) {
      const message = formatError(error);
      setLastAction(`Failed: ${label} - ${message}`);
      addEvent('TX', `${label} failed: ${message}`);
    } finally {
      setActiveAction((current) => (current === label ? null : current));
    }
  }

  async function ensureAndroidPermissions(reason: string) {
    if (Platform.OS !== 'android') {
      return true;
    }

    const permissions = androidRuntimePermissions();
    const results = await PermissionsAndroid.requestMultiple(permissions);
    const denied = permissions.filter(
      (permission) =>
        results[permission] !== PermissionsAndroid.RESULTS.GRANTED,
    );

    if (denied.length > 0) {
      setPermissionStatus(`Permissions: missing ${denied.length}`);
      addEvent('BLE', `permissions denied for ${reason}: ${denied.join(', ')}`);
      return false;
    }

    setPermissionStatus('Permissions: granted');
    return true;
  }

  async function startScan() {
    const model = selectedScanModel;
    await runAction(`Scan ${scanModelLabel(model)}`, async () => {
      if (!(await ensureAndroidPermissions('scan'))) {
        throw new Error('Bluetooth permissions are required to scan.');
      }
      bluetooth.scan.selectDevice(null);
      const devices = await bluetooth.scan.start(model);
      addEvent('BLE', `scan completed with ${devices.length} result${devices.length === 1 ? '' : 's'}`);
    });
  }

  async function connect() {
    await runAction('Connect', async () => {
      if (!(await ensureAndroidPermissions('connect'))) {
        throw new Error('Bluetooth permissions are required to connect.');
      }
      if (selectedDiscoveredDevice) {
        await bluetooth.connect(selectedDiscoveredDevice);
        return;
      }
      if (discoveredDevices.length === 0 && defaultDevice) {
        await bluetooth.connectDefault();
        return;
      }
      if (discoveredDevices.length > 0) {
        throw new Error('Choose one of the discovered glasses first.');
      }
      throw new Error('Scan first to choose nearby glasses.');
    });
  }

  async function connectDevice(device: Device) {
    bluetooth.scan.selectDevice(device);
    await runAction(`Connect ${device.name}`, async () => {
      if (!(await ensureAndroidPermissions('connect'))) {
        throw new Error('Bluetooth permissions are required to connect.');
      }
      await bluetooth.connect(device);
    });
  }

  async function checkForOtaUpdate() {
    await runAction('Check OTA', async () => {
      if (!glassesConnected) {
        throw new Error('Connect glasses first.');
      }
      requireGlassesWifi('check for OTA updates');
      if (isOtaEventInProgress(otaStatusRef.current)) {
        addEvent('TX', 'OTA check skipped while update is in progress');
        return;
      }
      await checkForOtaUpdateResult();
    });
  }

  async function checkForOtaUpdateResult(): Promise<boolean> {
    const updateAvailable = await BluetoothSdk.checkForOtaUpdate();
    if (isOtaEventInProgress(otaStatusRef.current)) {
      addEvent('LIVE', 'OTA check result ignored while update is in progress');
      return updateAvailable;
    }
    clearOtaDisplayProgress();
    if (updateAvailable) {
      otaStatusRef.current = null;
      setOtaStatus(null);
      setOtaStatusMessage(null);
      setOtaUpdateAvailable(true);
      addEvent('LIVE', 'OTA update available');
      return true;
    }
    otaStatusRef.current = null;
    setOtaStatus(null);
    setOtaStatusMessage('Glasses firmware is up to date');
    setOtaUpdateAvailable(false);
    addEvent('LIVE', 'OTA up to date');
    return false;
  }

  function clearOtaDisplayProgress() {
    otaDisplayProgressRef.current = null;
    setOtaDisplayPercent(null);
  }

  function updateOtaDisplayPercent(payload: OtaStatusEvent) {
    const incomingPercent = Math.max(0, Math.min(payload.overall_percent ?? 0, 100));
    const sessionId = otaStatusSessionKey(payload);
    const previous =
      otaDisplayProgressRef.current?.sessionId === sessionId
        ? otaDisplayProgressRef.current.percent
        : null;
    const displayPercent =
      payload.status === 'complete'
        ? 100
        : payload.status === 'in_progress' || payload.status === 'step_complete'
          ? Math.max(previous ?? incomingPercent, incomingPercent)
          : incomingPercent;

    otaDisplayProgressRef.current = {sessionId, percent: displayPercent};
    return displayPercent;
  }

  function schedulePostOtaCheck(payload: OtaStatusEvent) {
    if (payload.status !== 'complete') {
      return;
    }
    const sessionId = otaStatusSessionKey(payload);
    if (postOtaCheckInProgressRef.current || postOtaCheckedSessionRef.current === sessionId) {
      return;
    }

    postOtaCheckInProgressRef.current = true;
    autoOtaCheckInProgressRef.current = true;
    void runAction('Verify OTA', async () => {
      let checkSucceeded = false;
      try {
        if (!glassesConnectedRef.current || !glassesWifiConnectedRef.current) {
          addEvent('LIVE', 'OTA complete; skipped verification because glasses Wi-Fi is unavailable');
          return;
        }
        await checkForOtaUpdateResult();
        checkSucceeded = true;
      } finally {
        postOtaCheckInProgressRef.current = false;
        autoOtaCheckInProgressRef.current = false;
        if (checkSucceeded) {
          postOtaCheckedSessionRef.current = sessionId;
          if (latestAutoOtaCheckKeyRef.current) {
            autoOtaCheckedConnectionRef.current = latestAutoOtaCheckKeyRef.current;
          }
        }
      }
    });
  }

  async function startOtaUpdate() {
    await runAction('Start OTA', async () => {
      if (!glassesConnected) {
        throw new Error('Connect glasses first.');
      }
      requireGlassesWifi('start OTA updates');
      postOtaCheckedSessionRef.current = null;
      clearOtaDisplayProgress();
      await BluetoothSdk.startOtaUpdate();
      addEvent('LIVE', 'OTA start acknowledged');
    });
  }

  async function disconnect() {
    await runAction('Disconnect', async () => {
      stopDirectStreamFrameWatchdog();
      await bluetooth.disconnect();
      applyDisconnectedState('Disconnected');
    });
  }

  async function clearDefaultDevice() {
    await runAction('Clear default', async () => {
      await bluetooth.clearDefaultDevice();
    });
  }

  function selectDiscoveredDevice(device: Device) {
    bluetooth.scan.selectDevice(device);
    setLastAction(`Selected: ${device.name}`);
  }

  function selectScanModel(model: ScanModel) {
    if (selectedScanModel === model) {
      return;
    }
    bluetooth.scan.setModel(model);
    setLastAction(`Selected scan model: ${scanModelLabel(model)}`);
  }

  async function displayHello() {
    await runAction('Display Hello', async () => {
      requireDisplaySupport('display text');
      await BluetoothSdk.displayText('Hello from Mentra Bluetooth SDK', 0, 0, 24);
    });
  }

  async function clearDisplay() {
    await runAction('Clear Display', async () => {
      requireDisplaySupport('clear the display');
      await BluetoothSdk.clearDisplay();
    });
  }

  async function setGalleryModeEnabledAction(enabled: boolean) {
    await runAction(enabled ? 'Save in gallery mode' : 'Report button events', async () => {
      requireConnected('change gallery mode');
      await bluetooth.setGalleryModeEnabled(enabled);
    });
  }

  function syncScanCapturePreset(
    enabled: boolean,
    settings?: ButtonPhotoSettings,
  ) {
    if (!isGlassesConnected(bluetooth.glasses)) {
      return;
    }
    const generation = buttonPhotoSettingsSyncGenerationRef.current + 1;
    buttonPhotoSettingsSyncGenerationRef.current = generation;
    const label = enabled ? 'Apply scan preset on glasses' : 'Restore photo preset on glasses';
    const nextSettings = enabled
      ? settings ?? buildButtonPhotoSettings()
      : {
          size: photoSize,
          mfnr: true,
          zsl: true,
          resetCaptureTuning: true,
        };
    const syncTask = buttonPhotoSettingsSyncQueueRef.current.catch(() => undefined).then(async () => {
      if (generation !== buttonPhotoSettingsSyncGenerationRef.current) {
        return;
      }
      await runAction(label, async () => {
        if (generation !== buttonPhotoSettingsSyncGenerationRef.current) {
          return;
        }
        requireConnected('sync photo capture settings');
        await BluetoothSdk.setButtonPhotoSettings(nextSettings);
      });
    });
    buttonPhotoSettingsSyncQueueRef.current = syncTask;
  }

  function setScanModeAction(enabled: boolean) {
    scanModeRef.current = enabled;
    setScanMode(enabled);
    if (enabled) {
      applyBarcodeScanPhotoPresetValues();
      void syncScanCapturePreset(true, buttonPhotoSettingsFromBarcodePreset());
    } else {
      resetBarcodeScan();
      void syncScanCapturePreset(false);
    }
  }

  function setScanAeDivisorAction(divisor: ScanAeDivisor) {
    setScanAeDivisor(divisor);
    setPhotoAeExposureDivisor(divisor);
    if (scanMode) {
      void syncScanCapturePreset(true, buildButtonPhotoSettings({aeExposureDivisor: divisor}));
    }
  }

  function setScanIsoCapAction(isoCapValue: number) {
    setScanIsoCap(isoCapValue);
    setPhotoIsoCap(isoCapValue as PhotoIsoCap);
    if (scanMode) {
      void syncScanCapturePreset(true, buildButtonPhotoSettings({isoCap: isoCapValue}));
    }
  }

  function optionalTuningFlag(value: PhotoTuningFlag) {
    if (value === 'unset') {
      return undefined;
    }
    return value === 'on';
  }

  function buttonPhotoSettingsFromBarcodePreset(): ButtonPhotoSettings {
    return {
      ...SCAN_MODE_BUTTON_PRESET,
      aeExposureDivisor: BARCODE_SCAN_PHOTO_PRESET.aeExposureDivisor,
      isoCap: BARCODE_SCAN_PHOTO_PRESET.isoCap,
    };
  }

  function buildButtonPhotoSettings(overrides: ButtonPhotoSettingsOverrides = {}): ButtonPhotoSettings {
    const hasOverride = (key: keyof ButtonPhotoSettingsOverrides) =>
      Object.prototype.hasOwnProperty.call(overrides, key);
    const settings: ButtonPhotoSettings = {
      size: overrides.size ?? photoSize,
      compress: overrides.compress ?? photoCompression,
      sound: false,
    };
    let shouldResetCaptureTuning = false;
    const aeExposureDivisor = hasOverride('aeExposureDivisor')
      ? overrides.aeExposureDivisor
      : photoAeExposureDivisor;
    if (aeExposureDivisor != null) {
      settings.aeExposureDivisor = aeExposureDivisor;
    } else {
      shouldResetCaptureTuning = true;
    }
    const isoCap = hasOverride('isoCap') ? overrides.isoCap : photoIsoCap;
    if (isoCap != null) {
      settings.isoCap = isoCap;
    } else {
      shouldResetCaptureTuning = true;
    }
    const noiseReduction = hasOverride('noiseReduction')
      ? overrides.noiseReduction
      : optionalTuningFlag(photoNoiseReduction);
    if (noiseReduction != null) {
      settings.noiseReduction = noiseReduction;
    } else {
      shouldResetCaptureTuning = true;
    }
    const edgeEnhancement = hasOverride('edgeEnhancement')
      ? overrides.edgeEnhancement
      : optionalTuningFlag(photoEdgeEnhancement);
    if (edgeEnhancement != null) {
      settings.edgeEnhancement = edgeEnhancement;
    } else {
      shouldResetCaptureTuning = true;
    }
    const mfnr = hasOverride('mfnr') ? overrides.mfnr : optionalTuningFlag(photoMfnr);
    if (mfnr != null) {
      settings.mfnr = mfnr;
    } else {
      shouldResetCaptureTuning = true;
    }
    const zsl = hasOverride('zsl') ? overrides.zsl : optionalTuningFlag(photoZsl);
    if (zsl != null) {
      settings.zsl = zsl;
    } else {
      shouldResetCaptureTuning = true;
    }
    const ispDigitalGain = hasOverride('ispDigitalGain')
      ? overrides.ispDigitalGain
      : photoIspDigitalGain;
    if (ispDigitalGain != null) {
      settings.ispDigitalGain = ispDigitalGain;
    } else {
      shouldResetCaptureTuning = true;
    }
    const ispAnalogGain = hasOverride('ispAnalogGain')
      ? overrides.ispAnalogGain
      : photoIspAnalogGain;
    if (ispAnalogGain != null) {
      settings.ispAnalogGain = ispAnalogGain;
    } else {
      shouldResetCaptureTuning = true;
    }
    if (shouldResetCaptureTuning) {
      settings.resetCaptureTuning = true;
    }
    return settings;
  }

  function syncButtonPresetIfScanMode(settings?: ButtonPhotoSettings) {
    if (scanModeRef.current) {
      void syncScanCapturePreset(true, settings);
    }
  }

  function addRequestTuningFields(
    fields: Omit<PhotoRequestParams, 'requestId' | 'appId' | 'webhookUrl' | 'authToken'>,
  ) {
    if (photoAeExposureDivisor !== null) {
      fields.aeExposureDivisor = photoAeExposureDivisor;
    }
    if (photoIsoCap !== null) {
      fields.isoCap = photoIsoCap;
    }
    const noiseReduction = optionalTuningFlag(photoNoiseReduction);
    if (noiseReduction !== undefined) {
      fields.noiseReduction = noiseReduction;
    }
    const edgeEnhancement = optionalTuningFlag(photoEdgeEnhancement);
    if (edgeEnhancement !== undefined) {
      fields.edgeEnhancement = edgeEnhancement;
    }
    const mfnr = optionalTuningFlag(photoMfnr);
    if (mfnr !== undefined) {
      fields.mfnr = mfnr;
    }
    const zsl = optionalTuningFlag(photoZsl);
    if (zsl !== undefined) {
      fields.zsl = zsl;
    }
    if (photoIspDigitalGain !== null) {
      fields.ispDigitalGain = photoIspDigitalGain;
    }
    if (photoIspAnalogGain !== null) {
      fields.ispAnalogGain = photoIspAnalogGain;
    }
    return fields;
  }

  function buildPhotoRequestFields(): Omit<
    PhotoRequestParams,
    'requestId' | 'appId' | 'webhookUrl' | 'authToken'
  > {
    return addRequestTuningFields({
      size: photoSize,
      compress: photoCompression,
      sound: !scanMode,
      exposureTimeNs: photoExposureManual ? photoExposureTimeNs : null,
      iso: photoExposureManual ? photoIso : null,
    });
  }

  async function captureAndUpload() {
    clearCameraButtonNotice();
    resetBarcodeScan();
    const captureLabel = scanMode ? 'Capture scan photo' : 'Capture & upload';
    await runAction(captureLabel, async () => {
      requireConnected('capture photos');
      requireGlassesWifi('capture photos');
      if (!(await ensureAndroidPermissions('photo'))) {
        throw new Error('Camera and Bluetooth permissions are required for photos.');
      }
      if (!photoCloudServerEnabledRef.current) {
        await captureAndUploadToPhone();
        return;
      }
      await captureAndUploadToCloud();
    });
  }
  captureAndUploadRef.current = captureAndUpload;

  async function toggleVideoRecording() {
    clearCameraButtonNotice();
    resetBarcodeScan();
    if (videoRecordingRef.current || activeVideoRequestIdRef.current) {
      await stopVideoRecording();
      return;
    }
    await startVideoRecording();
  }

  async function startVideoRecording() {
    await runAction('Start video recording', async () => {
      requireConnected('record video');
      requireGlassesWifi('record video');
      const uploadUrlText = webhookUrl.trim();
      const validationMessage = photoUploadValidationMessage(uploadUrlText);
      if (validationMessage) {
        setCameraStatus(`Camera: ${validationMessage}`);
        throw new Error(validationMessage);
      }
      try {
        photoStatusUrl(uploadUrlText, '');
      } catch {
        setCameraStatus('Camera: enter a valid http:// or https:// media upload URL');
        throw new Error('Enter a valid http:// or https:// media upload URL.');
      }
      setCameraStatus('Camera: checking this app can reach the media server before video');
      try {
        const reachability = await checkWebhookReachable(uploadUrlText);
        setCameraStatus(`Camera: this app reached media server (${reachability.host}); starting video`);
        addEvent('LIVE', `app reached media server for video ${reachability.uploadUrl ?? reachability.healthUrl}`);
      } catch (error) {
        const message = formatError(error);
        setCameraStatus(`Camera: media server check failed: ${message}`);
        setVideoPreviewDetails({
          error: message,
          source: 'Cloud server',
          state: 'error',
          uploadUrl: uploadUrlText,
        });
        throw new Error(`Media server check failed: ${message}`);
      }

      const requestId = `video-${Date.now()}`;
      activeVideoRequestIdRef.current = requestId;
      videoRecordingRef.current = true;
      videoPollGenerationRef.current += 1;
      setVideoRecording(true);
      setVideoStatus(null);
      setVideoPreviewUrl(null);
      setVideoPreviewDetails({
        requestId,
        source: 'Cloud server',
        state: 'recording',
        uploadUrl: uploadUrlText,
      });
      setCameraStatus(`Camera: recording video (${requestId})`);

      try {
        const response = await BluetoothSdk.startVideoRecording(requestId, true, true, {
          maxRecordingTimeMinutes: 1,
        });
        handleVideoRecordingStatus(response);
      } catch (error) {
        activeVideoRequestIdRef.current = null;
        videoRecordingRef.current = false;
        setVideoRecording(false);
        setVideoPreviewDetails({
          error: formatError(error),
          requestId,
          source: 'Cloud server',
          state: 'error',
          uploadUrl: uploadUrlText,
        });
        throw error;
      }
    });
  }

  async function stopVideoRecording() {
    await runAction('Stop & upload video', async () => {
      const requestId = activeVideoRequestIdRef.current;
      if (!requestId) {
        const message = 'No active video recording to stop.';
        setCameraStatus(`Camera: ${message}`);
        throw new Error(message);
      }
      const uploadUrlText = webhookUrl.trim();
      const validationMessage = photoUploadValidationMessage(uploadUrlText);
      if (validationMessage) {
        setCameraStatus(`Camera: ${validationMessage}`);
        throw new Error(validationMessage);
      }
      const statusUrl = photoStatusUrl(uploadUrlText, requestId);
      videoPollGenerationRef.current += 1;
      const pollGeneration = videoPollGenerationRef.current;
      videoRecordingRef.current = false;
      setVideoRecording(false);
      setVideoPreviewDetails((current) => ({
        ...current,
        requestId,
        source: 'Cloud server',
        state: 'uploading',
        uploadUrl: uploadUrlText,
      }));
      setCameraStatus(`Camera: stopping video and uploading (${requestId})`);

      try {
        const response = await BluetoothSdk.stopVideoRecording(requestId, uploadUrlText);
        handleVideoRecordingStatus(response);
      } catch (error) {
        activeVideoRequestIdRef.current = null;
        setVideoPreviewDetails((current) => ({
          ...current,
          error: formatError(error),
          requestId,
          source: 'Cloud server',
          state: 'error',
          uploadUrl: uploadUrlText,
        }));
        throw error;
      }

      await pollVideoPreview(requestId, statusUrl, pollGeneration);
    });
  }

  async function captureAndUploadToCloud() {
      const uploadUrlText = webhookUrl.trim();
      const validationMessage = photoUploadValidationMessage(uploadUrlText);
      if (validationMessage) {
        setCameraStatus(`Camera: ${validationMessage}`);
        throw new Error(validationMessage);
      }
      let statusUrl = '';
      try {
        statusUrl = photoStatusUrl(uploadUrlText, '');
      } catch {
        setCameraStatus('Camera: enter a valid http:// or https:// media upload URL');
        throw new Error('Enter a valid http:// or https:// media upload URL.');
      }

      const requestId = `photo-${Date.now()}`;
      statusUrl = photoStatusUrl(uploadUrlText, requestId);
      activePhotoRequestIdRef.current = requestId;
      pollGenerationRef.current += 1;
      const pollGeneration = pollGenerationRef.current;

      setPhotoPreviewUrl(null);
      setPhotoPreviewDetails(null);
      markPhotoRequestStarted(requestId);
      resetBarcodeScan();
      setCameraStatus(`Camera: webhook upload requested (${requestId})`);
      try {
        const response = await BluetoothSdk.requestPhoto({
          requestId,
          appId: PHOTO_APP_ID,
          webhookUrl: uploadUrlText,
          authToken: null,
          ...buildPhotoRequestFields(),
        });
        handlePhotoResponse(response);
      } catch (error) {
        if (activePhotoRequestIdRef.current === requestId) {
          activePhotoRequestIdRef.current = null;
        }
        markPhotoRequestFailed(requestId, 'REQUEST_FAILED', formatError(error));
        throw error;
      }
      void pollPhotoPreview(requestId, statusUrl, pollGeneration);
  }

  async function captureAndUploadToPhone() {
    const receiver = await ensurePhonePhotoReceiver('capture');

    const requestId = `photo-${Date.now()}`;
    activePhotoRequestIdRef.current = requestId;
    pollGenerationRef.current += 1;

    setPhotoPreviewUrl(null);
    setPhotoPreviewDetails(null);
    markPhotoRequestStarted(requestId);
    resetBarcodeScan();
    setCameraStatus(`Camera: phone upload requested (${requestId})`);
    clearPhotoUploadTimeout();
    photoUploadTimeoutRef.current = setTimeout(() => {
      if (activePhotoRequestIdRef.current === requestId) {
        activePhotoRequestIdRef.current = null;
        setCameraStatus('Camera: timed out waiting for phone upload');
        markPhotoRequestFailed(requestId, 'UPLOAD_TIMEOUT', 'Timed out waiting for phone upload');
        addEvent('TX', `phone photo upload timed out ${requestId}`);
      }
    }, DIRECT_PHOTO_UPLOAD_TIMEOUT_MS);

    try {
      const response = await BluetoothSdk.requestPhoto({
        requestId,
        appId: PHOTO_APP_ID,
        webhookUrl: receiver.uploadUrl,
        authToken: null,
        ...buildPhotoRequestFields(),
      });
      handlePhotoResponse(response);
    } catch (error) {
      clearPhotoUploadTimeout();
      if (activePhotoRequestIdRef.current === requestId) {
        activePhotoRequestIdRef.current = null;
      }
      markPhotoRequestFailed(requestId, 'REQUEST_FAILED', formatError(error));
      throw error;
    }
  }

  async function testWebhook() {
    await runAction('Test webhook', async () => {
      const uploadUrlText = webhookUrl.trim();
      const validationMessage = photoUploadValidationMessage(uploadUrlText);
      if (validationMessage) {
        setCameraStatus(`Camera: ${validationMessage}`);
        throw new Error(validationMessage);
      }
      let healthUrl = '';
      try {
        healthUrl = webhookHealthUrl(uploadUrlText);
      } catch {
        setCameraStatus('Camera: enter a valid http:// or https:// media upload URL');
        throw new Error('Enter a valid http:// or https:// media upload URL.');
      }

      setCameraStatus('Camera: testing local webhook');
      try {
        const reachability = await checkWebhookReachable(uploadUrlText);
        setCameraStatus(`Camera: webhook reachable (${reachability.host})`);
        addEvent('LIVE', `webhook reachable ${reachability.uploadUrl ?? reachability.healthUrl}`);
      } catch (error) {
        const message = formatError(error);
        setCameraStatus(`Camera: webhook test failed: ${message}`);
        throw error;
      }
    });
  }

  async function checkWebhookReachable(uploadUrlText: string) {
    const healthUrl = webhookHealthUrl(uploadUrlText);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(cacheBustedUrl(healthUrl), {
        cache: 'no-store',
        headers: {'Cache-Control': 'no-cache', Pragma: 'no-cache'},
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`This app reached ${healthUrl}, but the media server returned HTTP ${response.status}.`);
      }
      const json = (await response.json().catch(() => ({}))) as {uploadUrl?: string};
      return {
        healthUrl,
        host: new URL(healthUrl).host,
        uploadUrl: json.uploadUrl,
      };
    } catch (error) {
      throw new Error(webhookReachabilityErrorMessage(error, healthUrl));
    } finally {
      clearTimeout(timeout);
    }
  }

  function handleDirectPhotoUpload(payload: PhotoReceiverUploadEvent) {
    const activeRequestId = activePhotoRequestIdRef.current;
    if (activeRequestId && payload.requestId && payload.requestId !== activeRequestId) {
      addEvent('LIVE', `ignoring stale phone photo ${payload.requestId}`);
      return;
    }
    clearPhotoUploadTimeout();
    activePhotoRequestIdRef.current = null;
    setPhonePhotoReceiverRunning(true);
    setPhotoPreviewUrl(payload.fileUri);
    setPhotoStatus(null);
    setPhotoPreviewDetails((current) => ({
      ...current,
      bleFallbackMessage: current?.bleFallbackUsed
        ? 'Wi-Fi upload failed; photo was compressed and delivered through Bluetooth.'
        : current?.bleFallbackMessage,
      byteCount: payload.byteCount,
      previewUrl: payload.fileUri,
      requestId: payload.requestId ?? activeRequestId ?? current?.requestId ?? null,
      source: 'Phone receiver',
      state: 'preview',
    }));
    void updatePhotoPreviewMetadata(payload.fileUri);
    if (scanModeRef.current) {
      void scanPreviewBarcode(payload.fileUri);
    }
    setCameraStatus(`Camera: phone photo ready (${Math.round(payload.byteCount / 1024)} KB)`);
    addEvent('LIVE', `phone photo ready ${payload.fileUri}`);
  }

  function handlePhotoReceiverStatus(payload: PhotoReceiverStatusEvent) {
    if (payload.message.toLowerCase().includes('ready at')) {
      setPhonePhotoReceiverRunning(true);
    }
    if (payload.message.toLowerCase().includes('stopped')) {
      phonePhotoReceiverRef.current = null;
      phonePhotoReceiverStartPromiseRef.current = null;
      setPhonePhotoReceiverRunning(false);
    }
    addEvent('LIVE', `photo receiver ${payload.message}`);
  }

  async function ensurePhonePhotoReceiver(reason: 'camera tab' | 'capture'): Promise<PhotoReceiverResult> {
    if (phonePhotoReceiverRef.current && reason !== 'capture') {
      return phonePhotoReceiverRef.current;
    }
    if (phonePhotoReceiverStartPromiseRef.current) {
      return phonePhotoReceiverStartPromiseRef.current;
    }

    const startedAt = Date.now();
    if (reason === 'capture') {
      setCameraStatus('Camera: preparing phone photo receiver');
    }
    addEvent('LIVE', `${phonePhotoReceiverRef.current ? 'refreshing' : 'starting'} phone photo receiver (${reason})`);
    const promise = MentraPhotoReceiver.startPhotoReceiver()
      .then((receiver) => {
        const previousUploadUrl = phonePhotoReceiverRef.current?.uploadUrl;
        phonePhotoReceiverRef.current = receiver;
        setPhonePhotoReceiverRunning(true);
        setPhonePhotoUploadUrl(receiver.uploadUrl);
        if (previousUploadUrl && previousUploadUrl !== receiver.uploadUrl) {
          addEvent('LIVE', `phone photo receiver URL changed ${previousUploadUrl} -> ${receiver.uploadUrl}`);
        }
        addEvent('LIVE', `phone photo receiver ready ${receiver.uploadUrl} (${Date.now() - startedAt}ms)`);
        return receiver;
      })
      .finally(() => {
        phonePhotoReceiverStartPromiseRef.current = null;
      });
    phonePhotoReceiverStartPromiseRef.current = promise;
    return promise;
  }

  async function stopPhonePhotoReceiver() {
    phonePhotoReceiverRef.current = null;
    phonePhotoReceiverStartPromiseRef.current = null;
    await MentraPhotoReceiver.stopPhotoReceiver();
    setPhonePhotoReceiverRunning(false);
    setPhonePhotoUploadUrl(null);
  }

  function markPhotoRequestStarted(requestId: string) {
    setPhotoStatus({
      type: 'photo_status',
      requestId,
      status: 'accepted',
      timestamp: Date.now(),
    });
  }

  function markPhotoRequestFailed(
    requestId: string,
    errorCode: string,
    errorMessage: string,
  ) {
    setPhotoStatus({
      type: 'photo_status',
      requestId,
      status: 'failed',
      timestamp: Date.now(),
      errorCode,
      errorMessage,
    });
  }

  function handlePhotoStatus(payload: PhotoStatusEvent) {
    const activeRequestId = activePhotoRequestIdRef.current;
    if (activeRequestId && payload.requestId !== activeRequestId) {
      addEvent('LIVE', `ignoring stale photo status ${payload.requestId}`);
      return;
    }

    const isGalleryModeButtonPhoto =
      galleryModePhotoRequestIdsRef.current.has(payload.requestId) ||
      (galleryModeEnabledRef.current &&
        !activeRequestId &&
        payload.resolvedConfig?.source === 'button');
    if (isGalleryModeButtonPhoto) {
      galleryModePhotoRequestIdsRef.current.add(payload.requestId);
      showCameraButtonNotice(CAMERA_BUTTON_GALLERY_MODE_NOTICE);
    }
    if (!activeRequestId && !isGalleryModeButtonPhoto) {
      addEvent('LIVE', `ignoring external photo status ${payload.requestId}`);
      return;
    }

    setPhotoStatus(payload);
    const label = photoStatusLabel(payload, isGalleryModeButtonPhoto);
    setCameraStatus(`Camera: ${label}`);
    if (photoStatusStartsNewCapture(payload.status)) {
      setPhotoPreviewDetails((current) => {
        if (!current || current.requestId === payload.requestId) {
          return current;
        }
        return clearPhotoBleFallbackWarning(current);
      });
    }
    const payloadWithExtras = payload as PhotoStatusEvent & PhotoStatusExtras;
    const fallbackMessage = photoBleFallbackMessage(payload.status);
    const bleTransferStatus =
      payload.status === 'ready_for_transfer' || payload.status === 'transferring';
    if (
      payload.resolvedConfig ||
      payloadWithExtras.requestedCaptureConfig ||
      payloadWithExtras.meteredPreview ||
      payloadWithExtras.captureMetadata ||
      fallbackMessage ||
      bleTransferStatus
    ) {
      setPhotoPreviewDetails((current) => {
        const bleFallbackUsed =
          current?.bleFallbackUsed || payload.status === 'ble_fallback_compression';
        return {
          ...current,
          bleFallbackMessage:
            fallbackMessage ??
            (bleFallbackUsed
              ? photoBleFallbackProgressMessage(payload.status, current?.bleFallbackMessage)
              : current?.bleFallbackMessage),
          bleFallbackUsed,
          requestId: payload.requestId,
          source:
            isGalleryModeButtonPhoto
              ? 'Glasses gallery'
              : payload.resolvedConfig?.source === 'button'
                ? 'Action button'
              : current?.source ?? (photoCloudServerEnabledRef.current ? 'Cloud server' : 'Phone receiver'),
          state: current?.state === 'preview' ? 'preview' : 'acknowledged',
          timestamp: payload.timestamp,
          resolvedConfig: payload.resolvedConfig ?? current?.resolvedConfig,
          requestedCaptureConfig:
            payloadWithExtras.requestedCaptureConfig ?? current?.requestedCaptureConfig,
          meteredPreview: payloadWithExtras.meteredPreview ?? current?.meteredPreview,
          captureMetadata: payloadWithExtras.captureMetadata ?? current?.captureMetadata,
        };
      });
    }

    if (payload.status === 'failed') {
      galleryModePhotoRequestIdsRef.current.delete(payload.requestId);
      clearPhotoUploadTimeout();
      activePhotoRequestIdRef.current = null;
      setPhotoPreviewDetails({
        error: payload.errorCode ?? payload.errorMessage,
        requestId: payload.requestId,
        source: photoCloudServerEnabledRef.current ? 'Cloud server' : 'Phone receiver',
        state: 'error',
        timestamp: payload.timestamp,
      });
      resetBarcodeScan();
    }

    const configSummary = photoStatusDetailSummary(payload);
    addEvent(
      'LIVE',
      `photo status ${payload.status}${configSummary ? ` · ${configSummary}` : ''}`,
    );
  }

  function handleVideoRecordingStatus(payload: VideoRecordingStatusEvent) {
    const activeRequestId = activeVideoRequestIdRef.current;
    if (activeRequestId && payload.requestId && payload.requestId !== activeRequestId) {
      addEvent('LIVE', `ignoring stale video status ${payload.requestId}`);
      return;
    }
    if (!activeRequestId && payload.requestId) {
      addEvent('LIVE', `external video status ${payload.status}`);
    }

    setVideoStatus(payload);
    const requestId = payload.requestId ?? activeRequestId;
    const durationMs = typeof payload.data?.duration_ms === 'number'
      ? payload.data.duration_ms
      : undefined;
    const failed = !payload.success || videoStatusIsFailure(payload.status);

    if (payload.status === 'recording_started' || payload.data?.recording === true) {
      videoRecordingRef.current = true;
      setVideoRecording(true);
      setVideoPreviewDetails((current) => ({
        ...current,
        requestId,
        source: 'Cloud server',
        state: 'recording',
        status: payload.status,
        timestamp: payload.timestamp,
      }));
      setCameraStatus('Camera: recording video');
    } else if (payload.status === 'recording_stopped') {
      videoRecordingRef.current = false;
      setVideoRecording(false);
      setVideoPreviewDetails((current) => ({
        ...current,
        durationMs,
        requestId,
        source: 'Cloud server',
        state: 'uploading',
        status: payload.status,
        timestamp: payload.timestamp,
      }));
      setCameraStatus('Camera: video stopped; waiting for upload preview');
    } else if (failed) {
      videoRecordingRef.current = false;
      setVideoRecording(false);
      activeVideoRequestIdRef.current = null;
      setVideoPreviewDetails((current) => ({
        ...current,
        durationMs,
        error: payload.details ?? payload.status,
        requestId,
        source: 'Cloud server',
        state: 'error',
        status: payload.status,
        timestamp: payload.timestamp,
      }));
      setCameraStatus(`Camera: video failed (${payload.details ?? payload.status})`);
    } else {
      setVideoPreviewDetails((current) => ({
        ...current,
        durationMs,
        requestId,
        source: 'Cloud server',
        state: current?.state ?? 'recording',
        status: payload.status,
        timestamp: payload.timestamp,
      }));
      setCameraStatus(`Camera: video ${payload.status.replace(/_/g, ' ')}`);
    }

    addEvent('LIVE', `video status ${payload.status}`);
  }

  function handleMediaUpload(payload: MediaUploadSuccessEvent | MediaUploadErrorEvent) {
    const activeRequestId = activeVideoRequestIdRef.current;
    const isVideo = payload.mediaType === 2;
    if (!isVideo) {
      return;
    }
    if (activeRequestId && payload.requestId !== activeRequestId) {
      addEvent('LIVE', `ignoring stale video upload ${payload.requestId}`);
      return;
    }

    if (payload.type === 'media_error') {
      activeVideoRequestIdRef.current = null;
      videoRecordingRef.current = false;
      setVideoRecording(false);
      setVideoPreviewDetails((current) => ({
        ...current,
        error: payload.errorMessage,
        requestId: payload.requestId,
        source: 'Cloud server',
        state: 'error',
        timestamp: payload.timestamp,
      }));
      setCameraStatus(`Camera: video upload failed (${payload.errorMessage})`);
      addEvent('LIVE', `video upload failed ${payload.errorMessage}`);
      return;
    }

    setVideoPreviewDetails((current) => ({
      ...current,
      mediaUrl: payload.mediaUrl,
      requestId: payload.requestId,
      source: 'Cloud server',
      state: current?.state === 'preview' ? 'preview' : 'uploading',
      timestamp: payload.timestamp,
    }));
    setCameraStatus('Camera: video uploaded; loading preview');
    addEvent('LIVE', `video uploaded ${payload.mediaUrl}`);
  }

  function handleVideoStreamReceiverStatus(payload: VideoStreamReceiverStatusEvent) {
    if (payload.kind === 'stream') {
      if (payload.message.toLowerCase().includes('ready at')) {
        setDirectStreamReceiverRunning(true);
      }
      if (payload.message.toLowerCase().includes('stopped')) {
        setDirectStreamReceiverRunning(false);
        stopDirectStreamFrameWatchdog();
      }
      if (payload.message.startsWith('Rendered ')) {
        markDirectStreamFrameReceived();
      }
    }
    addEvent('LIVE', `${payload.kind} receiver ${payload.message}`);
  }

  function handleDirectStreamFirstFrame(_payload: VideoStreamFirstFrameEvent) {
    markDirectStreamFrameReceived();
  }

  function handleDirectStreamFrame(_payload: VideoStreamFrameEvent) {
    markDirectStreamFrameReceived();
  }

  function markDirectStreamFrameReceived() {
    if (!activeStreamIdRef.current || streamCloudServerEnabledRef.current) {
      return;
    }
    setStreamPreviewReady(true);
    setStreamStartedAt((current) => current ?? Date.now());
    setStreamStatus('WebRTC phone preview ready');
    stopDirectStreamFrameWatchdog();
    directStreamFrameStaleTimerRef.current = setTimeout(() => {
      if (!activeStreamIdRef.current || streamCloudServerEnabledRef.current) {
        return;
      }
      setStreamPreviewReady(false);
      setStreamStatus('WebRTC preview stalled: no video frames received from glasses');
      addEvent('TX', 'WebRTC preview stalled');
    }, 7000);
  }

  function handlePhotoResponse(response: PhotoSuccessResponseEvent) {
    const activeRequestId = activePhotoRequestIdRef.current;
    if (activeRequestId && response.requestId !== activeRequestId) {
      addEvent('LIVE', `ignoring stale photo ${response.requestId}`);
      return;
    }
    setCameraStatus(
      photoCloudServerEnabledRef.current
        ? 'Camera: photo delivered to cloud webhook'
        : 'Camera: photo delivered to phone receiver',
    );
    setPhotoPreviewDetails((current) => ({
      ...current,
      byteCount: typeof response.fileSizeBytes === 'number' ? response.fileSizeBytes : current?.byteCount,
      contentType: response.contentType ?? current?.contentType,
      previewUrl: response.photoUrl ?? current?.previewUrl,
      requestId: response.requestId,
      source: photoCloudServerEnabledRef.current ? 'Cloud server' : 'Phone receiver',
      state: current?.state === 'preview' || response.photoUrl ? 'preview' : 'acknowledged',
      timestamp: response.timestamp,
      uploadUrl: response.uploadUrl,
    }));
    addEvent('LIVE', `photo response ${response.requestId}`);
  }

  async function pollPhotoPreview(
    requestId: string,
    statusUrl: string,
    pollGeneration: number,
  ) {
    for (let attempt = 0; attempt < PHOTO_POLL_ATTEMPTS; attempt += 1) {
      if (
        activePhotoRequestIdRef.current !== requestId ||
        pollGenerationRef.current !== pollGeneration
      ) {
        return;
      }
      try {
        const response = await fetch(cacheBustedUrl(statusUrl), {
          cache: 'no-store',
          headers: {'Cache-Control': 'no-cache', Pragma: 'no-cache'},
        });
        if (response.ok) {
          const json = (await response.json()) as {
            contentType?: string;
            fileSizeBytes?: number;
            photoUrl?: string;
            requestId?: string;
            uploadedAt?: string;
          };
          if (json.photoUrl) {
            setPhotoPreviewUrl(json.photoUrl);
            setPhotoStatus(null);
            setPhotoPreviewDetails((current) => ({
              ...current,
              bleFallbackMessage: current?.bleFallbackUsed
                ? 'Wi-Fi upload failed; photo was compressed and delivered through Bluetooth.'
                : current?.bleFallbackMessage,
              byteCount: typeof json.fileSizeBytes === 'number' ? json.fileSizeBytes : current?.byteCount,
              contentType: json.contentType ?? current?.contentType,
              previewUrl: json.photoUrl,
              requestId: json.requestId ?? requestId,
              source: 'Cloud server',
              state: 'preview',
              uploadedAt: json.uploadedAt ?? current?.uploadedAt,
            }));
            void updatePhotoPreviewMetadata(json.photoUrl);
            if (scanModeRef.current) {
              void scanPreviewBarcode(json.photoUrl);
            }
            setCameraStatus('Camera: loaded photo preview');
            addEvent('LIVE', `local photo ready ${json.photoUrl}`);
            activePhotoRequestIdRef.current = null;
            return;
          }
        }
        if (attempt === 0 || attempt % 10 === 9) {
          addEvent('LIVE', `waiting for upload ${requestId}: ${response.status}`);
        }
      } catch (error) {
        if (attempt === 0 || attempt % 10 === 9) {
          addEvent('LIVE', `waiting for local photo server: ${formatError(error)}`);
        }
      }
      await delay(1000);
    }
    if (activePhotoRequestIdRef.current === requestId) {
      setCameraStatus('Camera: timed out waiting for local server upload');
    }
  }

  async function pollVideoPreview(
    requestId: string,
    statusUrl: string,
    pollGeneration: number,
  ) {
    for (let attempt = 0; attempt < VIDEO_POLL_ATTEMPTS; attempt += 1) {
      if (
        activeVideoRequestIdRef.current !== requestId ||
        videoPollGenerationRef.current !== pollGeneration
      ) {
        return;
      }
      try {
        const response = await fetch(cacheBustedUrl(statusUrl), {
          cache: 'no-store',
          headers: {'Cache-Control': 'no-cache', Pragma: 'no-cache'},
        });
        if (response.ok) {
          const json = (await response.json()) as {
            contentType?: string;
            fileSizeBytes?: number;
            mediaType?: string;
            mediaUrl?: string;
            requestId?: string;
            uploadedAt?: string;
            url?: string;
            videoUrl?: string;
          };
          const previewUrl = json.videoUrl ?? (json.mediaType === 'video' ? json.mediaUrl ?? json.url : undefined);
          if (previewUrl) {
            setVideoPreviewUrl(previewUrl);
            setVideoPreviewDetails((current) => ({
              ...current,
              byteCount: typeof json.fileSizeBytes === 'number' ? json.fileSizeBytes : current?.byteCount,
              contentType: json.contentType ?? current?.contentType,
              mediaUrl: json.mediaUrl ?? json.url ?? current?.mediaUrl,
              previewUrl,
              requestId: json.requestId ?? requestId,
              source: 'Cloud server',
              state: 'preview',
              uploadedAt: json.uploadedAt ?? current?.uploadedAt,
            }));
            setCameraStatus('Camera: loaded video preview');
            addEvent('LIVE', `local video ready ${previewUrl}`);
            activeVideoRequestIdRef.current = null;
            return;
          }
        }
        if (attempt === 0 || attempt % 10 === 9) {
          addEvent('LIVE', `waiting for video upload ${requestId}: ${response.status}`);
        }
      } catch (error) {
        if (attempt === 0 || attempt % 10 === 9) {
          addEvent('LIVE', `waiting for local video server: ${formatError(error)}`);
        }
      }
      await delay(1000);
    }
    if (activeVideoRequestIdRef.current === requestId) {
      activeVideoRequestIdRef.current = null;
      setVideoPreviewDetails((current) => ({
        ...current,
        error: 'Timed out waiting for local server upload',
        requestId,
        source: 'Cloud server',
        state: 'error',
      }));
      setCameraStatus('Camera: timed out waiting for local server video upload');
    }
  }

  async function updatePhotoPreviewMetadata(uri: string) {
    try {
      const metadata = await MentraBarcodeScanner.getImageMetadata(uri);
      setPhotoPreviewDetails((current) =>
        current?.previewUrl === uri
          ? {
              ...current,
              estimatedFov: metadata.estimatedFov,
              focalLength35mm: metadata.focalLength35mm,
              height: metadata.height ?? current.height,
              width: metadata.width ?? current.width,
            }
          : current,
      );
    } catch (error) {
      addEvent('TX', `photo metadata failed: ${formatError(error)}`);
    }
  }

  async function openPhotoPreview() {
    if (photoPreviewOpeningRef.current) {
      return;
    }
    photoPreviewOpeningRef.current = true;
    resetBarcodeScan();
    await runAction('Open photo preview', async () => {
      try {
        if (!photoPreviewUrl) {
          throw new Error('Capture or load a photo preview first.');
        }
        await MentraBarcodeScanner.openImage(photoPreviewUrl);
      } finally {
        photoPreviewOpeningRef.current = false;
      }
    });
  }

  function resetBarcodeScan() {
    barcodeScanTokenRef.current += 1;
    updateBarcodeScan({barcodes: [], state: 'idle'});
  }

  function showCameraButtonNotice(message: string) {
    setCameraButtonNotice(message);
  }

  function clearCameraButtonNotice() {
    setCameraButtonNotice(null);
  }

  async function scanPreviewBarcode(sourceUri: string, expectedValue?: string) {
    const currentScan = barcodeScanRef.current;
    if (
      currentScan.sourceUri === sourceUri &&
      (currentScan.state === 'scanning' || currentScan.state === 'found')
    ) {
      return;
    }

    const token = barcodeScanTokenRef.current + 1;
    barcodeScanTokenRef.current = token;
    updateBarcodeScan({
      barcodes: [],
      expectedValue,
      sourceUri,
      state: 'scanning',
    });
    const visibleTimeout = setTimeout(() => {
      if (barcodeScanTokenRef.current !== token) {
        return;
      }
      const latestScan = barcodeScanRef.current;
      if (latestScan.sourceUri !== sourceUri || latestScan.state !== 'scanning') {
        return;
      }
      updateBarcodeScan({
        barcodes: [],
        expectedValue,
        scannedAt: new Date().toISOString(),
        sourceUri,
        state: 'none',
      });
      addEvent('LIVE', 'barcode scan timed out');
    }, BARCODE_SCAN_VISIBLE_TIMEOUT_MS);
    await waitForNextFrame();
    if (barcodeScanTokenRef.current !== token) {
      clearTimeout(visibleTimeout);
      return;
    }
    try {
      const barcodes = dedupeBarcodeResults(await MentraBarcodeScanner.scanImage(sourceUri));
      clearTimeout(visibleTimeout);
      if (barcodeScanTokenRef.current !== token) {
        return;
      }
      const scannedAt = new Date().toISOString();
      const latestScan = barcodeScanRef.current;
      if (
        barcodes.length === 0 &&
        latestScan.sourceUri === sourceUri &&
        latestScan.state === 'found' &&
        latestScan.barcodes.length > 0
      ) {
        addEvent('LIVE', 'ignored empty duplicate barcode scan');
        return;
      }
      updateBarcodeScan({
        barcodes,
        expectedValue,
        scannedAt,
        sourceUri,
        state: barcodes.length > 0 ? 'found' : 'none',
      });
      if (barcodes.length > 0) {
        addEvent('LIVE', `barcode ${barcodeScanSummary(barcodes)}`);
      } else {
        addEvent('LIVE', 'no barcode found in photo preview');
      }
    } catch (error) {
      clearTimeout(visibleTimeout);
      if (barcodeScanTokenRef.current !== token) {
        return;
      }
      const message = formatError(error);
      updateBarcodeScan({
        barcodes: [],
        error: message,
        expectedValue,
        scannedAt: new Date().toISOString(),
        sourceUri,
        state: 'error',
      });
      addEvent('TX', `barcode scan failed: ${message}`);
    }
  }

  function updateBarcodeScan(next: BarcodeScanDetails) {
    barcodeScanRef.current = next;
    setBarcodeScan(next);
  }
  function setPhotoExposureTimeNsAction(exposureTimeNs: number) {
    setPhotoExposureTimeNsState(clampRounded(exposureTimeNs, PHOTO_EXPOSURE_MIN_NS, PHOTO_EXPOSURE_MAX_NS));
  }

  function setPhotoIsoAction(iso: number) {
    setPhotoIsoState(clampRounded(iso, PHOTO_ISO_MIN, PHOTO_ISO_MAX));
  }

  function applyBarcodeScanPhotoPresetValues() {
    setPhotoSize(BARCODE_SCAN_PHOTO_PRESET.size);
    setPhotoCompression(BARCODE_SCAN_PHOTO_PRESET.compress);
    setScanAeDivisor(BARCODE_SCAN_PHOTO_PRESET.aeExposureDivisor);
    setScanIsoCap(BARCODE_SCAN_PHOTO_PRESET.isoCap);
    // The barcode preset intentionally leaves auto exposure by setting both exposure and ISO.
    setPhotoExposureManual(true);
    setPhotoExposureTimeNsState(BARCODE_SCAN_PHOTO_PRESET.exposureTimeNs);
    setPhotoIsoState(BARCODE_SCAN_PHOTO_PRESET.iso);
    setPhotoAeExposureDivisor(BARCODE_SCAN_PHOTO_PRESET.aeExposureDivisor);
    setPhotoIsoCap(BARCODE_SCAN_PHOTO_PRESET.isoCap);
    setPhotoNoiseReduction(BARCODE_SCAN_PHOTO_PRESET.noiseReduction);
    setPhotoEdgeEnhancement(BARCODE_SCAN_PHOTO_PRESET.edgeEnhancement);
    setPhotoMfnr(BARCODE_SCAN_PHOTO_PRESET.mfnr);
    setPhotoZsl(BARCODE_SCAN_PHOTO_PRESET.zsl);
    setPhotoIspDigitalGain(BARCODE_SCAN_PHOTO_PRESET.ispDigitalGain);
    setPhotoIspAnalogGain(BARCODE_SCAN_PHOTO_PRESET.ispAnalogGain);
  }

  function setPhotoSizeAction(size: PhotoSize) {
    setPhotoSize(size);
    syncButtonPresetIfScanMode(buildButtonPhotoSettings({size}));
  }

  function setPhotoCompressionAction(compression: PhotoCompression) {
    setPhotoCompression(compression);
    syncButtonPresetIfScanMode(buildButtonPhotoSettings({compress: compression}));
  }

  function setPhotoAeExposureDivisorAction(divisor: PhotoAeExposureDivisor | null) {
    setPhotoAeExposureDivisor(divisor);
    if (divisor === 3 || divisor === 5) {
      setScanAeDivisor(divisor);
    }
    syncButtonPresetIfScanMode(buildButtonPhotoSettings({aeExposureDivisor: divisor}));
  }

  function setPhotoIsoCapAction(isoCap: PhotoIsoCap | null) {
    setPhotoIsoCap(isoCap);
    if (isoCap === 400 || isoCap === 800) {
      setScanIsoCap(isoCap);
    }
    syncButtonPresetIfScanMode(buildButtonPhotoSettings({isoCap}));
  }

  function setPhotoNoiseReductionAction(value: PhotoTuningFlag) {
    setPhotoNoiseReduction(value);
    syncButtonPresetIfScanMode(buildButtonPhotoSettings({noiseReduction: optionalTuningFlag(value)}));
  }

  function setPhotoEdgeEnhancementAction(value: PhotoTuningFlag) {
    setPhotoEdgeEnhancement(value);
    syncButtonPresetIfScanMode(buildButtonPhotoSettings({edgeEnhancement: optionalTuningFlag(value)}));
  }

  function setPhotoMfnrAction(value: PhotoTuningFlag) {
    setPhotoMfnr(value);
    syncButtonPresetIfScanMode(buildButtonPhotoSettings({mfnr: optionalTuningFlag(value)}));
  }

  function setPhotoZslAction(value: PhotoTuningFlag) {
    setPhotoZsl(value);
    syncButtonPresetIfScanMode(buildButtonPhotoSettings({zsl: optionalTuningFlag(value)}));
  }

  function setPhotoIspDigitalGainAction(gain: PhotoIspDigitalGain | null) {
    setPhotoIspDigitalGain(gain);
    syncButtonPresetIfScanMode(buildButtonPhotoSettings({ispDigitalGain: gain}));
  }

  function setPhotoIspAnalogGainAction(gain: PhotoIspAnalogGain | null) {
    setPhotoIspAnalogGain(gain);
    syncButtonPresetIfScanMode(buildButtonPhotoSettings({ispAnalogGain: gain}));
  }

  function setCameraFovAction(fov: number) {
    const nextFov = clampRounded(fov, CAMERA_FOV_MIN, CAMERA_FOV_MAX);
    setCameraFovState(nextFov);
    if (nextFov === CAMERA_FOV_MAX) {
      setCameraRoiPositionState('center');
    }
  }

  function setCameraRoiPositionAction(roiPosition: CameraRoiPosition) {
    setCameraRoiPositionState(cameraFov === CAMERA_FOV_MAX ? 'center' : roiPosition);
  }

  async function applyCameraSettings() {
    if (cameraSettingsApplyingRef.current) {
      addEvent('TX', 'camera_fov already applying');
      return;
    }
    await runAction('Apply camera settings', async () => {
      requireConnected('apply camera settings');
      const fov = clampRounded(cameraFov, CAMERA_FOV_MIN, CAMERA_FOV_MAX);
      const roiPosition = fov === CAMERA_FOV_MAX ? 'center' : cameraRoiPosition;
      cameraSettingsApplyingRef.current = true;
      setCameraSettingsApplying(true);
      setCameraSettingsStatus('Camera settings: applying FOV/ROI on glasses');
      try {
        const result = await BluetoothSdk.setCameraFov({fov, roiPosition});
        addEvent('LIVE', `camera_fov ${describeCameraFovResult(result)}`);
        setCameraSettingsStatus(
          `Camera settings: applied; field of view ${result.fov}°, ${roiPositionLabel(result.roiPosition)} crop`,
        );
      } catch (error) {
        setCameraSettingsStatus(`Camera settings: failed - ${formatError(error)}`);
        throw error;
      } finally {
        cameraSettingsApplyingRef.current = false;
        setCameraSettingsApplying(false);
      }
    });
  }

  function selectProtocol(protocol: StreamProtocol) {
    if (streamRequested || streamStartedAt !== null) {
      void stopActiveStream('Stream stopped because protocol changed');
    }
    setStreamResolvedConfig(null);
    setStreamProtocol(protocol);
    const trimmed = streamUrl.trim();
    const nextUrl = !trimmed || STREAM_DEFAULT_URL_VALUES.has(trimmed)
      ? STREAM_DEFAULT_URLS[protocol]
      : streamUrl;
    setStreamUrlState(nextUrl);
    void savePersistedCloudUrls({
      streamProtocol: protocol,
      streamUrl: nextUrl,
      webhookUrl,
    });
  }

  function setWebhookUrlAction(url: string) {
    setWebhookUrlState(url);
    void savePersistedCloudUrls({
      streamProtocol,
      streamUrl,
      webhookUrl: url,
    });
  }

  async function setPhotoCloudServerEnabledAction(enabled: boolean) {
    await runAction(enabled ? 'Use photo cloud server' : 'Capture photos to phone', async () => {
      photoCloudServerEnabledRef.current = enabled;
      setPhotoCloudServerEnabledState(enabled);
      activePhotoRequestIdRef.current = null;
      clearPhotoUploadTimeout();
      setPhotoStatus(null);
      pollGenerationRef.current += 1;
      if (enabled) {
        await stopPhonePhotoReceiver().catch(() => undefined);
        setCameraStatus('Camera: enter the cloud media upload URL');
        return;
      }
      setCameraStatus('Camera: ready to capture to phone');
    });
  }

  async function setStreamCloudServerEnabledAction(enabled: boolean) {
    await runAction(enabled ? 'Use stream cloud server' : 'Stream to phone', async () => {
      if (streamRequested || streamStartedAt !== null) {
        await stopActiveStream('Stream stopped because destination changed');
      }
      streamCloudServerEnabledRef.current = enabled;
      setStreamCloudServerEnabledState(enabled);
      setStreamPreviewReady(false);
      setStreamResolvedConfig(null);
      if (enabled) {
        setStreamStatus('Ready to stream to a cloud server');
        return;
      }
      setStreamProtocol('webrtc');
      setStreamStatus('Ready to stream WebRTC to phone');
    });
  }

  function setStreamUrlAction(url: string) {
    if (streamRequested || streamStartedAt !== null) {
      void stopActiveStream('Stream stopped because URL changed');
    }
    setStreamResolvedConfig(null);
    setStreamUrlState(url);
    void savePersistedCloudUrls({
      streamProtocol,
      streamUrl: url,
      webhookUrl,
    });
  }

  function setStreamFpsAction(fps: number) {
    if (streamRequested || streamStartedAt !== null) {
      return;
    }
    const nextFps = Math.max(STREAM_MIN_FPS, Math.min(STREAM_MAX_FPS, Math.round(fps)));
    setStreamFps(nextFps);
  }

  function setStreamStartPendingValue(pending: boolean) {
    streamStartPendingRef.current = pending;
    setStreamStartPending(pending);
  }

  async function toggleStream() {
    if (streamStartPendingRef.current) {
      setStreamStatus('Stream start already in progress');
      addEvent('TX', 'duplicate stream start ignored');
      return;
    }

    if (streamRequested || streamStartedAt) {
      await runAction('Stop stream', () => stopActiveStream('Stopped'));
      return;
    }

    setStreamStartPendingValue(true);
    setStreamStatus(
      streamCloudServerEnabledRef.current
        ? `Starting ${streamProtocol.toUpperCase()} stream`
        : 'Starting WebRTC stream to phone',
    );
    await runAction('Start stream', async () => {
      try {
        requireConnected('start streaming');
        requireGlassesWifi('start streaming');
        if (streamCloudServerEnabledRef.current) {
          await startCloudStream();
          return;
        }
        await startPhoneWebRtcStream();
      } finally {
        setStreamStartPendingValue(false);
      }
    });
  }

  async function startCloudStream() {
    const url = streamUrl.trim();
    const validationMessage = streamUrlValidationMessage(url);
    if (validationMessage) {
      setStreamStatus(validationMessage);
      throw new Error(validationMessage);
    }
    if (streamProtocol === 'rtmp' || streamProtocol === 'srt' || streamProtocol === 'webrtc') {
      setStreamStatus(`Checking local ${streamProtocol.toUpperCase()} server`);
      const reachabilityMessage =
        streamProtocol === 'rtmp'
          ? await localRtmpReachabilityMessage(url)
          : streamProtocol === 'srt'
            ? await localSrtReachabilityMessage(url)
            : await localWebrtcReachabilityMessage(url);
      if (reachabilityMessage) {
        setStreamStatus(reachabilityMessage);
        throw new Error(reachabilityMessage);
      }
    }
    const streamId = `rn-${Date.now()}`;
    const params = {
      streamId,
      streamUrl: url,
      type: 'start_stream',
      video: {fps: streamFps},
    } satisfies StreamStartRequest;
    const status = await BluetoothSdk.startStream(params);
    addEvent('LIVE', `stream ${status.status}`);
    activeStreamIdRef.current = streamId;
    setStreamRequested(true);
    setStreamPreviewReady(false);
    setStreamStatus(`Starting ${streamProtocol.toUpperCase()} stream; waiting for preview`);
    void startPreviewReadinessPoll(url, streamProtocol, streamId);
  }

  async function startPhoneWebRtcStream() {
    const receiver = await MentraVideoStreamReceiver.startWebRtcReceiver();
    setDirectStreamReceiverRunning(true);
    setDirectStreamWhipUrl(receiver.streamUrl);
    setStreamPreviewReady(false);
    setStreamStatus('Phone WebRTC receiver ready; starting glasses stream');
    await delay(DIRECT_WEBRTC_RECEIVER_WARMUP_MS);

    const streamId = `rn-${Date.now()}`;
    const params = {
      streamId,
      streamUrl: receiver.streamUrl,
      type: 'start_stream',
      video: {fps: streamFps},
    } satisfies StreamStartRequest;
    try {
      const status = await BluetoothSdk.startStream(params);
      addEvent('LIVE', `stream ${status.status}`);
      activeStreamIdRef.current = streamId;
      setStreamRequested(true);
      setStreamPreviewReady(false);
      setStreamStatus('Starting WebRTC stream to phone; waiting for preview');
    } catch (error) {
      await MentraVideoStreamReceiver.stopWebRtcReceiver().catch(() => undefined);
      setDirectStreamReceiverRunning(false);
      setDirectStreamWhipUrl(null);
      throw error;
    }
  }

  async function stopActiveStream(status: string) {
    stopPreviewHealthPoll();
    stopDirectStreamFrameWatchdog();
    activeStreamIdRef.current = null;
    setStreamStartPendingValue(false);
    if (isGlassesConnected(glasses)) {
      const status = await BluetoothSdk.stopStream();
      addEvent('LIVE', `stream ${status.status}`);
    }
    await MentraVideoStreamReceiver.stopWebRtcReceiver().catch(() => undefined);
    setDirectStreamReceiverRunning(false);
    setDirectStreamWhipUrl(null);
    setStreamRequested(false);
    setStreamPreviewReady(false);
    setStreamStartedAt(null);
    setStreamStatus(status);
  }

  async function startPreviewReadinessPoll(
    url: string,
    protocol: StreamProtocol,
    streamId: string,
  ) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(1000);
      if (activeStreamIdRef.current !== streamId) {
        return;
      }
      if (await streamPreviewIsReady(url, protocol)) {
        if (activeStreamIdRef.current === streamId) {
          setStreamPreviewReady(true);
          setStreamStatus(`${protocol.toUpperCase()} preview ready`);
          addEvent('LIVE', `${protocol.toUpperCase()} preview ready`);
          startPreviewHealthPoll(url, protocol, streamId);
        }
        return;
      }
    }
    if (activeStreamIdRef.current === streamId) {
      setStreamStatus('Stream requested; preview is still starting');
      addEvent('TX', `${protocol.toUpperCase()} preview did not become ready`);
    }
  }

  function startPreviewHealthPoll(
    url: string,
    protocol: StreamProtocol,
    streamId: string,
  ) {
    stopPreviewHealthPoll();
    let lastReady = true;
    previewHealthTimerRef.current = setInterval(() => {
      void (async () => {
        if (activeStreamIdRef.current !== streamId) {
          stopPreviewHealthPoll();
          return;
        }
        const ready = await streamPreviewIsReady(url, protocol);
        if (activeStreamIdRef.current !== streamId) {
          return;
        }
        if (ready && !lastReady) {
          setStreamPreviewReady(true);
          setStreamStatus(`${protocol.toUpperCase()} preview ready`);
          addEvent('LIVE', `${protocol.toUpperCase()} preview ready`);
        } else if (!ready && lastReady) {
          setStreamPreviewReady(false);
          setStreamStatus(`${protocol.toUpperCase()} media path lost; preview may be frozen`);
          addEvent('TX', `${protocol.toUpperCase()} media path lost`);
        }
        lastReady = ready;
      })();
    }, 3000);
  }

  function stopPreviewHealthPoll() {
    if (previewHealthTimerRef.current) {
      clearInterval(previewHealthTimerRef.current);
      previewHealthTimerRef.current = null;
    }
  }

  function clearPhotoUploadTimeout() {
    if (photoUploadTimeoutRef.current) {
      clearTimeout(photoUploadTimeoutRef.current);
      photoUploadTimeoutRef.current = null;
    }
  }

  function stopDirectStreamFrameWatchdog() {
    if (directStreamFrameStaleTimerRef.current) {
      clearTimeout(directStreamFrameStaleTimerRef.current);
      directStreamFrameStaleTimerRef.current = null;
    }
  }

  async function requestWifiScan() {
    await runAction('Scan Wi-Fi', async () => {
      requireConnected('scan Wi-Fi');
      const networks = await BluetoothSdk.requestWifiScan();
      addEvent('LIVE', `Wi-Fi scan returned ${networks.length} network${networks.length === 1 ? '' : 's'}`);
    });
  }

  async function sendWifiCredentials(ssid: string, password: string, requiresPassword: boolean) {
    await runAction(`Connect Wi-Fi ${ssid}`, async () => {
      requireConnected('send Wi-Fi credentials');
      if (requiresPassword && !password) {
        throw new Error(`Enter the Wi-Fi password before connecting to ${ssid}.`);
      }
      const status = await BluetoothSdk.sendWifiCredentials(ssid, requiresPassword ? password : '');
      addEvent('LIVE', `Wi-Fi ${status.state === 'connected' ? status.ssid : status.state}`);
    });
  }

  async function forgetCurrentWifiNetwork() {
    await runAction('Forget current Wi-Fi', async () => {
      requireConnected('forget Wi-Fi network');
      const wifi = connectedWifiStatus(glasses);
      if (!wifi) {
        throw new Error('No connected Wi-Fi network to forget.');
      }
      const status = await BluetoothSdk.forgetWifiNetwork(wifi.ssid);
      addEvent('LIVE', `Wi-Fi ${status.state === 'connected' ? status.ssid : status.state}`);
    });
  }

  async function toggleHotspot() {
    await runAction(hotspotEnabled ? 'Disable hotspot' : 'Enable hotspot', async () => {
      requireConnected('toggle hotspot');
      const next = !hotspotEnabled;
      const status = await BluetoothSdk.setHotspotState(next);
      addEvent('LIVE', `hotspot ${status.state}`);
    });
  }

  async function openGalleryServer() {
    await runAction('Open gallery server', async () => {
      const baseUrl = requireGalleryServerUrl(glasses, hotspotEnabled);
      setGalleryServerReachable(null);
      setGalleryServerStatus(`Gallery server: checking ${baseUrl}`);
      const result = await checkGalleryServerReachability(baseUrl, glasses);
      setGalleryServerReachable(result.reachable);
      setGalleryServerStatus(result.status);
      addEvent(result.eventTag, result.eventText);
      if (result.reachable) {
        await Linking.openURL(baseUrl);
      }
    });
  }

  async function copyGalleryServerUrl() {
    await runAction('Copy gallery URL', async () => {
      const baseUrl = requireGalleryServerUrl(glasses, hotspotEnabled);
      Clipboard.setString(baseUrl);
      setGalleryServerStatus(`Gallery server: copied ${baseUrl}`);
    });
  }

  async function copyGalleryHotspotPassword() {
    await runAction('Copy hotspot password', async () => {
      const password = galleryHotspotPasswordLabel(glasses);
      Clipboard.setString(password);
      setGalleryServerStatus(`Hotspot password copied: ${password}`);
    });
  }

  async function openWifiSettings() {
    await runAction('Open Wi-Fi settings', async () => {
      if (Platform.OS === 'android') {
        const androidLinking = Linking as typeof Linking & {
          sendIntent?: (action: string) => Promise<void>;
        };
        if (androidLinking.sendIntent) {
          await androidLinking.sendIntent('android.settings.WIFI_SETTINGS');
          return;
        }
      }
      const ssid = galleryHotspotSsidLabel(glasses);
      setGalleryServerStatus(`Join ${ssid} from system Wi-Fi settings, then tap Open.`);
      addEvent('LIVE', `Join ${ssid} from system Wi-Fi settings, then tap Open.`);
    });
  }

  async function toggleMic() {
    await runAction(micRecording ? 'Stop microphone' : 'Start microphone', async () => {
      if (micRecordingRef.current) {
        await stopMicRecording();
      } else {
        await startMicRecording();
      }
    });
  }

  async function playMicRecording() {
    await runAction(micPlaying ? 'Stop mic playback' : 'Play mic recording', async () => {
      if (micPlayingRef.current) {
        await stopMicPlayback();
        return;
      }
      await startMicPlayback();
    });
  }

  async function setVoiceActivityDetectionEnabledAction(enabled: boolean) {
    await runAction(enabled ? 'Enable voice activity detection' : 'Disable voice activity detection', async () => {
      requireConnected('change voice activity detection');
      setVoiceActivityDetectionEnabledState(enabled);
      await BluetoothSdk.setVoiceActivityDetectionEnabled(enabled);
    });
  }

  async function openBluetoothSettings() {
    await runAction('Open Bluetooth settings', async () => {
      if (Platform.OS === 'android') {
        const androidLinking = Linking as typeof Linking & {
          sendIntent?: (action: string) => Promise<void>;
        };
        if (androidLinking.sendIntent) {
          await androidLinking.sendIntent('android.settings.BLUETOOTH_SETTINGS');
          return;
        }
      }

      if (Platform.OS === 'ios') {
        setMicPlaybackHint('Open iOS Settings > Bluetooth and connect/select the glasses for audio playback.');
        addEvent('LIVE', 'iOS blocks reliable Bluetooth Settings deep links. Open Settings > Bluetooth manually.');
        return;
      }

      await Linking.openSettings();
    });
  }

  async function startMicRecording() {
    requireConnected('stream microphone audio');
    await stopMicPlayback();
    micPcmChunksRef.current = [];
    micPcmChunkIndexRef.current = 0;
    micPcmStatsRef.current = {bytes: 0, frames: 0};
    lastMicFileUriRef.current = null;
    micElapsedSecondsRef.current = 0;
    micStartedAtRef.current = Date.now();
    setLastMicBytes(0);
    setLastMicDurationSeconds(null);
    setMicPlaybackHint(null);
    setMicElapsedSeconds(0);
    setPcmBytes(0);
    setPcmFrames(0);
    micRecordingRef.current = true;
    setMicRecording(true);
    startMicElapsedTimer();
    try {
      await BluetoothSdk.setMicState(true, true);
    } catch (error) {
      micRecordingRef.current = false;
      setMicRecording(false);
      stopMicElapsedTimer();
      throw error;
    }
  }

  async function stopMicRecording() {
    micRecordingRef.current = false;
    setMicRecording(false);
    stopMicElapsedTimer();
    flushMicStats();

    if (isGlassesConnected(glasses)) {
      await BluetoothSdk.setMicState(false);
    }

    const pcm = concatChunks(micPcmChunksRef.current);
    micPcmChunksRef.current = [];
    if (pcm.byteLength === 0) {
      lastMicFileUriRef.current = null;
      setLastMicBytes(0);
      setLastMicDurationSeconds(null);
      setMicPlaybackHint('No speech audio captured. Keep the glasses connected, speak while recording, and try again.');
      addEvent('LIVE', 'microphone stopped with no PCM data');
      return;
    }

    const file = new File(Paths.cache, 'mentra-mic-last.wav');
    file.create({intermediates: true, overwrite: true});
    file.write(wavBytes(pcm));
    lastMicFileUriRef.current = file.uri;
    setLastMicBytes(pcm.byteLength);
    setLastMicDurationSeconds(
      Math.max(micElapsedSecondsRef.current, estimatedMicDurationSeconds(pcm.byteLength)),
    );
    setMicPlaybackHint(null);
    addEvent('LIVE', `saved microphone WAV ${pcm.byteLength} bytes`);
  }

  async function startMicPlayback(restart = false) {
    const uri = lastMicFileUriRef.current;
    if (!uri || lastMicBytes <= 0) {
      throw new Error('Record microphone audio before playback.');
    }

    await stopMicPlayback();
    await setAudioModeAsync({interruptionMode: 'duckOthers', playsInSilentMode: true});
    if (Platform.OS === 'ios') {
      setMicPlaybackHint('If playback is silent, open iOS Settings > Bluetooth and connect/select the glasses.');
      addEvent('LIVE', 'iOS playback uses the selected system audio output. Pair/select the glasses in Settings > Bluetooth first.');
    } else if (Platform.OS === 'android') {
      addEvent('LIVE', 'Android playback uses the bonded Bluetooth audio route. Accept the pairing dialog after BLE connects.');
    }

    try {
      const player = createAudioPlayer({uri}, {updateInterval: 250});
      micPlayerRef.current = player;
      micPlayerSubscriptionRef.current = player.addListener(
        'playbackStatusUpdate',
        (status) => {
          if (status.didJustFinish) {
            void stopMicPlayback();
          }
        },
      );
      if (restart) {
        await player.seekTo(0);
      }
      await BluetoothSdk.setOwnAppAudioPlaying(true);
      micPlayingRef.current = true;
      setMicPlaybackHint(null);
      setMicPlaying(true);
      player.play();
    } catch (error) {
      await stopMicPlayback();
      setMicPlaybackHint(formatError(error));
      throw error;
    }
  }

  async function stopMicPlayback() {
    const wasPlaying = releaseMicPlayer();
    if (wasPlaying) {
      await BluetoothSdk.setOwnAppAudioPlaying(false);
    }
  }

  function stopMicPlaybackSync() {
    const wasPlaying = releaseMicPlayer();
    if (wasPlaying) {
      void BluetoothSdk.setOwnAppAudioPlaying(false).catch(() => undefined);
    }
  }

  function releaseMicPlayer() {
    micPlayerSubscriptionRef.current?.remove();
    micPlayerSubscriptionRef.current = null;
    if (micPlayerRef.current) {
      try {
        micPlayerRef.current.pause();
        micPlayerRef.current.remove();
      } catch {
        // The player may already be torn down after a native completion callback.
      }
    }
    micPlayerRef.current = null;
    const wasPlaying = micPlayingRef.current;
    micPlayingRef.current = false;
    setMicPlaying(false);
    return wasPlaying;
  }

  function startMicElapsedTimer() {
    stopMicElapsedTimer();
    micElapsedTimerRef.current = setInterval(() => {
      const startedAt = micStartedAtRef.current;
      if (!startedAt) {
        return;
      }
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      micElapsedSecondsRef.current = elapsed;
      setMicElapsedSeconds(elapsed);
      flushMicStats();
    }, 250);
  }

  function stopMicElapsedTimer() {
    if (micElapsedTimerRef.current) {
      clearInterval(micElapsedTimerRef.current);
      micElapsedTimerRef.current = null;
    }
    micStartedAtRef.current = null;
  }

  function flushMicStats() {
    setPcmFrames(micPcmStatsRef.current.frames);
    setPcmBytes(micPcmStatsRef.current.bytes);
  }

  async function selectLedMode(mode: LedMode) {
    await runAction(`RGB LED ${mode}`, async () => {
      requireConnected('control the RGB LED');
      setLedMode(mode);
      await sendRgbLedRequest(mode, ledColor);
    });
  }

  async function selectLedColor(color: LedColor) {
    await runAction(`RGB LED color ${color.toUpperCase()}`, async () => {
      requireConnected('control the RGB LED');
      if (!RGB_LED_COLORS.includes(color)) {
        throw new Error(`Unsupported RGB LED color: ${color}`);
      }
      setLedColor(color);
      if (ledMode !== 'Off') {
        await sendRgbLedRequest(ledMode, color);
      }
    });
  }

  async function sendRgbLedRequest(mode: LedMode, color: LedColor) {
    const requestId = `rgb-${Date.now()}`;
    const request = rgbLedRequestFor(mode, color);
    const response = await BluetoothSdk.rgbLedControl(
      requestId,
      PHOTO_APP_ID,
      request.action,
      request.color,
      request.ontime,
      request.offtime,
      request.count,
    );
    addEvent('LIVE', `RGB LED ack ${response.requestId}`);
  }

  function rgbLedRequestFor(mode: LedMode, color: LedColor): { action: RgbLedAction; color: LedColor | null; ontime: number; offtime: number; count: number } {
    switch (mode) {
      case 'Solid':
        return { action: 'on', color, ontime: 30_000, offtime: 0, count: 1 };
      case 'Pulse':
        return { action: 'on', color, ontime: 900, offtime: 900, count: 6 };
      case 'Blink':
        return { action: 'on', color, ontime: 250, offtime: 250, count: 12 };
      default:
        return { action: 'off', color: null, ontime: 0, offtime: 0, count: 0 };
    }
  }

  function requireConnected(feature: string) {
    if (isGlassesConnected(glasses)) {
      return;
    }
    const message = `Connect glasses first to ${feature}.`;
    if (feature.includes('photo') || feature.includes('capture') || feature.includes('video')) {
      setCameraStatus(message);
    }
    if (feature.includes('stream')) {
      setStreamStatus(message);
    }
    addEvent('TX', message);
    throw new Error(message);
  }

  function requireGlassesWifi(feature: string) {
    if (isGlassesWifiConnected(glasses)) {
      return;
    }
    const message = `Connect the glasses to Wi-Fi from the System tab before you ${feature}.`;
    if (feature.includes('photo') || feature.includes('capture') || feature.includes('video')) {
      setCameraStatus(`Camera: ${message}`);
    }
    if (feature.includes('stream')) {
      setStreamStatus(message);
    }
    addEvent('TX', message);
    throw new Error(message);
  }

  function requireDisplaySupport(feature: string) {
    requireConnected(feature);
    if (!supportsDisplay(glasses)) {
      throw new Error('This glasses model has no display, so display commands are unavailable.');
    }
  }

  function applyDisconnectedState(status: string) {
    stopPreviewHealthPoll();
    stopDirectStreamFrameWatchdog();
    clearPhotoUploadTimeout();
    void MentraVideoStreamReceiver.stopWebRtcReceiver().catch(() => undefined);
    activeStreamIdRef.current = null;
    setStreamStartPendingValue(false);
    const disconnectedPhotoRequestId = activePhotoRequestIdRef.current;
    const disconnectedVideoRequestId = activeVideoRequestIdRef.current;
    const hadPhotoRequest = disconnectedPhotoRequestId !== null;
    const hadVideoRequest = disconnectedVideoRequestId !== null || videoRecordingRef.current;
    activePhotoRequestIdRef.current = null;
    activeVideoRequestIdRef.current = null;
    videoRecordingRef.current = false;
    setVideoRecording(false);
    if (hadPhotoRequest) {
      pollGenerationRef.current += 1;
      setCameraStatus('Disconnected before photo upload completed');
      setPhotoStatus({
        type: 'photo_status',
        requestId: disconnectedPhotoRequestId ?? 'disconnected',
        status: 'failed',
        timestamp: Date.now(),
        errorCode: 'DISCONNECTED',
        errorMessage: 'Disconnected before photo upload completed',
      });
    }
    if (hadVideoRequest) {
      videoPollGenerationRef.current += 1;
      setCameraStatus('Disconnected before video upload completed');
      setVideoStatus({
        type: 'video_recording_status',
        requestId: disconnectedVideoRequestId ?? 'disconnected',
        success: false,
        status: 'error',
        timestamp: Date.now(),
        details: 'Disconnected before video upload completed',
      });
      setVideoPreviewDetails((current) => ({
        ...current,
        error: 'Disconnected before video upload completed',
        requestId: disconnectedVideoRequestId ?? current?.requestId ?? null,
        source: 'Cloud server',
        state: 'error',
      }));
    }
    setStreamRequested(false);
    setDirectStreamReceiverRunning(false);
    setDirectStreamWhipUrl(null);
    setStreamPreviewReady(false);
    setStreamStartedAt(null);
    setStreamStatus(status);
    setGalleryServerReachable(null);
    setGalleryServerStatus('Gallery server: connect glasses first');
    otaStatusRef.current = null;
    setOtaStatus(null);
    clearOtaDisplayProgress();
    setOtaStatusMessage(null);
    setOtaUpdateAvailable(false);
    setMicRecording(false);
    micRecordingRef.current = false;
    stopMicElapsedTimer();
    void stopMicPlayback();
  }

  function applyOtaStatus(payload: OtaStatusEvent) {
    if (!isDisplayableOtaStatus(payload)) {
      otaStatusRef.current = null;
      setOtaStatus(null);
      clearOtaDisplayProgress();
      setOtaStatusMessage('No active OTA');
      setOtaUpdateAvailable(false);
      addEvent('LIVE', 'OTA idle');
      return;
    }

    const displayPercent = updateOtaDisplayPercent(payload);
    otaStatusRef.current = payload;
    setOtaStatus(payload);
    setOtaDisplayPercent(displayPercent);
    setOtaStatusMessage(null);
    if (payload.status === 'complete' || payload.status === 'failed') {
      setOtaUpdateAvailable(false);
    }
    addEvent('LIVE', `OTA ${payload.status} ${payload.overall_percent ?? 0}%`);
    schedulePostOtaCheck(payload);
  }

  function applyStreamStatus(payload: StreamStatusEvent) {
    const resolvedConfig = (payload as {resolvedConfig?: StreamResolvedConfig})
      .resolvedConfig;
    const summary = summarizeMap(payload);

    const status = payload.status;
    if (
      status === 'streaming' ||
      status === 'initializing' ||
      status === 'reconnecting' ||
      status === 'reconnected'
    ) {
      if (typeof payload.streamId === 'string') {
        activeStreamIdRef.current = payload.streamId;
      }
      setStreamRequested(true);
      setStreamStartedAt((current) => current ?? Date.now());
      if (resolvedConfig) {
        setStreamResolvedConfig(resolvedConfig);
      }
      return;
    }
    if (
      status === 'stopped' ||
      status === 'stopping' ||
      status === 'error' ||
      status === 'reconnect_failed'
    ) {
      stopPreviewHealthPoll();
      stopDirectStreamFrameWatchdog();
      activeStreamIdRef.current = null;
      setStreamStartPendingValue(false);
      void MentraVideoStreamReceiver.stopWebRtcReceiver().catch(() => undefined);
      setDirectStreamReceiverRunning(false);
      setDirectStreamWhipUrl(null);
      setStreamRequested(false);
      setStreamPreviewReady(false);
      stopDirectStreamFrameWatchdog();
      if (!resolvedConfig) {
        setStreamResolvedConfig(null);
      }
      setStreamStartedAt(null);
      setStreamStatus(
        status === 'error'
          ? `Stream error: ${payload.errorDetails ?? summary}`
          : status === 'reconnect_failed'
            ? `Stream reconnect failed: ${summary}`
            : status === 'stopping'
              ? 'Stopping stream'
              : 'Stream stopped',
      );
    }
    if (resolvedConfig) {
      setStreamResolvedConfig(resolvedConfig);
    }
  }

  return {
    activeAction,
    barcodeScan,
    cameraButtonNotice,
    phone,
    cameraStatus,
    cameraFov,
    cameraRoiPosition,
    cameraSettingsApplying,
    cameraSettingsStatus,
    captureAndUpload,
    checkForOtaUpdate,
    clearDefaultDevice,
    clearDisplay,
    connect,
    connectDevice,
    copyGalleryHotspotPassword,
    copyGalleryServerUrl,
    disconnect,
    defaultDevice,
    directStreamReceiverRunning,
    directStreamWhipUrl,
    discoveredDevices,
    displayHello,
    events,
    forgetCurrentWifiNetwork,
    galleryModeEnabled,
    galleryServerReachable,
    galleryServerStatus,
    glasses,
    hotspotEnabled,
    lastAction,
    lastMicBytes,
    lastMicDurationSeconds,
    ledColor,
    ledMode,
    micAudioRouteStatus,
    micElapsedSeconds,
    micPlaybackHint,
    micPlaying,
    micRecording,
    otaStatus,
    otaDisplayPercent,
    otaStatusMessage,
    otaUpdateAvailable,
    openBluetoothSettings,
    openGalleryServer,
    openPhotoPreview,
    openWifiSettings,
    applyCameraSettings,
    pcmBytes,
    pcmFrames,
    speaking,
    permissionStatus,
    phonePhotoReceiverRunning,
    phonePhotoUploadUrl,
    photoCompression,
    photoCloudServerEnabled,
    photoAeExposureDivisor,
    photoIsoCap,
    photoNoiseReduction,
    photoEdgeEnhancement,
    photoMfnr,
    photoZsl,
    photoIspDigitalGain,
    photoIspAnalogGain,
    photoExposureManual,
    photoIso,
    photoExposureTimeNs,
    photoPreviewDetails,
    photoPreviewUrl,
    photoStatus,
    photoSize,
    scanMode,
    scanAeDivisor,
    scanIsoCap,
    videoPreviewDetails,
    videoPreviewUrl,
    videoRecording,
    videoStatus,
    playMicRecording,
    rawJsonExpanded,
    requestWifiScan,
    scanActive,
    selectDiscoveredDevice,
    selectLedColor,
    selectLedMode,
    selectedScanModel,
    selectScanModel,
    selectProtocol,
    sendWifiCredentials,
    setGalleryModeEnabled: setGalleryModeEnabledAction,
    setPhotoCompression: setPhotoCompressionAction,
    setPhotoCloudServerEnabled: setPhotoCloudServerEnabledAction,
    setPhotoAeExposureDivisor: setPhotoAeExposureDivisorAction,
    setPhotoIsoCap: setPhotoIsoCapAction,
    setPhotoNoiseReduction: setPhotoNoiseReductionAction,
    setPhotoEdgeEnhancement: setPhotoEdgeEnhancementAction,
    setPhotoMfnr: setPhotoMfnrAction,
    setPhotoZsl: setPhotoZslAction,
    setPhotoIspDigitalGain: setPhotoIspDigitalGainAction,
    setPhotoIspAnalogGain: setPhotoIspAnalogGainAction,
    setPhotoExposureManual,
    setPhotoIso: setPhotoIsoAction,
    setPhotoExposureTimeNs: setPhotoExposureTimeNsAction,
    setPhotoSize: setPhotoSizeAction,
    setScanMode: setScanModeAction,
    setScanAeDivisor: setScanAeDivisorAction,
    setScanIsoCap: setScanIsoCapAction,
    setCameraFov: setCameraFovAction,
    setCameraRoiPosition: setCameraRoiPositionAction,
    setRawJsonExpanded,
    setStreamCloudServerEnabled: setStreamCloudServerEnabledAction,
    setStreamFps: setStreamFpsAction,
    setStreamUrl: setStreamUrlAction,
    setWebhookUrl: setWebhookUrlAction,
    setVoiceActivityDetectionEnabled: setVoiceActivityDetectionEnabledAction,
    selectedDiscoveredDevice,
    startScan,
    startOtaUpdate,
    streamCloudServerEnabled,
    streamFps,
    streamProtocol,
    streamPreviewReady,
    streamRequested,
    streamResolvedConfig,
    streamStartPending,
    streamStartedAt,
    streamStatus,
    streamUrl,
    testWebhook,
    toggleHotspot,
    toggleMic,
    toggleVideoRecording,
    toggleStream,
    voiceActivityDetectionEnabled,
    webhookUrl,
  };
}

export function scanModelLabel(model: ScanModel) {
  return model === DeviceModels.G2 ? 'Even G2' : 'Mentra Live';
}

function scanModelFromDeviceModel(model: DeviceModel): ScanModel {
  return SCAN_MODELS.includes(model as ScanModel)
    ? (model as ScanModel)
    : DeviceModels.MentraLive;
}

function event(tag: SdkConsoleEvent['tag'], text: string): SdkConsoleEvent {
  return {
    tag,
    text,
    time: new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
  };
}

function barcodeScanSummary(barcodes: BarcodeScanResult[]) {
  return barcodes
    .map((barcode) => {
      const value = barcode.rawValue ?? barcode.displayValue ?? 'unreadable';
      return `${barcode.format}: ${value}`;
    })
    .join(' · ');
}

function dedupeBarcodeResults(barcodes: BarcodeScanResult[]) {
  const seen = new Set<string>();
  return barcodes.filter((barcode) => {
    const value = barcode.rawValue ?? barcode.displayValue;
    if (!value) {
      return true;
    }
    const key = `${barcode.format ?? 'unknown'}:${value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function loadPersistedDefaultDevice() {
  const file = new File(Paths.document, DEFAULT_DEVICE_FILE);
  if (!file.exists) {
    return null;
  }
  return parseDefaultDevice(JSON.parse(await file.text()));
}

async function savePersistedDefaultDevice(device: Device | null) {
  const file = new File(Paths.document, DEFAULT_DEVICE_FILE);
  if (!device) {
    if (file.exists) {
      file.delete();
    }
    return;
  }
  const persisted: PersistedDefaultDevice = {
    ...device,
    savedAt: Date.now(),
    version: 1,
  };
  file.create({intermediates: true, overwrite: true});
  file.write(JSON.stringify(persisted, null, 2));
}

async function loadPersistedCloudUrls(): Promise<PersistedCloudUrls | null> {
  const file = new File(Paths.document, CLOUD_URLS_FILE);
  if (!file.exists) {
    return null;
  }
  return parsePersistedCloudUrls(JSON.parse(await file.text()));
}

async function savePersistedCloudUrls(urls: {
  streamProtocol: StreamProtocol;
  streamUrl: string;
  webhookUrl: string;
}) {
  const file = new File(Paths.document, CLOUD_URLS_FILE);
  const persisted: PersistedCloudUrls = {
    savedAt: Date.now(),
    streamProtocol: urls.streamProtocol,
    streamUrl: urls.streamUrl,
    version: 1,
    webhookUrl: urls.webhookUrl,
  };
  file.create({intermediates: true, overwrite: true});
  file.write(JSON.stringify(persisted, null, 2));
}

function parsePersistedCloudUrls(value: unknown): PersistedCloudUrls | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const values = value as Record<string, unknown>;
  const version = values.version;
  if (version !== 1) {
    return null;
  }
  return {
    savedAt: typeof values.savedAt === 'number' ? values.savedAt : 0,
    streamProtocol: streamProtocolValue(values, 'streamProtocol') ?? undefined,
    streamUrl: stringValue(values, 'streamUrl') ?? undefined,
    version,
    webhookUrl: stringValue(values, 'webhookUrl') ?? undefined,
  };
}

function parseDefaultDevice(value: unknown): Device | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const values = value as Record<string, unknown>;
  const model = deviceModelValue(values, 'model');
  const name = stringValue(values, 'name');
  if (!model || !name) {
    return null;
  }
  const address = stringValue(values, 'address');
  return {
    id: stringValue(values, 'id') ?? address ?? `${model}:${name}`,
    model,
    name,
    ...(address ? {address} : {}),
  };
}

function discoveredDeviceKey(device: Device) {
  return device.id;
}

function stringValue(values: Record<string, unknown>, key: string) {
  const value = (values as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function deviceModelValue(
  values: Record<string, unknown>,
  key: string,
): DeviceModel | undefined {
  const value = stringValue(values, key);
  if (!value) {
    return undefined;
  }
  return (Object.values(DeviceModels) as string[]).includes(value) ? (value as DeviceModel) : undefined;
}

function streamProtocolValue(
  values: Record<string, unknown>,
  key: string,
): StreamProtocol | undefined {
  const value = stringValue(values, key);
  return value === 'rtmp' || value === 'srt' || value === 'webrtc' ? value : undefined;
}

export function durationText(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  return [hours, minutes, remainder]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function copyPcmFrame(pcm: MicPcmEvent['pcm'] | ArrayBufferView | ArrayLike<number>) {
  const raw = pcm as unknown;
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw).slice();
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
  }
  return Uint8Array.from(raw as ArrayLike<number>);
}

function formatMicPcmMetadata(event: MicPcmEvent) {
  return `${event.sampleRate}Hz ${event.bitsPerSample}-bit ${event.channels}ch ${event.encoding}`;
}

function formatMicLc3Metadata(event: MicLc3Event) {
  return `${event.lc3.byteLength} bytes, ${event.frameDurationMs}ms, ${event.sampleRate}Hz ${event.channels}ch, ${event.bitrate}bps`;
}

function concatChunks(chunks: MicPcmChunk[]) {
  const orderedChunks = [...chunks].sort((left, right) => left.index - right.index);
  const totalBytes = orderedChunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of orderedChunks) {
    merged.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return merged;
}

function estimatedMicDurationSeconds(byteCount: number) {
  const bytesPerSecond = (MIC_SAMPLE_RATE * MIC_CHANNEL_COUNT * MIC_BITS_PER_SAMPLE) / 8;
  return byteCount <= 0 ? 0 : Math.ceil(byteCount / bytesPerSecond);
}

function wavBytes(pcm: Uint8Array) {
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  function writeAscii(value: string) {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
    offset += value.length;
  }

  function writeUInt16(value: number) {
    view.setUint16(offset, value, true);
    offset += 2;
  }

  function writeUInt32(value: number) {
    view.setUint32(offset, value, true);
    offset += 4;
  }

  writeAscii('RIFF');
  writeUInt32(36 + pcm.byteLength);
  writeAscii('WAVE');
  writeAscii('fmt ');
  writeUInt32(16);
  writeUInt16(1);
  writeUInt16(MIC_CHANNEL_COUNT);
  writeUInt32(MIC_SAMPLE_RATE);
  writeUInt32((MIC_SAMPLE_RATE * MIC_CHANNEL_COUNT * MIC_BITS_PER_SAMPLE) / 8);
  writeUInt16((MIC_CHANNEL_COUNT * MIC_BITS_PER_SAMPLE) / 8);
  writeUInt16(MIC_BITS_PER_SAMPLE);
  writeAscii('data');
  writeUInt32(pcm.byteLength);
  bytes.set(pcm, offset);
  return bytes;
}

function photoStatusUrl(uploadUrlText: string, requestId: string) {
  const uploadUrl = new URL(uploadUrlText);
  if (uploadUrl.protocol !== 'http:' && uploadUrl.protocol !== 'https:') {
    throw new Error('Only http and https webhook URLs are supported.');
  }
  return `${uploadUrl.protocol}//${uploadUrl.host}/uploads/${requestId}.json`;
}

function webhookHealthUrl(uploadUrlText: string) {
  const uploadUrl = new URL(uploadUrlText);
  if (uploadUrl.protocol !== 'http:' && uploadUrl.protocol !== 'https:') {
    throw new Error('Only http and https webhook URLs are supported.');
  }
  return `${uploadUrl.protocol}//${uploadUrl.host}/`;
}

export function streamPreviewTarget(protocol: StreamProtocol, streamUrl: string): StreamPreviewTarget | null {
  try {
    if (protocol === 'rtmp') {
      const url = rtmpHlsPreviewUrl(streamUrl);
      return url ? {kind: 'hls', url} : null;
    }
    if (protocol === 'srt') {
      const url = srtHlsPreviewUrl(streamUrl);
      return url ? {kind: 'hls', url} : null;
    }
    return {kind: 'web', url: webrtcPreviewUrl(streamUrl)};
  } catch {
    return null;
  }
}

function photoUploadValidationMessage(uploadUrlText: string) {
  const value = uploadUrlText.trim();
  if (value.length === 0) {
    return 'Paste the media upload URL printed by local demo cloud.';
  }
  if (value.includes('<computer-ip>')) {
    return 'Replace <computer-ip> with the IP printed by local demo cloud.';
  }
  return null;
}

async function localWebrtcReachabilityMessage(whipUrlText: string) {
  let previewUrl = '';
  try {
    previewUrl = webrtcPreviewUrl(whipUrlText);
  } catch {
    return 'Enter a valid http:// or https:// WHIP URL.';
  }

  return localHttpPreviewReachabilityMessage(previewUrl, localWebrtcSetupMessage);
}

async function localRtmpReachabilityMessage(rtmpUrlText: string) {
  let previewUrl = '';
  try {
    previewUrl = rtmpHlsPreviewUrl(rtmpUrlText) ?? '';
  } catch {
    return 'Enter a valid rtmp:// or rtmps:// publish URL.';
  }
  if (!previewUrl) {
    return null;
  }

  return localHttpPreviewReachabilityMessage(previewUrl, localRtmpSetupMessage);
}

async function localSrtReachabilityMessage(srtUrlText: string) {
  let previewUrl = '';
  try {
    previewUrl = srtHlsPreviewUrl(srtUrlText) ?? '';
  } catch {
    return 'Enter a valid srt:// publish URL.';
  }
  if (!previewUrl) {
    return null;
  }

  return localHttpPreviewReachabilityMessage(previewUrl, localSrtSetupMessage);
}

async function localHttpPreviewReachabilityMessage(
  previewUrl: string,
  setupMessage: (detail: string) => string,
) {
  try {
    const response = await fetch(cacheBustedUrl(previewUrl), {
      cache: 'no-store',
      headers: {'Cache-Control': 'no-cache', Pragma: 'no-cache'},
    });
    // MediaMTX may return 404 before a stream exists; any HTTP response means it is reachable.
    void response.status;
    return null;
  } catch (error) {
    return setupMessage(formatError(error));
  }
}

async function streamPreviewIsReady(streamUrl: string, protocol: StreamProtocol) {
  try {
    if (protocol === 'rtmp') {
      const previewUrl = rtmpHlsPreviewUrl(streamUrl);
      return previewUrl ? hlsPreviewIsReady(previewUrl) : false;
    }
    if (protocol === 'srt') {
      const previewUrl = srtHlsPreviewUrl(streamUrl);
      return previewUrl ? hlsPreviewIsReady(previewUrl) : false;
    }
    return webPreviewIsReady(webrtcPreviewUrl(streamUrl));
  } catch {
    return false;
  }
}

async function webPreviewIsReady(previewUrl: string) {
  try {
    const response = await fetch(cacheBustedUrl(previewUrl), {
      cache: 'no-store',
      headers: {'Cache-Control': 'no-cache', Pragma: 'no-cache'},
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function hlsPreviewIsReady(previewUrl: string) {
  try {
    const response = await fetch(cacheBustedUrl(previewUrl), {
      cache: 'no-store',
      headers: {'Cache-Control': 'no-cache', Pragma: 'no-cache'},
    });
    if (!response.ok) {
      return false;
    }
    return (await response.text()).includes('#EXTM3U');
  } catch {
    return false;
  }
}

function rtmpHlsPreviewUrl(rtmpUrlText: string) {
  const rtmpUrl = new URL(rtmpUrlText);
  if (rtmpUrl.protocol !== 'rtmp:' && rtmpUrl.protocol !== 'rtmps:') {
    throw new Error('Only rtmp and rtmps URLs are supported.');
  }
  if (!isLocalPreviewHost(rtmpUrl.hostname)) {
    return null;
  }
  const streamPath = rtmpUrl.pathname.replace(/^\/+|\/+$/g, '');
  rtmpUrl.protocol = rtmpUrl.protocol === 'rtmps:' ? 'https:' : 'http:';
  rtmpUrl.port = '8888';
  rtmpUrl.pathname = streamPath.length === 0 ? '/index.m3u8' : `/${streamPath}/index.m3u8`;
  rtmpUrl.search = '';
  return rtmpUrl.toString();
}

function srtHlsPreviewUrl(srtUrlText: string) {
  const srtUrl = new URL(srtUrlText);
  if (srtUrl.protocol !== 'srt:') {
    throw new Error('Only srt URLs are supported.');
  }
  if (!isLocalPreviewHost(srtUrl.hostname)) {
    return null;
  }
  const path = srtStreamPath(srtUrl.searchParams.get('streamid'));
  if (!path) {
    return null;
  }
  return `http://${srtUrl.hostname}:8888/${path}/index.m3u8`;
}

function srtStreamPath(streamId: string | null) {
  if (!streamId) {
    return null;
  }
  const parts = streamId.split(':');
  const path = parts[0] === 'publish' || parts[0] === 'read' ? parts[1] : streamId;
  return path?.replace(/^\/+|\/+$/g, '') || null;
}

function isLocalPreviewHost(host: string) {
  const normalized = host.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.local') ||
    normalized.startsWith('192.168.') ||
    normalized.startsWith('10.') ||
    normalized.startsWith('169.254.')
  ) {
    return true;
  }
  const parts = normalized.split('.').map((part) => Number(part));
  return (
    parts.length === 4 &&
    parts.every(Number.isInteger) &&
    parts[0] === 172 &&
    parts[1] >= 16 &&
    parts[1] <= 31
  );
}

function webrtcPreviewUrl(whipUrlText: string) {
  const whipUrl = new URL(whipUrlText);
  if (whipUrl.protocol !== 'http:' && whipUrl.protocol !== 'https:') {
    throw new Error('Only http and https WHIP URLs are supported.');
  }
  if (whipUrl.pathname.endsWith('/whip')) {
    whipUrl.pathname = whipUrl.pathname.slice(0, -'/whip'.length) || '/';
  }
  whipUrl.search = '';
  return whipUrl.toString();
}

function localWebrtcSetupMessage(detail: string) {
  return `Local WebRTC server not reachable (${detail}). Run python3 examples/local-demo-cloud/server.py and paste the printed WHIP publish URL.`;
}

function localRtmpSetupMessage(detail: string) {
  return `Local RTMP/HLS server not reachable (${detail}). Run python3 examples/local-demo-cloud/server.py and paste the printed RTMP publish URL.`;
}

function localSrtSetupMessage(detail: string) {
  return `Local SRT/HLS server not reachable (${detail}). Run python3 examples/local-demo-cloud/server.py and paste the printed SRT publish URL.`;
}

function streamUrlValidationMessage(streamUrl: string) {
  if (!streamUrl) {
    return 'Stream URL is required.';
  }
  if (streamUrl.includes('<computer-ip>')) {
    return 'Replace <computer-ip> with the matching publish URL printed by local demo cloud.';
  }
  if (streamUrl.includes('<') || streamUrl.includes('>') || streamUrl.includes('YOUR_')) {
    return 'Replace the placeholder stream URL before starting.';
  }
  const rtmpSegmentCount = rtmpPathSegmentCount(streamUrl);
  if (rtmpSegmentCount !== null && rtmpSegmentCount < 2) {
    return 'RTMP URL must include an app and stream key, for example rtmp://<computer-ip>:1935/live/mentra-live.';
  }
  return null;
}

function rtmpPathSegmentCount(streamUrl: string) {
  try {
    const url = new URL(streamUrl);
    if (url.protocol !== 'rtmp:' && url.protocol !== 'rtmps:') {
      return null;
    }
    return url.pathname.split('/').filter(Boolean).length;
  } catch {
    return null;
  }
}

function cacheBustedUrl(url: string) {
  return `${url}${url.includes('?') ? '&' : '?'}poll=${Date.now()}`;
}

function requireGalleryServerUrl(status: GlassesRuntimeState, fallbackEnabled: boolean) {
  const baseUrl = galleryServerUrl(status, fallbackEnabled);
  if (!baseUrl) {
    throw new Error('Enable the glasses hotspot first.');
  }
  return baseUrl;
}

async function checkGalleryServerReachability(
  baseUrl: string,
  status: GlassesRuntimeState,
) {
  try {
    const response = await fetch(cacheBustedUrl(`${baseUrl}/api/status`), {
      cache: 'no-store',
      headers: {'Cache-Control': 'no-cache', Pragma: 'no-cache'},
    });
    const body = await response.text();
    if (response.ok) {
      const totalPhotos = /"total_photos"\s*:\s*(\d+)/.exec(body)?.[1];
      return {
        reachable: true,
        status: totalPhotos
          ? `Gallery server: reachable · ${totalPhotos} items`
          : 'Gallery server: reachable',
        eventTag: 'LIVE' as const,
        eventText: `gallery server reachable ${baseUrl}`,
      };
    }
    return {
      reachable: false,
      status: `Gallery server: HTTP ${response.status}`,
      eventTag: 'TX' as const,
      eventText: `gallery server HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      reachable: false,
      status: `Gallery server: not reachable. Join ${galleryHotspotSsidLabel(status)} and retry.`,
      eventTag: 'TX' as const,
      eventText: `gallery server unreachable: ${formatError(error)}`,
    };
  }
}

function androidRuntimePermissions() {
  const permissions = [
    PermissionsAndroid.PERMISSIONS.CAMERA,
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ];

  if (Number(Platform.Version) >= ANDROID_12_API_LEVEL) {
    permissions.push(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    );
  } else {
    permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION);
  }

  if (Number(Platform.Version) >= 33) {
    permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }

  return permissions;
}

type PhotoStatusExtras = {
  requestedCaptureConfig?: PhotoRequestedCaptureConfigDetails;
  meteredPreview?: PhotoMeteredPreviewDetails;
  captureMetadata?: PhotoCaptureMetadataDetails;
};

function photoStatusLabel(event: PhotoStatusEvent, galleryModeButtonPhoto = false) {
  const base = (() => {
    if (galleryModeButtonPhoto) {
      switch (event.status) {
        case 'accepted':
        case 'queued':
          return 'gallery photo queued on glasses';
        case 'configuring':
          return 'gallery camera configured';
        case 'capturing':
          return 'saving photo on glasses';
        case 'captured':
        case 'uploading':
        case 'uploaded':
          return 'photo saved on glasses';
        case 'failed':
          return event.errorCode ?? event.errorMessage ?? 'gallery photo failed';
        default:
          return String(event.status).replace(/_/g, ' ');
      }
    }
    switch (event.status) {
      case 'accepted':
        return 'photo request started';
      case 'queued':
        return 'photo queued on glasses';
      case 'configuring':
        return 'camera configured';
      case 'capturing':
        return 'capturing photo';
      case 'captured':
        return 'photo captured';
      case 'compressing':
        return 'compressing photo';
      case 'ble_fallback_compression':
        return 'Wi-Fi upload failed; Bluetooth fallback compression';
      case 'uploading':
        return 'uploading photo';
      case 'uploaded':
        return 'photo uploaded';
      case 'ready_for_transfer':
        return 'photo ready for transfer';
      case 'transferring':
        return 'transferring photo';
      case 'failed':
        return event.errorCode ?? event.errorMessage ?? 'photo failed';
      default:
        return String(event.status).replace(/_/g, ' ');
    }
  })();
  const configSummary = photoStatusDetailSummary(event);
  return configSummary ? `${base} (${configSummary})` : base;
}

function photoBleFallbackMessage(status: string) {
  return status === 'ble_fallback_compression'
    ? 'Wi-Fi upload failed; compressing photo for Bluetooth fallback.'
    : null;
}

function photoBleFallbackProgressMessage(status: string, currentMessage?: string) {
  switch (status) {
    case 'ready_for_transfer':
      return 'Wi-Fi upload failed; compressed photo is ready for Bluetooth fallback.';
    case 'transferring':
      return 'Wi-Fi upload failed; sending compressed photo over Bluetooth.';
    default:
      return currentMessage;
  }
}

function photoStatusStartsNewCapture(status: string) {
  return status === 'accepted' || status === 'queued' || status === 'configuring';
}

function videoStatusIsFailure(status: string) {
  return [
    'already_recording',
    'not_recording',
    'request_id_mismatch',
    'service_unavailable',
    'json_error',
    'battery_low',
    'camera_busy',
    'storage_unavailable',
    'integrity_failed',
    'error',
  ].includes(status);
}

function isCameraActionButtonPress(payload: ButtonPressEvent) {
  return payload.pressType === 'short' && CAMERA_ACTION_BUTTON_IDS.has(payload.buttonId.toLowerCase());
}

function isCameraActionTouchEvent(payload: TouchEvent) {
  const gestureName = payload.gestureName?.trim();
  if (!gestureName) {
    return false;
  }
  const normalized = gestureName.toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'tap' || normalized === 'single_tap';
}

function clearPhotoBleFallbackWarning(details: PhotoPreviewDetails) {
  if (!details.bleFallbackUsed && !details.bleFallbackMessage) {
    return details;
  }
  return {
    ...details,
    bleFallbackMessage: undefined,
    bleFallbackUsed: false,
  };
}

function photoStatusDetailSummary(event: PhotoStatusEvent) {
  const eventWithExtras = event as PhotoStatusEvent & PhotoStatusExtras;
  return [
    photoResolvedConfigSummary(event.resolvedConfig),
    photoRequestedCaptureSummary(eventWithExtras.requestedCaptureConfig),
    photoMeteredPreviewSummary(eventWithExtras.meteredPreview),
    photoCaptureMetadataSummary(eventWithExtras.captureMetadata),
  ].filter(Boolean).join(' · ') || null;
}

function photoResolvedConfigSummary(config: PhotoStatusEvent['resolvedConfig']) {
  if (!config) {
    return null;
  }
  const values = [
    config.width && config.height ? `${config.width}x${config.height}` : null,
    config.quality ? `q${config.quality}` : null,
    config.requestedSize ? `requested ${config.requestedSize}` : null,
    config.transferMethod ? config.transferMethod : null,
    config.compression ? `compress ${config.compression}` : null,
    config.exposureTimeNs ? exposureTimeSummary(config.exposureTimeNs) : null,
    config.iso ? `ISO ${config.iso}` : null,
  ].filter(Boolean);
  return values.length > 0 ? values.join(' · ') : null;
}

function photoRequestedCaptureSummary(config: PhotoStatusExtras['requestedCaptureConfig']) {
  if (!config) {
    return null;
  }
  const fps = config.aeTargetFpsRange?.min != null && config.aeTargetFpsRange?.max != null
    ? `${config.aeTargetFpsRange.min}-${config.aeTargetFpsRange.max}fps`
    : null;
  const values = [
    config.manual != null ? (config.manual ? 'manual request' : 'auto request') : null,
    config.exposureTimeNs ? `request ${exposureTimeSummary(config.exposureTimeNs)}` : null,
    config.iso ? `request ISO ${config.iso}` : null,
    config.frameDurationNs ? `frame ${exposureTimeSummary(config.frameDurationNs)}` : null,
    fps,
  ].filter(Boolean);
  return values.length > 0 ? values.join(' · ') : null;
}

function photoMeteredPreviewSummary(config: PhotoStatusExtras['meteredPreview']) {
  if (!config) {
    return null;
  }
  const values = [
    config.exposureTimeNs ? `metered ${exposureTimeSummary(config.exposureTimeNs)}` : null,
    config.iso ? `metered ISO ${config.iso}` : null,
  ].filter(Boolean);
  return values.length > 0 ? values.join(' · ') : null;
}

function photoCaptureMetadataSummary(config: PhotoStatusExtras['captureMetadata']) {
  if (!config) {
    return null;
  }
  const values = [
    config.exposureTimeNs ? `actual ${exposureTimeSummary(config.exposureTimeNs)}` : null,
    config.iso ? `actual ISO ${config.iso}` : null,
    config.frameDurationNs ? `actual frame ${exposureTimeSummary(config.frameDurationNs)}` : null,
    config.aeStateName ? `AE ${config.aeStateName}` : null,
  ].filter(Boolean);
  return values.length > 0 ? values.join(' · ') : null;
}

function exposureTimeSummary(exposureTimeNs: number) {
  const seconds = exposureTimeNs / 1_000_000_000;
  if (seconds <= 0) {
    return `${Math.round(exposureTimeNs)} ns`;
  }
  return `1/${Math.round(1 / seconds)}s`;
}

function summarizeMap(values: object) {
  const record = values as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return 'empty update';
  }
  return keys
    .slice(0, 3)
    .map((key) => `${key}: ${String(record[key])}`)
    .join(', ');
}

function describeSettingsAck(ack: SettingsAckEvent) {
  const parts = [`${ack.setting} ${ack.status}`];
  if (ack.fov !== undefined) {
    parts.push(`fov=${ack.fov}`);
  }
  if (ack.roiPosition !== undefined) {
    parts.push(`roi=${ack.roiPosition}`);
  }
  if (ack.errorCode) {
    parts.push(ack.errorCode);
  }
  return parts.join(' ');
}

function describeCameraFovResult(result: CameraFovResult) {
  return `applied fov=${result.fov} roi=${result.roiPosition} request=${result.requestId}`;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clampRounded(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function roiPositionLabel(roiPosition: CameraRoiPosition) {
  return CAMERA_ROI_POSITIONS.find((option) => option.value === roiPosition)?.label ?? 'Center';
}

function otaStatusSessionKey(status: OtaStatusEvent) {
  return status.session_id || 'current-ota';
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function webhookReachabilityErrorMessage(error: unknown, healthUrl: string) {
  if (isAbortError(error)) {
    return `Timed out after 3s while this app tried to GET ${healthUrl}. This only checks app-device-to-media-server reachability.`;
  }
  const message = formatError(error);
  if (message === 'Network request failed' || error instanceof TypeError) {
    return `This app could not GET ${healthUrl}. Check that the media server is running and that this device can reach that host on the local network.`;
  }
  return message;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}
