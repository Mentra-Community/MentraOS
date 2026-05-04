import {useEffect, useRef, useState} from 'react';
import {PermissionsAndroid, Platform} from 'react-native';
import BluetoothSdk, {
  type BatteryStatusEvent,
  type ButtonPressEvent,
  type CompatibleGlassesSearchStopEvent,
  type CoreStatus,
  type DeviceSearchResult,
  type GlassesStatus,
  type LogEvent,
  type MicLc3Event,
  type MicPcmEvent,
  type PhotoResponseEvent,
  type RgbLedControlResponseEvent,
  type StreamStatusEvent,
  type TouchEvent,
  type WifiStatusChangeEvent,
} from '@mentra/bluetooth-sdk';

export type StreamProtocol = 'rtmp' | 'srt' | 'webrtc';
export type LedMode = 'Off' | 'Solid' | 'Pulse' | 'Blink';

export const STREAM_DEFAULT_URLS: Record<StreamProtocol, string> = {
  rtmp: 'rtmp://<computer-ip>:1935/mentra-live',
  srt: 'srt://srt.example.com:4201?streamid=YOUR_STREAM_ID&passphrase=YOUR_PASSPHRASE',
  webrtc: 'http://<computer-ip>:8889/mentra-live/whip',
};

const STREAM_DEFAULT_URL_VALUES = new Set(Object.values(STREAM_DEFAULT_URLS));

export type SdkConsoleEvent = {
  tag: 'LIVE' | 'STORE' | 'BLE' | 'TX';
  text: string;
  time: string;
};

export type MentraSdkState = {
  activeAction: string | null;
  bluetoothStatus: Partial<CoreStatus> & Record<string, unknown>;
  cameraStatus: string;
  discoveredDevices: DeviceSearchResult[];
  events: SdkConsoleEvent[];
  galleryModeAuto: boolean;
  glassesStatus: Partial<GlassesStatus>;
  hotspotEnabled: boolean;
  lastAction: string;
  ledMode: LedMode;
  micRecording: boolean;
  pcmBytes: number;
  pcmFrames: number;
  permissionStatus: string;
  photoPreviewUrl: string | null;
  rawJsonExpanded: boolean;
  streamProtocol: StreamProtocol;
  streamStartedAt: number | null;
  streamStatus: string;
  streamUrl: string;
  webhookUrl: string;
};

export type MentraSdkActions = {
  applySettings: () => Promise<void>;
  captureAndUpload: () => Promise<void>;
  clearDisplay: () => Promise<void>;
  connect: () => Promise<void>;
  connectDevice: (device: DeviceSearchResult) => Promise<void>;
  disconnect: () => Promise<void>;
  displayHello: () => Promise<void>;
  requestWifiScan: () => Promise<void>;
  selectLedMode: (mode: LedMode) => Promise<void>;
  selectProtocol: (protocol: StreamProtocol) => void;
  sendWifiCredentials: (ssid: string) => Promise<void>;
  setRawJsonExpanded: (expanded: boolean) => void;
  setStreamUrl: (url: string) => void;
  setWebhookUrl: (url: string) => void;
  startScan: () => Promise<void>;
  testWebhook: () => Promise<void>;
  toggleHotspot: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleStream: () => Promise<void>;
};

export type MentraSdkModel = MentraSdkState & MentraSdkActions;

const PHOTO_APP_ID = 'com.mentra.examples.reactnative';
const PHOTO_POLL_ATTEMPTS = 45;
const ANDROID_12_API_LEVEL = 31;

declare const process: {
  env?: {
    EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL?: string;
    EXPO_PUBLIC_MENTRA_STREAM_URL?: string;
  };
};

