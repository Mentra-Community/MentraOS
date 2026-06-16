import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Image, TextInput, Clipboard, Switch, PanResponder, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { VideoView, useVideoPlayer } from 'expo-video';
import Svg, { Circle, Path, Polyline, Rect } from 'react-native-svg';
import { Header } from '../components/Header';
import { useScrollBottomPadding } from '../components/keyboardLayout';
import { OfflineNotice } from '../components/OfflineNotice';
import { colors } from '../components/theme';
import { isGlassesConnected, isGlassesWifiConnected } from '../sdkFormat';
import {
  CAMERA_FOV_DEFAULT,
  CAMERA_FOV_MAX,
  CAMERA_FOV_MIN,
  CAMERA_ROI_POSITIONS,
  PHOTO_COMPRESSIONS,
  PHOTO_EXPOSURE_DEFAULT_NS,
  PHOTO_EXPOSURE_MAX_NS,
  PHOTO_EXPOSURE_MIN_NS,
  PHOTO_ISO_DEFAULT,
  PHOTO_ISO_MAX,
  PHOTO_ISO_MIN,
  PHOTO_SIZES,
  SCAN_AE_DIVISOR_OPTIONS,
  SCAN_ISO_CAP_OPTIONS,
  type BluetoothSdkExampleModel,
  type PhotoCompression,
  type PhotoPreviewDetails,
  type PhotoSize,
  type ScanAeDivisor,
  type VideoPreviewDetails,
} from '../useBluetoothSdkExample';

const PHOTO_EXPOSURE_STEP_NS = 500_000;
const PHOTO_ISO_STEP = 50;
const CAMERA_FOV_STEP = 1;
type CameraCaptureMode = 'photo' | 'video';

function photoSdkCall(
  size: PhotoSize,
  compression: PhotoCompression,
  useCloudServer: boolean,
  exposureManual: boolean,
  exposureTimeNs: number,
  iso: number,
  cameraFov: number,
  cameraRoiPosition: (typeof CAMERA_ROI_POSITIONS)[number]['value'],
  scanMode: boolean,
  scanAeDivisor: ScanAeDivisor,
  scanIsoCap: number,
) {
  const prefix = `const cameraFov = await BluetoothSdk.setCameraFov({ fov: ${cameraFov}, roiPosition: "${cameraRoiPosition}" });
console.log(\`Camera FOV applied at \${cameraFov.fov}°\`);
`;
  const requestFields = scanMode
    ? `  size: "max",
  compress: "none",
  sound: false,
  aeExposureDivisor: ${scanAeDivisor},
  isoCap: ${scanIsoCap},
  noiseReduction: false,
  edgeEnhancement: false,
  mfnr: false,
  ispDigitalGain: 0,
  ispAnalogGain: "low",`
    : [
        `  size: "${size}",`,
        `  compress: "${compression}",`,
        '  sound: true,',
        exposureManual ? `  exposureTimeNs: ${exposureTimeNs},` : '  exposureTimeNs: null, // auto exposure',
        exposureManual ? `  iso: ${iso},` : '  iso: null, // auto ISO',
      ].join('\n');
  if (!useCloudServer) {
    return `${prefix}const photoRequestId = \`photo-\${Date.now()}\`;
const { uploadUrl } = await MentraPhotoReceiver.startPhotoReceiver();
const photo = await BluetoothSdk.requestPhoto({
  requestId: photoRequestId,
  appId: PHOTO_APP_ID,
  webhookUrl: uploadUrl,
  authToken: null,
${requestFields}
})
console.log("Photo delivered", photo.photoUrl ?? photo.uploadUrl)`;
  }
  return `${prefix}const photoRequestId = \`photo-\${Date.now()}\`;
const photo = await BluetoothSdk.requestPhoto({
  requestId: photoRequestId,
  appId: PHOTO_APP_ID,
  webhookUrl,
  authToken: null,
${requestFields}
})
console.log("Photo delivered", photo.photoUrl ?? photo.uploadUrl)`;
}

function videoSdkCall(
  cameraFov: number,
  cameraRoiPosition: (typeof CAMERA_ROI_POSITIONS)[number]['value'],
) {
  return `const cameraFov = await BluetoothSdk.setCameraFov({ fov: ${cameraFov}, roiPosition: "${cameraRoiPosition}" });
console.log(\`Camera FOV applied at \${cameraFov.fov}°\`);
const videoRequestId = \`video-\${Date.now()}\`;
await BluetoothSdk.startVideoRecording(videoRequestId, true, true, {
  maxRecordingTimeMinutes: 1,
});
const stopped = await BluetoothSdk.stopVideoRecording(videoRequestId, webhookUrl);
console.log("Video stopped", stopped.status)`;
}

