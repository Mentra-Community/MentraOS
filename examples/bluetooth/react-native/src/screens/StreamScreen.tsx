import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, TextInput, Clipboard, Switch, PanResponder } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Polyline, Rect } from 'react-native-svg';
import WebView from 'react-native-webview';
import { MentraVideoStreamReceiverView } from '@mentra/react-native-video-stream-receiver';
import { Header } from '../components/Header';
import { useScrollBottomPadding } from '../components/keyboardLayout';
import { OfflineNotice } from '../components/OfflineNotice';
import { colors } from '../components/theme';
import { isGlassesConnected, isGlassesWifiConnected, streamUptime } from '../sdkFormat';
import {
  STREAM_DEFAULT_URLS,
  STREAM_MAX_FPS,
  STREAM_MIN_FPS,
  streamPreviewTarget,
  type BluetoothSdkExampleModel,
  type StreamPreviewTarget,
  type StreamProtocol,
} from '../useBluetoothSdkExample';

const bars = [18, 32, 48, 24, 40, 56, 30, 44, 22, 36, 50, 28, 40];
function streamSdkCall(useCloudServer: boolean, fps: number) {
  if (!useCloudServer) {
    return `const receiver = await MentraVideoStreamReceiver.startWebRtcReceiver();
const streamId = \`rn-\${Date.now()}\`;
await BluetoothSdk.startStream({
  type: 'start_stream',
  streamId,
  streamUrl: receiver.streamUrl,
  keepAlive: true,
  keepAliveIntervalSeconds: 15,
  video: { fps: ${fps} },
})`;
  }
  return `const streamId = \`rn-\${Date.now()}\`;
await BluetoothSdk.startStream({
  type: 'start_stream',
  streamId,
  streamUrl,
  keepAlive: true,
  keepAliveIntervalSeconds: 15,
  video: { fps: ${fps} },
})`;
}

