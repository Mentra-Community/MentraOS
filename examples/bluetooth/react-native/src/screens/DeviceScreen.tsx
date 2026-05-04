import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';
import { Header } from '../components/Header';
import { StatusBarBar } from '../components/StatusBarBar';
import { colors } from '../components/theme';
import {
  batteryLabel,
  batteryLevel,
  bluetoothSearchLabel,
  connectionLabel,
  deviceLabel,
  discoveredLabel,
  firmwareLabel,
  latestEventLabel,
  modelLabel,
  rssiLabel,
  rssiQuality,
  wifiLabel,
  wifiSubLabel,
} from '../sdkFormat';
import type { MentraSdkModel } from '../useMentraSdk';

const glassesImages = {
  evenRealitiesG1: require('../../assets/glasses/even_realities_g1.png'),
  evenRealitiesG2: require('../../assets/glasses/even_realities_g2.png'),
  mentraDisplay: require('../../assets/glasses/mentra_display.png'),
  mentraLive: require('../../assets/glasses/mentra_live.png'),
  unknownWearable: require('../../assets/glasses/unknown_wearable.png'),
  vuzixZ100: require('../../assets/glasses/vuzix_z100.png'),
};

export function DeviceScreen({ sdk }: { sdk: MentraSdkModel }) {
  const level = batteryLevel(sdk.glassesStatus);
  const connected = sdk.glassesStatus.connected === true;
  const connection = connectionLabel(sdk.glassesStatus);
  const latestEvent = sdk.events[0];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 140 }}>
      <StatusBarBar />
      <Header connected={connected} title="Device" />

      {/* Hero card */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.heroCard}>
        <View style={styles.heroTop}>
          <View style={{ gap: 4 }}>
            <Text style={styles.eyebrowGreen}>{connection}</Text>
            <Text style={styles.heroTitle}>{modelLabel(sdk.glassesStatus)}</Text>
            <Text style={styles.heroSub}>{deviceLabel(sdk.glassesStatus)}</Text>
          </View>
          <Image source={glassesImageFor(sdk.glassesStatus)} style={styles.glasses} resizeMode="contain" />
        </View>
        <View style={styles.heroDivider} />
        <View style={styles.batteryRow}>
          <View style={{ gap: 4 }}>
            <Text style={styles.eyebrow}>BATTERY</Text>
            <View style={styles.batteryNumRow}>
              <Text style={styles.batteryNum}>{level ?? '--'}</Text>
              <Text style={styles.batteryPct}>%</Text>
            </View>
            <View style={styles.chargingRow}>
              <Svg width={11} height={11} viewBox="0 0 24 24"><Path d="M13 2 3 14h7v8l10-12h-7z" fill={colors.greenAccent} /></Svg>
              <Text style={styles.chargingText}>{sdk.glassesStatus.charging ? 'Charging' : connected ? 'Not charging' : 'Waiting'}</Text>
            </View>
          </View>
          <View style={styles.signalBars}>
            {[14, 22, 30, 38, 46, 54, 62].map((h, i) => (
              <View key={i} style={[styles.bar, { height: h, backgroundColor: level !== null && i < Math.ceil((level / 100) * 7) ? colors.greenAccent : '#0000000F' }]} />
            ))}
          </View>
        </View>
      </LinearGradient>

      {/* Stat row */}
      <View style={styles.statRow}>
        <StatCard label="FIRMWARE" value={firmwareLabel(sdk.glassesStatus)} sub="reported by glasses" subColor={colors.greenAccent} />
        <StatCard label="WI-FI" value={wifiLabel(sdk.glassesStatus)} sub={wifiSubLabel(sdk.glassesStatus)} subColor={colors.muted} bold />
        <StatCard label="RSSI" value={rssiLabel(sdk.glassesStatus)} sub={rssiQuality(sdk.glassesStatus)} subColor={colors.greenAccent} bold />
      </View>

      {/* Quick actions */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.bigCard}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Quick actions</Text>
          <Text style={styles.cardEyebrow}>SDK</Text>
        </View>
        <View style={{ gap: 8 }}>
          <View style={styles.btnRow}>
            <Pressable style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, { backgroundColor: '#0E2C1A' }]} onPress={sdk.startScan}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Circle cx={11} cy={11} r={7} /><Path d="m21 21-3.5-3.5" />
              </Svg>
              <Text style={styles.btnTextLight}>Scan</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, { backgroundColor: colors.greenPrimary }]} onPress={sdk.connect}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M9 17H5a3 3 0 0 1 0-6h4" /><Path d="M15 7h4a3 3 0 0 1 0 6h-4" /><Line x1={8} y1={14} x2={16} y2={14} />
              </Svg>
              <Text style={styles.btnTextLight}>Connect</Text>
            </Pressable>
          </View>
          <View style={styles.btnRow}>
            <Pressable disabled={!connected} style={({ pressed }) => [styles.btnLight, pressed && styles.btnPressed, !connected && styles.disabled]} onPress={sdk.displayHello}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.inkAlt} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Rect x={2} y={4} width={20} height={14} rx={2} /><Path d="M8 22h8" /><Path d="M12 18v4" />
              </Svg>
              <Text style={styles.btnTextDark}>Display Hello</Text>
            </Pressable>
            <Pressable disabled={!connected} style={({ pressed }) => [styles.btnLight, pressed && styles.btnPressed, !connected && styles.disabled]} onPress={sdk.clearDisplay}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.inkAlt} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Rect x={2} y={4} width={20} height={14} rx={2} /><Line x1={2} y1={11} x2={22} y2={11} />
              </Svg>
              <Text style={styles.btnTextDark}>Clear Display</Text>
            </Pressable>
          </View>
          <View style={styles.btnRow}>
            <Pressable disabled={!connected} style={({ pressed }) => [styles.btnLight, pressed && styles.btnPressed, !connected && styles.disabled]} onPress={sdk.applySettings}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.inkAlt} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Polyline points="20 6 9 17 4 12" />
              </Svg>
              <Text style={styles.btnTextDark}>Apply Settings</Text>
            </Pressable>
            <Pressable disabled={!connected} onPress={sdk.disconnect} style={[{ flex: 1 }, !connected && styles.disabled]}>
              <LinearGradient colors={['#FF6B5B', '#FF3B30']} style={[styles.btn, { borderRadius: 18 }]}>
                <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M9 17H5a3 3 0 0 1 0-6h2" /><Path d="M17 7h2a3 3 0 0 1 3 3" /><Line x1={2} y1={2} x2={22} y2={22} />
                </Svg>
                <Text style={styles.btnTextLight}>Disconnect</Text>
              </LinearGradient>
            </Pressable>
          </View>
        </View>
      </LinearGradient>

      {/* Live status */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={[styles.bigCard, { paddingHorizontal: 0 }]}>
        <View style={[styles.cardHead, { paddingHorizontal: 18 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: colors.greenPrimary }} />
            <Text style={styles.cardTitle}>Live status</Text>
          </View>
          <View style={styles.recPill}><Text style={styles.recText}>REC</Text></View>
        </View>
        <View style={{ paddingHorizontal: 18 }}>
          <StatusRow label="LAST ACTION" value={sdk.lastAction} />
          <StatusRow label="CONNECTION" custom={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: colors.greenPrimary }} />
            <Text style={[styles.statusValue, { color: colors.greenInk, fontWeight: '600' }]}>{connection}</Text>
          </View>} />
          <StatusRow label="DEVICE" value={deviceLabel(sdk.glassesStatus)} mono />
          <StatusRow label="BATTERY" custom={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[styles.statusValue, { fontWeight: '600' }]}>{batteryLabel(sdk.glassesStatus)}</Text>
            {sdk.glassesStatus.charging ? <View style={styles.chargingPill}>
              <Svg width={10} height={10} viewBox="0 0 24 24"><Path d="M13 2 4.09 12.97a1 1 0 0 0 .77 1.63H10v7l8.91-10.97a1 1 0 0 0-.77-1.63H13z" fill={colors.greenPrimary} /></Svg>
              <Text style={styles.chargingPillText}>charging</Text>
            </View> : null}
          </View>} />
          <StatusRow label="BLUETOOTH" value={bluetoothSearchLabel(sdk.bluetoothStatus)} />
          <StatusRow label="DISCOVERED" value={discoveredLabel(sdk.discoveredDevices)} mono />
          <StatusRow label="PERMISSIONS" value={sdk.permissionStatus} />
          <StatusRow label="CAMERA" value={sdk.cameraStatus} />
          <StatusRow label="LATEST EVENT" custom={<View style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={styles.liveBadge}><View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: colors.greenPrimary }} /><Text style={styles.liveText}>{latestEvent?.tag ?? 'LIVE'}</Text></View>
              <Text style={styles.timeFaint}>{latestEvent?.time ?? '--:--:--'}</Text>
            </View>
            <Text style={styles.statusValue}>{latestEventLabel(sdk.events)}</Text>
          </View>} last />
        </View>
      </LinearGradient>
    </ScrollView>
  );
}

