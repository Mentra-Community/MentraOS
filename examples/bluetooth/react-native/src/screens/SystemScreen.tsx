import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';
import { Header } from '../components/Header';
import { OfflineNotice } from '../components/OfflineNotice';
import { StatusBarBar } from '../components/StatusBarBar';
import { colors } from '../components/theme';
import { wifiLabel, wifiSubLabel } from '../sdkFormat';
import type { LedMode, MentraSdkModel } from '../useMentraSdk';

export function SystemScreen({ sdk }: { sdk: MentraSdkModel }) {
  const networks = sdk.bluetoothStatus.wifiScanResults ?? [];
  const connected = sdk.glassesStatus.connected === true;
  const inputEvents = sdk.events.filter((item) => item.text.includes('button') || item.text.includes('touch')).slice(0, 3);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 140 }}>
      <StatusBarBar />
      <Header connected={sdk.glassesStatus.connected === true} title="System" />
      {!connected && <OfflineNotice />}

      {/* Wi-Fi card */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.bigCard}>
        <View style={styles.wifiHeader}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={styles.iconTile}>
              <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.greenInk} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M5 12.55a11 11 0 0 1 14.08 0" />
                <Path d="M1.42 9a16 16 0 0 1 21.16 0" />
                <Path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <Line x1={12} y1={20} x2={12.01} y2={20} />
              </Svg>
            </View>
            <View>
              <Text style={styles.wifiTitle}>Wi-Fi</Text>
              <Text style={styles.wifiSub}>{networks.length} networks nearby</Text>
            </View>
          </View>
          <Pressable
            disabled={!connected}
            style={[styles.scanBtn, !connected && styles.disabled]}
            onPress={sdk.requestWifiScan}>
            <Svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
              <Polyline points="23 4 23 10 17 10" />
              <Path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </Svg>
            <Text style={styles.scanText}>Scan</Text>
          </Pressable>
        </View>
        <NetworkRow name={wifiLabel(sdk.glassesStatus)} sub={wifiSubLabel(sdk.glassesStatus)} subColor={colors.greenAccent} check />
        {(networks.length > 0 ? networks : [
          { ssid: 'Scan for nearby networks', signalStrength: 0, requiresPassword: false },
        ]).map((network, index) => (
          <NetworkRow
            key={`${network.ssid}-${index}`}
            name={network.ssid}
            sub={`${network.requiresPassword ? 'secured' : 'open'} · ${network.signalStrength ?? 0}`}
            subColor={colors.muted}
            faint
            locked={network.requiresPassword}
            last={index === Math.max(networks.length - 1, 0)}
            disabled={!connected || network.ssid === 'Scan for nearby networks'}
            onPress={() => sdk.sendWifiCredentials(network.ssid)}
          />
        ))}
      </LinearGradient>

      {/* Hotspot + Microphone row */}
      <View style={styles.row2}>
        <Pressable disabled={!connected} style={[{ flex: 1 }, !connected && styles.disabled]} onPress={sdk.toggleHotspot}>
        <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.tileCard}>
          <View style={styles.tileHead}>
            <View style={styles.iconTileSm}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.greenInk} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Circle cx={12} cy={12} r={2} />
                <Path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.48" />
              </Svg>
            </View>
            <View style={styles.toggleOn}>
              <View style={[styles.toggleKnob, !sdk.hotspotEnabled && { backgroundColor: colors.mutedSoft, alignSelf: 'flex-start' }]} />
            </View>
          </View>
          <View>
            <Text style={styles.tileTitle}>Hotspot</Text>
            <Text style={styles.tileSub}>{sdk.hotspotEnabled ? 'enabled' : 'disabled'}</Text>
          </View>
        </LinearGradient>
        </Pressable>
        <Pressable disabled={!connected} style={[{ flex: 1 }, !connected && styles.disabled]} onPress={sdk.toggleMic}>
        <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.tileCard}>
          <View style={styles.tileHead}>
            <View style={styles.iconTileSm}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.greenInk} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              </Svg>
            </View>
            <View style={styles.miniBars}>
              {[6, 14, 8, 16, 10].map((h, i) => (
                <View key={i} style={[styles.miniBar, { height: h }]} />
              ))}
            </View>
          </View>
          <View>
            <Text style={styles.tileTitle}>Microphone</Text>
            <Text style={[styles.tileSub, { color: sdk.micRecording ? colors.greenAccent : colors.muted }]}>{sdk.micRecording ? `${sdk.pcmFrames} PCM frames · ${sdk.pcmBytes} bytes` : 'tap to start PCM'}</Text>
          </View>
        </LinearGradient>
        </Pressable>
      </View>

      {/* Inputs */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.bigCard}>
        <View style={styles.tileHead}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={styles.iconTileSm}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.greenInk} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Circle cx={12} cy={12} r={9} />
                <Circle cx={12} cy={12} r={3} fill={colors.greenInk} />
              </Svg>
            </View>
            <View>
              <Text style={styles.tileTitle}>Inputs</Text>
              <Text style={styles.tileSub}>button · touch · swipe</Text>
            </View>
          </View>
          <View style={styles.livePill2}>
            <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: connected ? colors.greenAccent : colors.mutedSoft }} />
            <Text style={styles.livePill2Text}>{connected ? 'LIVE' : 'OFF'}</Text>
          </View>
        </View>
        <View style={styles.inputChips}>
          {(inputEvents.length > 0 ? inputEvents : [
            { time: '--', text: 'waiting for input' },
          ]).map((item, index) => (
            <InputChip key={`${item.time}-${index}`} prefix={item.time.slice(-8, -6) || '--'} label={item.text.replace(/^button /, '')} />
          ))}
        </View>
      </LinearGradient>

      {/* RGB LED */}
      <LinearGradient colors={['rgba(255,255,255,0.72)', 'rgba(255,255,255,0.5)']} style={styles.bigCard}>
        <View style={styles.tileHead}>
          <View>
            <Text style={styles.ledTitle}>RGB LED</Text>
            <Text style={styles.tileSub}>intensity & pattern</Text>
          </View>
          <View style={styles.onPill}>
            <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: colors.greenAccent }} />
            <Text style={styles.onText}>{sdk.ledMode === 'Off' ? 'off' : 'on'}</Text>
          </View>
        </View>
        <View style={styles.ledTabs}>
          <LedTab active={sdk.ledMode === 'Off'} disabled={!connected} onPress={() => sdk.selectLedMode('Off')} icon={<Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Circle cx={12} cy={12} r={9} /><Line x1={6.5} y1={17.5} x2={17.5} y2={6.5} /></Svg>} label="Off" />
          <LedTab active={sdk.ledMode === 'Solid'} disabled={!connected} onPress={() => sdk.selectLedMode('Solid')} icon={<Svg width={18} height={18} viewBox="0 0 24 24"><Circle cx={12} cy={12} r={6} fill={colors.greenInk} /></Svg>} label="Solid" />
          <LedTab active={sdk.ledMode === 'Pulse'} disabled={!connected} onPress={() => sdk.selectLedMode('Pulse')} icon={<Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2}><Circle cx={12} cy={12} r={3} fill={colors.muted} /><Circle cx={12} cy={12} r={6.5} opacity={0.55} /><Circle cx={12} cy={12} r={10} opacity={0.25} /></Svg>} label="Pulse" />
          <LedTab active={sdk.ledMode === 'Blink'} disabled={!connected} onPress={() => sdk.selectLedMode('Blink')} icon={<Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2} strokeDasharray="3 3"><Circle cx={12} cy={12} r={9} /></Svg>} label="Blink" />
        </View>
        <View style={{ gap: 8 }}>
          <View style={styles.brightnessHead}>
            <Text style={styles.brightnessLabel}>BRIGHTNESS</Text>
            <Text style={styles.brightnessValue}>72%</Text>
          </View>
          <View style={styles.sliderTrack}>
            <LinearGradient colors={['#3FB76A', '#7DD89E']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[styles.sliderFill, { width: '72%' }]} />
            <View style={[styles.sliderThumb, { left: '72%' }]} />
          </View>
        </View>
      </LinearGradient>
    </ScrollView>
  );
}

