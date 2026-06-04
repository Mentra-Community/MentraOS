import {createAudioPlayer, setAudioModeAsync, type AudioPlayer} from 'expo-audio';
import {File, Paths} from 'expo-file-system';
import {useEffect, useRef, useState} from 'react';
import {Clipboard, Linking, PermissionsAndroid, Platform} from 'react-native';
import BluetoothSdk, {
  DeviceModels,
  type AudioConnectedEvent,
  type ButtonPressEvent,
  type CompatibleGlassesSearchStopEvent,
  type LogEvent,
  type Device,
  type DeviceModel,
  type MicLc3Event,
  type MicPcmEvent,
  type OtaQueryResult,
  type OtaStatusEvent,
  type OtaUpdateAvailableEvent,
  type PhotoResponseEvent,
  type PhotoStatusEvent,
  type SettingsAckEvent,
  type SpeakingStatusEvent,
  type StreamStatusEvent,
  type TouchEvent,
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
export type PhotoSize = 'small' | 'medium' | 'large' | 'full';
export type PhotoCompression = 'none' | 'medium' | 'heavy';
export type CameraRoiPosition = 0 | 1 | 2;
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

export const RGB_LED_COLORS: LedColor[] = ['red', 'green', 'blue', 'orange', 'white'];
export const PHOTO_SIZES: PhotoSize[] = ['small', 'medium', 'large', 'full'];
export const PHOTO_COMPRESSIONS: PhotoCompression[] = ['none', 'medium', 'heavy'];
export const STREAM_MIN_FPS = 1;
export const STREAM_MAX_FPS = 24;
export const STREAM_DEFAULT_FPS = 15;
export const PHOTO_EXPOSURE_MIN_NS = 1_000_000;
export const PHOTO_EXPOSURE_MAX_NS = 33_333_333;
export const PHOTO_EXPOSURE_DEFAULT_NS = 8_333_333;
export const PHOTO_ISO_MIN = 100;
export const PHOTO_ISO_MAX = 6400;
export const PHOTO_ISO_DEFAULT = 200;
export const CAMERA_FOV_MIN = 62;
export const CAMERA_FOV_MAX = 118;
export const CAMERA_FOV_DEFAULT = 102;
export const CAMERA_ROI_POSITIONS = [
  {label: 'Center', value: 0},
  {label: 'Bottom', value: 1},
  {label: 'Top', value: 2},
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
  otaStatus: OtaStatusEvent | null;
  otaUpdateAvailable: OtaUpdateAvailableEvent | null;
  pcmBytes: number;
  pcmFrames: number;
  speaking: boolean | null;
  voiceActivityDetectionEnabled: boolean;
  permissionStatus: string;
  phonePhotoReceiverRunning: boolean;
  phonePhotoUploadUrl: string | null;
  photoCompression: PhotoCompression;
  photoCloudServerEnabled: boolean;
  photoExposureManual: boolean;
  photoIso: number;
  photoExposureTimeNs: number;
  photoPreviewDetails: PhotoPreviewDetails | null;
  photoPreviewUrl: string | null;
  photoStatus: PhotoStatusEvent | null;
  photoSize: PhotoSize;
  cameraFov: number;
  cameraRoiPosition: CameraRoiPosition;
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
  setPhotoExposureManual: (enabled: boolean) => void;
  setPhotoIso: (iso: number) => void;
  setPhotoExposureTimeNs: (exposureTimeNs: number) => void;
  setPhotoSize: (size: PhotoSize) => void;
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
  toggleStream: () => Promise<void>;
};

export type BluetoothSdkExampleModel = BluetoothSdkExampleState & BluetoothSdkExampleActions;

const PHOTO_APP_ID = 'com.mentra.examples.reactnative';
const PHOTO_POLL_ATTEMPTS = 45;
const DIRECT_PHOTO_UPLOAD_TIMEOUT_MS = 75_000;
const DIRECT_WEBRTC_RECEIVER_WARMUP_MS = 1000;
const BARCODE_SCAN_VISIBLE_TIMEOUT_MS = 2_500;
const ANDROID_12_API_LEVEL = 31;
const MIC_SAMPLE_RATE = 16000;
const MIC_CHANNEL_COUNT = 1;
const MIC_BITS_PER_SAMPLE = 16;
const DEFAULT_DEVICE_FILE = 'mentra-default-device.json';
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
  const [webhookUrl, setWebhookUrl] = useState(
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
  const [photoSize, setPhotoSize] = useState<PhotoSize>('full');
  const [photoCompression, setPhotoCompression] = useState<PhotoCompression>('none');
  const [photoExposureManual, setPhotoExposureManual] = useState(false);
  const [photoExposureTimeNs, setPhotoExposureTimeNsState] = useState(PHOTO_EXPOSURE_DEFAULT_NS);
  const [photoIso, setPhotoIsoState] = useState(PHOTO_ISO_DEFAULT);
  const [cameraFov, setCameraFovState] = useState(CAMERA_FOV_DEFAULT);
  const [cameraRoiPosition, setCameraRoiPositionState] = useState<CameraRoiPosition>(0);
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
  const [otaUpdateAvailable, setOtaUpdateAvailable] =
    useState<OtaUpdateAvailableEvent | null>(null);
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
  const activeStreamIdRef = useRef<string | null>(null);
  const pollGenerationRef = useRef(0);
  const photoCloudServerEnabledRef = useRef(false);
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
  const phone = bluetooth.sdk;
  const scanActive = bluetooth.scan.active;
  const galleryModeEnabled = phone.galleryMode.enabled;
  const hotspotEnabled = enabledHotspotStatus(glasses) !== null;
  const selectedDiscoveredDevice = bluetooth.scan.selectedDevice;
  const selectedScanModel = scanModelFromDeviceModel(bluetooth.scan.model);
  activeTabRef.current = activeTab;
  galleryModeEnabledRef.current = galleryModeEnabled;

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
      BluetoothSdk.addListener('stream_status', (payload: StreamStatusEvent) => {
        applyStreamStatus(payload);
        if (streamCloudServerEnabledRef.current) {
          setStreamStatus(JSON.stringify(payload));
        }
        addEvent('LIVE', `stream status ${summarizeMap(payload)}`);
      }),
      BluetoothSdk.addListener('ota_status', (payload: OtaStatusEvent) => {
        setOtaStatus(payload);
        if (payload.status === 'complete' || payload.status === 'failed') {
          setOtaUpdateAvailable(null);
        }
        addEvent('LIVE', `OTA ${payload.status} ${payload.overall_percent ?? 0}%`);
      }),
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
      activePhotoRequestIdRef.current = null;
      pollGenerationRef.current += 1;
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
      if (!wasConnectedRef.current) {
        void checkForOtaUpdateResult().catch((error) => {
          addEvent('TX', `OTA check failed: ${formatError(error)}`);
        });
      }
      wasConnectedRef.current = true;
      return;
    }
    if (wasConnectedRef.current && isDisconnectedStatus(glasses)) {
      wasConnectedRef.current = false;
      applyDisconnectedState('Disconnected');
    }
  }, [glassesConnected, glasses]);

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
      await checkForOtaUpdateResult();
    });
  }

  async function checkForOtaUpdateResult(): Promise<OtaQueryResult> {
    const result = await BluetoothSdk.checkForOtaUpdate();
    if (result.type === 'ota_update_available') {
      setOtaUpdateAvailable(result);
      addEvent('LIVE', `OTA available ${result.version_name ?? 'unknown'} (${(result.updates ?? []).join(', ') || 'update'})`);
      return result;
    }
    setOtaStatus(result);
    if (result.status === 'complete' || result.status === 'failed') {
      setOtaUpdateAvailable(null);
    }
    addEvent('LIVE', `OTA ${result.status} ${result.overall_percent ?? 0}%`);
    return result;
  }

  async function startOtaUpdate() {
    await runAction('Start OTA', async () => {
      if (!glassesConnected) {
        throw new Error('Connect glasses first.');
      }
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

  async function captureAndUpload() {
    clearCameraButtonNotice();
    resetBarcodeScan();
    await runAction('Capture & upload', async () => {
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
        setCameraStatus('Camera: enter a valid http:// or https:// Photo upload URL');
        throw new Error('Enter a valid http:// or https:// Photo upload URL.');
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
          size: photoSize,
          webhookUrl: uploadUrlText,
          authToken: null,
          compress: photoCompression,
          sound: true,
          exposureTimeNs: photoExposureManual ? photoExposureTimeNs : null,
          iso: photoExposureManual ? photoIso : null,
        });
        handlePhotoResponse(response);
        if (response.state === 'error') {
          throw new Error(response.errorMessage || response.errorCode || 'Photo request failed');
        }
      } catch (error) {
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
        size: photoSize,
        webhookUrl: receiver.uploadUrl,
        authToken: null,
        compress: photoCompression,
        sound: true,
        exposureTimeNs: photoExposureManual ? photoExposureTimeNs : null,
        iso: photoExposureManual ? photoIso : null,
      });
      handlePhotoResponse(response);
      if (response.state === 'error') {
        clearPhotoUploadTimeout();
        throw new Error(response.errorMessage || response.errorCode || 'Photo request failed');
      }
    } catch (error) {
      clearPhotoUploadTimeout();
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
        setCameraStatus('Camera: enter a valid http:// or https:// Photo upload URL');
        throw new Error('Enter a valid http:// or https:// Photo upload URL.');
      }

      setCameraStatus('Camera: testing local webhook');
      try {
        const response = await fetch(cacheBustedUrl(healthUrl), {
          cache: 'no-store',
          headers: {'Cache-Control': 'no-cache', Pragma: 'no-cache'},
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const json = (await response.json()) as {uploadUrl?: string};
        const host = new URL(healthUrl).host;
        setCameraStatus(`Camera: webhook reachable (${host})`);
        addEvent('LIVE', `webhook reachable ${json.uploadUrl ?? healthUrl}`);
      } catch (error) {
        const message = formatError(error);
        setCameraStatus(`Camera: webhook test failed: ${message}`);
        throw error;
      }
    });
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
    void scanPreviewBarcode(payload.fileUri);
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

  function handlePhotoResponse(payload: PhotoResponseEvent) {
    const activeRequestId = activePhotoRequestIdRef.current;
    if (activeRequestId && payload.requestId !== activeRequestId) {
      addEvent('LIVE', `ignoring stale photo ${payload.requestId}`);
      return;
    }
    if (payload.state === 'error') {
      setPhotoStatus({
        type: 'photo_status',
        requestId: payload.requestId,
        status: 'failed',
        timestamp: payload.timestamp,
        errorCode: payload.errorCode,
        errorMessage: payload.errorMessage,
      });
      setPhotoPreviewDetails({
        error: payload.errorCode ?? payload.errorMessage,
        requestId: payload.requestId,
        source: photoCloudServerEnabledRef.current ? 'Cloud server' : 'Phone receiver',
        state: 'error',
        timestamp: payload.timestamp,
      });
      resetBarcodeScan();
      setCameraStatus(
        `Camera: glasses reported ${payload.errorCode ?? payload.errorMessage}; waiting for upload`,
      );
      addEvent('LIVE', `photo response ${payload.errorCode ?? payload.errorMessage}`);
      return;
    }
    setCameraStatus(
      photoCloudServerEnabledRef.current
        ? 'Camera: photo acknowledged; waiting for cloud upload'
        : 'Camera: photo acknowledged; waiting for phone upload',
    );
    setPhotoPreviewDetails((current) => ({
      ...current,
      requestId: payload.requestId,
      source: photoCloudServerEnabledRef.current ? 'Cloud server' : 'Phone receiver',
      state: current?.state === 'preview' ? 'preview' : 'acknowledged',
      timestamp: payload.timestamp,
      uploadUrl: payload.uploadUrl,
    }));
    addEvent('LIVE', `photo response ${payload.requestId}`);
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
            bytes?: number;
            contentType?: string;
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
              byteCount: typeof json.bytes === 'number' ? json.bytes : current?.byteCount,
              contentType: json.contentType ?? current?.contentType,
              previewUrl: json.photoUrl,
              requestId: json.requestId ?? requestId,
              source: 'Cloud server',
              state: 'preview',
              uploadedAt: json.uploadedAt ?? current?.uploadedAt,
            }));
            void updatePhotoPreviewMetadata(json.photoUrl);
            void scanPreviewBarcode(json.photoUrl);
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

  function setCameraFovAction(fov: number) {
    const nextFov = clampRounded(fov, CAMERA_FOV_MIN, CAMERA_FOV_MAX);
    setCameraFovState(nextFov);
    if (nextFov === CAMERA_FOV_MAX) {
      setCameraRoiPositionState(0);
    }
  }

  function setCameraRoiPositionAction(roiPosition: CameraRoiPosition) {
    setCameraRoiPositionState(cameraFov === CAMERA_FOV_MAX ? 0 : roiPosition);
  }

  async function applyCameraSettings() {
    await runAction('Apply camera settings', async () => {
      requireConnected('apply camera settings');
      const fov = clampRounded(cameraFov, CAMERA_FOV_MIN, CAMERA_FOV_MAX);
      const roiPosition = fov === CAMERA_FOV_MAX ? 0 : cameraRoiPosition;
      setCameraSettingsStatus('Camera settings: waiting for glasses camera-ready ack');
      const ack = await BluetoothSdk.setCameraFov({fov, roiPosition});
      addEvent('LIVE', `settings_ack ${describeSettingsAck(ack)}`);
      if (ack.status === 'error') {
        throw new Error(ack.errorMessage || ack.errorCode || 'Camera settings failed');
      }
      setCameraSettingsStatus(
        `Camera settings: ${ack.ready || ack.status === 'ready' ? 'camera ready' : 'applied on glasses'}; field of view ${fov}°, ${roiPositionLabel(roiPosition)} crop`,
      );
    });
  }

  function selectProtocol(protocol: StreamProtocol) {
    if (streamRequested || streamStartedAt !== null) {
      void stopActiveStream('Stream stopped because protocol changed');
    }
    setStreamResolvedConfig(null);
    setStreamProtocol(protocol);
    setStreamUrlState((current) => {
      const trimmed = current.trim();
      if (!trimmed || STREAM_DEFAULT_URL_VALUES.has(trimmed)) {
        return STREAM_DEFAULT_URLS[protocol];
      }
      return current;
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
        setCameraStatus('Camera: enter the cloud Photo upload URL');
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
  }

  function setStreamFpsAction(fps: number) {
    if (streamRequested || streamStartedAt !== null) {
      return;
    }
    const nextFps = Math.max(STREAM_MIN_FPS, Math.min(STREAM_MAX_FPS, Math.round(fps)));
    setStreamFps(nextFps);
  }

  async function toggleStream() {
    if (streamRequested || streamStartedAt) {
      await runAction('Stop stream', () => stopActiveStream('Stopped'));
      return;
    }

    await runAction('Start stream', async () => {
      requireConnected('start streaming');
      requireGlassesWifi('start streaming');
      if (streamCloudServerEnabledRef.current) {
        await startCloudStream();
        return;
      }
      await startPhoneWebRtcStream();
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
    await BluetoothSdk.startStream(params);
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
      await BluetoothSdk.startStream(params);
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
    if (isGlassesConnected(glasses)) {
      await BluetoothSdk.stopStream();
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
      await BluetoothSdk.requestWifiScan();
    });
  }

  async function sendWifiCredentials(ssid: string, password: string, requiresPassword: boolean) {
    await runAction(`Connect Wi-Fi ${ssid}`, async () => {
      requireConnected('send Wi-Fi credentials');
      if (requiresPassword && !password) {
        throw new Error(`Enter the Wi-Fi password before connecting to ${ssid}.`);
      }
      await BluetoothSdk.sendWifiCredentials(ssid, requiresPassword ? password : '');
    });
  }

  async function forgetCurrentWifiNetwork() {
    await runAction('Forget current Wi-Fi', async () => {
      requireConnected('forget Wi-Fi network');
      const wifi = connectedWifiStatus(glasses);
      if (!wifi) {
        throw new Error('No connected Wi-Fi network to forget.');
      }
      await BluetoothSdk.forgetWifiNetwork(wifi.ssid);
    });
  }

  async function toggleHotspot() {
    await runAction(hotspotEnabled ? 'Disable hotspot' : 'Enable hotspot', async () => {
      requireConnected('toggle hotspot');
      const next = !hotspotEnabled;
      await BluetoothSdk.setHotspotState(next);
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
    if (response.state === 'error') {
      throw new Error(`RGB LED failed: ${response.errorCode}`);
    }
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
    if (feature.includes('photo') || feature.includes('capture')) {
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
    if (feature.includes('photo') || feature.includes('capture')) {
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
    const disconnectedPhotoRequestId = activePhotoRequestIdRef.current;
    const hadPhotoRequest = disconnectedPhotoRequestId !== null;
    activePhotoRequestIdRef.current = null;
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
    setStreamRequested(false);
    setDirectStreamReceiverRunning(false);
    setDirectStreamWhipUrl(null);
    setStreamPreviewReady(false);
    setStreamStartedAt(null);
    setStreamStatus(status);
    setGalleryServerReachable(null);
    setGalleryServerStatus('Gallery server: connect glasses first');
    setMicRecording(false);
    micRecordingRef.current = false;
    stopMicElapsedTimer();
    void stopMicPlayback();
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
    photoExposureManual,
    photoIso,
    photoExposureTimeNs,
    photoPreviewDetails,
    photoPreviewUrl,
    photoStatus,
    photoSize,
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
    setPhotoCompression,
    setPhotoCloudServerEnabled: setPhotoCloudServerEnabledAction,
    setPhotoExposureManual,
    setPhotoIso: setPhotoIsoAction,
    setPhotoExposureTimeNs: setPhotoExposureTimeNsAction,
    setPhotoSize,
    setCameraFov: setCameraFovAction,
    setCameraRoiPosition: setCameraRoiPositionAction,
    setRawJsonExpanded,
    setStreamCloudServerEnabled: setStreamCloudServerEnabledAction,
    setStreamFps: setStreamFpsAction,
    setStreamUrl: setStreamUrlAction,
    setWebhookUrl,
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
    streamStartedAt,
    streamStatus,
    streamUrl,
    testWebhook,
    toggleHotspot,
    toggleMic,
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
    return 'Paste the Photo upload URL printed by local demo cloud.';
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
    const previewUrl = webrtcHlsPreviewUrl(streamUrl);
    return previewUrl ? hlsPreviewIsReady(previewUrl) : false;
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

function webrtcHlsPreviewUrl(whipUrlText: string) {
  const whipUrl = new URL(whipUrlText);
  if (whipUrl.protocol !== 'http:' && whipUrl.protocol !== 'https:') {
    throw new Error('Only http and https WHIP URLs are supported.');
  }
  if (!isLocalPreviewHost(whipUrl.hostname)) {
    return null;
  }
  let path = whipUrl.pathname;
  if (path.endsWith('/whip')) {
    path = path.slice(0, -'/whip'.length);
  } else if (path.endsWith('/whep')) {
    path = path.slice(0, -'/whep'.length);
  }
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  whipUrl.protocol = 'http:';
  whipUrl.port = '8888';
  whipUrl.pathname = trimmed ? `/${trimmed}/index.m3u8` : '/index.m3u8';
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
        return 'photo request accepted';
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
  if (ack.ready !== undefined) {
    parts.push(ack.ready ? 'ready' : 'not ready');
  }
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

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
