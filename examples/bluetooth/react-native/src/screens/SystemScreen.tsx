import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Modal,
  TextInput,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';
import { Header } from '../components/Header';
import { useScrollBottomPadding } from '../components/keyboardLayout';
import { OfflineNotice } from '../components/OfflineNotice';
import { colors } from '../components/theme';
import {
  connectedWifiStatus,
  galleryHotspotPasswordLabel,
  galleryHotspotSsidLabel,
  galleryServerUrl,
  hotspotLabel,
  isGlassesConnected,
  wifiLabel,
  wifiSubLabel,
} from '../sdkFormat';
import { RGB_LED_COLORS, durationText, type LedColor, type LedMode, type BluetoothSdkExampleModel, type SdkConsoleEvent } from '../useBluetoothSdkExample';

const WIFI_COLLAPSED_NETWORK_LIMIT = 3;

export function SystemScreen({ sdk }: { sdk: BluetoothSdkExampleModel }) {
  const scrollBottomPadding = useScrollBottomPadding();
  const connected = isGlassesConnected(sdk.glasses);
  const currentWifi = connectedWifiStatus(sdk.glasses);
  const networks = (sdk.phone.wifiScanResults ?? []).filter(
    (network) => !connected || !currentWifi || network.ssid !== currentWifi.ssid,
  );
  const galleryUrl = galleryServerUrl(sdk.glasses, sdk.hotspotEnabled);
  const galleryHotspotPassword = galleryUrl ? galleryHotspotPasswordLabel(sdk.glasses) : null;
  const inputChips = recentInputChips(sdk.events);
  const [pendingWifi, setPendingWifi] = useState<{ssid: string; requiresPassword: boolean} | null>(null);
  const [pendingWifiPassword, setPendingWifiPassword] = useState('');
  const [wifiExpanded, setWifiExpanded] = useState(false);
  const didAutoScanWifi = useRef(false);
  const visibleNetworks = wifiExpanded ? networks : networks.slice(0, WIFI_COLLAPSED_NETWORK_LIMIT);
  const hiddenNetworkCount = Math.max(0, networks.length - visibleNetworks.length);
  const canToggleWifiList = networks.length > WIFI_COLLAPSED_NETWORK_LIMIT;
  const micStatus = sdk.micRecording
    ? recordingMicStatus(sdk)
    : sdk.micPlaying
      ? 'playing last recording'
      : sdk.lastMicDurationSeconds !== null && sdk.lastMicBytes > 0
        ? `last ${durationText(sdk.lastMicDurationSeconds)} · ${formatPcmBytes(sdk.lastMicBytes)}`
        : connected
          ? 'record PCM from glasses'
          : 'connect glasses to record';

  useEffect(() => {
    if (!connected) {
      didAutoScanWifi.current = false;
      return;
    }
    if (didAutoScanWifi.current) {
      return;
    }
    didAutoScanWifi.current = true;
    void sdk.requestWifiScan();
  }, [connected, sdk]);

  return (
    <ScrollView
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: scrollBottomPadding }}>
      <Header title="System" />
      {!connected && <OfflineNotice />}

      {/* Wi-Fi card */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.bigCard}>
        <View style={styles.wifiHeader}>
          <View>
            <Text style={styles.wifiTitle}>Wi-Fi</Text>
            <Text style={styles.wifiSub}>{networks.length} networks nearby</Text>
          </View>
          <Pressable
            disabled={!connected}
            style={[styles.scanBtn, !connected && styles.disabled]}
            onPress={sdk.requestWifiScan}>
            <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
              <Polyline points="23 4 23 10 17 10" />
              <Path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </Svg>
            <Text style={styles.scanText}>Scan</Text>
          </Pressable>
        </View>
        {currentWifi ? (
          <NetworkRow
            actionLabel="Forget"
            actionColor={colors.red}
            check
            name={wifiLabel(sdk.glasses)}
            onActionPress={sdk.forgetCurrentWifiNetwork}
            sub={wifiSubLabel(sdk.glasses)}
            subColor={colors.greenAccent}
          />
        ) : null}
        {visibleNetworks.map((network, index) => {
          const joinNetwork = () => {
            if (network.requiresPassword) {
              setPendingWifi({ssid: network.ssid, requiresPassword: true});
              setPendingWifiPassword('');
            } else {
              void sdk.sendWifiCredentials(network.ssid, '', false);
            }
          };

          return (
            <NetworkRow
              key={`${network.ssid}-${index}`}
              actionColor={colors.greenDeep}
              actionLabel="Join"
              name={network.ssid}
              sub={`${network.requiresPassword ? 'secured' : 'open'} · ${network.signalStrength ?? 0}`}
              subColor={colors.muted}
              faint
              locked={network.requiresPassword}
              last={index === visibleNetworks.length - 1 && !canToggleWifiList}
              disabled={!connected}
              onActionPress={joinNetwork}
              onPress={joinNetwork}
            />
          );
        })}
        {canToggleWifiList ? (
          <Pressable style={styles.wifiExpandRow} onPress={() => setWifiExpanded((expanded) => !expanded)}>
            <Text style={styles.wifiExpandText}>
              {wifiExpanded ? 'Show fewer networks' : `Show ${hiddenNetworkCount} more network${hiddenNetworkCount === 1 ? '' : 's'}`}
            </Text>
            <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.greenInk} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
              <Path d={wifiExpanded ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} />
            </Svg>
          </Pressable>
        ) : null}
      </LinearGradient>

      {/* Hotspot */}
      <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.hotspotCard}>
        <View style={styles.tileHead}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={styles.iconTileSm}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.greenInk} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Circle cx={12} cy={12} r={2} />
                <Path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.48" />
              </Svg>
            </View>
            <View>
              <Text style={styles.tileTitle}>Hotspot</Text>
              <Text style={[styles.tileSub, { color: sdk.hotspotEnabled ? colors.greenAccent : colors.muted }]}>
                {connected ? hotspotLabel(sdk.glasses, sdk.hotspotEnabled) : 'connect glasses to toggle'}
              </Text>
            </View>
          </View>
          <Pressable
            disabled={!connected}
            hitSlop={10}
            onPress={sdk.toggleHotspot}
            style={[
              styles.toggleOn,
              { borderColor: sdk.hotspotEnabled ? 'rgba(52,199,89,0.72)' : 'rgba(15,42,29,0.18)' },
              !connected && styles.disabled,
            ]}>
            <View style={[styles.toggleKnob, !sdk.hotspotEnabled && { backgroundColor: colors.mutedSoft, alignSelf: 'flex-start' }]} />
          </Pressable>
        </View>
        <View style={styles.hotspotDivider} />
        <View style={styles.hotspotGalleryRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.hotspotGalleryTitle}>Gallery server</Text>
            <Text style={[styles.hotspotGalleryUrl, { color: galleryUrl ? colors.greenAccent : colors.muted }]}>
              {galleryUrl ?? 'Enable hotspot to expose local gallery access'}
            </Text>
            {galleryHotspotPassword ? (
              <Text style={styles.hotspotGalleryHint}>
                Join {galleryHotspotSsidLabel(sdk.glasses)} · password {galleryHotspotPassword}
              </Text>
            ) : null}
          </View>
          <View style={styles.hotspotActions}>
            <View style={styles.hotspotActionRow}>
              <HotspotActionChip enabled={galleryUrl !== null} label="Open" onPress={sdk.openGalleryServer} />
              <HotspotActionChip enabled={galleryUrl !== null} label="Wi-Fi" onPress={sdk.openWifiSettings} />
            </View>
            <View style={styles.hotspotActionRow}>
              <HotspotActionChip enabled={galleryUrl !== null} label="Copy URL" onPress={sdk.copyGalleryServerUrl} />
              <HotspotActionChip enabled={galleryHotspotPassword !== null} label="Copy pwd" onPress={sdk.copyGalleryHotspotPassword} />
            </View>
          </View>
        </View>
        <Text
          style={[
            styles.hotspotStatus,
            {
              color:
                sdk.galleryServerReachable === true
                  ? colors.greenAccent
                  : sdk.galleryServerReachable === false
                    ? colors.red
                    : colors.muted,
            },
          ]}>
          {sdk.galleryServerStatus}
        </Text>
      </LinearGradient>

      {/* Microphone */}
      <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={[styles.micCard, !connected && styles.disabled]}>
        <View style={styles.tileHead}>
          <View style={styles.iconTileSm}>
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.greenInk} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            </Svg>
          </View>
          <View style={styles.micControls}>
            <MicControlButton disabled={!connected} active={sdk.micRecording} onPress={sdk.toggleMic}>
              {sdk.micRecording ? <StopIcon active /> : <RecordIcon />}
            </MicControlButton>
            <MicControlButton disabled={sdk.lastMicBytes <= 0 || sdk.micRecording} active={sdk.micPlaying} onPress={sdk.playMicRecording}>
              {sdk.micPlaying ? <StopIcon active /> : <PlayIcon />}
            </MicControlButton>
          </View>
        </View>
        <View>
          <Text style={styles.tileTitle}>Microphone</Text>
          <Text style={[styles.tileSub, { color: sdk.micRecording || sdk.micPlaying ? colors.greenAccent : colors.muted }]}>{micStatus}</Text>
          <Text style={styles.micRouteText}>{sdk.micAudioRouteStatus}</Text>
          <Pressable style={styles.micSettingsButton} onPress={sdk.openBluetoothSettings}>
            <Text style={styles.micSettingsText}>Audio setup</Text>
          </Pressable>
          {sdk.micPlaybackHint ? <Text style={styles.micWarning}>{sdk.micPlaybackHint}</Text> : null}
        </View>
      </LinearGradient>

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
          {inputChips.map((item) => (
            <InputChip key={`${item.age}-${item.label}`} prefix={item.age} label={item.label} />
          ))}
        </View>
        <View style={styles.galleryModeBlock}>
          <Text style={styles.galleryModeTitle}>Save in gallery mode</Text>
          <Text style={styles.galleryModeBody}>
            {sdk.galleryModeAuto
              ? 'On: the glasses button saves photos/videos locally.'
              : 'Off: button and touch events are reported to the phone.'}
          </Text>
          <View style={styles.galleryModeChips}>
            <GalleryModeChip active={sdk.galleryModeAuto} disabled={!connected} label="Save media" onPress={() => sdk.setGalleryModeAuto(true)} />
            <GalleryModeChip active={!sdk.galleryModeAuto} disabled={!connected} label="Report events" onPress={() => sdk.setGalleryModeAuto(false)} />
          </View>
        </View>
      </LinearGradient>

      {/* RGB LED */}
      <LinearGradient colors={['rgba(255,255,255,0.72)', 'rgba(255,255,255,0.5)']} style={styles.bigCard}>
        <View style={styles.tileHead}>
          <View>
            <Text style={styles.ledTitle}>RGB LED</Text>
            <Text style={styles.tileSub}>color & pattern</Text>
          </View>
          <View style={styles.onPill}>
            {sdk.ledMode !== 'Off' && (
              <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: ledSwatchColor(sdk.ledColor) }} />
            )}
            <Text style={styles.onText}>{sdk.ledMode === 'Off' ? 'off' : 'on'}</Text>
          </View>
        </View>
        <View style={styles.ledTabs}>
          <LedTab active={sdk.ledMode === 'Off'} disabled={!connected} onPress={() => sdk.selectLedMode('Off')} icon={<Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Circle cx={12} cy={12} r={9} /><Line x1={6.5} y1={17.5} x2={17.5} y2={6.5} /></Svg>} label="Off" />
          <LedTab active={sdk.ledMode === 'Solid'} disabled={!connected} onPress={() => sdk.selectLedMode('Solid')} icon={<Svg width={18} height={18} viewBox="0 0 24 24"><Circle cx={12} cy={12} r={6} fill={colors.greenInk} /></Svg>} label="Solid" />
          <LedTab active={sdk.ledMode === 'Pulse'} disabled={!connected} onPress={() => sdk.selectLedMode('Pulse')} icon={<Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2}><Circle cx={12} cy={12} r={3} fill={colors.muted} /><Circle cx={12} cy={12} r={6.5} opacity={0.55} /><Circle cx={12} cy={12} r={10} opacity={0.25} /></Svg>} label="Pulse" />
          <LedTab active={sdk.ledMode === 'Blink'} disabled={!connected} onPress={() => sdk.selectLedMode('Blink')} icon={<Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2} strokeDasharray="3 3"><Circle cx={12} cy={12} r={9} /></Svg>} label="Blink" />
        </View>
        <View style={styles.ledColorRow}>
          {RGB_LED_COLORS.map((color) => (
            <LedColorChip
              key={color}
              active={sdk.ledColor === color}
              color={color}
              disabled={!connected}
              onPress={() => sdk.selectLedColor(color)}
            />
          ))}
        </View>
        <Text style={styles.ledNote}>
          Mentra Live RGB controls demonstrate LED color and timing patterns.
        </Text>
      </LinearGradient>

      <Modal
        animationType="fade"
        onRequestClose={() => setPendingWifi(null)}
        transparent
        visible={pendingWifi !== null}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Join Wi-Fi</Text>
            <Text style={styles.modalSub}>{pendingWifi?.ssid}</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setPendingWifiPassword}
              placeholder="Password"
              placeholderTextColor={colors.muted}
              returnKeyType="done"
              secureTextEntry
              style={styles.modalInput}
              value={pendingWifiPassword}
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={() => setPendingWifi(null)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={!pendingWifiPassword}
                style={[styles.modalConfirm, !pendingWifiPassword && styles.disabled]}
                onPress={() => {
                  if (pendingWifi) {
                    void sdk.sendWifiCredentials(pendingWifi.ssid, pendingWifiPassword, pendingWifi.requiresPassword);
                  }
                  setPendingWifi(null);
                  setPendingWifiPassword('');
                }}>
                <Text style={styles.modalConfirmText}>Connect</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function NetworkRow({
  actionColor = colors.ink,
  actionLabel,
  check,
  disabled,
  faint,
  last,
  locked,
  name,
  onActionPress,
  onPress,
  rssi,
  sub,
  subColor,
}: {
  actionColor?: string;
  actionLabel?: string;
  check?: boolean;
  disabled?: boolean;
  faint?: boolean;
  last?: boolean;
  locked?: boolean;
  name: string;
  onActionPress?: () => void;
  onPress?: () => void;
  rssi?: string;
  sub: string;
  subColor: string;
}) {
  return (
    <Pressable disabled={disabled || (!onPress && !onActionPress)} style={[styles.networkRow, !last && styles.networkBorder, disabled && styles.disabled]} onPress={onPress}>
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
      {actionLabel ? (
        <Pressable disabled={!onActionPress} onPress={onActionPress} style={[styles.networkAction, { backgroundColor: `${actionColor}1A` }]}>
          <Text style={[styles.networkActionText, { color: actionColor }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function GalleryModeChip({ active, disabled, label, onPress }: { active: boolean; disabled: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.galleryModeChip, active && styles.galleryModeChipActive, disabled && styles.disabled]}>
      <Text style={[styles.galleryModeChipText, active && styles.galleryModeChipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function HotspotActionChip({ enabled, label, onPress }: { enabled: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable disabled={!enabled} onPress={onPress} style={[styles.hotspotActionChip, !enabled && styles.hotspotActionChipDisabled]}>
      <Text style={[styles.hotspotActionText, !enabled && styles.hotspotActionTextDisabled]}>{label}</Text>
    </Pressable>
  );
}

function InputChip({ prefix, label }: { prefix: string; label: string }) {
  return (
    <View style={styles.inputChip}>
      <Text style={styles.inputChipPrefix}>{prefix}</Text>
      <Text numberOfLines={1} style={styles.inputChipLabel}>{label}</Text>
    </View>
  );
}

function recordingMicStatus(sdk: BluetoothSdkExampleModel) {
  if (sdk.pcmBytes <= 0) {
    return 'recording · listening for speech';
  }
  return `recording · ${formatPcmBytes(sdk.pcmBytes)} captured`;
}

function formatPcmBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B PCM`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib >= 10 ? kib.toFixed(0) : kib.toFixed(1)} KB PCM`;
  }
  const mib = kib / 1024;
  return `${mib >= 10 ? mib.toFixed(0) : mib.toFixed(1)} MB PCM`;
}

function recentInputChips(events: SdkConsoleEvent[]) {
  const labels = events.map((item) => inputLabel(item.text)).filter((label): label is string => Boolean(label)).slice(0, 3);
  if (labels.length === 0) {
    return [{ age: '--', label: 'waiting' }];
  }
  return labels.map((label, index) => ({ age: `${index + 1}s`, label }));
}

function inputLabel(text: string) {
  const normalized = normalizeInputText(text);
  const [prefix, ...payloadParts] = normalized.split(' ');
  if (!inputEventPrefixes.has(prefix)) {
    return null;
  }
  const label = beautifyInputPayload(payloadParts.join(' '));
  return label || prefix;
}

const inputEventPrefixes = new Set(['button', 'touch', 'swipe']);

const inputLabelReplacements: Array<[string, string]> = [
  ['forward swipe', 'swipe →'],
  ['right swipe', 'swipe →'],
  ['backward swipe', 'swipe ←'],
  ['backwards swipe', 'swipe ←'],
  ['left swipe', 'swipe ←'],
  ['up swipe', 'swipe ↑'],
  ['down swipe', 'swipe ↓'],
  ['single tap', 'tap'],
  ['long press', 'long'],
];

function normalizeInputText(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/->/g, ' forward swipe ')
    .replace(/[_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function beautifyInputPayload(payload: string) {
  return inputLabelReplacements.reduce(
    (label, [source, replacement]) => label.replaceAll(source, replacement),
    payload,
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

function LedColorChip({ active, color, disabled, onPress }: { active: boolean; color: LedColor; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      disabled={disabled}
      style={[styles.ledColorChip, active && styles.ledColorChipActive, disabled && styles.disabled, active && { borderColor: ledChipBorderColor(color) }]}
      onPress={onPress}>
      <View style={[styles.ledColorDot, { backgroundColor: ledSwatchColor(color) }, color === 'white' && styles.ledColorDotWhite]} />
      <Text style={[styles.ledColorText, active && styles.ledColorTextActive]}>{capitalize(color)}</Text>
    </Pressable>
  );
}

function MicControlButton({ active, children, disabled, onPress }: { active: boolean; children: React.ReactNode; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      disabled={disabled}
      style={[styles.micControlButton, active && styles.micControlButtonActive, disabled && styles.disabled]}
      onPress={onPress}>
      {children}
    </Pressable>
  );
}

function RecordIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={7} fill={colors.greenInk} />
    </Svg>
  );
}

function StopIcon({ active }: { active?: boolean }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Rect x={7} y={7} width={10} height={10} rx={2} fill={active ? '#fff' : colors.greenInk} />
    </Svg>
  );
}

function PlayIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path d="M8 5v14l11-7z" fill={colors.greenInk} />
    </Svg>
  );
}

function ledSwatchColor(color: LedColor) {
  switch (color) {
    case 'red':
      return colors.red;
    case 'blue':
      return colors.ble;
    case 'orange':
      return colors.amber;
    case 'white':
      return '#FFFFFF';
    default:
      return colors.greenAccent;
  }
}

function ledChipBorderColor(color: LedColor) {
  return color === 'white' ? 'rgba(15,42,29,0.16)' : `${ledSwatchColor(color)}6B`;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const styles = StyleSheet.create({
  bigCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 28, paddingVertical: 18, paddingHorizontal: 18, borderWidth: 1, borderColor: colors.border, gap: 12 },
  wifiHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconTileSm: { width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(125,216,158,0.18)', borderWidth: 1, borderColor: 'rgba(52,199,89,0.22)', alignItems: 'center', justifyContent: 'center' },
  wifiTitle: { color: colors.ink, fontSize: 17, fontWeight: '700', letterSpacing: -0.17 },
  wifiSub: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  scanBtn: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 7, backgroundColor: 'rgba(15,42,29,0.06)', paddingVertical: 9, paddingHorizontal: 14, borderRadius: 999 },
  disabled: { opacity: 0.45 },
  scanText: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  networkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 },
  networkBorder: { borderBottomWidth: 1, borderColor: 'rgba(15,42,29,0.06)' },
  networkIcon: { width: 28, alignItems: 'center', justifyContent: 'center' },
  networkName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  networkSub: { fontSize: 12, fontWeight: '500' },
  networkAction: { minHeight: 40, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999 },
  networkActionText: { fontSize: 12, fontWeight: '700' },
  wifiExpandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderTopWidth: 1, borderTopColor: 'rgba(15,42,29,0.06)', paddingTop: 12, paddingBottom: 2 },
  wifiExpandText: { color: colors.greenInk, fontSize: 12, fontWeight: '700' },
  tileCard: { flex: 1, borderRadius: 22, paddingVertical: 16, paddingHorizontal: 16, gap: 10, borderWidth: 1, borderColor: colors.borderSoft },
  hotspotCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, paddingVertical: 14, paddingHorizontal: 16, gap: 10, borderWidth: 1, borderColor: colors.borderSoft },
  hotspotDivider: { height: 1, backgroundColor: 'rgba(15,42,29,0.05)' },
  hotspotGalleryRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  hotspotGalleryTitle: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  hotspotGalleryUrl: { fontSize: 11, fontWeight: '600', lineHeight: 15 },
  hotspotGalleryHint: { color: colors.muted, fontSize: 11, fontWeight: '500', lineHeight: 15, marginTop: 2 },
  hotspotActions: { alignItems: 'flex-end', gap: 6 },
  hotspotActionRow: { flexDirection: 'row', gap: 6 },
  hotspotActionChip: { minHeight: 40, minWidth: 72, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 11, borderRadius: 999, backgroundColor: 'rgba(52,199,89,0.14)' },
  hotspotActionChipDisabled: { backgroundColor: 'rgba(15,42,29,0.04)' },
  hotspotActionText: { color: colors.greenDeep, fontSize: 12, fontWeight: '700' },
  hotspotActionTextDisabled: { color: colors.muted },
  hotspotStatus: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  micCard: { marginHorizontal: 16, marginTop: 8, borderRadius: 22, paddingVertical: 16, paddingHorizontal: 16, gap: 10, borderWidth: 1, borderColor: colors.borderSoft },
  tileHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleOn: { width: 38, height: 22, borderRadius: 999, backgroundColor: '#fff', borderWidth: 1.2, paddingHorizontal: 2, alignItems: 'flex-end', justifyContent: 'center' },
  toggleKnob: { width: 18, height: 18, borderRadius: 999, backgroundColor: colors.greenAccent },
  micControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  micControlButton: { width: 44, height: 44, borderRadius: 999, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#0F2A1D', shadowOpacity: 0.05, shadowOffset: { width: 0, height: 4 }, shadowRadius: 8, elevation: 1 },
  micControlButtonActive: { backgroundColor: colors.greenInk },
  micSettingsButton: { alignSelf: 'flex-start', minHeight: 40, marginTop: 6, backgroundColor: 'rgba(52,199,89,0.14)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'center' },
  micSettingsText: { color: colors.greenDeep, fontSize: 12, fontWeight: '700' },
  micRouteText: { color: colors.muted, fontSize: 12, fontWeight: '600', lineHeight: 16, marginTop: 4 },
  micWarning: { color: colors.red, fontSize: 12, fontWeight: '500', lineHeight: 16, marginTop: 4 },
  tileTitle: { color: colors.ink, fontSize: 16, fontWeight: '700', letterSpacing: -0.16 },
  tileSub: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  livePill2: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(52,199,89,0.16)', borderWidth: 1, borderColor: 'rgba(52,199,89,0.3)', paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999 },
  livePill2Text: { color: colors.greenDeep, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  inputChips: { flexDirection: 'row', gap: 8 },
  inputChip: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 40, gap: 6, backgroundColor: 'rgba(15,42,29,0.04)', paddingVertical: 9, paddingHorizontal: 10, borderRadius: 12 },
  inputChipPrefix: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  inputChipLabel: { flex: 1, color: colors.ink, fontSize: 12, fontWeight: '700' },
  galleryModeBlock: { gap: 6, marginTop: 12 },
  galleryModeTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  galleryModeBody: { color: colors.muted, fontSize: 11, fontWeight: '500', lineHeight: 15 },
  galleryModeChips: { flexDirection: 'row', gap: 8, marginTop: 2 },
  galleryModeChip: { minHeight: 44, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 999, backgroundColor: 'rgba(15,42,29,0.04)', borderWidth: 1, borderColor: 'rgba(15,42,29,0.05)' },
  galleryModeChipActive: { backgroundColor: 'rgba(52,199,89,0.16)', borderColor: 'rgba(52,199,89,0.32)' },
  galleryModeChipText: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  galleryModeChipTextActive: { color: colors.greenInk, fontWeight: '700' },
  modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.34)', padding: 24 },
  modalCard: { width: '100%', borderRadius: 24, backgroundColor: colors.bg, padding: 20, gap: 12 },
  modalTitle: { color: colors.ink, fontSize: 22, fontWeight: '800' },
  modalSub: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  modalInput: { color: colors.ink, fontSize: 16, fontWeight: '500', backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 14 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  modalCancel: { flex: 1, alignItems: 'center', backgroundColor: 'rgba(15,42,29,0.06)', borderRadius: 16, paddingVertical: 14 },
  modalCancelText: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  modalConfirm: { flex: 1, alignItems: 'center', backgroundColor: colors.greenPrimary, borderRadius: 16, paddingVertical: 14 },
  modalConfirmText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  ledTitle: { color: colors.ink, fontSize: 18, fontWeight: '700', letterSpacing: -0.18 },
  onPill: { flexDirection: 'row', alignItems: 'center', minHeight: 36, gap: 6, backgroundColor: 'rgba(15,42,29,0.06)', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  onText: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  ledTabs: { flexDirection: 'row', gap: 4, backgroundColor: 'rgba(15,42,29,0.05)', borderRadius: 14, padding: 4 },
  ledTab: { flex: 1, paddingVertical: 12, paddingHorizontal: 6, alignItems: 'center', gap: 6, borderRadius: 10 },
  ledTabActive: { backgroundColor: '#fff' },
  ledTabText: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  ledTabTextActive: { color: colors.ink, fontWeight: '600' },
  ledColorRow: { flexDirection: 'row', gap: 6 },
  ledColorChip: { flex: 1, minWidth: 0, minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, paddingHorizontal: 8, borderRadius: 999, backgroundColor: 'rgba(15,42,29,0.04)', borderWidth: 1, borderColor: 'rgba(15,42,29,0.05)' },
  ledColorChipActive: { backgroundColor: '#fff' },
  ledColorDot: { width: 9, height: 9, borderRadius: 999 },
  ledColorDotWhite: { borderWidth: 1, borderColor: 'rgba(15,42,29,0.16)' },
  ledColorText: { color: colors.muted, fontSize: 11, fontWeight: '500' },
  ledColorTextActive: { color: colors.ink, fontWeight: '600' },
  ledNote: { color: colors.muted, fontSize: 11, lineHeight: 16, fontWeight: '500' },
});