export function StreamScreen({ sdk }: { sdk: BluetoothSdkExampleModel }) {
  const scrollRef = React.useRef<React.ElementRef<typeof ScrollView>>(null);
  const streamUrlInputRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
  const scrollBottomPadding = useScrollBottomPadding();
  const connected = isGlassesConnected(sdk.glasses);
  const glassesWifiConnected = isGlassesWifiConnected(sdk.glasses);
  const streamActive = sdk.streamRequested || sdk.streamStartedAt !== null;
  const wifiRequired = connected && !glassesWifiConnected && !streamActive;
  const previewReady = streamActive && sdk.streamPreviewReady;
  const uptime = streamUptime(sdk.streamStartedAt);
  const setupHint = sdk.streamCloudServerEnabled
    ? localStreamSetupHint(sdk.streamProtocol, sdk.streamUrl, sdk.streamStatus)
    : null;
  const previewTarget = sdk.streamCloudServerEnabled && previewReady
    ? streamPreviewTarget(sdk.streamProtocol, sdk.streamUrl)
    : null;
  const sdkCall = streamSdkCall(sdk.streamCloudServerEnabled, sdk.streamFps);
  const statusFailed = isStreamStatusFailure(sdk.streamStatus);
  const focusStreamUrlInput = React.useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
    requestAnimationFrame(() => {
      streamUrlInputRef.current?.focus();
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 250);
    });
  }, []);
  const handleStreamPress = React.useCallback(() => {
    if (sdk.streamCloudServerEnabled && !streamActive && sdk.streamUrl.includes('<computer-ip>')) {
      focusStreamUrlInput();
    }
    void sdk.toggleStream();
  }, [focusStreamUrlInput, sdk, streamActive]);

  return (
    <ScrollView
      ref={scrollRef}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: scrollBottomPadding }}>
      <Header title="Stream" />
      {!connected ? (
        <OfflineNotice />
      ) : wifiRequired ? (
        <OfflineNotice message="Connect the glasses to Wi-Fi from the System tab before streaming. Streams are published over the glasses network connection." />
      ) : null}

      {/* Live preview */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.card}>
        <View style={styles.previewWrap}>
          <View style={styles.preview}>
            {previewTarget ? (
              <LiveStreamPreview target={previewTarget} />
            ) : !sdk.streamCloudServerEnabled && previewReady ? (
              <MentraVideoStreamReceiverView style={styles.previewFill} />
            ) : (
              <PlaceholderStreamPreview message={streamActive ? 'Starting stream...\nWaiting for preview' : undefined} />
            )}
            <View style={styles.livePill}>
              <View style={[styles.liveDot, !streamActive && styles.readyDot]} />
              <Text style={styles.liveText}>{previewReady ? 'LIVE' : streamActive ? 'STARTING' : 'READY'}</Text>
            </View>
            <Text style={styles.timer}>{uptime}</Text>
            <Text style={styles.previewMeta}>
              {previewReady
                ? sdk.streamCloudServerEnabled
                  ? `${sdk.streamProtocol.toUpperCase()} · keep-alive 15s`
                  : 'WEBRTC · phone receiver'
                : streamActive
                  ? 'Waiting for preview'
                  : sdk.streamCloudServerEnabled
                    ? 'Ready · enter stream URL'
                    : 'Ready · WebRTC to phone'}
            </Text>
          </View>
        </View>

        <Pressable disabled={(!connected || !glassesWifiConnected) && !streamActive} onPress={handleStreamPress}>
          <LinearGradient colors={streamActive ? ['#DE3A30', '#C43B30'] : ['#26473A', '#1F3A2A']} style={[styles.endBtn, (!connected || !glassesWifiConnected) && !streamActive && styles.disabled]}>
            {streamActive ? <View style={styles.stopSquare} /> : <StreamPlayIcon />}
            <Text style={styles.endText}>
              {!connected && !streamActive
                ? 'Connect glasses first'
                : !glassesWifiConnected && !streamActive
                  ? 'Connect glasses to Wi-Fi'
                  : streamActive
                    ? 'End stream'
                    : 'Start stream'}
            </Text>
          </LinearGradient>
        </Pressable>
      </LinearGradient>

      {/* SDK call */}
      <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.sdkCard}>
        <View style={styles.sdkBlock}>
          <View style={styles.cardHead}>
            <Text style={styles.sdkEyebrow}>SDK CALL</Text>
            <Pressable style={({pressed}) => [styles.copyChip, pressed && styles.copyChipPressed]} onPress={() => Clipboard.setString(sdkCall)}>
              <Svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke={colors.consoleText} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Rect x={9} y={9} width={13} height={13} rx={2} />
                <Path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </Svg>
              <Text style={styles.copyText}>Copy</Text>
            </Pressable>
          </View>
          <Text style={styles.sdkCode}>{sdkCall}</Text>
        </View>
        <View style={styles.statusBar}>
          <View style={[styles.statusCircle, statusFailed ? styles.statusCircleError : styles.statusCircleOk]}>
            <View style={[styles.statusDot, statusFailed ? styles.statusDotError : styles.statusDotOk]} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.statusTitle}>{sdk.streamStatus}</Text>
            <Text style={styles.statusSub}>uptime {uptime} · keep-alive 15s</Text>
          </View>
        </View>
      </LinearGradient>

      {/* Protocol */}
      <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.protocolCard}>
        <View style={styles.cardHead}>
          <Text style={styles.eyebrow}>DESTINATION</Text>
        </View>
        <View style={styles.cloudToggleRow}>
          <Text style={styles.cloudToggleLabel}>Use cloud server</Text>
          <Switch
            ios_backgroundColor="rgba(15,42,29,0.18)"
            onValueChange={sdk.setStreamCloudServerEnabled}
            thumbColor="#fff"
            trackColor={{ false: 'rgba(15,42,29,0.18)', true: colors.greenAccent }}
            value={sdk.streamCloudServerEnabled}
          />
        </View>
        {sdk.streamCloudServerEnabled ? (
          <>
            <View style={styles.tabs}>
              {(['rtmp', 'srt', 'webrtc'] satisfies StreamProtocol[]).map((protocol) => (
                <Pressable key={protocol} style={[styles.protoTab, sdk.streamProtocol === protocol && styles.protoTabActive]} onPress={() => sdk.selectProtocol(protocol)}>
                  <Text style={[styles.protoText, sdk.streamProtocol === protocol && styles.protoTextActive]}>{protocol.toUpperCase()}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.urlBar}>
              <Text style={styles.method}>{streamProtocolLabel(sdk.streamProtocol)}</Text>
              <View style={styles.divider} />
              <TextInput
                ref={streamUrlInputRef}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={sdk.setStreamUrl}
                onFocus={focusStreamUrlInput}
                placeholder={STREAM_DEFAULT_URLS[sdk.streamProtocol]}
                placeholderTextColor={colors.muted}
                returnKeyType="done"
                selectTextOnFocus
                style={styles.url}
                value={sdk.streamUrl}
              />
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <Path d="m18.5 2.5 3 3L12 15l-4 1 1-4z" />
              </Svg>
            </View>
            {setupHint ? <Text style={styles.setupHint}>{setupHint}</Text> : null}
          </>
        ) : (
          <Text style={styles.setupHint}>
            The phone starts a local WebRTC receiver, sends its WHIP URL to the glasses, and previews incoming frames here.
          </Text>
        )}
        <FpsSlider
          disabled={streamActive}
          max={STREAM_MAX_FPS}
          min={STREAM_MIN_FPS}
          onChange={sdk.setStreamFps}
          value={sdk.streamFps}
        />
      </LinearGradient>
    </ScrollView>
  );
}

