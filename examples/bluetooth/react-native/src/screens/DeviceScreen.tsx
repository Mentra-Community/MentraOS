import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { Header } from '../components/Header';
import { OfflineNotice } from '../components/OfflineNotice';
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
  isGlassesWifiConnected,
  latestEventLabel,
  modelLabel,
  rssiLabel,
  rssiUpdatedLabel,
  supportsDisplay,
  wifiLabel,
  wifiSubLabel,
} from '../sdkFormat';
import { SCAN_MODELS, scanModelLabel, type BluetoothSdkExampleModel, type ScanModel } from '../useBluetoothSdkExample';

const glassesImages = {
  evenRealitiesG1: require('../../assets/glasses/even_realities_g1.png'),
  evenRealitiesG2: require('../../assets/glasses/even_realities_g2.png'),
  mentraDisplay: require('../../assets/glasses/mentra_display.png'),
  mentraLive: require('../../assets/glasses/mentra_live.png'),
  unknownWearable: require('../../assets/glasses/unknown_wearable.png'),
  vuzixZ100: require('../../assets/glasses/vuzix_z100.png'),
};

export function DeviceScreen({ sdk }: { sdk: BluetoothSdkExampleModel }) {
  const scrollBottomPadding = useScrollBottomPadding();
  const level = batteryLevel(sdk.glasses);
  const connected = isGlassesConnected(sdk.glasses);
  const charging = sdk.glasses.connected && sdk.glasses.battery.charging;
  const canConnect = !connected && hasConnectionTarget(sdk);
  const hasDefaultTarget = Boolean(sdk.defaultDevice);
  const displaySupported = connected && supportsDisplay(sdk.glasses);
  const glassesWifiConnected = isGlassesWifiConnected(sdk.glasses);
  const otaWifiRequired = connected && !glassesWifiConnected;
  const otaInProgress = isOtaInProgress(sdk);
  const canCheckOta = connected && glassesWifiConnected && !otaInProgress;
  const connection = connectionLabel(sdk.glasses);
  const latestEvent = sdk.events[0];

  return (
    <ScrollView
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: scrollBottomPadding }}>
      <Header title="Device" />

      {connected ? (
        <>
          {/* Hero card */}
          <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.heroCard}>
            <View style={styles.heroTop}>
              <View style={{ gap: 4 }}>
                <Text style={styles.eyebrowGreen}>{connection}</Text>
                <Text style={styles.heroTitle}>{modelLabel(sdk.glasses)}</Text>
                <Text style={styles.heroSub}>{deviceLabel(sdk.glasses)}</Text>
              </View>
              <Image source={glassesImageFor(sdk.glasses)} style={styles.glasses} resizeMode="contain" />
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
                  <Text style={styles.chargingText}>{charging ? 'Charging' : 'Not charging'}</Text>
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
            <StatCard label="FIRMWARE" value={firmwareLabel(sdk.glasses)} sub={firmwareSubLabel(sdk.glasses)} subColor={colors.greenAccent} />
            <StatCard label="WI-FI" value={wifiLabel(sdk.glasses)} sub={wifiSubLabel(sdk.glasses)} subColor={colors.muted} bold />
            <StatCard label="RSSI" value={rssiLabel(sdk.glasses)} sub={rssiUpdatedLabel(sdk.glasses)} subColor={colors.greenAccent} bold />
          </View>
          {(sdk.otaStatus || sdk.otaUpdateAvailable) ? <OtaCard sdk={sdk} /> : null}
          {otaWifiRequired ? (
            <OfflineNotice message="Connect the glasses to Wi-Fi from the System tab before checking or starting OTA updates. OTA downloads run over the glasses network connection." />
          ) : null}
        </>
      ) : null}

      {/* Quick actions */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.bigCard}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>{connected ? 'Quick actions' : 'Connect glasses'}</Text>
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
            <Pressable disabled={!canCheckOta} style={({ pressed }) => [styles.btnLight, pressed && styles.btnPressed, !canCheckOta && styles.disabled]} onPress={sdk.checkForOtaUpdate}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.inkAlt} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M21 12a9 9 0 0 1-15.5 6.2" /><Path d="M3 12a9 9 0 0 1 15.5-6.2" /><Path d="M18 2v4h-4" /><Path d="M6 22v-4h4" />
              </Svg>
              <Text style={styles.btnTextDark}>{connected && !glassesWifiConnected ? 'Connect Wi-Fi' : 'Check OTA'}</Text>
            </Pressable>
            <Pressable disabled={!canStartOta(sdk)} style={({ pressed }) => [styles.btnLight, pressed && styles.btnPressed, !canStartOta(sdk) && styles.disabled]} onPress={sdk.startOtaUpdate}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.inkAlt} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M12 3v12" /><Path d="m7 10 5 5 5-5" /><Path d="M5 21h14" />
              </Svg>
              <Text style={styles.btnTextDark}>Start OTA</Text>
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
              {modelLabel(sdk.glasses)} has no display, so display commands are disabled.
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
          <StatusRow label="LAST ACTION" value={sdk.lastAction} selectable />
          <StatusRow label="CONNECTION" custom={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: colors.greenPrimary }} />
            <Text style={[styles.statusValue, { color: colors.greenInk, fontWeight: '600' }]}>{connection}</Text>
          </View>} />
          <StatusRow label="TARGET" value={connectionTargetLabel(sdk)} mono />
          <StatusRow label="DEVICE" value={deviceLabel(sdk.glasses)} mono />
          <StatusRow label="BATTERY" custom={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[styles.statusValue, { fontWeight: '600' }]}>{batteryLabel(sdk.glasses)}</Text>
            {charging ? <View style={styles.chargingPill}>
              <Svg width={10} height={10} viewBox="0 0 24 24"><Path d="M13 2 4.09 12.97a1 1 0 0 0 .77 1.63H10v7l8.91-10.97a1 1 0 0 0-.77-1.63H13z" fill={colors.greenPrimary} /></Svg>
              <Text style={styles.chargingPillText}>charging</Text>
            </View> : null}
          </View>} />
          <StatusRow label="BLUETOOTH" value={bluetoothSearchLabel(sdk.phone, sdk.discoveredDevices.length)} />
          <StatusRow label="DISCOVERED" value={discoveredLabel(sdk.discoveredDevices)} mono />
          <StatusRow label="PERMISSIONS" value={sdk.permissionStatus} />
          <StatusRow label="CAMERA" value={sdk.cameraStatus} />
          <StatusRow label="OTA" value={otaStatusLine(sdk)} />
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