export function CameraScreen({ sdk }: { sdk: BluetoothSdkExampleModel }) {
  const scrollBottomPadding = useScrollBottomPadding();
  const [captureMode, setCaptureMode] = React.useState<CameraCaptureMode>('photo');
  const [photoDetailsExpanded, setPhotoDetailsExpanded] = React.useState(false);
  const [videoDetailsExpanded, setVideoDetailsExpanded] = React.useState(false);
  const connected = isGlassesConnected(sdk.glasses);
  const glassesWifiConnected = isGlassesWifiConnected(sdk.glasses);
  const wifiRequired = connected && !glassesWifiConnected;
  const videoActionBusy =
    sdk.activeAction === 'Start video recording' ||
    sdk.activeAction === 'Stop & upload video';
  const videoControlsDisabled =
    !connected ||
    !glassesWifiConnected ||
    videoActionBusy;
  const cameraStatusFailed = isCameraStatusFailure(sdk.cameraStatus);
  const photoStatusOverlay = photoStatusOverlayInfo(
    sdk.photoStatus,
    sdk.photoPreviewUrl,
    sdk.photoPreviewDetails,
  );
  const bleFallbackWarning = sdk.photoPreviewDetails?.bleFallbackUsed
    ? sdk.photoPreviewDetails.bleFallbackMessage ??
      'Wi-Fi upload failed; photo was compressed and delivered through Bluetooth.'
    : null;
  const cloudSetupHint = localCameraSetupHint(sdk.webhookUrl, sdk.cameraStatus);
  const photoStateText = sdk.photoPreviewUrl
    ? 'preview ready'
    : sdk.photoStatus
      ? photoStatusTitle(sdk.photoStatus, sdk.photoPreviewDetails)
      : 'ready';
  const videoStateText = sdk.videoRecording
    ? 'recording'
    : sdk.videoPreviewUrl
      ? 'preview ready'
      : sdk.videoPreviewDetails?.state ?? 'ready';
  const sdkCall = captureMode === 'video'
    ? videoSdkCall(sdk.cameraFov, sdk.cameraRoiPosition)
    : photoSdkCall(
        sdk.photoSize,
        sdk.photoCompression,
        sdk.photoCloudServerEnabled,
        sdk.photoExposureManual,
        sdk.photoExposureTimeNs,
        sdk.photoIso,
        sdk.cameraFov,
        sdk.cameraRoiPosition,
        sdk.scanMode,
        sdk.scanAeDivisor,
        sdk.scanIsoCap,
      );

  React.useEffect(() => {
    if (
      sdk.videoRecording ||
      sdk.activeAction === 'Start video recording' ||
      sdk.activeAction === 'Stop & upload video'
    ) {
      setCaptureMode('video');
    } else if (sdk.activeAction === 'Capture & upload' || sdk.activeAction === 'Capture scan photo') {
      setCaptureMode('photo');
    }
  }, [sdk.activeAction, sdk.videoRecording]);

  return (
    <ScrollView
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: scrollBottomPadding }}>
      <Header title="Camera" />
      {!connected ? (
        <OfflineNotice />
      ) : wifiRequired ? (
        <OfflineNotice message="Connect the glasses to Wi-Fi from the System tab before capturing photos. Photos are uploaded over the glasses network connection." />
      ) : null}
      {sdk.cameraButtonNotice ? (
        <View pointerEvents="none" style={styles.cameraButtonNoticeWrap}>
          <View style={styles.cameraButtonNotice}>
            <Text style={styles.cameraButtonNoticeText}>{sdk.cameraButtonNotice}</Text>
          </View>
        </View>
      ) : null}

      <CameraModeSelector activeMode={captureMode} onChange={setCaptureMode} />

      {/* Preview card */}
      {captureMode === 'photo' ? (
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.card}>
        <View style={styles.captureModeHeader}>
          <Text style={styles.eyebrow}>PHOTO</Text>
          <Text style={styles.videoStateText}>{photoStateText}</Text>
        </View>
        <View style={styles.previewWrap}>
          <LinearGradient colors={['#1F4A33', '#3A8A56', '#7DD89E', '#26B870', '#163A26']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.preview}>
            {sdk.photoPreviewUrl ? (
              <>
                <Image source={{ uri: sdk.photoPreviewUrl }} style={styles.previewImage} resizeMode="cover" />
                <Pressable
                  accessibilityLabel="Open photo preview"
                  hitSlop={8}
                  onPress={sdk.openPhotoPreview}
                  style={styles.previewTapLayer}
                />
                <Pressable
                  accessibilityLabel="Open photo preview"
                  hitSlop={8}
                  onPress={sdk.openPhotoPreview}
                  style={styles.previewOpenBadge}>
                  <Svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round">
                    <Path d="M15 3h6v6" />
                    <Path d="M10 14 21 3" />
                    <Path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                  </Svg>
                  <Text style={styles.previewOpenText}>Open</Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.previewGlow} />
                <View style={styles.previewBottomShade} />
                {!photoStatusOverlay ? (
                  <>
                    <View style={styles.previewBadge}>
                      <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: colors.greenSoft }} />
                      <Text style={styles.previewBadgeText}>JPEG · waiting</Text>
                    </View>
                    <Text style={styles.previewMeta}>ready</Text>
                  </>
                ) : null}
              </>
            )}
            {photoStatusOverlay ? (
              <View
                pointerEvents="none"
                style={[
                  styles.previewStatusOverlay,
                  photoStatusOverlay.failed && styles.previewStatusOverlayFailed,
                ]}>
                <View style={styles.previewStatusLine}>
                  {photoStatusOverlay.busy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                      {photoStatusOverlay.failed ? <Path d="M18 6 6 18M6 6l12 12" /> : <Polyline points="20 6 9 17 4 12" />}
                    </Svg>
                  )}
                  <Text style={styles.previewStatusText}>{photoStatusOverlay.title}</Text>
                </View>
                {photoStatusOverlay.detail ? (
                  <Text style={styles.previewStatusDetail}>{photoStatusOverlay.detail}</Text>
                ) : null}
              </View>
            ) : null}
          </LinearGradient>
        </View>
        {bleFallbackWarning ? (
          <View style={styles.previewFallbackWarning}>
            <Text style={styles.previewFallbackWarningTitle}>Bluetooth fallback</Text>
            <Text style={styles.previewFallbackWarningText}>{bleFallbackWarning}</Text>
          </View>
        ) : null}

        <BarcodeResult scan={sdk.barcodeScan} />

        <Pressable disabled={!connected || !glassesWifiConnected} onPress={sdk.captureAndUpload}>
          <LinearGradient colors={['#26473A', '#1F3A2A']} style={[styles.captureBtn, (!connected || !glassesWifiConnected) && styles.disabled]}>
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <Circle cx={12} cy={13} r={4} />
            </Svg>
            <Text style={styles.captureText}>
              {!connected
                ? 'Connect glasses first'
                : !glassesWifiConnected
                  ? 'Connect glasses to Wi-Fi'
                : sdk.activeAction === 'Capture & upload' || sdk.activeAction === 'Capture scan photo'
                  ? 'Capturing…'
                  : sdk.scanMode
                    ? 'Capture scan photo'
                    : 'Capture photo'}
            </Text>
          </LinearGradient>
        </Pressable>
        <View style={styles.scanModeBelowCapture}>
          <ScanModeSettingsCard
            aeDivisor={sdk.scanAeDivisor}
            enabled={sdk.scanMode}
            isoCap={sdk.scanIsoCap}
            onAeDivisorChange={sdk.setScanAeDivisor}
            onEnabledChange={sdk.setScanMode}
            onIsoCapChange={sdk.setScanIsoCap}
          />
        </View>
        <PhotoDetailsCard
          details={sdk.photoPreviewDetails}
          embedded
          expanded={photoDetailsExpanded}
          onToggle={() => setPhotoDetailsExpanded((value) => !value)}
        />
      </LinearGradient>
      ) : null}

      {captureMode === 'video' ? (
      <LinearGradient colors={['rgba(255,255,255,0.74)', 'rgba(255,255,255,0.52)']} style={styles.videoCard}>
        <View style={styles.cardHead}>
          <Text style={styles.eyebrow}>VIDEO RECORDING</Text>
          <Text style={styles.videoStateText}>{videoStateText}</Text>
        </View>
        <View style={styles.videoPreviewWrap}>
          {sdk.videoPreviewUrl ? (
            <VideoPreviewPlayer url={sdk.videoPreviewUrl} />
          ) : (
            <LinearGradient
              colors={['#101820', '#21383B', '#357064']}
              start={{x: 0, y: 0}}
              end={{x: 1, y: 1}}
              style={styles.videoPlaceholder}>
              <View style={styles.previewBottomShade} />
              <View style={styles.previewBadge}>
                <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: colors.greenSoft }} />
                <Text style={styles.previewBadgeText}>MP4 · waiting</Text>
              </View>
              <Text style={styles.previewMeta}>
                {sdk.videoRecording ? 'recording' : 'ready'}
              </Text>
            </LinearGradient>
          )}
        </View>
        <Pressable disabled={videoControlsDisabled} onPress={sdk.toggleVideoRecording}>
          <LinearGradient colors={['#223F4D', '#182C38']} style={[styles.captureBtn, videoControlsDisabled && styles.disabled]}>
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="m15 10 4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14" />
              <Rect x={3} y={6} width={12} height={12} rx={2} />
            </Svg>
            <Text style={styles.captureText}>
              {!connected
                ? 'Connect glasses first'
                : !glassesWifiConnected
                  ? 'Connect glasses to Wi-Fi'
                  : sdk.activeAction === 'Start video recording'
                      ? 'Starting video…'
                      : sdk.activeAction === 'Stop & upload video'
                        ? 'Uploading video…'
                        : sdk.videoRecording
                          ? 'Stop & upload video'
                          : 'Start video'}
            </Text>
          </LinearGradient>
        </Pressable>
        <VideoDetailsCard
          details={sdk.videoPreviewDetails}
          expanded={videoDetailsExpanded}
          onToggle={() => setVideoDetailsExpanded((value) => !value)}
        />
      </LinearGradient>
      ) : null}

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
              {captureMode === 'video'
                ? sdk.videoRecording
                  ? 'Recording MP4 on glasses'
                  : sdk.videoPreviewUrl
                    ? 'Video preview loaded from media server'
                    : 'MP4 uploads to the media server after recording stops'
                : sdk.photoPreviewUrl
                    ? sdk.photoCloudServerEnabled
                      ? 'Photo preview loaded from cloud server'
                      : 'Photo preview loaded from phone receiver'
                    : sdk.photoCloudServerEnabled
                      ? 'Waiting for media upload'
                      : sdk.phonePhotoReceiverRunning
                        ? 'Phone receiver ready'
                        : 'Preparing phone receiver'}
            </Text>
          </View>
        </View>
      </LinearGradient>

      {/* Upload to */}
      <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.uploadCard}>
        <View style={styles.cardHead}>
          <Text style={styles.eyebrow}>UPLOAD TO</Text>
          {captureMode === 'video' || sdk.photoCloudServerEnabled ? (
            <Pressable onPress={sdk.testWebhook}>
              {({pressed}) => (
                <Text style={[styles.linkRight, { color: colors.greenAccent, opacity: pressed ? 0.6 : 1 }]}>test webhook</Text>
              )}
            </Pressable>
          ) : null}
        </View>
        {captureMode === 'video' ? (
          <>
            <View style={styles.cloudToggleRow}>
              <Text style={styles.cloudToggleLabel}>Media cloud server</Text>
              <View style={styles.fixedDestinationBadge}>
                <Text style={styles.fixedDestinationBadgeText}>MP4</Text>
              </View>
            </View>
            <View style={styles.cardHead}>
              <Text style={styles.modeHint}>Cloud server receives MP4 uploads.</Text>
            </View>
            <View style={styles.urlBar}>
              <Text style={styles.method}>POST</Text>
              <View style={styles.divider} />
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={sdk.setWebhookUrl}
                placeholder="Media upload URL"
                placeholderTextColor={colors.muted}
                returnKeyType="done"
                style={styles.url}
                value={sdk.webhookUrl}
              />
            </View>
            {cloudSetupHint ? <Text style={styles.setupHint}>{cloudSetupHint}</Text> : null}
          </>
        ) : (
          <>
            <View style={styles.cloudToggleRow}>
              <Text style={styles.cloudToggleLabel}>Use media cloud server</Text>
              <Switch
                ios_backgroundColor="rgba(15,42,29,0.18)"
                onValueChange={sdk.setPhotoCloudServerEnabled}
                thumbColor="#fff"
                trackColor={{ false: 'rgba(15,42,29,0.18)', true: colors.greenAccent }}
                value={sdk.photoCloudServerEnabled}
              />
            </View>
        {sdk.photoCloudServerEnabled ? (
          <>
            <View style={styles.cardHead}>
              <Text style={styles.modeHint}>Cloud server receives photo uploads.</Text>
            </View>
            <View style={styles.urlBar}>
              <Text style={styles.method}>POST</Text>
              <View style={styles.divider} />
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={sdk.setWebhookUrl}
                placeholder="Media upload URL"
                placeholderTextColor={colors.muted}
                returnKeyType="done"
                style={styles.url}
                value={sdk.webhookUrl}
              />
            </View>
            {cloudSetupHint ? <Text style={styles.setupHint}>{cloudSetupHint}</Text> : null}
          </>
        ) : (
          <Text style={styles.setupHint}>
            The phone keeps a local upload receiver ready on this tab and previews JPEG photos when the glasses upload them.
          </Text>
        )}
        <OptionGroup label="photo size">
          {PHOTO_SIZES.map((size) => (
            <Chip
              key={size}
              active={sdk.photoSize === size}
              disabled={sdk.scanMode}
              value={size}
              onPress={() => sdk.setPhotoSize(size)}
            />
          ))}
        </OptionGroup>
        <OptionGroup label="photo compress">
          {PHOTO_COMPRESSIONS.map((compression) => (
            <Chip
              key={compression}
              active={sdk.photoCompression === compression}
              disabled={sdk.scanMode}
              value={compression}
              onPress={() => sdk.setPhotoCompression(compression)}
            />
          ))}
        </OptionGroup>
        <ExposureControl
          disabled={sdk.scanMode}
          enabled={sdk.photoExposureManual}
          onEnabledChange={sdk.setPhotoExposureManual}
          onIsoChange={sdk.setPhotoIso}
          onValueChange={sdk.setPhotoExposureTimeNs}
          iso={sdk.photoIso}
          value={sdk.photoExposureTimeNs}
        />
          </>
        )}
        <CameraSettingsControl
          applying={sdk.cameraSettingsApplying}
          fov={sdk.cameraFov}
          onApply={sdk.applyCameraSettings}
          onFovChange={sdk.setCameraFov}
          onRoiChange={sdk.setCameraRoiPosition}
          roiPosition={sdk.cameraRoiPosition}
          status={sdk.cameraSettingsStatus}
        />
      </LinearGradient>
    </ScrollView>
  );
}

