import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Image, TextInput, Clipboard } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path, Polyline, Rect } from 'react-native-svg';
import { Header } from '../components/Header';
import { useScrollBottomPadding } from '../components/keyboardLayout';
import { OfflineNotice } from '../components/OfflineNotice';
import { colors } from '../components/theme';
import { isGlassesConnected } from '../sdkFormat';
import { PHOTO_COMPRESSIONS, PHOTO_SIZES, type MentraSdkModel, type PhotoCompression, type PhotoSize } from '../useMentraSdk';

function cameraSdkCall(size: PhotoSize, compression: PhotoCompression, flash: boolean, useCloudServer: boolean) {
  if (!useCloudServer) {
    return `const { uploadUrl } = await MentraDirectReceiver.startPhotoReceiver();
await BluetoothSdk.photoRequest(
  requestId,
  PHOTO_APP_ID,
  "${size}",
  uploadUrl,
  null,
  "${compression}",
  ${flash},
  true,
)`;
  }
  return `await BluetoothSdk.photoRequest(
  requestId,
  PHOTO_APP_ID,
  "${size}",
  webhookUrl,
  null,
  "${compression}",
  ${flash},
  true,
)`;
}

export function CameraScreen({ sdk }: { sdk: MentraSdkModel }) {
  const scrollBottomPadding = useScrollBottomPadding();
  const connected = isGlassesConnected(sdk.glassesStatus);
  const cameraStatusFailed = isCameraStatusFailure(sdk.cameraStatus);
  const setupHint = sdk.photoCloudServerEnabled ? localCameraSetupHint(sdk.webhookUrl, sdk.cameraStatus) : null;
  const sdkCall = cameraSdkCall(
    sdk.photoSize,
    sdk.photoCompression,
    sdk.photoFlash,
    sdk.photoCloudServerEnabled,
  );

  return (
    <ScrollView
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: scrollBottomPadding }}>
      <Header connected={connected} title="Camera" />
      {!connected && <OfflineNotice />}

      {/* Preview card */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.card}>
        <View style={styles.previewWrap}>
          <LinearGradient colors={['#1F4A33', '#3A8A56', '#7DD89E', '#26B870', '#163A26']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.preview}>
            {sdk.photoPreviewUrl ? <Image source={{ uri: sdk.photoPreviewUrl }} style={styles.previewImage} resizeMode="cover" /> : null}
            <View style={styles.previewGlow} />
            <View style={styles.previewBottomShade} />
            <View style={styles.previewBadge}>
              <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: colors.greenSoft }} />
              <Text style={styles.previewBadgeText}>{sdk.photoPreviewUrl ? 'JPEG · uploaded' : 'JPEG · waiting'}</Text>
            </View>
            <Text style={styles.previewMeta}>{sdk.photoPreviewUrl ? 'latest' : 'ready'}</Text>
          </LinearGradient>
        </View>

        <Pressable disabled={!connected} onPress={sdk.captureAndUpload}>
          <LinearGradient colors={['#26473A', '#1F3A2A']} style={[styles.captureBtn, !connected && styles.disabled]}>
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <Circle cx={12} cy={13} r={4} />
            </Svg>
            <Text style={styles.captureText}>
              {!connected
                ? 'Connect glasses first'
                : sdk.activeAction === 'Capture & upload'
                  ? 'Capturing…'
                  : 'Capture & upload'}
            </Text>
          </LinearGradient>
        </Pressable>
      </LinearGradient>

      {/* SDK call card */}
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
          <View style={[styles.statusIconCircle, cameraStatusFailed && styles.statusIconCircleError]}>
            <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={cameraStatusFailed ? colors.red : colors.greenAccent} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
              {cameraStatusFailed ? <Path d="M18 6 6 18M6 6l12 12" /> : <Polyline points="20 6 9 17 4 12" />}
            </Svg>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.statusTitle}>{sdk.cameraStatus}</Text>
            <Text style={styles.statusSub}>
              {sdk.photoPreviewUrl
                ? sdk.photoCloudServerEnabled
                  ? 'Preview loaded from cloud server'
                  : 'Preview loaded from phone receiver'
                : sdk.photoCloudServerEnabled
                  ? 'Waiting for cloud upload'
                  : 'Waiting for capture'}
            </Text>
          </View>
        </View>
      </LinearGradient>

      {/* Upload to */}
      <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.uploadCard}>
        <View style={styles.cardHead}>
          <Text style={styles.eyebrow}>UPLOAD TO</Text>
          <Pressable
            onPress={() => void sdk.setPhotoCloudServerEnabled(!sdk.photoCloudServerEnabled)}
            style={[styles.toggleChip, sdk.photoCloudServerEnabled && styles.toggleChipActive]}>
            {({pressed}) => (
              <Text style={[styles.toggleText, sdk.photoCloudServerEnabled && styles.toggleTextActive, pressed && styles.toggleTextPressed]}>
                Use cloud server
              </Text>
            )}
          </Pressable>
        </View>
        {sdk.photoCloudServerEnabled ? (
          <>
            <View style={styles.cardHead}>
              <Text style={styles.modeHint}>Cloud server receives the JPEG upload.</Text>
              <Pressable onPress={sdk.testWebhook}>
                {({pressed}) => (
                  <Text style={[styles.linkRight, { color: colors.greenAccent, opacity: pressed ? 0.6 : 1 }]}>test webhook</Text>
                )}
              </Pressable>
            </View>
            <View style={styles.urlBar}>
              <Text style={styles.method}>POST</Text>
              <View style={styles.divider} />
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={sdk.setWebhookUrl}
                placeholder="Photo upload URL"
                placeholderTextColor={colors.muted}
                returnKeyType="done"
                style={styles.url}
                value={sdk.webhookUrl}
              />
            </View>
            {setupHint ? <Text style={styles.setupHint}>{setupHint}</Text> : null}
          </>
        ) : (
          <Text style={styles.setupHint}>
            The phone starts a local upload receiver before each capture and previews the JPEG when the glasses upload it.
          </Text>
        )}
        <OptionGroup label="size">
          {PHOTO_SIZES.map((size) => (
            <Chip key={size} active={sdk.photoSize === size} value={size} onPress={() => sdk.setPhotoSize(size)} />
          ))}
        </OptionGroup>
        <OptionGroup label="compress">
          {PHOTO_COMPRESSIONS.map((compression) => (
            <Chip
              key={compression}
              active={sdk.photoCompression === compression}
              value={compression}
              onPress={() => sdk.setPhotoCompression(compression)}
            />
          ))}
        </OptionGroup>
        <OptionGroup label="flash">
          <Chip active={!sdk.photoFlash} value="off" onPress={() => sdk.setPhotoFlash(false)} />
          <Chip active={sdk.photoFlash} value="on" onPress={() => sdk.setPhotoFlash(true)} />
        </OptionGroup>
      </LinearGradient>
    </ScrollView>
  );
}

