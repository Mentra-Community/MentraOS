import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, TextInput, Clipboard } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Polyline, Rect } from 'react-native-svg';
import { Header } from '../components/Header';
import { StatusBarBar } from '../components/StatusBarBar';
import { colors } from '../components/theme';
import { streamUptime } from '../sdkFormat';
import { STREAM_DEFAULT_URLS, type MentraSdkModel, type StreamProtocol } from '../useMentraSdk';

const bars = [18, 32, 48, 24, 40, 56, 30, 44, 22, 36, 50, 28, 40];
const streamSdkCall = `const streamId = \`rn-\${Date.now()}\`;
await BluetoothSdk.startStream({
  type: 'start_stream',
  protocol: streamProtocol,
  streamId,
  streamUrl,
  keepAlive: true,
  keepAliveIntervalSeconds: 15,
})`;

export function StreamScreen({ sdk }: { sdk: MentraSdkModel }) {
  const isLive = sdk.streamStartedAt !== null;
  const uptime = streamUptime(sdk.streamStartedAt);
  const setupHint = localStreamSetupHint(sdk.streamProtocol, sdk.streamUrl, sdk.streamStatus);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 140 }}>
      <StatusBarBar />
      <Header connected={sdk.glassesStatus.connected === true} title="Stream" />

      {/* Live preview */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.card}>
        <View style={styles.previewWrap}>
          <LinearGradient colors={['#163A26', '#26583E', '#7DD89E', '#3F8F5C']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.preview}>
            <View style={styles.glow1} />
            <View style={styles.glow2} />
            <View style={styles.livePill}>
              <View style={[styles.liveDot, !isLive && styles.readyDot]} />
              <Text style={styles.liveText}>{isLive ? 'LIVE' : 'READY'}</Text>
            </View>
            <Text style={styles.timer}>{uptime}</Text>
            <View style={styles.eqWrap}>
              {bars.map((h, i) => (
                <View key={i} style={[styles.eqBar, { height: h, backgroundColor: i % 3 === 2 ? '#fff' : 'rgba(255,255,255,0.85)' }]} />
              ))}
            </View>
            <Text style={styles.previewMeta}>{isLive ? `${sdk.streamProtocol.toUpperCase()} · keep-alive 15s` : 'Ready · enter stream URL'}</Text>
          </LinearGradient>
        </View>

        <Pressable onPress={sdk.toggleStream}>
          <LinearGradient colors={isLive ? ['#FF6B5B', '#FF3B30'] : ['#26473A', '#1F3A2A']} style={styles.endBtn}>
            <View style={styles.stopSquare} />
            <Text style={styles.endText}>{isLive ? 'End stream' : 'Start stream'}</Text>
          </LinearGradient>
        </Pressable>
      </LinearGradient>

      {/* SDK call */}
      <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.sdkCard}>
        <View style={styles.sdkBlock}>
          <View style={styles.cardHead}>
            <Text style={styles.sdkEyebrow}>SDK CALL</Text>
            <Pressable style={({pressed}) => [styles.copyChip, pressed && styles.copyChipPressed]} onPress={() => Clipboard.setString(streamSdkCall)}>
              <Svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke={colors.consoleText} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Rect x={9} y={9} width={13} height={13} rx={2} />
                <Path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </Svg>
              <Text style={styles.copyText}>Copy</Text>
            </Pressable>
          </View>
          <Text style={styles.sdkCode}>{streamSdkCall}</Text>
        </View>
        <View style={styles.statusBar}>
          <View style={styles.redCircle}>
            <View style={styles.redDot} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.statusTitle}>{sdk.streamStatus}</Text>
            <Text style={styles.statusSub}>uptime {uptime} · keep-alive 15s</Text>
          </View>
          <Text style={styles.linkRight}>Stats →</Text>
        </View>
      </LinearGradient>

      {/* Protocol */}
      <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.protocolCard}>
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
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={sdk.setStreamUrl}
            placeholder={STREAM_DEFAULT_URLS[sdk.streamProtocol]}
            placeholderTextColor={colors.muted}
            style={styles.url}
            value={sdk.streamUrl}
          />
          <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <Path d="m18.5 2.5 3 3L12 15l-4 1 1-4z" />
          </Svg>
        </View>
        {setupHint ? <Text style={styles.setupHint}>{setupHint}</Text> : null}
      </LinearGradient>
    </ScrollView>
  );
}

