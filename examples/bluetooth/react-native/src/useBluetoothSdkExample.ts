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
  type PhotoResponseEvent,
  type RgbLedControlResponseEvent,
  type StreamStatusEvent,
  type TouchEvent,
} from '@mentra/bluetooth-sdk';
import {
  useMentraBluetooth,
  type DefaultDeviceStorage,
  type GlassesRuntimeState,
  type PhoneSdkRuntimeState,
} from '@mentra/bluetooth-sdk/react';
import MentraDirectReceiver, {
  type DirectPhotoUploadEvent,
  type DirectReceiverStatusEvent,
  type DirectStreamFirstFrameEvent,
} from 'mentra-direct-receiver';
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

export type StreamProtocol = 'rtmp' | 'srt' | 'webrtc';
export type StreamPreviewTarget = {
  kind: 'hls' | 'web';
  url: string;
};
export type LedMode = 'Off' | 'Solid' | 'Pulse' | 'Blink';
type RgbLedAction = 'on' | 'off';
export type LedColor = 'red' | 'green' | 'blue' | 'orange' | 'white';
export type PhotoSize = 'small' | 'medium' | 'large' | 'full';
export type PhotoCompression = 'none' | 'medium' | 'heavy';
export const SCAN_MODELS = [DeviceModels.MentraLive, DeviceModels.G2] as const;
export type ScanModel = (typeof SCAN_MODELS)[number];
type StreamStartRequest = {
  keepAlive: boolean;
  keepAliveIntervalSeconds: number;
  streamId: string;
  streamUrl: string;
  type: 'start_stream';
};

type PersistedDefaultDevice = Device & {
  savedAt: number;
  version: 1;
};

export const RGB_LED_COLORS: LedColor[] = ['red', 'green', 'blue', 'orange', 'white'];
export const PHOTO_SIZES: PhotoSize[] = ['small', 'medium', 'large', 'full'];
export const PHOTO_COMPRESSIONS: PhotoCompression[] = ['none', 'medium', 'heavy'];

export const STREAM_DEFAULT_URLS: Record<StreamProtocol, string> = {
  rtmp: 'rtmp://<computer-ip>:1935/live/mentra-live',
  srt: 'srt://<computer-ip>:8890?streamid=publish:mentra-live',
  webrtc: 'http://<computer-ip>:8889/mentra-live/whip',
};

export const PHOTO_UPLOAD_DEFAULT_URL = 'http://<computer-ip>:8787/upload';

const STREAM_DEFAULT_URL_VALUES = new Set(Object.values(STREAM_DEFAULT_URLS));

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
  cameraStatus: string;
  defaultDevice: Device | null;
  discoveredDevices: Device[];
  events: SdkConsoleEvent[];
  galleryModeAuto: boolean;
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
  pcmBytes: number;
  pcmFrames: number;
  permissionStatus: string;
  phonePhotoReceiverRunning: boolean;
  phonePhotoUploadUrl: string | null;
  photoCompression: PhotoCompression;
  photoCloudServerEnabled: boolean;
  photoPreviewUrl: string | null;
  photoSize: PhotoSize;
  rawJsonExpanded: boolean;
  selectedDiscoveredDevice: Device | null;
  selectedScanModel: ScanModel;
  directStreamReceiverRunning: boolean;
  directStreamWhipUrl: string | null;
  streamCloudServerEnabled: boolean;
  streamProtocol: StreamProtocol;
  streamPreviewReady: boolean;
  streamRequested: boolean;
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
  openWifiSettings: () => Promise<void>;
  requestWifiScan: () => Promise<void>;
  playMicRecording: () => Promise<void>;
  selectDiscoveredDevice: (device: Device) => void;
  selectScanModel: (model: ScanModel) => void;
  selectLedColor: (color: LedColor) => Promise<void>;
  selectLedMode: (mode: LedMode) => Promise<void>;
  selectProtocol: (protocol: StreamProtocol) => void;
  sendWifiCredentials: (ssid: string, password: string, requiresPassword: boolean) => Promise<void>;
  setGalleryModeAuto: (enabled: boolean) => Promise<void>;
  setPhotoCompression: (compression: PhotoCompression) => void;
  setPhotoCloudServerEnabled: (enabled: boolean) => Promise<void>;
  setPhotoSize: (size: PhotoSize) => void;
  setRawJsonExpanded: (expanded: boolean) => void;
  setStreamCloudServerEnabled: (enabled: boolean) => Promise<void>;
  setStreamUrl: (url: string) => void;
  setWebhookUrl: (url: string) => void;
  startScan: () => Promise<void>;
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

