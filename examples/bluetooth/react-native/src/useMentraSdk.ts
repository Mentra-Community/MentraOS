import {createAudioPlayer, setAudioModeAsync, type AudioPlayer} from 'expo-audio';
import {File, Paths} from 'expo-file-system';
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
import {isDisconnectedStatus, isGlassesConnected} from './sdkFormat';

export type StreamProtocol = 'rtmp' | 'srt' | 'webrtc';
export type LedMode = 'Off' | 'Solid' | 'Pulse' | 'Blink';

export const STREAM_DEFAULT_URLS: Record<StreamProtocol, string> = {
  rtmp: 'rtmp://<computer-ip>:1935/live/mentra-live',
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
  lastMicBytes: number;
  lastMicDurationSeconds: number | null;
  ledMode: LedMode;
  micElapsedSeconds: number;
  micPlaying: boolean;
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
  playMicRecording: () => Promise<void>;
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
const MIC_SAMPLE_RATE = 16000;
const MIC_CHANNEL_COUNT = 1;
const MIC_BITS_PER_SAMPLE = 16;

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
  const [micPlaying, setMicPlaying] = useState(false);
  const [micElapsedSeconds, setMicElapsedSeconds] = useState(0);
  const [pcmFrames, setPcmFrames] = useState(0);
  const [pcmBytes, setPcmBytes] = useState(0);
  const [lastMicBytes, setLastMicBytes] = useState(0);
  const [lastMicDurationSeconds, setLastMicDurationSeconds] = useState<number | null>(null);
  const [galleryModeAuto, setGalleryModeAuto] = useState(true);
  const [ledMode, setLedMode] = useState<LedMode>('Solid');
  const [rawJsonExpanded, setRawJsonExpanded] = useState(false);
  const activePhotoRequestIdRef = useRef<string | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const pollGenerationRef = useRef(0);
  const keepAliveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMicFileUriRef = useRef<string | null>(null);
  const micElapsedSecondsRef = useRef(0);
  const micElapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const micPcmChunksRef = useRef<Uint8Array[]>([]);
  const micPlayerRef = useRef<AudioPlayer | null>(null);
  const micPlayerSubscriptionRef = useRef<{remove: () => void} | null>(null);
  const micPlayingRef = useRef(false);
  const micRecordingRef = useRef(false);
  const micStartedAtRef = useRef<number | null>(null);

  const discoveredDevices = bluetoothStatus.searchResults ?? [];

  useEffect(() => {
    const removeGlasses = BluetoothSdk.onGlassesStatus((changed) => {
      if (isDisconnectedStatus(changed)) {
        applyDisconnectedState('Disconnected');
      } else {
        setGlassesStatus((current) => ({...current, ...changed}));
      }
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
        applyStreamStatus(payload);
        setStreamStatus(JSON.stringify(payload));
        addEvent('LIVE', `stream status ${summarizeMap(payload)}`);
      }),
      BluetoothSdk.addListener('mic_pcm', (payload: MicPcmEvent) => {
        if (!micRecordingRef.current) {
          return;
        }
        const pcm = new Uint8Array(payload.pcm);
        const frame = new Uint8Array(pcm.byteLength);
        frame.set(pcm);
        micPcmChunksRef.current.push(frame);
        const size = payload.pcm.byteLength;
        setPcmFrames((current) => current + 1);
        setPcmBytes((current) => current + size);
      }),
      BluetoothSdk.addListener('mic_lc3', (payload: MicLc3Event) => {
        if (micRecordingRef.current) {
          addEvent('LIVE', `received LC3 mic frame while PCM recording is enabled (${payload.lc3.byteLength} bytes)`);
        }
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
      activeStreamIdRef.current = null;
      activePhotoRequestIdRef.current = null;
      pollGenerationRef.current += 1;
      stopMicElapsedTimer();
      stopMicPlaybackSync();
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
      applyDisconnectedState('Disconnected');
    });
  }

  async function displayHello() {
    await runAction('Display Hello', async () => {
      requireConnected('display text');
      await BluetoothSdk.displayText({
        size: 24,
        text: 'Hello from Mentra Bluetooth SDK',
        x: 0,
        y: 0,
      });
    });
  }

  async function clearDisplay() {
    await runAction('Clear Display', async () => {
      requireConnected('clear the display');
      await BluetoothSdk.clearDisplay();
    });
  }

  async function applySettings() {
    await runAction('Apply Settings', async () => {
      requireConnected('apply settings');
      await BluetoothSdk.updateCore({
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
      });
    });
  }

  async function captureAndUpload() {
    await runAction('Capture & upload', async () => {
      requireConnected('capture photos');
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
        activeStreamIdRef.current = null;
        if (isGlassesConnected(glassesStatus)) {
          await BluetoothSdk.stopStream();
        }
        setStreamStartedAt(null);
        setStreamStatus('Stopped');
      });
      return;
    }

    await runAction('Start stream', async () => {
      requireConnected('start streaming');
      const url = streamUrl.trim();
      const validationMessage = streamUrlValidationMessage(url);
      if (validationMessage) {
        setStreamStatus(validationMessage);
        throw new Error(validationMessage);
      }
      if (streamProtocol === 'rtmp' || streamProtocol === 'webrtc') {
        setStreamStatus(`Checking local ${streamProtocol.toUpperCase()} server`);
        const reachabilityMessage =
          streamProtocol === 'rtmp'
            ? await localRtmpReachabilityMessage(url)
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
        protocol: streamProtocol,
        streamId,
        streamUrl: url,
        type: 'start_stream',
      };
      await BluetoothSdk.startStream(params);
      activeStreamIdRef.current = streamId;
      setStreamStatus(`Requested ${streamProtocol.toUpperCase()} stream; waiting for glasses`);
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
    await runAction('Scan Wi-Fi', async () => {
      requireConnected('scan Wi-Fi');
      await BluetoothSdk.requestWifiScan();
    });
  }

  async function sendWifiCredentials(ssid: string) {
    await runAction(`Connect Wi-Fi ${ssid}`, async () => {
      requireConnected('send Wi-Fi credentials');
      await BluetoothSdk.sendWifiCredentials(ssid, '');
    });
  }

  async function toggleHotspot() {
    await runAction(hotspotEnabled ? 'Disable hotspot' : 'Enable hotspot', async () => {
      requireConnected('toggle hotspot');
      const next = !hotspotEnabled;
      await BluetoothSdk.setHotspotState(next);
      setHotspotEnabled(next);
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

  async function startMicRecording() {
    requireConnected('stream microphone audio');
    await stopMicPlayback();
    micPcmChunksRef.current = [];
    lastMicFileUriRef.current = null;
    micElapsedSecondsRef.current = 0;
    micStartedAtRef.current = Date.now();
    setLastMicBytes(0);
    setLastMicDurationSeconds(null);
    setMicElapsedSeconds(0);
    setPcmBytes(0);
    setPcmFrames(0);
    await BluetoothSdk.setMicState(true, false, true);
    micRecordingRef.current = true;
    setMicRecording(true);
    startMicElapsedTimer();
  }

  async function stopMicRecording() {
    if (isGlassesConnected(glassesStatus)) {
      await BluetoothSdk.setMicState(false, false, true);
    }
    micRecordingRef.current = false;
    setMicRecording(false);
    stopMicElapsedTimer();

    const pcm = concatChunks(micPcmChunksRef.current);
    micPcmChunksRef.current = [];
    if (pcm.byteLength === 0) {
      lastMicFileUriRef.current = null;
      setLastMicBytes(0);
      setLastMicDurationSeconds(null);
      addEvent('LIVE', 'microphone stopped with no PCM frames');
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
    addEvent('LIVE', `saved microphone WAV ${pcm.byteLength} bytes`);
  }

  async function startMicPlayback(restart = false) {
    const uri = lastMicFileUriRef.current;
    if (!uri || lastMicBytes <= 0) {
      throw new Error('Record microphone audio before playback.');
    }

    await stopMicPlayback();
    await setAudioModeAsync({interruptionMode: 'duckOthers', playsInSilentMode: true});

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
      setMicPlaying(true);
      player.play();
    } catch (error) {
      await stopMicPlayback();
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
    }, 250);
  }

  function stopMicElapsedTimer() {
    if (micElapsedTimerRef.current) {
      clearInterval(micElapsedTimerRef.current);
      micElapsedTimerRef.current = null;
    }
    micStartedAtRef.current = null;
  }

  async function selectLedMode(mode: LedMode) {
    await runAction(`RGB LED ${mode}`, async () => {
      requireConnected('control the RGB LED');
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

  function requireConnected(feature: string) {
    if (isGlassesConnected(glassesStatus)) {
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

  function applyDisconnectedState(status: string) {
    stopKeepAlive();
    activeStreamIdRef.current = null;
    const hadPhotoRequest = activePhotoRequestIdRef.current !== null;
    activePhotoRequestIdRef.current = null;
    if (hadPhotoRequest) {
      pollGenerationRef.current += 1;
      setCameraStatus('Disconnected before photo upload completed');
    }
    setGlassesStatus(disconnectedGlassesStatus({connected: false}));
    setStreamStartedAt(null);
    setStreamStatus(status);
    setHotspotEnabled(false);
    setMicRecording(false);
    micRecordingRef.current = false;
    stopMicElapsedTimer();
    void stopMicPlayback();
  }

  function applyStreamStatus(payload: StreamStatusEvent) {
    const status = typeof payload.status === 'string' ? payload.status : '';
    if (status === 'streaming' || status === 'initializing' || status === 'starting') {
      if (typeof payload.streamId === 'string') {
        activeStreamIdRef.current = payload.streamId;
      }
      setStreamStartedAt((current) => current ?? Date.now());
      if (keepAliveTimerRef.current === null && activeStreamIdRef.current) {
        startKeepAlive(activeStreamIdRef.current);
      }
      return;
    }
    if (
      status === 'stopped' ||
      status === 'stopping' ||
      status === 'error' ||
      status === 'error_not_streaming'
    ) {
      stopKeepAlive();
      activeStreamIdRef.current = null;
      setStreamStartedAt(null);
    }
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
    lastMicBytes,
    lastMicDurationSeconds,
    ledMode,
    micElapsedSeconds,
    micPlaying,
    micRecording,
    pcmBytes,
    pcmFrames,
    permissionStatus,
    photoPreviewUrl,
    playMicRecording,
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

export function durationText(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  return [hours, minutes, remainder]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function concatChunks(chunks: Uint8Array[]) {
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
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
    connectionState: 'DISCONNECTED',
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

function rtmpHlsPreviewUrl(rtmpUrlText: string) {
  const rtmpUrl = new URL(rtmpUrlText);
  if (rtmpUrl.protocol !== 'rtmp:' && rtmpUrl.protocol !== 'rtmps:') {
    throw new Error('Only rtmp and rtmps URLs are supported.');
  }
  if (!isLocalPreviewHost(rtmpUrl.hostname)) {
    return null;
  }
  rtmpUrl.protocol = rtmpUrl.protocol === 'rtmps:' ? 'https:' : 'http:';
  rtmpUrl.port = '8888';
  rtmpUrl.search = '';
  return rtmpUrl.toString();
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