function FpsSlider({
  disabled,
  max,
  min,
  onChange,
  value,
}: {
  disabled: boolean;
  max: number;
  min: number;
  onChange: (value: number) => void;
  value: number;
}) {
  const [trackWidth, setTrackWidth] = React.useState(0);
  const progress = (value - min) / (max - min);
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const updateFromX = React.useCallback(
    (x: number) => {
      if (disabled || trackWidth <= 0) {
        return;
      }
      const ratio = Math.max(0, Math.min(1, x / trackWidth));
      onChange(min + ratio * (max - min));
    },
    [disabled, max, min, onChange, trackWidth],
  );
  const panResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (event) => updateFromX(event.nativeEvent.locationX),
        onPanResponderMove: (event) => updateFromX(event.nativeEvent.locationX),
      }),
    [disabled, updateFromX],
  );

  return (
    <View style={[styles.fpsCard, disabled && styles.fpsCardDisabled]}>
      <View style={styles.fpsHeader}>
        <Text style={styles.fpsLabel}>STREAM FPS</Text>
        <Text style={styles.fpsValue}>{value} fps</Text>
      </View>
      <View
        {...panResponder.panHandlers}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        style={styles.fpsTrack}>
        <View style={styles.fpsTrackBase} />
        <View style={[styles.fpsTrackFill, {width: `${clampedProgress * 100}%`}]} />
        <View style={[styles.fpsThumb, {left: `${clampedProgress * 100}%`}]} />
      </View>
      <View style={styles.fpsRangeRow}>
        <Text style={styles.fpsRangeText}>{min}</Text>
        <Text style={styles.fpsHint}>{disabled ? 'Read-only while streaming' : 'Drag to set before starting'}</Text>
        <Text style={styles.fpsRangeText}>{max}</Text>
      </View>
    </View>
  );
}

function PlaceholderStreamPreview({message}: {message?: string}) {
  return (
    <LinearGradient colors={['#163A26', '#26583E', '#7DD89E', '#3F8F5C']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.previewFill}>
      <View style={styles.glow1} />
      <View style={styles.glow2} />
      {message ? (
        <Text style={styles.previewMessage}>{message}</Text>
      ) : (
        <View style={styles.eqWrap}>
          {bars.map((height, index) => (
            <View
              key={index}
              style={[
                styles.eqBar,
                {
                  height,
                  backgroundColor: index % 3 === 2 ? '#fff' : 'rgba(255,255,255,0.85)',
                },
              ]}
            />
          ))}
        </View>
      )}
    </LinearGradient>
  );
}