function isCameraStatusFailure(status: string) {
  const normalized = status.toLowerCase();
  return (
    normalized.includes('failed') ||
    normalized.includes('returned http') ||
    normalized.includes('timed out') ||
    normalized.includes('reported') ||
    normalized.includes('invalid') ||
    normalized.includes('replace <computer-ip>') ||
    normalized.includes('valid http') ||
    normalized.includes('enter a webhook url like') ||
    normalized.includes('connect glasses first')
  );
}

function localCameraSetupHint(webhookUrl: string, status: string) {
  const normalized = status.toLowerCase();
  const needsSetup =
    webhookUrl.trim().length === 0 ||
    webhookUrl.includes('<computer-ip>') ||
    normalized.includes('webhook test failed') ||
    normalized.includes('returned http') ||
    normalized.includes('timed out') ||
    normalized.includes('valid http') ||
    normalized.includes('enter a webhook url like');
  if (!needsSetup) {
    return null;
  }
  return 'Local setup: run python3 examples/local-demo-cloud/server.py from the Partner Kit repo root, then paste the printed Photo upload URL here. It looks like http://<computer-ip>:8787/upload.';
}

function OptionGroup({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <View style={styles.optionGroup}>
      <Text style={styles.optionLabel}>{label}</Text>
      <View style={styles.chipRow}>{children}</View>
    </View>
  );
}