function streamProtocolLabel(protocol: StreamProtocol) {
  return protocol === 'webrtc' ? 'WHIP' : protocol.toUpperCase();
}

function localStreamSetupHint(protocol: StreamProtocol, streamUrl: string, status: string) {
  if (protocol !== 'rtmp' && protocol !== 'webrtc') {
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
    return 'Local RTMP setup: run python3 examples/local-demo-cloud/server.py, paste the printed RTMP publish URL here, then open the HLS preview URL on your computer. The printed ffplay command is optional for debugging.';
  }
  return 'Local WebRTC setup: run python3 examples/local-demo-cloud/server.py, paste the printed WHIP publish URL here, then open the WebRTC preview URL on your computer.';
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 8, borderRadius: 28, paddingTop: 8, paddingBottom: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8 },
  previewWrap: { borderRadius: 22, overflow: 'hidden', height: 160 },
  preview: { flex: 1 },
  glow1: { position: 'absolute', top: -60, left: -40, width: 220, height: 220, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.18)' },
  glow2: { position: 'absolute', bottom: -80, right: -50, width: 240, height: 240, borderRadius: 999, backgroundColor: 'rgba(125,216,158,0.25)' },
  livePill: { position: 'absolute', top: 14, left: 14, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.45)', paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  liveDot: { width: 7, height: 7, borderRadius: 999, backgroundColor: colors.redLive },
  readyDot: { backgroundColor: colors.greenSoft },
  liveText: { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  timer: { position: 'absolute', top: 14, right: 14, color: '#fff', fontSize: 13, fontWeight: '600' },
  eqWrap: { position: 'absolute', bottom: 56, left: 0, right: 0, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 5, height: 56 },
  eqBar: { width: 5, borderRadius: 3 },
  previewMeta: { position: 'absolute', bottom: 14, left: 14, color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '500' },
  endBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 18, paddingVertical: 16, marginTop: 14, marginHorizontal: 6, gap: 10 },
  stopSquare: { width: 12, height: 12, backgroundColor: '#fff', borderRadius: 3 },
  endText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  sdkCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, overflow: 'hidden', borderWidth: 1, borderColor: colors.borderSoft },
  sdkBlock: { backgroundColor: '#0E1A14', paddingVertical: 14, paddingHorizontal: 16, gap: 8 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sdkEyebrow: { color: colors.greenAccent, fontSize: 9, fontWeight: '700', letterSpacing: 1.1 },
  copyChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.06)', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6 },
  copyChipPressed: { opacity: 0.6 },
  copyText: { color: colors.consoleText, fontSize: 10, fontWeight: '600' },
  sdkCode: { color: colors.consoleText, fontSize: 11, lineHeight: 16, fontFamily: 'Courier' },
  statusBar: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, gap: 10 },
  redCircle: { width: 22, height: 22, borderRadius: 999, backgroundColor: 'rgba(255,59,48,0.16)', alignItems: 'center', justifyContent: 'center' },
  redDot: { width: 8, height: 8, borderRadius: 999, backgroundColor: colors.red },
  statusTitle: { color: colors.ink, fontSize: 11, fontWeight: '600' },
  statusSub: { color: colors.muted, fontSize: 10, fontWeight: '500' },
  linkRight: { color: colors.muted, fontSize: 10, fontWeight: '600' },

  protocolCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, paddingVertical: 14, paddingHorizontal: 14, gap: 12, borderWidth: 1, borderColor: colors.borderSoft },
  tabs: { flexDirection: 'row', gap: 4, backgroundColor: 'rgba(15,42,29,0.05)', borderRadius: 14, padding: 4 },
  protoTab: { flex: 1, paddingVertical: 10, paddingHorizontal: 8, alignItems: 'center', borderRadius: 10 },
  protoTabActive: { backgroundColor: '#fff' },
  protoText: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  protoTextActive: { color: colors.ink, fontWeight: '700' },
  urlBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  setupHint: { color: colors.muted, fontSize: 11, fontWeight: '500', lineHeight: 15, backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 },
  method: { color: colors.greenAccent, fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  divider: { width: 1, height: 14, backgroundColor: 'rgba(15,42,29,0.12)' },
  url: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '500' },
});