function NetworkRow({ name, sub, subColor, rssi, check, faint, locked, last, disabled, onPress }: { name: string; sub: string; subColor: string; rssi?: string; check?: boolean; faint?: boolean; locked?: boolean; last?: boolean; disabled?: boolean; onPress?: () => void }) {
  return (
    <Pressable disabled={disabled || !onPress} style={[styles.networkRow, !last && styles.networkBorder, disabled && styles.disabled]} onPress={onPress}>
      <View style={styles.networkIcon}>
        <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={faint ? colors.mutedSoft : colors.greenInk} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M5 12.55a11 11 0 0 1 14.08 0" />
          <Path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <Line x1={12} y1={20} x2={12.01} y2={20} />
        </Svg>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.networkName}>{name}</Text>
        <Text style={[styles.networkSub, { color: subColor }]}>{sub}</Text>
      </View>
      {rssi && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={{ color: colors.ink, fontSize: 11, fontWeight: '600' }}>{rssi}</Text>
          {check && <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><Polyline points="20 6 9 17 4 12" /></Svg>}
        </View>
      )}
      {locked && (
        <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <Rect x={3} y={11} width={18} height={11} rx={2} />
          <Path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </Svg>
      )}
    </Pressable>
  );
}

function InputChip({ prefix, label }: { prefix: string; label: string }) {
  return (
    <View style={styles.inputChip}>
      <Text style={styles.inputChipPrefix}>{prefix}</Text>
      <Text style={styles.inputChipLabel}>{label}</Text>
    </View>
  );
}