function PhotoDetailsCard({
  details,
  embedded = false,
  expanded,
  onToggle,
}: {
  details: PhotoPreviewDetails | null;
  embedded?: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const rows = photoDetailsRows(details);
  const content = (
    <>
      <Pressable onPress={onToggle} style={styles.detailsHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>PHOTO DETAILS</Text>
          <Text style={styles.detailsSummary}>{photoDetailsSummary(details)}</Text>
        </View>
        <Text style={styles.detailsChevron}>{expanded ? 'Hide' : 'Show'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.detailsBody}>
          {rows.map((row) => (
            <View key={row.label} style={styles.detailsRow}>
              <Text style={[styles.detailsLabel, row.tone === 'warning' && styles.detailsLabelWarning]}>
                {row.label}
              </Text>
              <Text style={[styles.detailsValue, row.tone === 'warning' && styles.detailsValueWarning]}>
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );

  if (embedded) {
    return <View style={styles.videoDetailsPanel}>{content}</View>;
  }

  return (
    <LinearGradient colors={['rgba(255,255,255,0.74)', 'rgba(255,255,255,0.52)']} style={styles.detailsCard}>
      {content}
    </LinearGradient>
  );
}

function CameraModeSelector({
  activeMode,
  onChange,
}: {
  activeMode: CameraCaptureMode;
  onChange: (mode: CameraCaptureMode) => void;
}) {
  return (
    <View style={styles.modeSelectorWrap}>
      <View style={styles.modeSelector}>
        <CameraModeButton active={activeMode === 'photo'} mode="photo" onChange={onChange} />
        <CameraModeButton active={activeMode === 'video'} mode="video" onChange={onChange} />
      </View>
    </View>
  );
}

function CameraModeButton({
  active,
  mode,
  onChange,
}: {
  active: boolean;
  mode: CameraCaptureMode;
  onChange: (mode: CameraCaptureMode) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{selected: active}}
      onPress={() => onChange(mode)}
      style={({pressed}) => [styles.modeButton, active && styles.modeButtonActive, pressed && styles.copyChipPressed]}>
      <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={active ? colors.ink : colors.muted} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        {mode === 'photo' ? (
          <>
            <Path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
            <Circle cx={12} cy={13} r={4} />
          </>
        ) : (
          <>
            <Path d="m15 10 4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14" />
            <Rect x={3} y={6} width={12} height={12} rx={2} />
          </>
        )}
      </Svg>
      <Text style={[styles.modeButtonText, active && styles.modeButtonTextActive]}>
        {mode === 'photo' ? 'Photo' : 'Video'}
      </Text>
    </Pressable>
  );
}

function sanitizeVideoMediaSeconds(seconds: number) {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function formatVideoPlaybackSeconds(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function VideoPreviewPlayer({url}: {url: string}) {
  const player = useVideoPlayer(url, (videoPlayer) => {
    videoPlayer.loop = false;
    videoPlayer.muted = true;
    videoPlayer.timeUpdateEventInterval = 0.25;
    videoPlayer.play();
  });
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);

  React.useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setPlaying(true);
    const interval = setInterval(() => {
      const nextDuration = sanitizeVideoMediaSeconds(player.duration);
      const nextCurrentTime = sanitizeVideoMediaSeconds(player.currentTime);
      setDuration(nextDuration);
      setCurrentTime(Math.min(nextCurrentTime, nextDuration || nextCurrentTime));
      setPlaying(player.playing);
    }, 250);
    return () => clearInterval(interval);
  }, [player, url]);

  const seekTo = React.useCallback(
    (seconds: number) => {
      const upperBound = duration > 0 ? duration : seconds;
      const nextTime = Math.max(0, Math.min(upperBound, seconds));
      player.currentTime = nextTime;
      setCurrentTime(nextTime);
    },
    [duration, player],
  );

  const togglePlayback = React.useCallback(() => {
    if (player.playing) {
      player.pause();
      setPlaying(false);
      return;
    }
    if (duration > 0 && currentTime >= duration - 0.2) {
      player.currentTime = 0;
      setCurrentTime(0);
    }
    player.play();
    setPlaying(true);
  }, [currentTime, duration, player]);

  return (
    <View style={styles.videoPreviewPlayer}>
      <VideoView
        contentFit="cover"
        nativeControls={false}
        player={player}
        style={styles.videoPreviewFill}
      />
      <View style={styles.videoPlaybackControls}>
        <Pressable
          accessibilityLabel={playing ? 'Pause video preview' : 'Play video preview'}
          accessibilityRole="button"
          onPress={togglePlayback}
          style={({pressed}) => [styles.videoPlaybackButton, pressed && styles.copyChipPressed]}>
          <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
            {playing ? (
              <>
                <Rect x={6} y={5} width={4} height={14} rx={1} fill="#fff" />
                <Rect x={14} y={5} width={4} height={14} rx={1} fill="#fff" />
              </>
            ) : (
              <Path d="M8 5v14l11-7z" fill="#fff" />
            )}
          </Svg>
        </Pressable>
        <Text style={styles.videoPlaybackTime}>{formatVideoPlaybackSeconds(currentTime)}</Text>
        <PlaybackScrubber duration={duration} position={currentTime} onSeek={seekTo} />
        <Text style={styles.videoPlaybackTime}>{duration > 0 ? formatVideoPlaybackSeconds(duration) : '--:--'}</Text>
      </View>
    </View>
  );
}

function PlaybackScrubber({
  duration,
  onSeek,
  position,
}: {
  duration: number;
  onSeek: (seconds: number) => void;
  position: number;
}) {
  const trackRef = React.useRef<React.ElementRef<typeof View>>(null);
  const trackLeftRef = React.useRef(0);
  const trackWidthRef = React.useRef(0);
  const [trackWidth, setTrackWidth] = React.useState(0);
  const enabled = duration > 0;
  const progress = enabled ? Math.max(0, Math.min(1, position / duration)) : 0;

  const updateFromPageX = React.useCallback(
    (pageX: number, measuredLeft = trackLeftRef.current, measuredWidth = trackWidthRef.current || trackWidth) => {
      if (!enabled || measuredWidth <= 0) {
        return;
      }
      const x = pageX - measuredLeft;
      const ratio = Math.max(0, Math.min(1, x / measuredWidth));
      onSeek(ratio * duration);
    },
    [duration, enabled, onSeek, trackWidth],
  );

  const measureAndUpdate = React.useCallback(
    (pageX: number) => {
      trackRef.current?.measureInWindow((left, _top, width) => {
        trackLeftRef.current = left;
        trackWidthRef.current = width;
        setTrackWidth(width);
        updateFromPageX(pageX, left, width);
      });
    },
    [updateFromPageX],
  );

  const panResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => enabled,
        onMoveShouldSetPanResponder: () => enabled,
        onPanResponderGrant: (event) => measureAndUpdate(event.nativeEvent.pageX),
        onPanResponderMove: (_event, gestureState) => updateFromPageX(gestureState.moveX),
      }),
    [enabled, measureAndUpdate, updateFromPageX],
  );

  return (
    <View
      ref={trackRef}
      {...panResponder.panHandlers}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        trackWidthRef.current = width;
        setTrackWidth(width);
      }}
      style={[styles.videoPlaybackTrack, !enabled && styles.sliderDisabled]}>
      <View style={styles.videoPlaybackTrackBase} />
      <View style={[styles.videoPlaybackTrackFill, {width: `${progress * 100}%`}]} />
      <View style={[styles.videoPlaybackThumb, {left: `${progress * 100}%`}]} />
    </View>
  );
}

