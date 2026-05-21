import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type Permission,
} from 'react-native';
import {
  BluetoothSdk,
  DeviceModels,
  type BluetoothSdkSubscription,
  type Device,
  type MicPcmEvent,
} from '@mentra/bluetooth-sdk';

declare const process: {
  env?: {
    EXPO_PUBLIC_ELEVENLABS_AGENT_ID?: string;
    EXPO_PUBLIC_ELEVENLABS_SIGNED_URL_ENDPOINT?: string;
  };
};

const DEFAULT_AGENT_ID = 'agent_0301ks3wg64pf9evgxqa6dw34t1f';
const DEFAULT_SIGNED_URL_ENDPOINT = 'http://localhost:8788/signed-url';

type ElevenLabsEvent = {
  type?: string;
  [key: string]: any;
};

type StreamStats = {
  droppedChunks: number;
  frames: number;
  receivedBytes: number;
  sentBytes: number;
  sentChunks: number;
};

type LogEntry = {
  id: string;
  message: string;
};

type CloseSource = 'none' | 'remote' | 'user_stop' | 'cleanup' | 'mic_start_failed';

type Diagnostics = {
  elevenLabsEventCount: number;
  firstPcmDelayMs: number | null;
  firstPcmAtMs: number | null;
  lastElevenLabsEvent: string;
  lastPcmAtMs: number | null;
  lastPcmSize: number | null;
  lastPcmVadGated: boolean | null;
  lastSendError: string | null;
  micRequestedAtMs: number | null;
  micStage: string;
  signedUrlLatencyMs: number | null;
  signedUrlStatus: string;
  websocketCloseAfterMs: number | null;
  websocketCloseCode: number | null;
  websocketCloseReason: string;
  websocketCloseSource: CloseSource;
  websocketCloseWasClean: boolean | null;
  websocketOpenedAtMs: number | null;
  websocketState: string;
  websocketTarget: string;
};

const emptyStats: StreamStats = {
  droppedChunks: 0,
  frames: 0,
  receivedBytes: 0,
  sentBytes: 0,
  sentChunks: 0,
};

const emptyDiagnostics: Diagnostics = {
  elevenLabsEventCount: 0,
  firstPcmDelayMs: null,
  firstPcmAtMs: null,
  lastElevenLabsEvent: 'None',
  lastPcmAtMs: null,
  lastPcmSize: null,
  lastPcmVadGated: null,
  lastSendError: null,
  micRequestedAtMs: null,
  micStage: 'Idle',
  signedUrlLatencyMs: null,
  signedUrlStatus: 'Not requested',
  websocketCloseAfterMs: null,
  websocketCloseCode: null,
  websocketCloseReason: '',
  websocketCloseSource: 'none',
  websocketCloseWasClean: null,
  websocketOpenedAtMs: null,
  websocketState: 'Not connected',
  websocketTarget: 'Unknown',
};