function LiveStreamPreview({target}: {target: StreamPreviewTarget}) {
  if (target.kind === 'hls') {
    return <HlsStreamPreview url={target.url} />;
  }
  return (
    <WebView
      allowsInlineMediaPlayback
      domStorageEnabled
      javaScriptEnabled
      mediaPlaybackRequiresUserAction={false}
      source={{uri: target.url}}
      style={styles.previewFill}
    />
  );
}

function HlsStreamPreview({url}: {url: string}) {
  const source = React.useMemo(() => ({uri: url, contentType: 'hls' as const}), [url]);
  const player = useVideoPlayer(source, (videoPlayer) => {
    videoPlayer.muted = true;
    videoPlayer.play();
  });

  React.useEffect(() => {
    void player
      .replaceAsync(source)
      .then(() => {
        player.muted = true;
        player.play();
      })
      .catch(() => {});
  }, [player, source]);

  return (
    <VideoView
      contentFit="cover"
      nativeControls={false}
      player={player}
      style={styles.previewFill}
    />
  );
}

function streamProtocolLabel(protocol: StreamProtocol) {
  return protocol === 'webrtc' ? 'WHIP' : protocol.toUpperCase();
}

function isStreamStatusFailure(status: string) {
  const normalized = status.toLowerCase();
  return (
    normalized.includes('failed') ||
    normalized.includes('not reachable') ||
    normalized.includes('required') ||
    normalized.includes('replace') ||
    normalized.includes('error') ||
    normalized.includes('connect the glasses to wi-fi') ||
    normalized.includes('connect glasses first')
  );
}

function localStreamSetupHint(protocol: StreamProtocol, streamUrl: string, status: string) {
  if (protocol !== 'rtmp' && protocol !== 'srt' && protocol !== 'webrtc') {
    return null;
  }
  const normalized = status.toLowerCase();
  const url = streamUrl.trim();
  const needsSetup =
    url.length === 0 ||
    url.includes('<computer-ip>') ||
    url.includes('YOUR_') ||
    normalized.includes('not reachable') ||
    normalized.includes('replace') ||
    normalized.includes('required');
  if (!needsSetup) {
    return null;
  }
  if (protocol === 'rtmp') {
    return 'Local RTMP setup: run python3 examples/local-demo-cloud/server.py, paste the printed RTMP publish URL here, then start streaming. The app previews the derived HLS URL; the printed ffplay command is optional for debugging.';
  }
  if (protocol === 'srt') {
    return 'Local SRT setup: run python3 examples/local-demo-cloud/server.py, paste the printed SRT publish URL here, then start streaming. The app previews the derived HLS URL; the printed SRT ffplay command is optional for debugging.';
  }
  return 'Local WebRTC setup: run python3 examples/local-demo-cloud/server.py, paste the printed WHIP publish URL here, then start streaming. The app previews the MediaMTX WebRTC page.';
}

function StreamPlayIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path d="M8 5v14l11-7z" fill="#fff" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 8, borderRadius: 28, paddingTop: 8, paddingBottom: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8 },
  previewWrap: { borderRadius: 22, overflow: 'hidden', height: 160 },
  preview: { flex: 1, backgroundColor: '#000' },
  previewFill: { ...StyleSheet.absoluteFillObject },
  glow1: { position: 'absolute', top: -60, left: -40, width: 220, height: 220, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.18)' },
  glow2: { position: 'absolute', bottom: -80, right: -50, width: 240, height: 240, borderRadius: 999, backgroundColor: 'rgba(125,216,158,0.25)' },
  livePill: { position: 'absolute', top: 14, left: 14, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.45)', paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  liveDot: { width: 7, height: 7, borderRadius: 999, backgroundColor: colors.redLive },
  readyDot: { backgroundColor: colors.greenSoft },
  liveText: { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  timer: { position: 'absolute', top: 14, right: 14, color: '#fff', fontSize: 13, fontWeight: '600' },
  eqWrap: { position: 'absolute', bottom: 56, left: 0, right: 0, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 5, height: 56 },
  eqBar: { width: 5, borderRadius: 3 },
  previewMessage: { position: 'absolute', left: 24, right: 24, top: 58, color: '#fff', fontSize: 16, fontWeight: '600', lineHeight: 21, textAlign: 'center' },
  previewMeta: { position: 'absolute', bottom: 14, left: 14, color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '500' },
  endBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 18, paddingVertical: 16, marginTop: 14, marginHorizontal: 6, gap: 10 },
  stopSquare: { width: 12, height: 12, backgroundColor: '#fff', borderRadius: 3 },
  endText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 },

  sdkCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, overflow: 'hidden', borderWidth: 1, borderColor: colors.borderSoft },
  sdkBlock: { backgroundColor: '#0E1A14', paddingVertical: 14, paddingHorizontal: 16, gap: 8 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sdkEyebrow: { color: colors.greenAccent, fontSize: 9, fontWeight: '700', letterSpacing: 1.1 },
  copyChip: { flexDirection: 'row', alignItems: 'center', minHeight: 36, gap: 5, backgroundColor: 'rgba(255,255,255,0.06)', paddingVertical: 7, paddingHorizontal: 10, borderRadius: 9 },
  copyChipPressed: { opacity: 0.6 },
  copyText: { color: colors.consoleText, fontSize: 12, fontWeight: '600' },
  sdkCode: { color: colors.consoleText, fontSize: 11, lineHeight: 16, fontFamily: 'Courier' },
  statusBar: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, gap: 10 },
  statusCircle: { width: 22, height: 22, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  statusCircleOk: { backgroundColor: 'rgba(52,199,89,0.16)' },
  statusCircleError: { backgroundColor: 'rgba(255,59,48,0.16)' },
  statusDot: { width: 8, height: 8, borderRadius: 999 },
  statusDotOk: { backgroundColor: colors.greenAccent },
  statusDotError: { backgroundColor: colors.red },
  statusTitle: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  statusSub: { color: colors.muted, fontSize: 11, fontWeight: '500' },

  protocolCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, paddingVertical: 14, paddingHorizontal: 14, gap: 12, borderWidth: 1, borderColor: colors.borderSoft },
  eyebrow: { color: colors.muted, fontSize: 10, fontWeight: '600', letterSpacing: 1.2 },
  cloudToggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 9, paddingHorizontal: 12 },
  cloudToggleLabel: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  tabs: { flexDirection: 'row', gap: 4, backgroundColor: 'rgba(15,42,29,0.05)', borderRadius: 14, padding: 4 },
  protoTab: { flex: 1, minHeight: 44, paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  protoTabActive: { backgroundColor: '#fff' },
  protoText: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  protoTextActive: { color: colors.ink, fontWeight: '700' },
  urlBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  setupHint: { color: colors.muted, fontSize: 12, fontWeight: '500', lineHeight: 16, backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 },
  method: { color: colors.greenAccent, fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  divider: { width: 1, height: 14, backgroundColor: 'rgba(15,42,29,0.12)' },
  url: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '500' },
  fpsCard: { backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  fpsCardDisabled: { opacity: 0.62 },
  fpsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fpsLabel: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.1 },
  fpsValue: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  fpsTrack: { height: 28, marginTop: 8, justifyContent: 'center' },
  fpsTrackBase: { position: 'absolute', left: 0, right: 0, height: 6, borderRadius: 999, backgroundColor: 'rgba(15,42,29,0.12)' },
  fpsTrackFill: { position: 'absolute', left: 0, height: 6, borderRadius: 999, backgroundColor: colors.greenAccent },
  fpsThumb: { position: 'absolute', marginLeft: -10, width: 20, height: 20, borderRadius: 999, backgroundColor: '#fff', borderWidth: 2, borderColor: colors.greenAccent, shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 5, shadowOffset: {width: 0, height: 2} },
  fpsRangeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fpsRangeText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  fpsHint: { color: colors.muted, fontSize: 11, fontWeight: '500' },
});
