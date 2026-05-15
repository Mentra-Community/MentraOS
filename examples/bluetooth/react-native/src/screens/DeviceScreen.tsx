import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { Header } from '../components/Header';
import { useScrollBottomPadding } from '../components/keyboardLayout';
import { colors } from '../components/theme';
import {
  batteryLabel,
  batteryLevel,
  bluetoothSearchLabel,
  connectionLabel,
  deviceLabel,
  discoveredLabel,
  firmwareLabel,
  firmwareSubLabel,
  isGlassesConnected,
  latestEventLabel,
  modelLabel,
  rssiLabel,
  rssiUpdatedLabel,
  supportsDisplay,
  wifiLabel,
  wifiSubLabel,
} from '../sdkFormat';
import { SCAN_MODELS, scanModelLabel, type MentraSdkModel, type ScanModel } from '../useMentraSdk';

const glassesImages = {
  evenRealitiesG1: require('../../assets/glasses/even_realities_g1.png'),
  evenRealitiesG2: require('../../assets/glasses/even_realities_g2.png'),
  mentraDisplay: require('../../assets/glasses/mentra_display.png'),
  mentraLive: require('../../assets/glasses/mentra_live.png'),
  unknownWearable: require('../../assets/glasses/unknown_wearable.png'),
  vuzixZ100: require('../../assets/glasses/vuzix_z100.png'),
};

export function DeviceScreen({ sdk }: { sdk: MentraSdkModel }) {
  const scrollBottomPadding = useScrollBottomPadding();
  const level = batteryLevel(sdk.glassesStatus);
  const connected = isGlassesConnected(sdk.glassesStatus);
  const canConnect = !connected && hasConnectionTarget(sdk);
  const hasDefaultTarget = Boolean(sdk.defaultDevice || savedConnectionTargetName(sdk.bluetoothStatus));
  const displaySupported = connected && supportsDisplay(sdk.glassesStatus);
  const connection = connectionLabel(sdk.glassesStatus);
  const latestEvent = sdk.events[0];

  return (
    <ScrollView
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: scrollBottomPadding }}>
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
        <StatCard label="FIRMWARE" value={firmwareLabel(sdk.glassesStatus)} sub={firmwareSubLabel(sdk.glassesStatus)} subColor={colors.greenAccent} />
        <StatCard label="WI-FI" value={wifiLabel(sdk.glassesStatus)} sub={wifiSubLabel(sdk.glassesStatus)} subColor={colors.muted} bold />
        <StatCard label="RSSI" value={rssiLabel(sdk.glassesStatus)} sub={rssiUpdatedLabel(sdk.glassesStatus)} subColor={colors.greenAccent} bold />
      </View>

      {/* Quick actions */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.bigCard}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Quick actions</Text>
          <Text style={styles.cardEyebrow}>SDK</Text>
        </View>
        <ScanModelPicker sdk={sdk} connected={connected} />
        <TargetPicker sdk={sdk} connected={connected} />
        <View style={{ gap: 8 }}>
          <View style={styles.btnRow}>
            <Pressable disabled={connected} style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, connected && styles.disabled, { backgroundColor: '#0E2C1A' }]} onPress={sdk.startScan}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Circle cx={11} cy={11} r={7} /><Path d="m21 21-3.5-3.5" />
              </Svg>
              <Text style={styles.btnTextLight}>Scan</Text>
            </Pressable>
            <Pressable disabled={!canConnect} style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, !canConnect && styles.disabled, { backgroundColor: colors.greenPrimary }]} onPress={sdk.connect}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M9 17H5a3 3 0 0 1 0-6h4" /><Path d="M15 7h4a3 3 0 0 1 0 6h-4" /><Line x1={8} y1={14} x2={16} y2={14} />
              </Svg>
              <Text style={styles.btnTextLight}>{connected ? 'Connected' : 'Connect'}</Text>
            </Pressable>
          </View>
          <View style={styles.btnRow}>
            <Pressable disabled={!displaySupported} style={({ pressed }) => [styles.btnLight, pressed && styles.btnPressed, !displaySupported && styles.disabled]} onPress={sdk.displayHello}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.inkAlt} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Rect x={2} y={4} width={20} height={14} rx={2} /><Path d="M8 22h8" /><Path d="M12 18v4" />
              </Svg>
              <Text style={styles.btnTextDark}>Display Hello</Text>
            </Pressable>
            <Pressable disabled={!displaySupported} style={({ pressed }) => [styles.btnLight, pressed && styles.btnPressed, !displaySupported && styles.disabled]} onPress={sdk.clearDisplay}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.inkAlt} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Rect x={2} y={4} width={20} height={14} rx={2} /><Line x1={2} y1={11} x2={22} y2={11} />
              </Svg>
              <Text style={styles.btnTextDark}>Clear Display</Text>
            </Pressable>
          </View>
          <View style={styles.btnRow}>
            <Pressable disabled={!hasDefaultTarget} style={({ pressed }) => [styles.btnLight, pressed && styles.btnPressed, !hasDefaultTarget && styles.disabled]} onPress={sdk.clearDefaultDevice}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.inkAlt} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M3 6h18" /><Path d="M8 6V4h8v2" /><Path d="M19 6l-1 14H6L5 6" />
              </Svg>
              <Text style={styles.btnTextDark}>Clear Default</Text>
            </Pressable>
            <Pressable disabled={!connected} onPress={sdk.disconnect} style={[styles.btnHalf, !connected && styles.disabled]}>
              <LinearGradient colors={['#DE3A30', '#C43B30']} style={[styles.btn, { borderRadius: 18 }]}>
                <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M9 17H5a3 3 0 0 1 0-6h2" /><Path d="M17 7h2a3 3 0 0 1 3 3" /><Line x1={2} y1={2} x2={22} y2={22} />
                </Svg>
                <Text style={styles.btnTextLight}>Disconnect</Text>
              </LinearGradient>
            </Pressable>
          </View>
          {connected && !displaySupported ? (
            <Text style={styles.quickNote}>
              {modelLabel(sdk.glassesStatus)} has no display, so display commands are disabled.
            </Text>
          ) : null}
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
          <StatusRow label="TARGET" value={connectionTargetLabel(sdk)} mono />
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