function LedTab({ icon, label, active, disabled, onPress }: { icon: React.ReactNode; label: LedMode; active?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable disabled={disabled} style={[styles.ledTab, active && styles.ledTabActive, disabled && styles.disabled]} onPress={onPress}>
      {icon}
      <Text style={[styles.ledTabText, active && styles.ledTabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bigCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 28, paddingVertical: 18, paddingHorizontal: 18, borderWidth: 1, borderColor: colors.border, gap: 12 },
  wifiHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconTile: { width: 36, height: 36, borderRadius: 12, backgroundColor: 'rgba(125,216,158,0.18)', borderWidth: 1, borderColor: 'rgba(52,199,89,0.22)', alignItems: 'center', justifyContent: 'center' },
  iconTileSm: { width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(125,216,158,0.18)', borderWidth: 1, borderColor: 'rgba(52,199,89,0.22)', alignItems: 'center', justifyContent: 'center' },
  wifiTitle: { color: colors.ink, fontSize: 17, fontWeight: '700', letterSpacing: -0.17 },
  wifiSub: { color: colors.muted, fontSize: 10, fontWeight: '500' },
  scanBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(15,42,29,0.06)', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  disabled: { opacity: 0.45 },
  scanText: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  networkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 },
  networkBorder: { borderBottomWidth: 1, borderColor: 'rgba(15,42,29,0.06)' },
  networkIcon: { width: 28, alignItems: 'center', justifyContent: 'center' },
  networkName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  networkSub: { fontSize: 11, fontWeight: '500' },
  row2: { flexDirection: 'row', gap: 10, marginHorizontal: 16, marginTop: 12 },
  tileCard: { flex: 1, borderRadius: 22, paddingVertical: 16, paddingHorizontal: 16, gap: 10, borderWidth: 1, borderColor: colors.borderSoft },
  tileHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleOn: { width: 38, height: 22, borderRadius: 999, backgroundColor: '#fff', padding: 2, alignItems: 'flex-end' },
  toggleKnob: { width: 18, height: 18, borderRadius: 999, backgroundColor: colors.greenAccent },
  miniBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 16 },
  miniBar: { width: 3, borderRadius: 1.5, backgroundColor: colors.greenAccent },
  tileTitle: { color: colors.ink, fontSize: 16, fontWeight: '700', letterSpacing: -0.16 },
  tileSub: { color: colors.muted, fontSize: 10, fontWeight: '500' },
  livePill2: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(52,199,89,0.16)', borderWidth: 1, borderColor: 'rgba(52,199,89,0.3)', paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999 },
  livePill2Text: { color: colors.greenDeep, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  inputChips: { flexDirection: 'row', gap: 6 },
  inputChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(15,42,29,0.04)', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10 },
  inputChipPrefix: { color: colors.muted, fontSize: 10, fontWeight: '600' },
  inputChipLabel: { color: colors.ink, fontSize: 11, fontWeight: '600' },
  ledTitle: { color: colors.ink, fontSize: 18, fontWeight: '700', letterSpacing: -0.18 },
  onPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(15,42,29,0.06)', paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999 },
  onText: { color: colors.ink, fontSize: 11, fontWeight: '600' },
  ledTabs: { flexDirection: 'row', gap: 4, backgroundColor: 'rgba(15,42,29,0.05)', borderRadius: 14, padding: 4 },
  ledTab: { flex: 1, paddingVertical: 12, paddingHorizontal: 6, alignItems: 'center', gap: 6, borderRadius: 10 },
  ledTabActive: { backgroundColor: '#fff' },
  ledTabText: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  ledTabTextActive: { color: colors.ink, fontWeight: '600' },
  brightnessHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brightnessLabel: { color: colors.muted, fontSize: 10, fontWeight: '600', letterSpacing: 1.6 },
  brightnessValue: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  sliderTrack: { height: 8, borderRadius: 999, backgroundColor: 'rgba(15,42,29,0.08)', position: 'relative' },
  sliderFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 999 },
  sliderThumb: { position: 'absolute', top: -6, marginLeft: -10, width: 20, height: 20, borderRadius: 999, backgroundColor: '#fff', shadowColor: '#0F2A1D', shadowOpacity: 0.18, shadowOffset: { width: 0, height: 2 }, shadowRadius: 6, elevation: 4 },
});