function VideoDetailsCard({
  details,
  expanded,
  onToggle,
}: {
  details: VideoPreviewDetails | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const rows = videoDetailsRows(details);
  return (
    <View style={styles.videoDetailsPanel}>
      <Pressable onPress={onToggle} style={styles.detailsHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>VIDEO DETAILS</Text>
          <Text style={styles.detailsSummary}>{videoDetailsSummary(details)}</Text>
        </View>
        <Text style={styles.detailsChevron}>{expanded ? 'Hide' : 'Show'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.detailsBody}>
          {rows.map((row) => (
            <View key={row.label} style={styles.detailsRow}>
              <Text style={styles.detailsLabel}>{row.label}</Text>
              <Text style={styles.detailsValue}>{row.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

type PhotoStatusEvent = NonNullable<BluetoothSdkExampleModel['photoStatus']>;
type PhotoStatusExtras = {
  requestedCaptureConfig?: PhotoPreviewDetails['requestedCaptureConfig'];
  meteredPreview?: PhotoPreviewDetails['meteredPreview'];
  captureMetadata?: PhotoPreviewDetails['captureMetadata'];
};

function photoStatusOverlayInfo(
  status: PhotoStatusEvent | null,
  previewUrl: string | null,
  details: PhotoPreviewDetails | null,
) {
  if (!status) {
    return null;
  }
  if (previewUrl && status.status !== 'failed') {
    return null;
  }

  const failed = status.status === 'failed';
  return {
    busy: !failed,
    detail: failed
      ? status.errorMessage
      : details?.source === 'Glasses gallery'
        ? 'Gallery mode is on, so the photo remains on the glasses and is not previewed.'
        : photoStatusDetail(status),
    failed,
    title: photoStatusTitle(status, details),
  };
}

function photoStatusTitle(status: PhotoStatusEvent, details: PhotoPreviewDetails | null) {
  if (details?.source === 'Glasses gallery') {
    switch (status.status) {
      case 'accepted':
      case 'queued':
        return 'Queued for glasses gallery';
      case 'configuring':
        return 'Preparing glasses capture';
      case 'capturing':
      case 'captured':
      case 'uploading':
        return 'Saving on glasses';
      case 'uploaded':
        return 'Saved on glasses';
      case 'failed':
        return status.errorCode ?? 'Gallery photo failed';
      default:
        return String(status.status).replace(/_/g, ' ');
    }
  }
  switch (status.status) {
    case 'accepted':
      return 'Request accepted';
    case 'queued':
      return 'Queued on glasses';
    case 'configuring':
      return 'Camera configured';
    case 'capturing':
      return 'Capturing photo';
    case 'captured':
      return 'Photo captured';
    case 'compressing':
      return 'Compressing photo';
    case 'ble_fallback_compression':
      return 'Bluetooth fallback';
    case 'uploading':
      return 'Uploading photo';
    case 'uploaded':
      return 'Photo uploaded';
    case 'ready_for_transfer':
      return 'Ready for transfer';
    case 'transferring':
      return 'Transferring photo';
    case 'failed':
      return status.errorCode ?? 'Photo failed';
    default:
      return String(status.status).replace(/_/g, ' ');
  }
}

function photoStatusDetail(status: PhotoStatusEvent) {
  const statusWithExtras = status as PhotoStatusEvent & PhotoStatusExtras;
  return [
    photoResolvedConfigDetail(status.resolvedConfig),
    photoRequestedCaptureDetail(statusWithExtras.requestedCaptureConfig),
    photoMeteredPreviewDetail(statusWithExtras.meteredPreview),
    photoCaptureMetadataDetail(statusWithExtras.captureMetadata),
  ].filter(Boolean).join(' · ') || null;
}

function photoResolvedConfigDetail(config: PhotoStatusEvent['resolvedConfig']) {
  if (!config) {
    return null;
  }
  const values = [
    config.width && config.height ? `${config.width} x ${config.height}` : null,
    config.quality ? `q${config.quality}` : null,
    config.requestedSize ? String(config.requestedSize) : null,
    config.transferMethod ? String(config.transferMethod) : null,
    config.compression ? `compress ${config.compression}` : null,
    config.iso ? `ISO ${config.iso}` : null,
  ].filter(Boolean);
  return values.length > 0 ? values.join(' · ') : null;
}

function compactExposureLabel(ns: number) {
  const seconds = ns / 1_000_000_000;
  if (seconds <= 0) {
    return `${Math.round(ns)} ns`;
  }
  return `1/${Math.round(1 / seconds)}s`;
}

function photoRequestedCaptureDetail(config: PhotoStatusExtras['requestedCaptureConfig']) {
  if (!config) {
    return null;
  }
  const fps = config.aeTargetFpsRange?.min != null && config.aeTargetFpsRange?.max != null
    ? `${config.aeTargetFpsRange.min}-${config.aeTargetFpsRange.max}fps`
    : null;
  const values = [
    config.manual != null ? (config.manual ? 'manual request' : 'auto request') : null,
    config.exposureTimeNs ? `request ${compactExposureLabel(config.exposureTimeNs)}` : null,
    config.iso ? `request ISO ${config.iso}` : null,
    fps,
  ].filter(Boolean);
  return values.length > 0 ? values.join(' · ') : null;
}

function photoMeteredPreviewDetail(config: PhotoStatusExtras['meteredPreview']) {
  if (!config) {
    return null;
  }
  const values = [
    config.exposureTimeNs ? `metered ${compactExposureLabel(config.exposureTimeNs)}` : null,
    config.iso ? `metered ISO ${config.iso}` : null,
  ].filter(Boolean);
  return values.length > 0 ? values.join(' · ') : null;
}

function photoCaptureMetadataDetail(config: PhotoStatusExtras['captureMetadata']) {
  if (!config) {
    return null;
  }
  const values = [
    config.exposureTimeNs ? `actual ${compactExposureLabel(config.exposureTimeNs)}` : null,
    config.iso ? `actual ISO ${config.iso}` : null,
    config.frameDurationNs ? `frame ${compactExposureLabel(config.frameDurationNs)}` : null,
    config.aeStateName ? `AE ${config.aeStateName}` : null,
  ].filter(Boolean);
  return values.length > 0 ? values.join(' · ') : null;
}

function ScanModeSettingsCard({
  aeDivisor,
  enabled,
  isoCap,
  onAeDivisorChange,
  onEnabledChange,
  onIsoCapChange,
}: {
  aeDivisor: ScanAeDivisor;
  enabled: boolean;
  isoCap: number;
  onAeDivisorChange: (divisor: ScanAeDivisor) => void;
  onEnabledChange: (enabled: boolean) => void;
  onIsoCapChange: (isoCap: number) => void;
}) {
  return (
    <View style={styles.settingCard}>
      <View style={styles.settingHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.settingLabel}>SCAN MODE</Text>
          <Text style={styles.settingHint}>
            {enabled ? `Max res · AE÷${aeDivisor} · ISO cap ${isoCap}` : 'Document / barcode capture preset'}
          </Text>
        </View>
        <Switch
          ios_backgroundColor="rgba(15,42,29,0.18)"
          onValueChange={onEnabledChange}
          thumbColor="#fff"
          trackColor={{ false: 'rgba(15,42,29,0.18)', true: colors.greenAccent }}
          value={enabled}
        />
      </View>
      {enabled ? (
        <>
          <Text style={styles.settingDescription}>
            Pushes size, MFNR, NR, edge, and ISP gain presets to glasses (HAL may warn on NR/ISP). Capture still sends AE÷ and ISO cap in take_photo.
          </Text>
          <OptionGroup label="ae divisor">
            {SCAN_AE_DIVISOR_OPTIONS.map((option) => (
              <Chip
                key={option}
                active={aeDivisor === option}
                value={`÷${option}`}
                onPress={() => onAeDivisorChange(option)}
              />
            ))}
          </OptionGroup>
          <OptionGroup label="iso cap">
            {SCAN_ISO_CAP_OPTIONS.map((option) => (
              <Chip
                key={option}
                active={isoCap === option}
                value={String(option)}
                onPress={() => onIsoCapChange(option)}
              />
            ))}
          </OptionGroup>
        </>
      ) : (
        <Text style={styles.settingDescription}>
          Off — capture uses the size, compress, and exposure options below.
        </Text>
      )}
    </View>
  );
}

function ExposureControl({
  disabled = false,
  enabled,
  onEnabledChange,
  onIsoChange,
  onValueChange,
  iso,
  value,
}: {
  disabled?: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onIsoChange: (iso: number) => void;
  onValueChange: (value: number) => void;
  iso: number;
  value: number;
}) {
  const controlsDisabled = disabled || !enabled;
  return (
    <View style={[styles.settingCard, disabled && styles.sliderDisabled]}>
      <View style={styles.settingHeader}>
        <View>
          <Text style={styles.settingLabel}>EXPOSURE</Text>
          <Text style={styles.settingHint}>{enabled ? exposureLabel(value) : 'Auto exposure'}</Text>
        </View>
        <Switch
          disabled={disabled}
          ios_backgroundColor="rgba(15,42,29,0.18)"
          onValueChange={onEnabledChange}
          thumbColor="#fff"
          trackColor={{false: 'rgba(15,42,29,0.18)', true: colors.greenAccent}}
          value={enabled}
        />
      </View>
      <RangeSlider
        disabled={controlsDisabled}
        max={PHOTO_EXPOSURE_MAX_NS}
        min={PHOTO_EXPOSURE_MIN_NS}
        onChange={onValueChange}
        step={PHOTO_EXPOSURE_STEP_NS}
        value={value}
      />
      <View style={styles.settingRangeRow}>
        <Text style={styles.settingRangeText}>1/1000s</Text>
        <Pressable onPress={() => onValueChange(PHOTO_EXPOSURE_DEFAULT_NS)}>
          <Text style={styles.settingHint}>Default 1/120s</Text>
        </Pressable>
        <Text style={styles.settingRangeText}>1/30s</Text>
      </View>
      <View style={styles.isoHeader}>
        <View>
          <Text style={styles.settingLabel}>ISO</Text>
          <Text style={styles.settingHint}>{enabled ? `ISO ${iso}` : 'Auto ISO'}</Text>
        </View>
      </View>
      <RangeSlider
        disabled={controlsDisabled}
        max={PHOTO_ISO_MAX}
        min={PHOTO_ISO_MIN}
        onChange={onIsoChange}
        step={PHOTO_ISO_STEP}
        value={iso}
      />
      <View style={styles.settingRangeRow}>
        <Text style={styles.settingRangeText}>ISO {PHOTO_ISO_MIN}</Text>
        <Pressable onPress={() => onIsoChange(PHOTO_ISO_DEFAULT)}>
          <Text style={styles.settingHint}>Default ISO {PHOTO_ISO_DEFAULT}</Text>
        </Pressable>
        <Text style={styles.settingRangeText}>ISO {PHOTO_ISO_MAX}</Text>
      </View>
    </View>
  );
}

function CameraSettingsControl({
  applying,
  fov,
  onApply,
  onFovChange,
  onRoiChange,
  roiPosition,
  status,
}: {
  applying: boolean;
  fov: number;
  onApply: () => Promise<void>;
  onFovChange: (fov: number) => void;
  onRoiChange: (roiPosition: (typeof CAMERA_ROI_POSITIONS)[number]['value']) => void;
  roiPosition: (typeof CAMERA_ROI_POSITIONS)[number]['value'];
  status: string;
}) {
  const roiDisabled = fov === CAMERA_FOV_MAX;
  const controlsDisabled = applying;
  return (
    <View style={styles.settingCard}>
      <View style={styles.settingHeader}>
        <View>
          <Text style={styles.settingLabel}>FIELD OF VIEW</Text>
          <Text style={styles.settingHint}>{fov}° · {roiDisabled ? 'full sensor' : `${roiLabel(roiPosition)} crop`}</Text>
        </View>
        <Pressable
          disabled={controlsDisabled}
          onPress={() => void onApply()}
          style={({pressed}) => [styles.applyChip, pressed && !controlsDisabled && styles.copyChipPressed]}
        >
          <Text style={[styles.applyChipText, controlsDisabled && styles.settingRangeText]}>
            {applying ? 'Applying...' : 'Apply'}
          </Text>
        </Pressable>
      </View>
      <RangeSlider
        disabled={controlsDisabled}
        max={CAMERA_FOV_MAX}
        min={CAMERA_FOV_MIN}
        onChange={onFovChange}
        step={CAMERA_FOV_STEP}
        value={fov}
      />
      <View style={styles.settingRangeRow}>
        <Text style={styles.settingRangeText}>{CAMERA_FOV_MIN}°</Text>
        <Pressable disabled={controlsDisabled} onPress={() => onFovChange(CAMERA_FOV_DEFAULT)}>
          <Text style={[styles.settingHint, controlsDisabled && styles.settingRangeText]}>
            Default {CAMERA_FOV_DEFAULT}°
          </Text>
        </Pressable>
        <Text style={styles.settingRangeText}>{CAMERA_FOV_MAX}°</Text>
      </View>
      <OptionGroup label="crop position">
        {CAMERA_ROI_POSITIONS.map((option) => (
          <Chip
            key={option.value}
            active={roiPosition === option.value}
            disabled={controlsDisabled || roiDisabled}
            value={option.label}
            onPress={() => onRoiChange(option.value)}
          />
        ))}
      </OptionGroup>
      <Text style={styles.settingDescription}>{status}</Text>
    </View>
  );
}

function RangeSlider({
  disabled,
  max,
  min,
  onChange,
  step,
  value,
}: {
  disabled: boolean;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  const trackRef = React.useRef<React.ElementRef<typeof View>>(null);
  const trackLeftRef = React.useRef(0);
  const trackWidthRef = React.useRef(0);
  const [trackWidth, setTrackWidth] = React.useState(0);
  const progress = (value - min) / (max - min);
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const clampAndSnap = React.useCallback(
    (nextValue: number) => {
      const snapped = min + Math.round((nextValue - min) / step) * step;
      return Math.max(min, Math.min(max, snapped));
    },
    [max, min, step],
  );
  const updateFromPageX = React.useCallback(
    (pageX: number, measuredLeft = trackLeftRef.current, measuredWidth = trackWidthRef.current || trackWidth) => {
      if (disabled || measuredWidth <= 0) {
        return;
      }
      const x = pageX - measuredLeft;
      const ratio = Math.max(0, Math.min(1, x / measuredWidth));
      onChange(clampAndSnap(min + ratio * (max - min)));
    },
    [clampAndSnap, disabled, max, min, onChange, trackWidth],
  );
  const measureAndUpdate = React.useCallback(
    (pageX: number) => {
      trackRef.current?.measureInWindow((left, _top, width) => {
        trackLeftRef.current = left;
        trackWidthRef.current = width;
        setTrackWidth(width);
        updateFromPageX(pageX, left, width);
      });
    },
    [updateFromPageX],
  );
  const adjust = React.useCallback(
    (delta: number) => {
      if (!disabled) {
        onChange(clampAndSnap(value + delta));
      }
    },
    [clampAndSnap, disabled, onChange, value],
  );
  const panResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (event) => measureAndUpdate(event.nativeEvent.pageX),
        onPanResponderMove: (_event, gestureState) => updateFromPageX(gestureState.moveX),
      }),
    [disabled, measureAndUpdate, updateFromPageX],
  );

  return (
    <View style={[styles.sliderControlRow, disabled && styles.sliderDisabled]}>
      <SliderStepButton disabled={disabled || value <= min} label="-" onPress={() => adjust(-step)} />
      <View
        ref={trackRef}
        {...panResponder.panHandlers}
        onLayout={(event) => {
          const width = event.nativeEvent.layout.width;
          trackWidthRef.current = width;
          setTrackWidth(width);
        }}
        style={styles.sliderTrack}>
        <View style={styles.sliderTrackBase} />
        <View style={[styles.sliderTrackFill, {width: `${clampedProgress * 100}%`}]} />
        <View style={[styles.sliderThumb, {left: `${clampedProgress * 100}%`}]} />
      </View>
      <SliderStepButton disabled={disabled || value >= max} label="+" onPress={() => adjust(step)} />
    </View>
  );
}

function SliderStepButton({
  disabled,
  label,
  onPress,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [styles.sliderStepButton, disabled && styles.sliderStepButtonDisabled, pressed && styles.copyChipPressed]}>
      <Text style={[styles.sliderStepText, disabled && styles.sliderStepTextDisabled]}>{label}</Text>
    </Pressable>
  );
}

function exposureLabel(ns: number) {
  const seconds = ns / 1_000_000_000;
  const denominator = Math.round(1 / seconds);
  return `${Math.round(ns).toLocaleString()} ns · 1/${denominator}s`;
}

function roiLabel(roiPosition: (typeof CAMERA_ROI_POSITIONS)[number]['value']) {
  return CAMERA_ROI_POSITIONS.find((option) => option.value === roiPosition)?.label ?? 'Center';
}

function withBarcodePositionLabels<T extends {barcode: BluetoothSdkExampleModel['barcodeScan']['barcodes'][number]}>(
  results: T[],
): Array<T & {positionLabel: string | null}> {
  const positions = results
    .map((result, index) => {
      const bounds = result.barcode.bounds;
      if (!bounds) {
        return null;
      }
      return {
        index,
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
    })
    .filter((position): position is {index: number; x: number; y: number} => position !== null);

  if (positions.length < 2) {
    return results.map((result) => ({...result, positionLabel: null}));
  }

  const minX = Math.min(...positions.map((position) => position.x));
  const maxX = Math.max(...positions.map((position) => position.x));
  const minY = Math.min(...positions.map((position) => position.y));
  const maxY = Math.max(...positions.map((position) => position.y));
  const xSpan = maxX - minX;
  const ySpan = maxY - minY;

  return results.map((result, index) => {
    const position = positions.find((candidate) => candidate.index === index);
    const candidates: Array<{distance: number; label: string; priority: number}> = [];

    if (position && xSpan > 0) {
      const xPercent = (position.x - minX) / xSpan;
      if (position.x === minX) {
        candidates.push({distance: xPercent, label: 'left-most', priority: 0});
      }
      if (position.x === maxX) {
        candidates.push({distance: 1 - xPercent, label: 'right-most', priority: 1});
      }
    }

    if (position && ySpan > 0) {
      const yPercent = (position.y - minY) / ySpan;
      if (position.y === minY) {
        candidates.push({distance: yPercent, label: 'top-most', priority: 2});
      }
      if (position.y === maxY) {
        candidates.push({distance: 1 - yPercent, label: 'bottom-most', priority: 3});
      }
    }

    candidates.sort((a, b) => a.distance - b.distance || a.priority - b.priority);
    return {
      ...result,
      positionLabel: candidates[0]?.label ?? null,
    };
  });
}

function barcodeScannerLabel(barcode: BluetoothSdkExampleModel['barcodeScan']['barcodes'][number]) {
  const scanner = (barcode as typeof barcode & {scanner?: unknown}).scanner;
  return typeof scanner === 'string' ? scanner : null;
}

function BarcodeResult({scan}: {scan: BluetoothSdkExampleModel['barcodeScan']}) {
  if (scan.state === 'idle') {
    return null;
  }

  const foundBarcodes = withBarcodePositionLabels(
    scan.barcodes
      .map((barcode, index) => ({
        barcode,
        index,
        value: barcode.rawValue ?? barcode.displayValue,
      }))
      .filter((result): result is {barcode: (typeof scan.barcodes)[number]; index: number; value: string} => Boolean(result.value)),
  );
  const foundValues = foundBarcodes.map((result) => result.value);
  const foundFormats = Array.from(new Set(scan.barcodes.map((barcode) => barcode.format).filter(Boolean)));
  const foundTypeLabel = foundFormats.length === 1 ? ` (type: ${foundFormats[0]})` : foundFormats.length > 1 ? ` (types: ${foundFormats.join(', ')})` : '';
  const expectedMatched = scan.expectedValue
    ? foundValues.includes(scan.expectedValue)
    : false;
  const isFound = scan.state === 'found';
  const isError = scan.state === 'error';
  const isScanning = scan.state === 'scanning';
  const title = isScanning
    ? 'Barcode scanning'
    : isFound
      ? expectedMatched
        ? `Barcode matched${foundTypeLabel}`
        : `Barcode found${foundTypeLabel}`
      : isError
        ? 'Barcode error'
        : 'No barcode found';
  const fallbackBody = isError
      ? scan.error ?? 'Scanner failed'
      : isScanning
        ? 'Analyzing photo preview...'
        : 'Photo preview scanned';
  const body = isFound
    ? `${foundBarcodes.length} barcode${foundBarcodes.length === 1 ? '' : 's'} found`
    : fallbackBody;

  return (
    <View style={[styles.barcodeRow, isScanning && styles.barcodeRowScanning, isFound && styles.barcodeRowFound, isError && styles.barcodeRowError]}>
      {isScanning ? (
        <ActivityIndicator size="small" color={colors.greenAccent} />
      ) : (
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={isError ? colors.red : isFound ? colors.greenAccent : colors.muted} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M3 5v14" />
          <Path d="M7 5v14" />
          <Path d="M11 5v14" />
          <Path d="M17 5v14" />
          <Path d="M21 5v14" />
        </Svg>
      )}
      <View style={{flex: 1}}>
        <Text style={styles.barcodeTitle}>{title}</Text>
        {isFound ? (
          <View style={styles.barcodeResultList}>
            {foundBarcodes.map(({barcode, index, positionLabel, value}) => (
              <View key={`${barcode.format}-${value}-${index}`} style={styles.barcodeResultItem}>
                <View style={styles.barcodeResultTextWrap}>
                  <Text style={styles.barcodeValue}>{value}</Text>
                  <Text style={styles.barcodeMeta}>
                    {[barcode.format, barcodeScannerLabel(barcode), positionLabel].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Pressable
                  hitSlop={8}
                  onPress={() => Clipboard.setString(value)}
                  style={({pressed}) => [styles.barcodeCopyBtn, pressed && styles.copyChipPressed]}>
                  <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.greenAccent} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
                    <Path d="M8 8h11v13H8z" />
                    <Path d="M5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1" />
                  </Svg>
                  <Text style={styles.barcodeCopyText}>Copy</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.barcodeValue}>{body}</Text>
        )}
      </View>
    </View>
  );
}

function photoDetailsSummary(details: PhotoPreviewDetails | null) {
  if (!details) {
    return 'Waiting for first photo preview';
  }
  if (details.state === 'error') {
    return `Error · ${details.error ?? 'Photo failed'}`;
  }
  return [
    details.source,
    details.byteCount ? formatBytes(details.byteCount) : null,
    details.width && details.height ? `${details.width} x ${details.height}` : null,
    details.captureMetadata ? photoCaptureMetadataDetail(details.captureMetadata) : null,
    details.source === 'Glasses gallery'
      ? 'saved on glasses'
      : details.state === 'acknowledged'
        ? 'acknowledged'
        : 'preview ready',
  ].filter(Boolean).join(' · ');
}

type DetailRow = {label: string; value: string};
type DetailRowTone = 'default' | 'warning';

function photoDetailsRows(details: PhotoPreviewDetails | null) {
  if (!details) {
    return [{label: 'Status', value: 'No photo metadata received yet'}];
  }
  const rows: Array<DetailRow & {tone?: DetailRowTone}> = [
    {label: 'Source', value: details.source},
    {
      label: 'State',
      value:
        details.source === 'Glasses gallery' && details.state === 'acknowledged'
          ? 'saved on glasses'
          : details.state,
    },
  ];
  if (details.source === 'Glasses gallery') {
    rows.push({
      label: 'Gallery mode',
      value: 'Photo stayed on the glasses and was not previewed on the phone.',
      tone: 'warning',
    });
  }
  if (details.bleFallbackMessage) {
    rows.push({label: 'Bluetooth fallback', value: details.bleFallbackMessage, tone: 'warning'});
  }
  if (details.requestId) rows.push({label: 'Request ID', value: details.requestId});
  if (details.byteCount) rows.push({label: 'Size', value: formatBytes(details.byteCount)});
  if (details.width && details.height) rows.push({label: 'Dimensions', value: `${details.width} x ${details.height}`});
  if (details.estimatedFov) rows.push({label: 'Estimated FOV', value: formatFovEstimate(details.estimatedFov)});
  else if (details.focalLength35mm) rows.push({label: 'Focal length', value: `${details.focalLength35mm}mm equiv.`});
  addActualCaptureRows(rows, details.captureMetadata);
  addRequestedCaptureRows(rows, details.requestedCaptureConfig);
  addMeteredPreviewRows(rows, details.meteredPreview);
  addResolvedConfigRows(rows, details.resolvedConfig);
  if (details.contentType) rows.push({label: 'Content type', value: details.contentType});
  if (details.uploadUrl) rows.push({label: 'Upload URL', value: details.uploadUrl});
  if (details.previewUrl) rows.push({label: 'Preview URL', value: details.previewUrl});
  if (details.timestamp) rows.push({label: 'SDK timestamp', value: new Date(details.timestamp).toLocaleTimeString()});
  if (details.uploadedAt) rows.push({label: 'Uploaded at', value: details.uploadedAt});
  if (details.error) rows.push({label: 'Error', value: details.error});
  return rows;
}

function videoDetailsSummary(details: VideoPreviewDetails | null) {
  if (!details) {
    return 'Waiting for first video preview';
  }
  if (details.state === 'error') {
    return `Error · ${details.error ?? 'Video failed'}`;
  }
  return [
    details.source,
    details.byteCount ? formatBytes(details.byteCount) : null,
    details.durationMs ? formatDurationMs(details.durationMs) : null,
    details.status ? details.status.replace(/_/g, ' ') : details.state,
  ].filter(Boolean).join(' · ');
}

function videoDetailsRows(details: VideoPreviewDetails | null) {
  if (!details) {
    return [{label: 'Status', value: 'No video metadata received yet'}];
  }
  const rows: DetailRow[] = [
    {label: 'Source', value: details.source},
    {label: 'State', value: details.state},
  ];
  if (details.status) rows.push({label: 'SDK status', value: details.status});
  if (details.requestId) rows.push({label: 'Request ID', value: details.requestId});
  if (details.durationMs) rows.push({label: 'Duration', value: formatDurationMs(details.durationMs)});
  if (details.byteCount) rows.push({label: 'Size', value: formatBytes(details.byteCount)});
  if (details.contentType) rows.push({label: 'Content type', value: details.contentType});
  if (details.uploadUrl) rows.push({label: 'Upload URL', value: details.uploadUrl});
  if (details.mediaUrl) rows.push({label: 'SDK media URL', value: details.mediaUrl});
  if (details.previewUrl) rows.push({label: 'Preview URL', value: details.previewUrl});
  if (details.timestamp) rows.push({label: 'SDK timestamp', value: new Date(details.timestamp).toLocaleTimeString()});
  if (details.uploadedAt) rows.push({label: 'Uploaded at', value: details.uploadedAt});
  if (details.error) rows.push({label: 'Error', value: details.error});
  return rows;
}

const AE_MODE_LABELS: Record<number, string> = {
  0: 'OFF',
  1: 'ON',
  2: 'ON_AUTO_FLASH',
  3: 'ON_ALWAYS_FLASH',
  4: 'ON_AUTO_FLASH_REDEYE',
  5: 'ON_EXTERNAL_FLASH',
};

const AF_MODE_LABELS: Record<number, string> = {
  0: 'OFF',
  1: 'AUTO',
  2: 'MACRO',
  3: 'CONTINUOUS_VIDEO',
  4: 'CONTINUOUS_PICTURE',
  5: 'EDOF',
};

const EDGE_MODE_LABELS: Record<number, string> = {
  0: 'OFF',
  1: 'FAST',
  2: 'HIGH_QUALITY',
  3: 'ZERO_SHUTTER_LAG',
};

const NOISE_REDUCTION_MODE_LABELS: Record<number, string> = {
  0: 'OFF',
  1: 'FAST',
  2: 'HIGH_QUALITY',
  3: 'MINIMAL',
  4: 'ZERO_SHUTTER_LAG',
};

function addResolvedConfigRows(rows: DetailRow[], config: PhotoPreviewDetails['resolvedConfig']) {
  if (!config) {
    return;
  }
  if (config.format) rows.push({label: 'Resolved format', value: String(config.format)});
  if (config.width && config.height) rows.push({label: 'Resolved dimensions', value: `${config.width} x ${config.height}`});
  if (config.quality != null) rows.push({label: 'Resolved quality', value: String(config.quality)});
  if (config.requestedSize) rows.push({label: 'Requested size', value: String(config.requestedSize)});
  if (config.source) rows.push({label: 'Request source', value: String(config.source)});
  if (config.transferMethod) rows.push({label: 'Transfer method', value: String(config.transferMethod)});
  if (config.compression) rows.push({label: 'Compression', value: String(config.compression)});
  if (config.saveToGallery != null) rows.push({label: 'Save to gallery', value: boolLabel(config.saveToGallery)});
  if (config.exposureTimeNs != null) rows.push({label: 'Resolved exposure', value: formatExposureNs(config.exposureTimeNs)});
  if (config.iso != null) rows.push({label: 'Resolved ISO', value: String(config.iso)});
}

function addRequestedCaptureRows(rows: DetailRow[], config: PhotoPreviewDetails['requestedCaptureConfig']) {
  if (!config) {
    return;
  }
  if (config.manual != null) rows.push({label: 'Requested mode', value: config.manual ? 'manual' : 'auto'});
  if (config.exposureTimeNs != null) rows.push({label: 'Requested exposure', value: formatExposureNs(config.exposureTimeNs)});
  if (config.iso != null) rows.push({label: 'Requested ISO', value: String(config.iso)});
  if (config.frameDurationNs != null) rows.push({label: 'Requested frame', value: formatFrameDurationNs(config.frameDurationNs)});
  if (config.aeMode != null) rows.push({label: 'Requested AE mode', value: cameraModeLabel(config.aeMode, AE_MODE_LABELS)});
  if (config.aeLock != null) rows.push({label: 'Requested AE lock', value: boolLabel(config.aeLock)});
  if (config.aeExposureCompensation != null) rows.push({label: 'Requested AE comp', value: String(config.aeExposureCompensation)});
  if (config.aeTargetFpsRange?.min != null && config.aeTargetFpsRange?.max != null) {
    rows.push({label: 'Requested AE FPS', value: `${config.aeTargetFpsRange.min}-${config.aeTargetFpsRange.max} fps`});
  }
  if (config.noiseReductionMode != null) {
    rows.push({label: 'Requested NR mode', value: cameraModeLabel(config.noiseReductionMode, NOISE_REDUCTION_MODE_LABELS)});
  }
  if (config.edgeMode != null) rows.push({label: 'Requested edge mode', value: cameraModeLabel(config.edgeMode, EDGE_MODE_LABELS)});
  if (config.afMode != null) rows.push({label: 'Requested AF mode', value: cameraModeLabel(config.afMode, AF_MODE_LABELS)});
  if (config.zsl != null) rows.push({label: 'Requested ZSL', value: boolLabel(config.zsl)});
}

function addMeteredPreviewRows(rows: DetailRow[], config: PhotoPreviewDetails['meteredPreview']) {
  if (!config) {
    return;
  }
  if (config.exposureTimeNs != null) rows.push({label: 'Metered exposure', value: formatExposureNs(config.exposureTimeNs)});
  if (config.iso != null) rows.push({label: 'Metered ISO', value: String(config.iso)});
  if (config.totalLightProxy != null) rows.push({label: 'Metered light proxy', value: formatDecimal(config.totalLightProxy)});
}

function addActualCaptureRows(rows: DetailRow[], config: PhotoPreviewDetails['captureMetadata']) {
  if (!config) {
    return;
  }
  if (config.manual != null) rows.push({label: 'Actual mode', value: config.manual ? 'manual' : 'auto'});
  if (config.exposureTimeNs != null) rows.push({label: 'Actual exposure', value: formatExposureNs(config.exposureTimeNs)});
  if (config.iso != null) rows.push({label: 'Actual ISO', value: String(config.iso)});
  if (config.frameDurationNs != null) rows.push({label: 'Actual frame', value: formatFrameDurationNs(config.frameDurationNs)});
  if (config.aeMode != null) rows.push({label: 'Actual AE mode', value: cameraModeLabel(config.aeMode, AE_MODE_LABELS)});
  if (config.aeStateName || config.aeState != null) rows.push({label: 'Actual AE state', value: aeStateLabel(config)});
  if (config.noiseReductionMode != null) {
    rows.push({label: 'Actual NR mode', value: cameraModeLabel(config.noiseReductionMode, NOISE_REDUCTION_MODE_LABELS)});
  }
  if (config.edgeMode != null) rows.push({label: 'Actual edge mode', value: cameraModeLabel(config.edgeMode, EDGE_MODE_LABELS)});
  if (config.zsl != null) rows.push({label: 'Actual ZSL', value: boolLabel(config.zsl)});
  if (config.sensorTimestampNs != null) rows.push({label: 'Sensor timestamp', value: `${config.sensorTimestampNs} ns`});
  if (config.totalLightProxy != null) rows.push({label: 'Actual light proxy', value: formatDecimal(config.totalLightProxy)});
  if (config.mfnrLikely != null) rows.push({label: 'MFNR likely', value: boolLabel(config.mfnrLikely)});
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDurationMs(ms: number) {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function formatFovEstimate(fov: NonNullable<PhotoPreviewDetails['estimatedFov']>) {
  return [
    `${Math.round(fov.diagonalDegrees)}° diag`,
    `${Math.round(fov.horizontalDegrees)}° H`,
    `${Math.round(fov.verticalDegrees)}° V`,
    `${fov.focalLength35mm}mm equiv.`,
  ].join(' · ');
}

function boolLabel(value: boolean) {
  return value ? 'yes' : 'no';
}

function cameraModeLabel(value: number, labels: Record<number, string>) {
  return labels[value] ? `${labels[value]} (${value})` : String(value);
}

function aeStateLabel(config: NonNullable<PhotoPreviewDetails['captureMetadata']>) {
  if (config.aeStateName && config.aeState != null) {
    return `${config.aeStateName} (${config.aeState})`;
  }
  return config.aeStateName ?? String(config.aeState);
}

function formatExposureNs(ns: number) {
  return `${compactExposureLabel(ns)} · ${(ns / 1_000_000).toFixed(2)}ms`;
}

function formatFrameDurationNs(ns: number) {
  const fps = ns > 0 ? 1_000_000_000 / ns : 0;
  return `${(ns / 1_000_000).toFixed(2)}ms · ${fps.toFixed(1)} fps`;
}

function formatDecimal(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
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
    normalized.includes('connect the glasses to wi-fi') ||
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
  return 'Local setup: run python3 examples/local-demo-cloud/server.py from the Starter Kit repo root, then paste the printed Media upload URL here. It looks like http://<computer-ip>:8787/upload.';
}

function OptionGroup({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <View style={styles.optionGroup}>
      <Text style={styles.optionLabel}>{label}</Text>
      <View style={styles.chipRow}>{children}</View>
    </View>
  );
}

function Chip({ active, disabled = false, onPress, value }: { active: boolean; disabled?: boolean; onPress: () => void; value: string }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.chip, active && styles.chipActive, disabled && styles.chipDisabled]}>
      <Text style={[styles.chipValue, active && styles.chipValueActive]}>{value}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cameraButtonNoticeWrap: { alignItems: 'flex-end', marginTop: -2, marginHorizontal: 16, marginBottom: 6 },
  cameraButtonNotice: { maxWidth: 260, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,59,48,0.28)', backgroundColor: 'rgba(255,59,48,0.1)', paddingVertical: 8, paddingHorizontal: 10 },
  cameraButtonNoticeText: { color: colors.red, fontSize: 11, fontWeight: '800', lineHeight: 15, textAlign: 'right' },
  modeSelectorWrap: { marginHorizontal: 16, marginTop: 8 },
  modeSelector: { flexDirection: 'row', gap: 6, borderRadius: 16, backgroundColor: 'rgba(15,42,29,0.05)', padding: 4, borderWidth: 1, borderColor: 'rgba(15,42,29,0.08)' },
  modeButton: { flex: 1, minHeight: 42, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  modeButtonActive: { backgroundColor: '#fff', borderWidth: 1, borderColor: 'rgba(15,42,29,0.08)' },
  modeButtonText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  modeButtonTextActive: { color: colors.ink },
  card: { marginHorizontal: 16, marginTop: 8, borderRadius: 28, paddingTop: 8, paddingBottom: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8 },
  captureModeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingTop: 4, paddingBottom: 10 },
  previewWrap: { borderRadius: 22, overflow: 'hidden', height: 160 },
  preview: { flex: 1 },
  previewImage: { ...StyleSheet.absoluteFillObject },
  previewTapLayer: { ...StyleSheet.absoluteFillObject, zIndex: 2 },
  previewGlow: { position: 'absolute', top: 30, right: 50, width: 80, height: 80, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.55)' },
  previewBottomShade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 90, backgroundColor: 'rgba(0,0,0,0.25)' },
  previewBadge: { position: 'absolute', bottom: 14, left: 14, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.35)', paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  previewBadgeText: { color: '#fff', fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  previewMeta: { position: 'absolute', bottom: 14, right: 14, color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '500' },
  previewOpenBadge: { position: 'absolute', right: 12, bottom: 12, zIndex: 3, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.42)', borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', paddingVertical: 7, paddingHorizontal: 11 },
  previewOpenText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  previewStatusOverlay: { position: 'absolute', left: 12, right: 12, bottom: 12, zIndex: 4, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', backgroundColor: 'rgba(8,24,16,0.74)', paddingVertical: 10, paddingHorizontal: 12 },
  previewStatusOverlayFailed: { backgroundColor: 'rgba(95,18,18,0.76)', borderColor: 'rgba(255,255,255,0.22)' },
  previewStatusLine: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  previewStatusText: { flex: 1, color: '#fff', fontSize: 13, fontWeight: '800' },
  previewStatusDetail: { color: 'rgba(255,255,255,0.82)', fontSize: 11, fontWeight: '600', lineHeight: 15, marginTop: 5 },
  previewFallbackWarning: { marginTop: 10, marginHorizontal: 6, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,59,48,0.3)', backgroundColor: 'rgba(255,59,48,0.1)', paddingVertical: 10, paddingHorizontal: 12 },
  previewFallbackWarningTitle: { color: colors.red, fontSize: 12, fontWeight: '800' },
  previewFallbackWarningText: { color: colors.red, fontSize: 11, fontWeight: '600', lineHeight: 15, marginTop: 3 },
  barcodeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 10, marginHorizontal: 6, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(15,42,29,0.08)', backgroundColor: 'rgba(15,42,29,0.04)', paddingVertical: 10, paddingHorizontal: 12 },
  barcodeRowScanning: { borderColor: 'rgba(52,199,89,0.24)', backgroundColor: 'rgba(52,199,89,0.08)' },
  barcodeRowFound: { borderColor: 'rgba(52,199,89,0.32)', backgroundColor: 'rgba(52,199,89,0.12)' },
  barcodeRowError: { borderColor: 'rgba(255,59,48,0.24)', backgroundColor: 'rgba(255,59,48,0.09)' },
  barcodeResultList: { gap: 7, marginTop: 8 },
  barcodeResultItem: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.42)', paddingVertical: 8, paddingHorizontal: 9 },
  barcodeResultTextWrap: { flex: 1, minWidth: 0 },
  barcodeCopyBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(52,199,89,0.26)', backgroundColor: 'rgba(255,255,255,0.5)', paddingVertical: 7, paddingHorizontal: 9 },
  barcodeCopyText: { color: colors.greenAccent, fontSize: 11, fontWeight: '700' },
  barcodeTitle: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  barcodeValue: { color: colors.ink, fontSize: 11, fontWeight: '700', lineHeight: 15, marginTop: 2 },
  barcodeMeta: { color: colors.muted, fontSize: 10, fontWeight: '600', lineHeight: 14, marginTop: 2 },
  captureBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 18, paddingVertical: 16, marginTop: 14, marginHorizontal: 6, gap: 10 },
  scanModeBelowCapture: { marginTop: 12, marginHorizontal: 6 },
  captureText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 },

  videoCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, paddingTop: 14, paddingBottom: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.borderSoft },
  videoStateText: { color: colors.greenAccent, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  videoPreviewWrap: { borderRadius: 18, overflow: 'hidden', height: 170, marginTop: 12, backgroundColor: '#101820' },
  videoPlaceholder: { flex: 1 },
  videoPreviewPlayer: { flex: 1, backgroundColor: '#101820' },
  videoPreviewFill: { flex: 1 },
  videoPlaybackControls: { position: 'absolute', left: 10, right: 10, bottom: 10, minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', backgroundColor: 'rgba(6,16,20,0.72)', paddingVertical: 7, paddingHorizontal: 8 },
  videoPlaybackButton: { width: 28, height: 28, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  videoPlaybackTime: { width: 38, color: '#fff', fontSize: 10, fontWeight: '700', textAlign: 'center' },
  videoPlaybackTrack: { flex: 1, height: 28, justifyContent: 'center' },
  videoPlaybackTrackBase: { position: 'absolute', left: 0, right: 0, height: 5, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.2)' },
  videoPlaybackTrackFill: { position: 'absolute', left: 0, height: 5, borderRadius: 999, backgroundColor: colors.greenSoft },
  videoPlaybackThumb: { position: 'absolute', marginLeft: -7, width: 14, height: 14, borderRadius: 999, backgroundColor: '#fff', borderWidth: 2, borderColor: colors.greenSoft },
  videoDetailsPanel: { marginTop: 12, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(15,42,29,0.08)', backgroundColor: 'rgba(15,42,29,0.04)', paddingVertical: 12, paddingHorizontal: 12 },

  sdkCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, overflow: 'hidden', borderWidth: 1, borderColor: colors.borderSoft },
  sdkBlock: { backgroundColor: '#0E1A14', paddingVertical: 14, paddingHorizontal: 16, gap: 8 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sdkEyebrow: { color: colors.greenAccent, fontSize: 9, fontWeight: '700', letterSpacing: 1.1 },
  copyChip: { flexDirection: 'row', alignItems: 'center', minHeight: 36, gap: 5, backgroundColor: 'rgba(255,255,255,0.06)', paddingVertical: 7, paddingHorizontal: 10, borderRadius: 9 },
  copyChipPressed: { opacity: 0.6 },
  copyText: { color: colors.consoleText, fontSize: 12, fontWeight: '600' },
  sdkCode: { color: colors.consoleText, fontSize: 11, lineHeight: 16, fontFamily: 'Courier' },

  statusBar: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, gap: 10 },
  statusIconCircle: { width: 22, height: 22, borderRadius: 999, backgroundColor: 'rgba(52,199,89,0.16)', alignItems: 'center', justifyContent: 'center' },
  statusIconCircleError: { backgroundColor: 'rgba(255,59,48,0.16)' },
  statusTitle: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  statusSub: { color: colors.muted, fontSize: 11, fontWeight: '500' },
  linkRight: { color: colors.muted, fontSize: 12, fontWeight: '600' },

  detailsCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.borderSoft },
  detailsHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  detailsSummary: { color: colors.ink, fontSize: 12, fontWeight: '600', marginTop: 4 },
  detailsChevron: { color: colors.greenAccent, fontSize: 12, fontWeight: '700' },
  detailsBody: { marginTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(15,42,29,0.08)', paddingTop: 8 },
  detailsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 5, gap: 12 },
  detailsLabel: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  detailsLabelWarning: { color: colors.red },
  detailsValue: { color: colors.ink, fontSize: 12, fontWeight: '600', textAlign: 'right', flexShrink: 1 },
  detailsValueWarning: { color: colors.red },

  uploadCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, paddingVertical: 16, paddingHorizontal: 18, gap: 12, borderWidth: 1, borderColor: colors.borderSoft },
  eyebrow: { color: colors.muted, fontSize: 10, fontWeight: '600', letterSpacing: 1.2 },
  cloudToggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 9, paddingHorizontal: 12 },
  cloudToggleLabel: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  fixedDestinationBadge: { minHeight: 24, borderRadius: 999, backgroundColor: 'rgba(52,199,89,0.14)', paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  fixedDestinationBadgeText: { color: colors.greenAccent, fontSize: 11, fontWeight: '800' },
  modeHint: { flex: 1, color: colors.muted, fontSize: 12, fontWeight: '500', lineHeight: 16 },
  urlBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  setupHint: { color: colors.muted, fontSize: 12, fontWeight: '500', lineHeight: 16, backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 },
  method: { color: colors.greenAccent, fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  divider: { width: 1, height: 14, backgroundColor: 'rgba(15,42,29,0.12)' },
  url: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '500' },
  optionGroup: { gap: 6 },
  optionLabel: { color: colors.muted, fontSize: 11, fontWeight: '600', letterSpacing: 1.1, textTransform: 'uppercase' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 6, backgroundColor: 'rgba(255,255,255,0.6)', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(15,42,29,0.06)' },
  chipActive: { backgroundColor: 'rgba(52,199,89,0.16)', borderColor: 'rgba(52,199,89,0.32)' },
  chipDisabled: { opacity: 0.45 },
  chipValue: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  chipValueActive: { color: colors.greenAccent },
  settingCard: { backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 14, padding: 14, gap: 8 },
  settingHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  isoHeader: { paddingTop: 6 },
  settingLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase' },
  settingHint: { color: colors.greenAccent, fontSize: 12, fontWeight: '700', marginTop: 2 },
  settingDescription: { color: colors.muted, fontSize: 11, fontWeight: '600', lineHeight: 16 },
  settingRangeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingRangeText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  applyChip: { borderRadius: 999, backgroundColor: 'rgba(52,199,89,0.16)', borderWidth: 1, borderColor: 'rgba(52,199,89,0.28)', paddingHorizontal: 12, paddingVertical: 8 },
  applyChipText: { color: colors.greenAccent, fontSize: 12, fontWeight: '800' },
  sliderControlRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sliderTrack: { flex: 1, height: 40, justifyContent: 'center' },
  sliderDisabled: { opacity: 0.45 },
  sliderTrackBase: { position: 'absolute', left: 0, right: 0, height: 8, borderRadius: 999, backgroundColor: 'rgba(15,42,29,0.12)' },
  sliderTrackFill: { position: 'absolute', left: 0, height: 8, borderRadius: 999, backgroundColor: colors.greenAccent },
  sliderThumb: { position: 'absolute', marginLeft: -14, width: 28, height: 28, borderRadius: 999, backgroundColor: '#fff', borderWidth: 2, borderColor: colors.greenAccent, shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 5, shadowOffset: {width: 0, height: 2} },
  sliderStepButton: { width: 34, height: 34, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.78)', borderWidth: 1, borderColor: 'rgba(15,42,29,0.08)' },
  sliderStepButtonDisabled: { opacity: 0.4 },
  sliderStepText: { color: colors.ink, fontSize: 18, lineHeight: 20, fontWeight: '800' },
  sliderStepTextDisabled: { color: colors.muted },
});