function hasConnectionTarget(sdk: MentraSdkModel) {
  if (sdk.selectedDiscoveredDevice) {
    return true;
  }
  if (sdk.discoveredDevices.length > 0) {
    return false;
  }
  return Boolean(sdk.defaultDevice || savedConnectionTargetName(sdk.bluetoothStatus));
}

function connectionTargetLabel(sdk: MentraSdkModel) {
  if (isGlassesConnected(sdk.glassesStatus)) {
    return deviceLabel(sdk.glassesStatus);
  }
  if (sdk.selectedDiscoveredDevice) {
    return sdk.selectedDiscoveredDevice.name;
  }
  if (sdk.discoveredDevices.length > 0) {
    return 'Choose a discovered device';
  }
  return savedConnectionTargetName(sdk.bluetoothStatus) ?? sdk.defaultDevice?.name ?? 'Scan required';
}

function savedConnectionTargetName(values: Record<string, unknown>) {
  const name = values.device_name;
  return typeof name === 'string' && name.length > 0 ? name : null;
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

function ScanModelPicker({ sdk, connected }: { sdk: MentraSdkModel; connected: boolean }) {
  return (
    <View style={styles.scanModelPicker}>
      <View style={styles.targetHeader}>
        <Text style={styles.targetEyebrow}>SCAN MODEL</Text>
        {connected ? (
          <Text style={styles.targetSummaryMuted}>Disconnect to change</Text>
        ) : null}
      </View>
      <View style={styles.scanModelRow}>
        {SCAN_MODELS.map((model) => (
          <ScanModelChip
            key={model}
            active={sdk.selectedScanModel === model}
            enabled={!connected}
            model={model}
            onPress={() => sdk.selectScanModel(model)}
          />
        ))}
      </View>
    </View>
  );
}

function ScanModelChip({
  active,
  enabled,
  model,
  onPress,
}: {
  active: boolean;
  enabled: boolean;
  model: ScanModel;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.scanModelChip,
        active ? styles.scanModelChipActive : styles.scanModelChipIdle,
        pressed && styles.btnPressed,
        !enabled && styles.disabled,
      ]}>
      <Text style={[styles.scanModelText, active ? styles.scanModelTextActive : styles.scanModelTextIdle]}>
        {scanModelLabel(model)}
      </Text>
    </Pressable>
  );
}