export default function App() {
  const agentId = process.env?.EXPO_PUBLIC_ELEVENLABS_AGENT_ID ?? DEFAULT_AGENT_ID;
  const signedUrlEndpoint =
    process.env?.EXPO_PUBLIC_ELEVENLABS_SIGNED_URL_ENDPOINT ?? DEFAULT_SIGNED_URL_ENDPOINT;

  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [scanState, setScanState] = useState('Idle');
  const [connectionState, setConnectionState] = useState('Disconnected');
  const [conversationState, setConversationState] = useState('Idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastTranscript, setLastTranscript] = useState('');
  const [lastAgentResponse, setLastAgentResponse] = useState('');
  const [metadata, setMetadata] = useState('');
  const [vadScore, setVadScore] = useState<number | null>(null);
  const [stats, setStats] = useState<StreamStats>(emptyStats);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(emptyDiagnostics);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [nowMs, setNowMs] = useState(Date.now());

  const wsRef = useRef<WebSocket | null>(null);
  const pcmSubscriptionRef = useRef<BluetoothSdkSubscription | null>(null);
  const statsRef = useRef<StreamStats>(emptyStats);
  const logIndexRef = useRef(0);
  const audioMetadataCapturedRef = useRef(false);
  const closeSourceRef = useRef<CloseSource>('none');
  const firstPcmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const websocketOpenedAtMsRef = useRef<number | null>(null);

  const canStartConversation =
    connectedDevice && conversationState !== 'Signing' && conversationState !== 'Streaming';

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      clearInterval(interval);
      void stopConversation('cleanup');
    };
  }, []);

  function appendLog(message: string) {
    console.log(`[ElevenLabsAudioRepro] ${message}`);
    logIndexRef.current += 1;
    setLogs((current) => [
      {
        id: `${Date.now()}-${logIndexRef.current}-${Math.random()}`,
        message,
      },
      ...current,
    ].slice(0, 40));
  }

  function fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setLastError(message);
    appendLog(`error: ${message}`);
  }

  function updateStats(next: StreamStats) {
    statsRef.current = next;
    setStats(next);
  }

  function updateDiagnostics(next: Partial<Diagnostics>) {
    setDiagnostics((current) => ({...current, ...next}));
  }

  async function scan() {
    setLastError(null);
    setScanState('Scanning');
    setDevices([]);
    setSelectedDevice(null);
    appendLog('scan started');

    try {
      await ensureAndroidPermissions(false);
      const finalResults = await BluetoothSdk.scan(DeviceModels.MentraLive, {
        timeoutMs: 12000,
        onResults: (results) => {
          setDevices(results);
          setSelectedDevice((current) => current ?? results[0] ?? null);
        },
      });
      setDevices(finalResults);
      setSelectedDevice((current) => current ?? finalResults[0] ?? null);
      setScanState(`Found ${finalResults.length}`);
      appendLog(`scan finished: ${finalResults.length} result(s)`);
    } catch (error) {
      setScanState('Scan failed');
      fail(error);
    }
  }

  async function connect() {
    if (!selectedDevice) {
      return;
    }

    setLastError(null);
    setConnectionState('Connecting');
    appendLog(`connecting to ${selectedDevice.name}`);

    try {
      await ensureAndroidPermissions(false);
      await BluetoothSdk.connect(selectedDevice, {
        cancelExistingConnectionAttempt: true,
        saveAsDefault: true,
      });
      setConnectedDevice(selectedDevice);
      setConnectionState('Connected');
      appendLog(`connected to ${selectedDevice.name}`);
    } catch (error) {
      setConnectionState('Connect failed');
      fail(error);
    }
  }

  async function disconnect() {
    setLastError(null);
    await stopConversation();
    try {
      await BluetoothSdk.disconnect();
      setConnectedDevice(null);
      setConnectionState('Disconnected');
      appendLog('disconnected');
    } catch (error) {
      fail(error);
    }
  }

  async function startConversation() {
    if (!connectedDevice || conversationState === 'Streaming') {
      return;
    }

    setLastError(null);
    setConversationState('Signing');
    setLastTranscript('');
    setLastAgentResponse('');
    setMetadata('');
    audioMetadataCapturedRef.current = false;
    setVadScore(null);
    updateStats(emptyStats);
    closeSourceRef.current = 'remote';
    websocketOpenedAtMsRef.current = null;
    clearFirstPcmTimeout();
    updateDiagnostics({
      ...emptyDiagnostics,
      micStage: 'Waiting for WebSocket',
      signedUrlStatus: 'Requesting',
      websocketTarget: describeUrl(signedUrlEndpoint),
    });
    appendLog('fetching ElevenLabs signed URL');

    try {
      await ensureAndroidPermissions(true);
      const signedUrlStartedAtMs = Date.now();
      const signedUrl = await fetchSignedUrlFromLocalServer(signedUrlEndpoint, agentId);
      updateDiagnostics({
        signedUrlLatencyMs: Date.now() - signedUrlStartedAtMs,
        signedUrlStatus: 'OK',
        websocketState: 'Connecting',
        websocketTarget: describeUrl(signedUrl),
      });
      const websocket = new WebSocket(signedUrl);
      wsRef.current = websocket;

      websocket.onopen = () => {
        const openedAtMs = Date.now();
        websocketOpenedAtMsRef.current = openedAtMs;
        setConversationState('Streaming');
        updateDiagnostics({
          micStage: 'Starting mic',
          websocketOpenedAtMs: openedAtMs,
          websocketState: 'Open',
        });
        appendLog('ElevenLabs WebSocket open');
        sendJson(websocket, {type: 'conversation_initiation_client_data'});
        void startGlassesPcm().catch((error) => {
          closeSourceRef.current = 'mic_start_failed';
          updateDiagnostics({micStage: 'Mic start failed'});
          fail(error);
          websocket.close();
        });
      };

      websocket.onmessage = (event) => {
        handleElevenLabsMessage(websocket, event.data);
      };

      websocket.onerror = (event) => {
        setLastError('ElevenLabs WebSocket error');
        updateDiagnostics({websocketState: 'Error'});
        appendLog(`ElevenLabs WebSocket error: ${JSON.stringify(event)}`);
      };

      websocket.onclose = async (event) => {
        const openedAtMs = websocketOpenedAtMsRef.current;
        const closedAtMs = Date.now();
        const closeAfterMs = openedAtMs === null ? null : closedAtMs - openedAtMs;
        const source = closeSourceRef.current;
        appendLog(
          `ElevenLabs WebSocket closed: source=${source} code=${event.code} reason=${
            event.reason || '(empty)'
          } clean=${String(event.wasClean)} after=${closeAfterMs === null ? '?' : `${closeAfterMs}ms`}`,
        );
        if (source === 'remote' && closeAfterMs !== null && closeAfterMs < 5000) {
          setLastError(
            `ElevenLabs closed the WebSocket after ${closeAfterMs}ms (code ${event.code}, reason ${
              event.reason || 'empty'
            }).`,
          );
        }
        clearFirstPcmTimeout();
        updateDiagnostics({
          micStage: 'Stopped',
          websocketCloseAfterMs: closeAfterMs,
          websocketCloseCode: event.code,
          websocketCloseReason: event.reason || '',
          websocketCloseSource: source,
          websocketCloseWasClean: event.wasClean,
          websocketState: 'Closed',
        });
        wsRef.current = null;
        stopPcmSubscription();
        await BluetoothSdk.setMicState(false).catch(() => undefined);
        setConversationState('Idle');
      };
    } catch (error) {
      setConversationState('Idle');
      clearFirstPcmTimeout();
      updateDiagnostics({
        micStage: 'Not started',
        signedUrlStatus: 'Failed',
        websocketState: 'Not connected',
      });
      fail(error);
    }
  }

  async function stopConversation(reason: CloseSource = 'user_stop') {
    closeSourceRef.current = reason;
    clearFirstPcmTimeout();
    updateDiagnostics({micStage: 'Stopping'});
    stopPcmSubscription();
    await BluetoothSdk.setMicState(false).catch(() => undefined);
    wsRef.current?.close();
    wsRef.current = null;
    setConversationState('Idle');
  }

  async function startGlassesPcm() {
    stopPcmSubscription();
    pcmSubscriptionRef.current = BluetoothSdk.addListener('mic_pcm', handlePcmFrame);
    appendLog('requesting continuous glasses PCM with SDK VAD bypassed');
    updateDiagnostics({micStage: 'Setting preferred mic'});
    await BluetoothSdk.setPreferredMic('glasses');
    updateDiagnostics({micStage: 'Enabling mic stream'});
    const micRequestedAtMs = Date.now();
    updateDiagnostics({micRequestedAtMs});
    await BluetoothSdk.setMicState(
      true,
      true,
      true, // Bypass SDK VAD so ElevenLabs receives continuous PCM.
    );
    updateDiagnostics({micStage: 'Mic requested; waiting for PCM'});
    startFirstPcmWatchdog();
  }

  function stopPcmSubscription() {
    pcmSubscriptionRef.current?.remove();
    pcmSubscriptionRef.current = null;
  }

  function clearFirstPcmTimeout() {
    if (firstPcmTimeoutRef.current) {
      clearTimeout(firstPcmTimeoutRef.current);
      firstPcmTimeoutRef.current = null;
    }
  }

  function startFirstPcmWatchdog() {
    clearFirstPcmTimeout();
    firstPcmTimeoutRef.current = setTimeout(() => {
      setDiagnostics((current) =>
        current.firstPcmAtMs
          ? current
          : {
              ...current,
              micStage: 'Mic requested; no PCM yet',
            },
      );
      appendLog('mic requested, still waiting for first PCM frame');
    }, 3000);
  }

  function handlePcmFrame(event: MicPcmEvent) {
    const websocket = wsRef.current;
    const pcm = new Uint8Array(event.pcm);
    const current = statsRef.current;
    const receivedAtMs = Date.now();
    const nextBase = {
      ...current,
      frames: current.frames + 1,
      receivedBytes: current.receivedBytes + pcm.byteLength,
    };

    if (nextBase.frames === 1) {
      clearFirstPcmTimeout();
      appendLog(
        `first PCM frame: ${pcm.byteLength} bytes, vadGated=${String(event.vadGated)}`,
      );
    }

    if (!audioMetadataCapturedRef.current) {
      audioMetadataCapturedRef.current = true;
      setMetadata(
        `${event.sampleRate} Hz, ${event.bitsPerSample}-bit, ${event.channels} ch, ${event.encoding}, vadGated=${event.vadGated}`,
      );
    }

    if (nextBase.frames === 1 || nextBase.frames % 10 === 0) {
      setDiagnostics((currentDiagnostics) => ({
        ...currentDiagnostics,
        firstPcmDelayMs:
          currentDiagnostics.firstPcmDelayMs ??
          (currentDiagnostics.micRequestedAtMs === null
            ? null
            : receivedAtMs - currentDiagnostics.micRequestedAtMs),
        firstPcmAtMs: currentDiagnostics.firstPcmAtMs ?? receivedAtMs,
        lastPcmAtMs: receivedAtMs,
        lastPcmSize: pcm.byteLength,
        lastPcmVadGated: event.vadGated,
        micStage: 'Receiving PCM',
      }));
    }

    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      updateStats({
        ...nextBase,
        droppedChunks: nextBase.droppedChunks + 1,
      });
      return;
    }

    try {
      websocket.send(JSON.stringify({user_audio_chunk: bytesToBase64(pcm)}));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateDiagnostics({lastSendError: message});
      appendLog(`failed to send PCM chunk: ${message}`);
      updateStats({
        ...nextBase,
        droppedChunks: nextBase.droppedChunks + 1,
      });
      return;
    }

    const next = {
      ...nextBase,
      sentBytes: nextBase.sentBytes + pcm.byteLength,
      sentChunks: nextBase.sentChunks + 1,
    };
    statsRef.current = next;

    if (next.sentChunks % 10 === 0) {
      setStats(next);
    }
  }

  function handleElevenLabsMessage(websocket: WebSocket, rawData: WebSocketMessageEvent['data']) {
    if (typeof rawData !== 'string') {
      appendLog('received non-string WebSocket message');
      return;
    }

    let event: ElevenLabsEvent;
    try {
      event = JSON.parse(rawData) as ElevenLabsEvent;
    } catch {
      appendLog(`received non-JSON WebSocket message: ${rawData.slice(0, 80)}`);
      return;
    }

    setDiagnostics((currentDiagnostics) => ({
      ...currentDiagnostics,
      elevenLabsEventCount: currentDiagnostics.elevenLabsEventCount + 1,
      lastElevenLabsEvent: event.type ?? 'unknown',
    }));

    switch (event.type) {
      case 'conversation_initiation_metadata': {
        const data = event.conversation_initiation_metadata_event;
        appendLog(`conversation ${data.conversation_id}`);
        if (data.user_input_audio_format || data.agent_output_audio_format) {
          setMetadata((current) =>
            [
              current,
              `11labs input=${data.user_input_audio_format ?? '?'}`,
              `11labs output=${data.agent_output_audio_format ?? '?'}`,
            ]
              .filter(Boolean)
              .join(' | '),
          );
        }
        break;
      }
      case 'ping': {
        const delayMs = event.ping_event.ping_ms ?? 0;
        setTimeout(() => {
          sendJson(websocket, {
            type: 'pong',
            event_id: event.ping_event.event_id,
          });
        }, delayMs);
        break;
      }
      case 'user_transcript':
        setLastTranscript(event.user_transcription_event.user_transcript);
        appendLog(`transcript: ${event.user_transcription_event.user_transcript}`);
        break;
      case 'agent_response':
        setLastAgentResponse(event.agent_response_event.agent_response);
        appendLog(`agent: ${event.agent_response_event.agent_response}`);
        break;
      case 'audio':
        appendLog(`agent audio chunk ${event.audio_event.event_id}`);
        break;
      case 'vad_score':
        setVadScore(event.vad_score_event.vad_score);
        break;
      case 'interruption':
        appendLog(`interruption: ${event.interruption_event?.reason ?? 'unknown'}`);
        break;
      default:
        appendLog(`event: ${event.type}`);
        break;
    }
  }

  const selectedDeviceId = selectedDevice?.id;
  const deviceRows = useMemo(
    () =>
      devices.map((device) => (
        <Pressable
          key={device.id}
          onPress={() => setSelectedDevice(device)}
          style={[styles.deviceRow, selectedDeviceId === device.id && styles.deviceRowSelected]}
        >
          <View>
            <Text style={styles.deviceName}>{device.name}</Text>
            <Text style={styles.deviceMeta}>
              {device.model}
              {typeof device.rssi === 'number' ? ` · ${device.rssi} dBm` : ''}
            </Text>
          </View>
          {selectedDeviceId === device.id ? <Text style={styles.selectedMark}>Selected</Text> : null}
        </Pressable>
      )),
    [devices, selectedDeviceId],
  );

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>ElevenLabs Audio Repro</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Glasses</Text>
          <StatusRow label="Scan" value={scanState} />
          <StatusRow label="Connection" value={connectionState} />
          <StatusRow label="Target" value={connectedDevice?.name ?? selectedDevice?.name ?? 'None'} />
          <View style={styles.actions}>
            <ActionButton label="Scan" onPress={scan} />
            <ActionButton label="Connect" onPress={connect} disabled={!selectedDevice} />
            <ActionButton label="Disconnect" onPress={disconnect} disabled={!connectedDevice} variant="secondary" />
          </View>
          <View style={styles.deviceList}>
            {deviceRows.length > 0 ? deviceRows : <Text style={styles.empty}>No scan results</Text>}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ElevenLabs</Text>
          <StatusRow label="Agent" value={agentId} />
          <StatusRow label="WebSocket" value={conversationState} />
          <StatusRow label="WS close" value={formatWebSocketClose(diagnostics)} />
          <StatusRow label="Audio" value={metadata || 'Waiting for PCM'} />
          <StatusRow label="Mic" value={diagnostics.micStage} />
          <StatusRow label="PCM wait" value={formatPcmWait(diagnostics, nowMs)} />
          <StatusRow label="VAD" value={vadScore === null ? 'None' : vadScore.toFixed(3)} />
          <View style={styles.actions}>
            <ActionButton
              label="Start"
              onPress={startConversation}
              disabled={!canStartConversation}
            />
            <ActionButton
              label="Stop"
              onPress={() => {
                void stopConversation('user_stop');
              }}
              disabled={conversationState !== 'Streaming'}
              variant="secondary"
            />
          </View>
          {conversationState === 'Signing' ? <ActivityIndicator style={styles.spinner} /> : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Diagnostics</Text>
          <StatusRow label="Signed URL" value={formatSignedUrlStatus(diagnostics)} />
          <StatusRow label="WS target" value={diagnostics.websocketTarget} />
          <StatusRow label="WS state" value={diagnostics.websocketState} />
          <StatusRow label="WS close" value={formatWebSocketClose(diagnostics)} />
          <StatusRow label="Mic stage" value={diagnostics.micStage} />
          <StatusRow label="PCM wait" value={formatPcmWait(diagnostics, nowMs)} />
          <StatusRow label="First PCM" value={formatTimestamp(diagnostics.firstPcmAtMs, nowMs)} />
          <StatusRow label="Last PCM" value={formatLastPcm(diagnostics, nowMs)} />
          <StatusRow
            label="11Labs event"
            value={`${diagnostics.lastElevenLabsEvent} (${diagnostics.elevenLabsEventCount})`}
          />
          <StatusRow label="Send error" value={diagnostics.lastSendError ?? 'None'} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Counters</Text>
          <StatusRow label="PCM frames" value={String(stats.frames)} />
          <StatusRow label="Received" value={`${stats.receivedBytes} bytes`} />
          <StatusRow label="Sent chunks" value={String(stats.sentChunks)} />
          <StatusRow label="Sent" value={`${stats.sentBytes} bytes`} />
          <StatusRow label="Dropped" value={String(stats.droppedChunks)} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Transcript</Text>
          <Text style={styles.bodyText}>{lastTranscript || 'No transcript yet'}</Text>
          <Text style={styles.sectionTitle}>Agent</Text>
          <Text style={styles.bodyText}>{lastAgentResponse || 'No response yet'}</Text>
        </View>

        {lastError ? (
          <View style={[styles.section, styles.errorSection]}>
            <Text style={styles.errorText}>{lastError}</Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Log</Text>
          {logs.map((entry) => (
            <Text key={entry.id} style={styles.logLine}>
              {entry.message}
            </Text>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

async function fetchSignedUrlFromLocalServer(endpoint: string, agentId: string) {
  const url = new URL(endpoint);
  url.searchParams.set('agent_id', agentId);

  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch (error) {
    throw new Error(`signed-url fetch failed at ${describeUrl(url.toString())}: ${getErrorMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(`signed-url server failed (${response.status}): ${await response.text().catch(() => '')}`);
  }
  const data = (await response.json()) as {signed_url?: string};
  if (!data.signed_url) {
    throw new Error('signed-url server response missing signed_url');
  }
  return data.signed_url;
}

function describeUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

function formatDuration(ms: number | null) {
  if (ms === null) {
    return '?';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatSignedUrlStatus(diagnostics: Diagnostics) {
  if (diagnostics.signedUrlLatencyMs === null) {
    return diagnostics.signedUrlStatus;
  }
  return `${diagnostics.signedUrlStatus} in ${formatDuration(diagnostics.signedUrlLatencyMs)}`;
}

function formatTimestamp(timestampMs: number | null, nowMs: number) {
  if (timestampMs === null) {
    return 'None';
  }
  return `${formatDuration(Math.max(0, nowMs - timestampMs))} ago`;
}

function formatLastPcm(diagnostics: Diagnostics, nowMs: number) {
  if (diagnostics.lastPcmAtMs === null) {
    return 'None';
  }
  return `${formatTimestamp(diagnostics.lastPcmAtMs, nowMs)}, ${diagnostics.lastPcmSize ?? '?'} bytes, vadGated=${String(
    diagnostics.lastPcmVadGated,
  )}`;
}

function formatPcmWait(diagnostics: Diagnostics, nowMs: number) {
  if (diagnostics.firstPcmDelayMs !== null) {
    return `first frame after ${formatDuration(diagnostics.firstPcmDelayMs)}`;
  }
  if (diagnostics.micRequestedAtMs !== null) {
    return `waiting ${formatDuration(Math.max(0, nowMs - diagnostics.micRequestedAtMs))}`;
  }
  return 'Not requested';
}

function formatWebSocketClose(diagnostics: Diagnostics) {
  if (diagnostics.websocketCloseCode === null) {
    return 'None';
  }
  return `${diagnostics.websocketCloseSource}, code ${diagnostics.websocketCloseCode}, clean=${String(
    diagnostics.websocketCloseWasClean,
  )}, after ${formatDuration(diagnostics.websocketCloseAfterMs)}, reason ${
    diagnostics.websocketCloseReason || 'empty'
  }`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(websocket: WebSocket, message: object) {
  if (websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(message));
  }
}

function bytesToBase64(bytes: Uint8Array) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  let index = 0;

  for (; index + 2 < bytes.length; index += 3) {
    const value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    output +=
      chars[(value >> 18) & 63] +
      chars[(value >> 12) & 63] +
      chars[(value >> 6) & 63] +
      chars[value & 63];
  }

  if (index < bytes.length) {
    const remaining = bytes.length - index;
    const value = (bytes[index] << 16) | (remaining === 2 ? bytes[index + 1] << 8 : 0);
    output += chars[(value >> 18) & 63] + chars[(value >> 12) & 63];
    output += remaining === 2 ? chars[(value >> 6) & 63] : '=';
    output += '=';
  }

  return output;
}

async function ensureAndroidPermissions(includeAudio: boolean) {
  if (Platform.OS !== 'android') {
    return;
  }

  const permissions: Permission[] = [
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
  ];

  if (Number(Platform.Version) >= 31) {
    permissions.push(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    );
  }

  if (includeAudio) {
    permissions.push(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  }

  const results = await PermissionsAndroid.requestMultiple(Array.from(new Set(permissions)));
  const denied = Object.entries(results)
    .filter(([, result]) => result !== PermissionsAndroid.RESULTS.GRANTED)
    .map(([permission]) => permission);

  if (denied.length > 0) {
    throw new Error(`Android permissions denied: ${denied.join(', ')}`);
  }
}

function StatusRow({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={styles.statusValue}>{value}</Text>
    </View>
  );
}

function ActionButton({
  disabled,
  label,
  onPress,
  variant = 'primary',
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        variant === 'secondary' && styles.buttonSecondary,
        disabled && styles.buttonDisabled,
      ]}
    >
      <Text style={[styles.buttonText, variant === 'secondary' && styles.buttonSecondaryText]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
  },
  bodyText: {
    color: '#122018',
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 12,
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#0f5f39',
    borderRadius: 8,
    minHeight: 48,
    minWidth: 104,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  buttonDisabled: {
    opacity: 0.35,
  },
  buttonSecondary: {
    backgroundColor: '#f2f5f1',
    borderColor: '#cbd8cf',
    borderWidth: 1,
  },
  buttonSecondaryText: {
    color: '#183326',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  content: {
    padding: 20,
    paddingBottom: 48,
  },
  deviceList: {
    gap: 8,
    marginTop: 14,
  },
  deviceMeta: {
    color: '#5d6c62',
    fontSize: 14,
    marginTop: 3,
  },
  deviceName: {
    color: '#122018',
    fontSize: 17,
    fontWeight: '700',
  },
  deviceRow: {
    alignItems: 'center',
    borderColor: '#dde6df',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 68,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  deviceRowSelected: {
    backgroundColor: '#eaf6ef',
    borderColor: '#95d1ad',
  },
  empty: {
    color: '#6c7870',
    fontSize: 15,
  },
  errorSection: {
    borderColor: '#e5a3a3',
  },
  errorText: {
    color: '#9f1d1d',
    fontSize: 15,
    lineHeight: 20,
  },
  logLine: {
    color: '#38463f',
    fontFamily: 'Courier',
    fontSize: 12,
    lineHeight: 18,
  },
  safe: {
    backgroundColor: '#f6f8f5',
    flex: 1,
  },
  section: {
    backgroundColor: '#ffffff',
    borderColor: '#e1e7e2',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 16,
    padding: 16,
  },
  sectionTitle: {
    color: '#0f1b14',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 10,
  },
  selectedMark: {
    color: '#0f7a44',
    fontSize: 13,
    fontWeight: '800',
  },
  spinner: {
    marginTop: 12,
  },
  statusLabel: {
    color: '#728077',
    flex: 0.42,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  statusRow: {
    borderBottomColor: '#edf1ee',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 9,
  },
  statusValue: {
    color: '#142019',
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  title: {
    color: '#0f1b14',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 0,
  },
});