export function useBluetoothSdkExample(): BluetoothSdkExampleModel {
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
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoSize, setPhotoSize] = useState<PhotoSize>('medium');
  const [photoCompression, setPhotoCompression] = useState<PhotoCompression>('medium');
  const [streamCloudServerEnabled, setStreamCloudServerEnabledState] = useState(false);
  const [directStreamReceiverRunning, setDirectStreamReceiverRunning] = useState(false);
  const [directStreamWhipUrl, setDirectStreamWhipUrl] = useState<string | null>(null);
  const [streamProtocol, setStreamProtocol] =
    useState<StreamProtocol>('webrtc');
  const [streamUrl, setStreamUrlState] = useState(
    process.env?.EXPO_PUBLIC_MENTRA_STREAM_URL ?? STREAM_DEFAULT_URLS.webrtc,
  );
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [streamRequested, setStreamRequested] = useState(false);
  const [streamPreviewReady, setStreamPreviewReady] = useState(false);
  const [streamStatus, setStreamStatus] = useState('Ready to stream WebRTC to phone');
  const [micRecording, setMicRecording] = useState(false);
  const [micPlaying, setMicPlaying] = useState(false);
  const [micElapsedSeconds, setMicElapsedSeconds] = useState(0);
  const [pcmFrames, setPcmFrames] = useState(0);
  const [pcmBytes, setPcmBytes] = useState(0);
  const [lastMicBytes, setLastMicBytes] = useState(0);
  const [lastMicDurationSeconds, setLastMicDurationSeconds] = useState<number | null>(null);
  const [micPlaybackHint, setMicPlaybackHint] = useState<string | null>(null);
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
  const photoUploadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepAliveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewHealthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
  const galleryModeAuto = phone.galleryMode.desired === 'auto';
  const hotspotEnabled = enabledHotspotStatus(glasses) !== null;
  const selectedDiscoveredDevice = bluetooth.scan.selectedDevice;
  const selectedScanModel = scanModelFromDeviceModel(bluetooth.scan.model);

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
      BluetoothSdk.addListener('button_press', (payload: ButtonPressEvent) => {
        addEvent('LIVE', `button ${payload.buttonId}: ${payload.pressType}`);
      }),
      BluetoothSdk.addListener('touch_event', (payload: TouchEvent) => {
        const gesture = payload.gestureName ?? payload.deviceModel ?? 'event';
        addEvent(
          'LIVE',
          `${gesture.toLowerCase().includes('swipe') ? 'swipe' : 'touch'} ${gesture}`,
        );
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
      MentraDirectReceiver.addListener('photoUpload', handleDirectPhotoUpload),
      MentraDirectReceiver.addListener('receiverStatus', handleDirectReceiverStatus),
      MentraDirectReceiver.addListener('streamFirstFrame', handleDirectStreamFirstFrame),
      BluetoothSdk.addListener('photo_response', handlePhotoResponse),
      BluetoothSdk.addListener('stream_status', (payload: StreamStatusEvent) => {
        applyStreamStatus(payload);
        if (streamCloudServerEnabledRef.current) {
          setStreamStatus(JSON.stringify(payload));
        }
        addEvent('LIVE', `stream status ${summarizeMap(payload)}`);
      }),
      BluetoothSdk.addListener('mic_pcm', (payload: MicPcmEvent) => {
        if (!micRecordingRef.current) {
          return;
        }
        const frame = copyPcmFrame(payload.pcm);
        if (frame.byteLength === 0) {
          return;
        }
        micPcmChunksRef.current.push({
          data: frame,
          index: micPcmChunkIndexRef.current,
        });
        micPcmChunkIndexRef.current += 1;
        micPcmStatsRef.current.frames += 1;
        micPcmStatsRef.current.bytes += frame.byteLength;
      }),
      BluetoothSdk.addListener('mic_lc3', (payload: MicLc3Event) => {
        if (micRecordingRef.current) {
          addEvent('LIVE', `received LC3 mic frame while PCM recording is enabled (${payload.lc3.byteLength} bytes)`);
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
      BluetoothSdk.addListener('rgb_led_control_response', (payload: RgbLedControlResponseEvent) => {
        addEvent('LIVE', `RGB LED ${payload.state === 'success' ? 'ack' : payload.errorCode}`);
      }),
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
      stopKeepAlive();
      stopPreviewHealthPoll();
      void MentraDirectReceiver.stopPhotoReceiver().catch(() => undefined);
      void MentraDirectReceiver.stopWebRtcReceiver().catch(() => undefined);
      activeStreamIdRef.current = null;
      activePhotoRequestIdRef.current = null;
      pollGenerationRef.current += 1;
      stopMicElapsedTimer();
      stopMicPlaybackSync();
    };
  }, []);

  useEffect(() => {
    if (glassesConnected) {
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

  async function disconnect() {
    await runAction('Disconnect', async () => {
      stopKeepAlive();
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

  async function setGalleryModeAutoAction(enabled: boolean) {
    await runAction(enabled ? 'Save in gallery mode' : 'Report button events', async () => {
      requireConnected('change gallery mode');
      await bluetooth.setGalleryMode(enabled ? 'auto' : 'manual');
    });
  }

  async function captureAndUpload() {
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
      setCameraStatus(`Camera: webhook upload requested (${requestId})`);
      await BluetoothSdk.requestPhoto(
        requestId,
        PHOTO_APP_ID,
        photoSize,
        uploadUrlText,
        null,
        photoCompression,
        true,
      );
      void pollPhotoPreview(requestId, statusUrl, pollGeneration);
  }

  async function captureAndUploadToPhone() {
    const receiver = await MentraDirectReceiver.startPhotoReceiver();
    setPhonePhotoReceiverRunning(true);
    setPhonePhotoUploadUrl(receiver.uploadUrl);

    const requestId = `photo-${Date.now()}`;
    activePhotoRequestIdRef.current = requestId;
    pollGenerationRef.current += 1;

    setPhotoPreviewUrl(null);
    setCameraStatus(`Camera: phone upload requested (${requestId})`);
    clearPhotoUploadTimeout();
    photoUploadTimeoutRef.current = setTimeout(() => {
      if (activePhotoRequestIdRef.current === requestId) {
        activePhotoRequestIdRef.current = null;
        setCameraStatus('Camera: timed out waiting for phone upload');
        addEvent('TX', `phone photo upload timed out ${requestId}`);
      }
    }, DIRECT_PHOTO_UPLOAD_TIMEOUT_MS);

    await BluetoothSdk.requestPhoto(
      requestId,
      PHOTO_APP_ID,
      photoSize,
      receiver.uploadUrl,
      null,
      photoCompression,
      true,
    );
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

  function handleDirectPhotoUpload(payload: DirectPhotoUploadEvent) {
    const activeRequestId = activePhotoRequestIdRef.current;
    if (activeRequestId && payload.requestId && payload.requestId !== activeRequestId) {
      addEvent('LIVE', `ignoring stale phone photo ${payload.requestId}`);
      return;
    }
    clearPhotoUploadTimeout();
    activePhotoRequestIdRef.current = null;
    setPhonePhotoReceiverRunning(true);
    setPhotoPreviewUrl(payload.fileUri);
    setCameraStatus(`Camera: phone photo ready (${Math.round(payload.byteCount / 1024)} KB)`);
    addEvent('LIVE', `phone photo ready ${payload.fileUri}`);
  }

  function handleDirectReceiverStatus(payload: DirectReceiverStatusEvent) {
    if (payload.kind === 'photo') {
      if (payload.message.toLowerCase().includes('ready at')) {
        setPhonePhotoReceiverRunning(true);
      }
      if (payload.message.toLowerCase().includes('stopped')) {
        setPhonePhotoReceiverRunning(false);
      }
      addEvent('LIVE', `photo receiver ${payload.message}`);
      return;
    }
    if (payload.kind === 'stream') {
      if (payload.message.toLowerCase().includes('ready at')) {
        setDirectStreamReceiverRunning(true);
      }
      if (payload.message.toLowerCase().includes('stopped')) {
        setDirectStreamReceiverRunning(false);
      }
    }
    addEvent('LIVE', `${payload.kind} receiver ${payload.message}`);
  }

  function handleDirectStreamFirstFrame(_payload: DirectStreamFirstFrameEvent) {
    if (!activeStreamIdRef.current || streamCloudServerEnabledRef.current) {
      return;
    }
    setStreamPreviewReady(true);
    setStreamStartedAt((current) => current ?? Date.now());
    setStreamStatus('WebRTC phone preview ready');
    addEvent('LIVE', 'WebRTC phone preview ready');
  }

  function handlePhotoResponse(payload: PhotoResponseEvent) {
    const activeRequestId = activePhotoRequestIdRef.current;
    if (activeRequestId && payload.requestId !== activeRequestId) {
      addEvent('LIVE', `ignoring stale photo ${payload.requestId}`);
      return;
    }
    if (payload.state === 'error') {
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
          const json = (await response.json()) as {photoUrl?: string};
          if (json.photoUrl) {
            setPhotoPreviewUrl(json.photoUrl);
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

  function selectProtocol(protocol: StreamProtocol) {
    if (streamRequested || streamStartedAt !== null) {
      void stopActiveStream('Stream stopped because protocol changed');
    }
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
      pollGenerationRef.current += 1;
      if (enabled) {
        await MentraDirectReceiver.stopPhotoReceiver().catch(() => undefined);
        setPhonePhotoReceiverRunning(false);
        setPhonePhotoUploadUrl(null);
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
    setStreamUrlState(url);
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
      keepAlive: true,
      keepAliveIntervalSeconds: 15,
      streamId,
      streamUrl: url,
      type: 'start_stream',
    } satisfies StreamStartRequest;
    await BluetoothSdk.startStream(params);
    activeStreamIdRef.current = streamId;
    setStreamRequested(true);
    setStreamPreviewReady(false);
    setStreamStatus(`Starting ${streamProtocol.toUpperCase()} stream; waiting for preview`);
    void startPreviewReadinessPoll(url, streamProtocol, streamId);
  }

  async function startPhoneWebRtcStream() {
    const receiver = await MentraDirectReceiver.startWebRtcReceiver();
    setDirectStreamReceiverRunning(true);
    setDirectStreamWhipUrl(receiver.streamUrl);
    setStreamPreviewReady(false);
    setStreamStatus('Phone WebRTC receiver ready; starting glasses stream');
    await delay(DIRECT_WEBRTC_RECEIVER_WARMUP_MS);

    const streamId = `rn-${Date.now()}`;
    const params = {
      keepAlive: true,
      keepAliveIntervalSeconds: 15,
      streamId,
      streamUrl: receiver.streamUrl,
      type: 'start_stream',
    } satisfies StreamStartRequest;
    try {
      await BluetoothSdk.startStream(params);
      activeStreamIdRef.current = streamId;
      setStreamRequested(true);
      setStreamPreviewReady(false);
      setStreamStatus('Starting WebRTC stream to phone; waiting for preview');
    } catch (error) {
      await MentraDirectReceiver.stopWebRtcReceiver().catch(() => undefined);
      setDirectStreamReceiverRunning(false);
      setDirectStreamWhipUrl(null);
      throw error;
    }
  }

  async function stopActiveStream(status: string) {
    stopKeepAlive();
    stopPreviewHealthPoll();
    activeStreamIdRef.current = null;
    if (isGlassesConnected(glasses)) {
      await BluetoothSdk.stopStream();
    }
    await MentraDirectReceiver.stopWebRtcReceiver().catch(() => undefined);
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
          setStreamStatus(`${protocol.toUpperCase()} media path lost; waiting for preview`);
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

  function startKeepAlive(streamId: string) {
    stopKeepAlive();
    keepAliveTimerRef.current = setInterval(() => {
      void BluetoothSdk.keepStreamAlive({
        ackId: `ack-${Date.now()}`,
        streamId,
        type: 'keep_stream_alive',
      });
      addEvent('TX', 'stream keep alive');
    }, 15000);
  }

  function stopKeepAlive() {
    if (keepAliveTimerRef.current) {
      clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
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
      await BluetoothSdk.setMicState(true, true, true);
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
    await BluetoothSdk.rgbLedControl(
      requestId,
      PHOTO_APP_ID,
      request.action,
      request.color,
      request.ontime,
      request.offtime,
      request.count,
    );
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
    stopKeepAlive();
    stopPreviewHealthPoll();
    clearPhotoUploadTimeout();
    void MentraDirectReceiver.stopWebRtcReceiver().catch(() => undefined);
    activeStreamIdRef.current = null;
    const hadPhotoRequest = activePhotoRequestIdRef.current !== null;
    activePhotoRequestIdRef.current = null;
    if (hadPhotoRequest) {
      pollGenerationRef.current += 1;
      setCameraStatus('Disconnected before photo upload completed');
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
      if (
        (status === 'streaming' || status === 'reconnecting' || status === 'reconnected') &&
        keepAliveTimerRef.current === null &&
        activeStreamIdRef.current
      ) {
        startKeepAlive(activeStreamIdRef.current);
      }
      return;
    }
    if (
      status === 'stopped' ||
      status === 'stopping' ||
      status === 'error' ||
      status === 'reconnect_failed'
    ) {
      stopKeepAlive();
      stopPreviewHealthPoll();
      activeStreamIdRef.current = null;
      void MentraDirectReceiver.stopWebRtcReceiver().catch(() => undefined);
      setDirectStreamReceiverRunning(false);
      setDirectStreamWhipUrl(null);
      setStreamRequested(false);
      setStreamPreviewReady(false);
      setStreamStartedAt(null);
    }
  }

  return {
    activeAction,
    phone,
    cameraStatus,
    captureAndUpload,
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
    galleryModeAuto,
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
    openBluetoothSettings,
    openGalleryServer,
    openWifiSettings,
    pcmBytes,
    pcmFrames,
    permissionStatus,
    phonePhotoReceiverRunning,
    phonePhotoUploadUrl,
    photoCompression,
    photoCloudServerEnabled,
    photoPreviewUrl,
    photoSize,
    playMicRecording,
    rawJsonExpanded,
    requestWifiScan,
    selectDiscoveredDevice,
    selectLedColor,
    selectLedMode,
    selectedScanModel,
    selectScanModel,
    selectProtocol,
    sendWifiCredentials,
    setGalleryModeAuto: setGalleryModeAutoAction,
    setPhotoCompression,
    setPhotoCloudServerEnabled: setPhotoCloudServerEnabledAction,
    setPhotoSize,
    setRawJsonExpanded,
    setStreamCloudServerEnabled: setStreamCloudServerEnabledAction,
    setStreamUrl: setStreamUrlAction,
    setWebhookUrl,
    selectedDiscoveredDevice,
    startScan,
    streamCloudServerEnabled,
    streamProtocol,
    streamPreviewReady,
    streamRequested,
    streamStartedAt,
    streamStatus,
    streamUrl,
    testWebhook,
    toggleHotspot,
    toggleMic,
    toggleStream,
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

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