function glassesImageFor(status: MentraSdkModel['glassesStatus']) {
  const rawStatus = status as Record<string, unknown>;
  const model = [status.deviceModel, status.bluetoothName, rawStatus.defaultWearable].filter(Boolean).join(' ').toLowerCase();

  if (model.includes('even') && model.includes('g2')) {
    return glassesImages.evenRealitiesG2;
  }
  if (model.includes('even') || model.includes('g1')) {
    return glassesImages.evenRealitiesG1;
  }
  if (model.includes('display')) {
    return glassesImages.mentraDisplay;
  }
  if (model.includes('vuzix') || model.includes('z100')) {
    return glassesImages.vuzixZ100;
  }
  if (model.includes('unknown')) {
    return glassesImages.unknownWearable;
  }
  return glassesImages.mentraLive;
}

function StatCard({ label, value, sub, subColor, bold }: { label: string; value: string; sub: string; subColor: string; bold?: boolean }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, bold && { fontWeight: '700' }]}>{value}</Text>
      <Text style={[styles.statSub, { color: subColor }]}>{sub}</Text>
    </View>
  );
}

function StatusRow({ label, value, custom, mono, last }: { label: string; value?: string; custom?: React.ReactNode; mono?: boolean; last?: boolean }) {
  return (
    <View style={[styles.statusRow, !last && styles.statusBorder]}>
      <Text style={styles.statusLabel}>{label}</Text>
      <View style={{ flex: 1 }}>
        {custom ?? <Text style={[styles.statusValue, mono && { fontFamily: 'Courier' }]}>{value}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  heroCard: {
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 28,
    paddingVertical: 22,
    paddingHorizontal: 22,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 18,
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  eyebrowGreen: { color: colors.greenAccent, fontSize: 10, fontWeight: '600', letterSpacing: 1.2 },
  eyebrow: { color: colors.muted, fontSize: 10, fontWeight: '600', letterSpacing: 1.2 },
  heroTitle: { color: colors.ink, fontSize: 28, fontWeight: '800', letterSpacing: -0.7 },
  heroSub: { color: colors.muted, fontSize: 11, fontWeight: '500' },
  glasses: { width: 145, height: 52 },
  heroDivider: { borderTopWidth: 1, borderColor: colors.hairline, paddingTop: 6 },
  batteryRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  batteryNumRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  batteryNum: { color: colors.ink, fontSize: 56, fontWeight: '800', letterSpacing: -2.2 },
  batteryPct: { color: colors.muted, fontSize: 22, fontWeight: '600' },
  chargingRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chargingText: { color: colors.greenAccent, fontSize: 12, fontWeight: '600' },
  signalBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, paddingBottom: 6 },
  bar: { width: 6, borderRadius: 3 },
  statRow: { flexDirection: 'row', gap: 10, marginHorizontal: 16, marginTop: 12 },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 18,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    gap: 4,
    shadowColor: '#0F2A1D',
    shadowOpacity: 0.07,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 22,
    elevation: 3,
  },
  statLabel: { color: colors.muted, fontSize: 9, fontWeight: '600', letterSpacing: 1.1 },
  statValue: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  statSub: { fontSize: 11, fontWeight: '500' },
  bigCard: {
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 28,
    paddingVertical: 22,
    paddingHorizontal: 22,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 18,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { color: colors.inkAlt, fontSize: 16, fontWeight: '700', letterSpacing: -0.16 },
  cardEyebrow: { color: 'rgba(14,14,16,0.4)', fontSize: 10, fontWeight: '600', letterSpacing: 1.6, fontFamily: 'Courier' },
  btnRow: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, gap: 8 },
  btnPressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.45 },
  btnLight: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, gap: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#DBDBDB' },
  btnTextLight: { color: '#fff', fontSize: 13, fontWeight: '600' },
  btnTextDark: { color: colors.inkAlt, fontSize: 13, fontWeight: '600' },
  recPill: { backgroundColor: 'rgba(14,44,26,0.06)', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  recText: { color: colors.greenInk, fontSize: 10, fontWeight: '600', letterSpacing: 1.6, fontFamily: 'Courier' },
  statusRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 11, gap: 14 },
  statusBorder: { borderTopWidth: 1, borderColor: '#F2EDE0' },
  statusLabel: { width: 90, color: 'rgba(14,14,16,0.5)', fontSize: 10, fontWeight: '600', letterSpacing: 1.4, fontFamily: 'Courier' },
  statusValue: { color: colors.inkAlt, fontSize: 13, fontWeight: '500' },
  chargingPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(22,163,74,0.08)', paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999 },
  chargingPillText: { color: colors.greenPrimary, fontSize: 11, fontWeight: '600' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(22,163,74,0.08)', paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6 },
  liveText: { color: colors.greenPrimary, fontSize: 10, fontWeight: '600', letterSpacing: 0.6, fontFamily: 'Courier' },
  timeFaint: { color: 'rgba(14,14,16,0.65)', fontSize: 11, fontFamily: 'Courier' },
});