function TargetPicker({ sdk, connected }: { sdk: MentraSdkModel; connected: boolean }) {
  const selectedKey = sdk.selectedDiscoveredDevice
    ? discoveredDeviceKey(sdk.selectedDiscoveredDevice)
    : null;
  const savedName = savedConnectionTargetName(sdk.bluetoothStatus) ?? sdk.defaultDevice?.name;

  return (
    <View style={styles.targetPicker}>
      <View style={styles.targetHeader}>
        <Text style={styles.targetEyebrow}>{connected ? 'CONNECTED DEVICE' : 'CONNECTION TARGET'}</Text>
        {!connected && sdk.discoveredDevices.length > 0 ? (
          <Text style={styles.targetSummary}>
            {selectedKey ? `${sdk.discoveredDevices.length} found` : 'choose one'}
          </Text>
        ) : null}
      </View>

      {connected ? (
        <TargetDeviceRow
          name={deviceLabel(sdk.glassesStatus)}
          detail="Active BLE connection"
          selected
          enabled={false}
        />
      ) : sdk.discoveredDevices.length === 0 && savedName ? (
        <TargetDeviceRow
          name={savedName}
          detail={savedConnectionTargetDetail(sdk)}
          selected
          enabled={false}
        />
      ) : sdk.discoveredDevices.length === 0 ? (
        <TargetDeviceRow
          name="Scan required"
          detail="No saved default target yet. Scan to choose nearby glasses."
          selected={false}
          enabled={false}
        />
      ) : (
        sdk.discoveredDevices.map((device) => (
          <TargetDeviceRow
            key={discoveredDeviceKey(device)}
            name={device.name}
            detail={targetDeviceDetail(device)}
            selected={selectedKey === discoveredDeviceKey(device)}
            enabled
            onPress={() => sdk.selectDiscoveredDevice(device)}
          />
        ))
      )}
    </View>
  );
}

function TargetDeviceRow({
  detail,
  enabled,
  name,
  onPress,
  selected,
}: {
  detail: string;
  enabled: boolean;
  name: string;
  onPress?: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.targetRow,
        selected ? styles.targetRowSelected : styles.targetRowIdle,
        pressed && styles.btnPressed,
        !enabled && styles.targetRowDisabled,
      ]}>
      <View style={[styles.targetCheck, selected && styles.targetCheckSelected]}>
        {selected ? (
          <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <Path d="m5 12 4 4 10-10" />
          </Svg>
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.targetName}>{name}</Text>
        <Text style={styles.targetDetail}>{detail}</Text>
      </View>
    </Pressable>
  );
}

function targetDeviceDetail(device: MentraSdkModel['discoveredDevices'][number]) {
  return device.address
    ? `${device.model} · ${device.address}`
    : device.model;
}

function savedConnectionTargetDetail(sdk: MentraSdkModel) {
  const model = stringValue(sdk.bluetoothStatus, 'default_wearable') ?? sdk.defaultDevice?.model ?? 'Saved model';
  return `${model} · BluetoothSdk.connectDefault()`;
}

function discoveredDeviceKey(device: MentraSdkModel['discoveredDevices'][number]) {
  return device.id;
}

function stringValue(values: Record<string, unknown>, key: string) {
  const value = values[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
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
  targetPicker: { backgroundColor: 'rgba(14,14,16,0.035)', borderRadius: 18, padding: 12, gap: 8 },
  targetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  targetEyebrow: { color: 'rgba(14,14,16,0.45)', fontSize: 10, fontWeight: '600', letterSpacing: 1.4, fontFamily: 'Courier' },
  targetSummary: { color: colors.greenInk, fontSize: 10, fontWeight: '600' },
  targetSummaryMuted: { color: colors.muted, fontSize: 10, fontWeight: '600' },
  scanModelPicker: { gap: 8 },
  scanModelRow: { flexDirection: 'row', gap: 8 },
  scanModelChip: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  scanModelChipActive: {
    backgroundColor: 'rgba(22,163,74,0.10)',
    borderColor: 'rgba(22,163,74,0.32)',
  },
  scanModelChipIdle: {
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderColor: colors.hairline,
  },
  scanModelText: { fontSize: 12, fontWeight: '700' },
  scanModelTextActive: { color: colors.greenInk },
  scanModelTextIdle: { color: colors.muted },
  targetRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9, gap: 10 },
  targetRowIdle: { backgroundColor: 'rgba(255,255,255,0.7)', borderColor: 'rgba(255,255,255,0.7)' },
  targetRowSelected: { backgroundColor: 'rgba(22,163,74,0.08)', borderColor: 'rgba(22,163,74,0.18)' },
  targetRowDisabled: { opacity: 1 },
  targetCheck: { width: 18, height: 18, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: colors.borderSoft },
  targetCheckSelected: { backgroundColor: colors.greenPrimary },
  targetName: { color: colors.inkAlt, fontSize: 13, fontWeight: '700' },
  targetDetail: { color: colors.muted, fontSize: 10, fontWeight: '500' },
  btnRow: { flexDirection: 'row', gap: 8 },
  quickNote: { color: colors.muted, fontSize: 11, fontWeight: '500', lineHeight: 15 },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, gap: 8 },
  btnHalf: { flex: 1 },
  btnFull: { flex: 0, alignSelf: 'stretch' },
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