export function useMentraSdk(): MentraSdkModel {
  const [glassesStatus, setGlassesStatus] = useState<Partial<GlassesStatus>>({});
  const [bluetoothStatus, setBluetoothStatus] = useState<
    Partial<CoreStatus> & Record<string, unknown>
  >({});
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
    process.env?.EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL ?? '',
  );
  const [cameraStatus, setCameraStatus] = useState(
    'Camera: enter the local webhook /upload URL',
  );
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [streamProtocol, setStreamProtocol] =
    useState<StreamProtocol>('rtmp');
  const [streamUrl, setStreamUrl] = useState(
    process.env?.EXPO_PUBLIC_MENTRA_STREAM_URL ?? STREAM_DEFAULT_URLS.rtmp,
  );
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [streamStatus, setStreamStatus] = useState('Ready to start stream');
  const [hotspotEnabled, setHotspotEnabled] = useState(false);
  const [micRecording, setMicRecording] = useState(false);
  const [pcmFrames, setPcmFrames] = useState(0);
  const [pcmBytes, setPcmBytes] = useState(0);
  const [galleryModeAuto, setGalleryModeAuto] = useState(true);
  const [ledMode, setLedMode] = useState<LedMode>('Solid');
  const [rawJsonExpanded, setRawJsonExpanded] = useState(false);
  const activePhotoRequestIdRef = useRef<string | null>(null);
  const pollGenerationRef = useRef(0);
  const keepAliveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const discoveredDevices = bluetoothStatus.searchResults ?? [];

  useEffect(() => {
    const removeGlasses = BluetoothSdk.onGlassesStatus((changed) => {
      setGlassesStatus((current) =>
        changed.connected === false
          ? disconnectedGlassesStatus(changed)
          : {...current, ...changed},
      );
      addEvent('STORE', summarizeMap(changed));
    });

    const removeBluetooth = BluetoothSdk.onCoreStatus((changed) => {
      setBluetoothStatus((current) => ({...current, ...changed}));
      addEvent('BLE', summarizeMap(changed));
    });

    const subscriptions = [
      BluetoothSdk.addListener('button_press', (payload: ButtonPressEvent) => {
        addEvent('LIVE', `button ${payload.buttonId}: ${payload.pressType}`);
      }),
      BluetoothSdk.addListener('touch_event', (payload: TouchEvent) => {
        addEvent(
          'LIVE',
          `touch ${payload.gesture_name ?? payload.device_model ?? 'event'}`,
        );
      }),
      BluetoothSdk.addListener('battery_status', (payload: BatteryStatusEvent) => {
        setGlassesStatus((current) => ({
          ...current,
          batteryLevel: payload.level,
          charging: payload.charging,
        }));
        addEvent('STORE', `battery ${payload.level}%${payload.charging ? ' charging' : ''}`);
      }),
      BluetoothSdk.addListener('wifi_status_change', (payload: WifiStatusChangeEvent) => {
        setGlassesStatus((current) => ({
          ...current,
          wifiConnected: payload.connected,
          wifiSsid: payload.ssid,
        }));
        addEvent('STORE', `Wi-Fi ${payload.connected ? 'connected' : 'disconnected'} ${payload.ssid}`);
      }),
      BluetoothSdk.addListener('photo_response', handlePhotoResponse),
      BluetoothSdk.addListener('stream_status', (payload: StreamStatusEvent) => {
        setStreamStatus(JSON.stringify(payload));
        addEvent('LIVE', `stream status ${summarizeMap(payload)}`);
      }),
      BluetoothSdk.addListener('mic_pcm', (payload: MicPcmEvent) => {
        const size = payload.pcm.byteLength;
        setPcmFrames((current) => current + 1);
        setPcmBytes((current) => current + size);
      }),
      BluetoothSdk.addListener('mic_lc3', (payload: MicLc3Event) => {
        const size = payload.lc3.byteLength;
        setPcmFrames((current) => current + 1);
        setPcmBytes((current) => current + size);
      }),
      BluetoothSdk.addListener(
        'compatible_glasses_search_stop',
        (payload: CompatibleGlassesSearchStopEvent) => {
          addEvent('BLE', `scan stopped for ${payload.device_model ?? 'glasses'}`);
        },
      ),
      BluetoothSdk.addListener('rgb_led_control_response', (payload: RgbLedControlResponseEvent) => {
        addEvent('LIVE', `RGB LED ${payload.success ? 'ack' : payload.error ?? 'failed'}`);
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
      removeGlasses();
      removeBluetooth();
      subscriptions.forEach((subscription) => subscription.remove());
      stopKeepAlive();
      activePhotoRequestIdRef.current = null;
      pollGenerationRef.current += 1;
    };
  }, []);

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
    await runAction('Scan', async () => {
      if (!(await ensureAndroidPermissions('scan'))) {
        throw new Error('Bluetooth permissions are required to scan.');
      }
      await BluetoothSdk.findCompatibleDevices('Mentra Live');
    });
  }

  async function connect() {
    await runAction('Connect', async () => {
      if (!(await ensureAndroidPermissions('connect'))) {
        throw new Error('Bluetooth permissions are required to connect.');
      }
      const firstDevice = discoveredDevices[0];
      if (firstDevice) {
        await BluetoothSdk.connectDiscoveredDevice(firstDevice);
        return;
      }
      await BluetoothSdk.connectDefault();
    });
  }

  async function connectDevice(device: DeviceSearchResult) {
    await runAction(`Connect ${device.deviceName}`, async () => {
      if (!(await ensureAndroidPermissions('connect'))) {
        throw new Error('Bluetooth permissions are required to connect.');
      }
      await BluetoothSdk.connectDiscoveredDevice(device);
    });
  }

  async function disconnect() {
    await runAction('Disconnect', async () => {
      stopKeepAlive();
      await BluetoothSdk.disconnect();
      setGlassesStatus(disconnectedGlassesStatus({connected: false}));
      setStreamStartedAt(null);
      setStreamStatus('Disconnected');
    });
  }

  async function displayHello() {
    await runAction('Display Hello', () =>
      BluetoothSdk.displayText({
        size: 24,
        text: 'Hello from Mentra Bluetooth SDK',
        x: 0,
        y: 0,
      }),
    );
  }

  async function clearDisplay() {
    await runAction('Clear Display', () => BluetoothSdk.clearDisplay());
  }

  async function applySettings() {
    await runAction('Apply Settings', () =>
      BluetoothSdk.updateCore({
        brightness: 72,
        button_camera_led: true,
        button_max_recording_time: 5,
        button_photo_size: 'medium',
        button_video_fps: 30,
        button_video_height: 1080,
        button_video_width: 1920,
        dashboard_depth: 6,
        dashboard_height: 4,
        gallery_mode: galleryModeAuto,
      }),
    );
  }

  async function captureAndUpload() {
    await runAction('Capture & upload', async () => {
      if (!(await ensureAndroidPermissions('photo'))) {
        throw new Error('Camera and Bluetooth permissions are required for photos.');
      }
      const uploadUrlText = webhookUrl.trim();
      let statusUrl = '';
      try {
        statusUrl = photoStatusUrl(uploadUrlText, '');
      } catch {
        setCameraStatus('Camera: enter a webhook URL like http://<computer-ip>:8787/upload');
        throw new Error('Invalid webhook URL.');
      }

      const requestId = `photo-${Date.now()}`;
      statusUrl = photoStatusUrl(uploadUrlText, requestId);
      activePhotoRequestIdRef.current = requestId;
      pollGenerationRef.current += 1;
      const pollGeneration = pollGenerationRef.current;

      setPhotoPreviewUrl(null);
      setCameraStatus(`Camera: webhook upload requested (${requestId})`);
      await BluetoothSdk.photoRequest(
        requestId,
        PHOTO_APP_ID,
        'medium',
        uploadUrlText,
        null,
        'medium',
        false,
        true,
      );
      void pollPhotoPreview(requestId, statusUrl, pollGeneration);
    });
  }

  async function testWebhook() {
    await runAction('Test webhook', async () => {
      let healthUrl = '';
      try {
        healthUrl = webhookHealthUrl(webhookUrl.trim());
      } catch {
        setCameraStatus('Camera: enter a webhook URL like http://<computer-ip>:8787/upload');
        throw new Error('Invalid webhook URL.');
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

  function handlePhotoResponse(payload: PhotoResponseEvent) {
    const activeRequestId = activePhotoRequestIdRef.current;
    if (activeRequestId && payload.requestId !== activeRequestId) {
      addEvent('LIVE', `ignoring stale photo ${payload.requestId}`);
      return;
    }
    if (payload.success === false) {
      setCameraStatus(
        `Camera: glasses reported ${payload.errorCode ?? 'error'}; waiting for upload`,
      );
      addEvent('LIVE', `photo response ${payload.errorCode ?? 'error'}`);
      return;
    }
    setCameraStatus('Camera: photo acknowledged; waiting for local upload');
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
    setStreamProtocol(protocol);
    setStreamUrl((current) => {
      const trimmed = current.trim();
      if (!trimmed || STREAM_DEFAULT_URL_VALUES.has(trimmed)) {
        return STREAM_DEFAULT_URLS[protocol];
      }
      return current;
    });
  }

  async function toggleStream() {
    if (streamStartedAt) {
      await runAction('Stop stream', async () => {
        stopKeepAlive();
        await BluetoothSdk.stopStream();
        setStreamStartedAt(null);
        setStreamStatus('Stopped');
      });
      return;
    }

    await runAction('Start stream', async () => {
      const url = streamUrl.trim();
      const validationMessage = streamUrlValidationMessage(url);
      if (validationMessage) {
        setStreamStatus(validationMessage);
        throw new Error(validationMessage);
      }
      if (streamProtocol === 'webrtc') {
        setStreamStatus('Checking local WebRTC server');
        const reachabilityMessage = await localWebrtcReachabilityMessage(url);
        if (reachabilityMessage) {
          setStreamStatus(reachabilityMessage);
          throw new Error(reachabilityMessage);
        }
      }
      const streamId = `rn-${Date.now()}`;
      const params = {
        keepAlive: true,
        keepAliveIntervalSeconds: 15,
        protocol: streamProtocol,
        streamId,
        streamUrl: url,
        type: 'start_stream',
      };
      await BluetoothSdk.startStream(params);
      setStreamStartedAt(Date.now());
      setStreamStatus(`LIVE · ${streamProtocol.toUpperCase()}`);
      startKeepAlive(streamId);
    });
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
    await runAction('Scan Wi-Fi', () => BluetoothSdk.requestWifiScan());
  }

  async function sendWifiCredentials(ssid: string) {
    await runAction(`Connect Wi-Fi ${ssid}`, () =>
      BluetoothSdk.sendWifiCredentials(ssid, ''),
    );
  }

  async function toggleHotspot() {
    await runAction(hotspotEnabled ? 'Disable hotspot' : 'Enable hotspot', async () => {
      const next = !hotspotEnabled;
      await BluetoothSdk.setHotspotState(next);
      setHotspotEnabled(next);
    });
  }

  async function toggleMic() {
    await runAction(micRecording ? 'Stop microphone' : 'Start microphone', async () => {
      const next = !micRecording;
      await BluetoothSdk.setMicState(next, false, true);
      setMicRecording(next);
      if (next) {
        setPcmBytes(0);
        setPcmFrames(0);
      }
    });
  }

  async function selectLedMode(mode: LedMode) {
    await runAction(`RGB LED ${mode}`, async () => {
      setLedMode(mode);
      const requestId = `rgb-${Date.now()}`;
      const action = mode === 'Off' ? 'off' : mode.toLowerCase();
      await BluetoothSdk.rgbLedControl(
        requestId,
        PHOTO_APP_ID,
        action,
        mode === 'Off' ? null : '#34C759',
        mode === 'Pulse' ? 600 : 1000,
        mode === 'Blink' ? 400 : 0,
        mode === 'Blink' ? 5 : 1,
      );
    });
  }

  return {
    activeAction,
    applySettings,
    bluetoothStatus,
    cameraStatus,
    captureAndUpload,
    clearDisplay,
    connect,
    connectDevice,
    disconnect,
    discoveredDevices,
    displayHello,
    events,
    galleryModeAuto,
    glassesStatus,
    hotspotEnabled,
    lastAction,
    ledMode,
    micRecording,
    pcmBytes,
    pcmFrames,
    permissionStatus,
    photoPreviewUrl,
    rawJsonExpanded,
    requestWifiScan,
    selectLedMode,
    selectProtocol,
    sendWifiCredentials,
    setRawJsonExpanded,
    setStreamUrl,
    setWebhookUrl,
    startScan,
    streamProtocol,
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

function disconnectedGlassesStatus(
  changed: Partial<GlassesStatus>,
): Partial<GlassesStatus> {
  return {
    ...changed,
    batteryLevel: -1,
    caseBatteryLevel: -1,
    caseCharging: false,
    caseOpen: false,
    caseRemoved: true,
    charging: false,
    connected: false,
    fullyBooted: false,
    wifiConnected: false,
    wifiLocalIp: '',
    wifiSsid: '',
  };
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

async function localWebrtcReachabilityMessage(whipUrlText: string) {
  let previewUrl = '';
  try {
    previewUrl = webrtcPreviewUrl(whipUrlText);
  } catch {
    return 'Enter a valid http:// or https:// WHIP URL.';
  }

  try {
    const response = await fetch(cacheBustedUrl(previewUrl), {
      cache: 'no-store',
      headers: {'Cache-Control': 'no-cache', Pragma: 'no-cache'},
    });
    // MediaMTX returns 404 before a stream exists; any HTTP response means it is reachable.
    void response.status;
    return null;
  } catch (error) {
    return localWebrtcSetupMessage(formatError(error));
  }
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
  return null;
}

function cacheBustedUrl(url: string) {
  return `${url}${url.includes('?') ? '&' : '?'}poll=${Date.now()}`;
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

function summarizeMap(values: Record<string, unknown>) {
  const keys = Object.keys(values);
  if (keys.length === 0) {
    return 'empty update';
  }
  return keys
    .slice(0, 3)
    .map((key) => `${key}: ${String(values[key])}`)
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