function hasConnectionTarget(sdk: BluetoothSdkExampleModel) {
  if (sdk.selectedDiscoveredDevice) {
    return true;
  }
  if (sdk.discoveredDevices.length > 0) {
    return false;
  }
  return Boolean(sdk.defaultDevice);
}

function connectionTargetLabel(sdk: BluetoothSdkExampleModel) {
  if (isGlassesConnected(sdk.glasses)) {
    return deviceLabel(sdk.glasses);
  }
  if (sdk.selectedDiscoveredDevice) {
    return sdk.selectedDiscoveredDevice.name;
  }
  if (sdk.discoveredDevices.length > 0) {
    return 'Choose a discovered device';
  }
  return sdk.defaultDevice?.name ?? 'Scan required';
}

function glassesImageFor(status: BluetoothSdkExampleModel['glasses']) {
  const model = status.connected
    ? [status.device.deviceModel, status.device.bluetoothName].filter(Boolean).join(' ').toLowerCase()
    : '';

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

function canStartOta(sdk: BluetoothSdkExampleModel) {
  if (!isGlassesConnected(sdk.glasses) || !isGlassesWifiConnected(sdk.glasses)) {
    return false;
  }
  return sdk.otaUpdateAvailable && !isOtaInProgress(sdk);
}

function isOtaInProgress(sdk: BluetoothSdkExampleModel) {
  return sdk.otaStatus?.status === 'in_progress' || sdk.otaStatus?.status === 'step_complete';
}

function otaStatusLine(sdk: BluetoothSdkExampleModel) {
  if (sdk.otaStatus) {
    return `${sdk.otaStatus.status.replace(/_/g, ' ')} · ${otaDisplayPercent(sdk)}%`;
  }
  if (sdk.otaUpdateAvailable) {
    return 'Update required';
  }
  if (sdk.otaStatusMessage) {
    return sdk.otaStatusMessage;
  }
  return isGlassesConnected(sdk.glasses) ? 'Check not run' : 'Connect glasses';
}

function otaCardTitle(sdk: BluetoothSdkExampleModel) {
  if (sdk.otaStatus?.status === 'failed') {
    return 'Update failed';
  }
  if (sdk.otaStatus && isOtaInProgress(sdk)) {
    return `Updating ${sdk.otaStatus.step_type || 'firmware'}`;
  }
  if (sdk.otaUpdateAvailable) {
    return 'Update required';
  }
  return 'OTA status';
}

function otaCardDetail(sdk: BluetoothSdkExampleModel) {
  if (sdk.otaStatus?.error_message) {
    return sdk.otaStatus.error_message;
  }
  if (sdk.otaStatus) {
    return `${sdk.otaStatus.phase || 'status'} · step ${sdk.otaStatus.current_step}/${sdk.otaStatus.total_steps}`;
  }
  if (sdk.otaUpdateAvailable) {
    return 'Update your glasses before continuing. This example app may not work properly until the glasses firmware is current.';
  }
  return 'Tap Check OTA to compare the current glasses version with the SDK OTA manifest.';
}

function otaDisplayPercent(sdk: BluetoothSdkExampleModel) {
  return sdk.otaDisplayPercent ?? sdk.otaStatus?.overall_percent ?? 0;
}

function OtaCard({ sdk }: { sdk: BluetoothSdkExampleModel }) {
  if (!sdk.otaStatus && !sdk.otaUpdateAvailable) {
    return null;
  }
  const percent = otaDisplayPercent(sdk);
  const updateRequired = sdk.otaUpdateAvailable && !sdk.otaStatus;
  return (
    <LinearGradient
      colors={updateRequired ? ['#FFF5DF', '#FFE6E1'] : ['#fff', '#fff']}
      style={[styles.otaCard, updateRequired && styles.otaCardRequired]}>
      <View style={styles.otaHead}>
        <View style={styles.otaTitleRow}>
          {updateRequired ? (
            <View style={styles.otaWarningIcon}>
              <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                <Path d="m21.7 18.6-8.3-14a1.6 1.6 0 0 0-2.8 0l-8.3 14A1.6 1.6 0 0 0 3.7 21h16.6a1.6 1.6 0 0 0 1.4-2.4Z" />
                <Path d="M12 8v5" />
                <Path d="M12 17h.01" />
              </Svg>
            </View>
          ) : null}
          <View style={{ flex: 1 }}>
            <Text style={[styles.otaEyebrow, updateRequired && styles.otaEyebrowRequired]}>
              {updateRequired ? 'ACTION NEEDED' : 'OTA'}
            </Text>
            <Text style={[styles.otaTitle, updateRequired && styles.otaTitleRequired]}>{otaCardTitle(sdk)}</Text>
          </View>
        </View>
        {sdk.otaStatus ? <Text style={styles.otaPercent}>{percent}%</Text> : null}
      </View>
      {sdk.otaStatus ? (
        <View style={styles.otaTrack}>
          <View style={[styles.otaFill, { width: `${Math.max(0, Math.min(percent, 100))}%` }]} />
        </View>
      ) : null}
      <Text style={[styles.otaDetail, updateRequired && styles.otaDetailRequired]}>{otaCardDetail(sdk)}</Text>
      {updateRequired ? (
        <Pressable
          disabled={!canStartOta(sdk)}
          onPress={sdk.startOtaUpdate}
          style={({ pressed }) => [
            styles.otaStartButton,
            pressed && styles.btnPressed,
            !canStartOta(sdk) && styles.otaStartButtonDisabled,
          ]}>
          <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M12 3v12" />
            <Path d="m7 10 5 5 5-5" />
            <Path d="M5 21h14" />
          </Svg>
          <Text style={styles.otaStartButtonText}>{canStartOta(sdk) ? 'Start OTA' : 'Connect Wi-Fi first'}</Text>
        </Pressable>
      ) : null}
    </LinearGradient>
  );
}

function ScanModelPicker({ sdk, connected }: { sdk: BluetoothSdkExampleModel; connected: boolean }) {
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

function TargetPicker({ sdk, connected }: { sdk: BluetoothSdkExampleModel; connected: boolean }) {
  const selectedKey = sdk.selectedDiscoveredDevice
    ? discoveredDeviceKey(sdk.selectedDiscoveredDevice)
    : null;
  const savedName = sdk.defaultDevice?.name;
  const scanning = !connected && sdk.scanActive;

  return (
    <View style={styles.targetPicker}>
      <View style={styles.targetHeader}>
        <Text style={styles.targetEyebrow}>{connected ? 'CONNECTED DEVICE' : 'CONNECTION TARGET'}</Text>
        {!connected && sdk.discoveredDevices.length > 0 ? (
          <Text style={styles.targetSummary}>
            {selectedKey ? `${sdk.discoveredDevices.length} found` : 'choose one'}
          </Text>
        ) : scanning ? (
          <Text style={styles.targetSummaryMuted}>scanning</Text>
        ) : null}
      </View>

      {connected ? (
        <TargetDeviceRow
          name={deviceLabel(sdk.glasses)}
          detail="Active BLE connection"
          selected
          enabled={false}
        />
      ) : scanning && sdk.discoveredDevices.length === 0 ? (
        <TargetDeviceRow
          name="Scanning..."
          detail={`Looking for ${scanModelLabel(sdk.selectedScanModel)} glasses.`}
          selected={false}
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

function targetDeviceDetail(device: BluetoothSdkExampleModel['discoveredDevices'][number]) {
  return device.address
    ? `${device.model} · ${device.address}`
    : device.model;
}

function savedConnectionTargetDetail(sdk: BluetoothSdkExampleModel) {
  const model = sdk.defaultDevice?.model ?? 'Saved model';
  return `${model} · BluetoothSdk.connectDefault()`;
}

function discoveredDeviceKey(device: BluetoothSdkExampleModel['discoveredDevices'][number]) {
  return device.id;
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

function StatusRow({
  label,
  value,
  custom,
  mono,
  last,
  selectable,
}: {
  label: string;
  value?: string;
  custom?: React.ReactNode;
  mono?: boolean;
  last?: boolean;
  selectable?: boolean;
}) {
  return (
    <View style={[styles.statusRow, !last && styles.statusBorder]}>
      <Text style={styles.statusLabel}>{label}</Text>
      <View style={{ flex: 1 }}>
        {custom ?? <Text selectable={selectable} style={[styles.statusValue, mono && { fontFamily: 'Courier' }]}>{value}</Text>}
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
  heroSub: { color: colors.muted, fontSize: 12, fontWeight: '500' },
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
  otaCard: { marginHorizontal: 16, marginTop: 10, padding: 14, borderRadius: 16, backgroundColor: '#fff', borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)', shadowColor: '#0F2A1D', shadowOpacity: 0.06, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, gap: 0 },
  otaCardRequired: { borderColor: 'rgba(255,59,48,0.34)', shadowColor: '#FF3B30', shadowOpacity: 0.18, shadowRadius: 22, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  otaHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  otaTitleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  otaWarningIcon: { width: 34, height: 34, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.red },
  otaEyebrow: { color: colors.muted, fontSize: 10, fontWeight: '600', letterSpacing: 1.1, fontFamily: 'Courier' },
  otaEyebrowRequired: { color: colors.red, fontWeight: '800' },
  otaTitle: { color: colors.ink, fontSize: 15, fontWeight: '700', marginTop: 3 },
  otaTitleRequired: { color: colors.inkAlt, fontSize: 19, fontWeight: '900' },
  otaPercent: { color: colors.greenInk, fontSize: 20, fontWeight: '800' },
  otaTrack: { height: 6, borderRadius: 999, overflow: 'hidden', backgroundColor: 'rgba(14,44,26,0.08)', marginTop: 12 },
  otaFill: { height: 6, borderRadius: 999, backgroundColor: colors.greenPrimary },
  otaDetail: { color: colors.muted, fontSize: 12, fontWeight: '500', lineHeight: 16, marginTop: 9 },
  otaDetailRequired: { color: '#5F201B', fontSize: 13, fontWeight: '700', lineHeight: 18, marginTop: 11 },
  otaStartButton: { marginTop: 13, minHeight: 48, borderRadius: 14, backgroundColor: colors.red, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  otaStartButtonDisabled: { backgroundColor: 'rgba(95,32,27,0.36)' },
  otaStartButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
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
  statLabel: { color: colors.muted, fontSize: 10, fontWeight: '600', letterSpacing: 1.1 },
  statValue: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  statSub: { fontSize: 12, fontWeight: '500' },
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
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    minHeight: 44,
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
  scanModelText: { fontSize: 13, fontWeight: '700' },
  scanModelTextActive: { color: colors.greenInk },
  scanModelTextIdle: { color: colors.muted },
  targetRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  targetRowIdle: { backgroundColor: 'rgba(255,255,255,0.7)', borderColor: 'rgba(255,255,255,0.7)' },
  targetRowSelected: { backgroundColor: 'rgba(22,163,74,0.08)', borderColor: 'rgba(22,163,74,0.18)' },
  targetRowDisabled: { opacity: 1 },
  targetCheck: { width: 18, height: 18, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: colors.borderSoft },
  targetCheckSelected: { backgroundColor: colors.greenPrimary },
  targetName: { color: colors.inkAlt, fontSize: 14, fontWeight: '700' },
  targetDetail: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  btnRow: { flexDirection: 'row', gap: 8 },
  quickNote: { color: colors.muted, fontSize: 12, fontWeight: '500', lineHeight: 16 },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 14, gap: 8 },
  btnHalf: { flex: 1 },
  btnFull: { flex: 0, alignSelf: 'stretch' },
  btnPressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.45 },
  btnLight: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 14, gap: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#DBDBDB' },
  btnTextLight: { color: '#fff', fontSize: 14, fontWeight: '600' },
  btnTextDark: { color: colors.inkAlt, fontSize: 14, fontWeight: '600' },
  recPill: { backgroundColor: 'rgba(14,44,26,0.06)', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  recText: { color: colors.greenInk, fontSize: 10, fontWeight: '600', letterSpacing: 1.6, fontFamily: 'Courier' },
  statusRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 11, gap: 14 },
  statusBorder: { borderTopWidth: 1, borderColor: '#F2EDE0' },
  statusLabel: { width: 90, color: 'rgba(14,14,16,0.5)', fontSize: 10, fontWeight: '600', letterSpacing: 1.4, fontFamily: 'Courier' },
  statusValue: { color: colors.inkAlt, fontSize: 14, fontWeight: '500' },
  chargingPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(22,163,74,0.08)', paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999 },
  chargingPillText: { color: colors.greenPrimary, fontSize: 11, fontWeight: '600' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(22,163,74,0.08)', paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6 },
  liveText: { color: colors.greenPrimary, fontSize: 10, fontWeight: '600', letterSpacing: 0.6, fontFamily: 'Courier' },
  timeFaint: { color: 'rgba(14,14,16,0.65)', fontSize: 11, fontFamily: 'Courier' },
});