function Chip({ active, onPress, value }: { active: boolean; onPress: () => void; value: string }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipValue, active && styles.chipValueActive]}>{value}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 8, borderRadius: 28, paddingTop: 8, paddingBottom: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8 },
  previewWrap: { borderRadius: 22, overflow: 'hidden', height: 160 },
  preview: { flex: 1 },
  previewImage: { ...StyleSheet.absoluteFillObject },
  previewGlow: { position: 'absolute', top: 30, right: 50, width: 80, height: 80, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.55)' },
  previewBottomShade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 90, backgroundColor: 'rgba(0,0,0,0.25)' },
  previewBadge: { position: 'absolute', bottom: 14, left: 14, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.35)', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  previewBadgeText: { color: '#fff', fontSize: 10, fontWeight: '600', letterSpacing: 0.5 },
  previewMeta: { position: 'absolute', bottom: 14, right: 14, color: 'rgba(255,255,255,0.85)', fontSize: 10, fontWeight: '500' },
  captureBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 18, paddingVertical: 16, marginTop: 14, marginHorizontal: 6, gap: 10 },
  captureText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 },

  sdkCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, overflow: 'hidden', borderWidth: 1, borderColor: colors.borderSoft },
  sdkBlock: { backgroundColor: '#0E1A14', paddingVertical: 14, paddingHorizontal: 16, gap: 8 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sdkEyebrow: { color: colors.greenAccent, fontSize: 9, fontWeight: '700', letterSpacing: 1.1 },
  copyChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.06)', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6 },
  copyChipPressed: { opacity: 0.6 },
  copyText: { color: colors.consoleText, fontSize: 10, fontWeight: '600' },
  sdkCode: { color: colors.consoleText, fontSize: 11, lineHeight: 16, fontFamily: 'Courier' },

  statusBar: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, gap: 10 },
  statusIconCircle: { width: 22, height: 22, borderRadius: 999, backgroundColor: 'rgba(52,199,89,0.16)', alignItems: 'center', justifyContent: 'center' },
  statusIconCircleError: { backgroundColor: 'rgba(255,59,48,0.16)' },
  statusTitle: { color: colors.ink, fontSize: 11, fontWeight: '600' },
  statusSub: { color: colors.muted, fontSize: 10, fontWeight: '500' },
  linkRight: { color: colors.muted, fontSize: 10, fontWeight: '600' },

  uploadCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, paddingVertical: 16, paddingHorizontal: 18, gap: 12, borderWidth: 1, borderColor: colors.borderSoft },
  eyebrow: { color: colors.muted, fontSize: 10, fontWeight: '600', letterSpacing: 1.2 },
  toggleChip: { borderRadius: 999, borderWidth: 1, borderColor: 'rgba(15,42,29,0.12)', paddingVertical: 6, paddingHorizontal: 10, backgroundColor: 'rgba(255,255,255,0.55)' },
  toggleChipActive: { backgroundColor: 'rgba(52,199,89,0.16)', borderColor: 'rgba(52,199,89,0.32)' },
  toggleText: { color: colors.muted, fontSize: 10, fontWeight: '700' },
  toggleTextActive: { color: colors.greenAccent },
  toggleTextPressed: { opacity: 0.6 },
  modeHint: { flex: 1, color: colors.muted, fontSize: 11, fontWeight: '500' },
  urlBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  setupHint: { color: colors.muted, fontSize: 11, fontWeight: '500', lineHeight: 15, backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 },
  method: { color: colors.greenAccent, fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  divider: { width: 1, height: 14, backgroundColor: 'rgba(15,42,29,0.12)' },
  url: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '500' },
  optionGroup: { gap: 6 },
  optionLabel: { color: colors.muted, fontSize: 10, fontWeight: '600', letterSpacing: 1.1, textTransform: 'uppercase' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.6)', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(15,42,29,0.06)' },
  chipActive: { backgroundColor: 'rgba(52,199,89,0.16)', borderColor: 'rgba(52,199,89,0.32)' },
  chipValue: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  chipValueActive: { color: colors.greenAccent },
});
