import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Image, TextInput, Clipboard, Switch, PanResponder, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
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
  type BluetoothSdkExampleModel,
  type PhotoCompression,
  type PhotoPreviewDetails,
  type PhotoSize,
} from '../useBluetoothSdkExample';

const PHOTO_EXPOSURE_STEP_NS = 500_000;
const PHOTO_ISO_STEP = 50;
const CAMERA_FOV_STEP = 1;

function cameraSdkCall(
  size: PhotoSize,
  compression: PhotoCompression,
  useCloudServer: boolean,
  exposureManual: boolean,
  exposureTimeNs: number,
  iso: number,
  cameraFov: number,
  cameraRoiPosition: number,
) {
  const exposureLine = exposureManual ? `  exposureTimeNs: ${exposureTimeNs},` : '  exposureTimeNs: null, // auto exposure';
  const isoLine = exposureManual ? `  iso: ${iso},` : '  iso: null, // auto ISO';
  const prefix = `await BluetoothSdk.setCameraFov({ fov: ${cameraFov}, roiPosition: ${cameraRoiPosition} });
// Mentra Live restarts the camera for about 5s after FOV/ROI changes.
`;
  if (!useCloudServer) {
    return `${prefix}const { uploadUrl } = await MentraPhotoReceiver.startPhotoReceiver();
await BluetoothSdk.requestPhoto({
  requestId,
  appId: PHOTO_APP_ID,
  size: "${size}",
  webhookUrl: uploadUrl,
  authToken: null,
  compress: "${compression}",
  sound: true,
${exposureLine}
${isoLine}
})`;
  }
  return `${prefix}await BluetoothSdk.requestPhoto({
  requestId,
  appId: PHOTO_APP_ID,
  size: "${size}",
  webhookUrl,
  authToken: null,
  compress: "${compression}",
  sound: true,
${exposureLine}
${isoLine}
})`;
}

export function CameraScreen({ sdk }: { sdk: BluetoothSdkExampleModel }) {
  const scrollBottomPadding = useScrollBottomPadding();
  const [photoDetailsExpanded, setPhotoDetailsExpanded] = React.useState(false);
  const connected = isGlassesConnected(sdk.glasses);
  const glassesWifiConnected = isGlassesWifiConnected(sdk.glasses);
  const wifiRequired = connected && !glassesWifiConnected;
  const cameraStatusFailed = isCameraStatusFailure(sdk.cameraStatus);
  const photoStatusOverlay = photoStatusOverlayInfo(sdk.photoStatus, sdk.photoPreviewUrl);
  const setupHint = sdk.photoCloudServerEnabled ? localCameraSetupHint(sdk.webhookUrl, sdk.cameraStatus) : null;
  const sdkCall = cameraSdkCall(
    sdk.photoSize,
    sdk.photoCompression,
    sdk.photoCloudServerEnabled,
    sdk.photoExposureManual,
    sdk.photoExposureTimeNs,
    sdk.photoIso,
    sdk.cameraFov,
    sdk.cameraRoiPosition,
  );

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

      {/* Preview card */}
      <LinearGradient colors={['rgba(255,255,255,0.78)', 'rgba(255,255,255,0.55)']} style={styles.card}>
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
                : sdk.activeAction === 'Capture & upload'
                  ? 'Capturing…'
                  : 'Capture photo'}
            </Text>
          </LinearGradient>
        </Pressable>
        <Pressable onPress={sdk.loadTestBarcodePreview} style={({pressed}) => [styles.testBarcodeBtn, pressed && styles.testBarcodeBtnPressed]}>
          <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={colors.greenAccent} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M3 5v14" />
            <Path d="M7 5v14" />
            <Path d="M11 5v14" />
            <Path d="M17 5v14" />
            <Path d="M21 5v14" />
          </Svg>
          <Text style={styles.testBarcodeText}>Test barcode</Text>
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

      <PhotoDetailsCard
        details={sdk.photoPreviewDetails}
        expanded={photoDetailsExpanded}
        onToggle={() => setPhotoDetailsExpanded((value) => !value)}
      />

      {/* Upload to */}
      <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.uploadCard}>
        <View style={styles.cardHead}>
          <Text style={styles.eyebrow}>UPLOAD TO</Text>
          {sdk.photoCloudServerEnabled ? (
            <Pressable onPress={sdk.testWebhook}>
              {({pressed}) => (
                <Text style={[styles.linkRight, { color: colors.greenAccent, opacity: pressed ? 0.6 : 1 }]}>test webhook</Text>
              )}
            </Pressable>
          ) : null}
        </View>
        <View style={styles.cloudToggleRow}>
          <Text style={styles.cloudToggleLabel}>Use cloud server</Text>
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
              <Text style={styles.modeHint}>Cloud server receives the JPEG upload.</Text>
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
        <ExposureControl
          enabled={sdk.photoExposureManual}
          onEnabledChange={sdk.setPhotoExposureManual}
          onIsoChange={sdk.setPhotoIso}
          onValueChange={sdk.setPhotoExposureTimeNs}
          iso={sdk.photoIso}
          value={sdk.photoExposureTimeNs}
        />
        <CameraSettingsControl
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
  expanded,
  onToggle,
}: {
  details: PhotoPreviewDetails | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const rows = photoDetailsRows(details);
  return (
    <LinearGradient colors={['rgba(255,255,255,0.74)', 'rgba(255,255,255,0.52)']} style={styles.detailsCard}>
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
              <Text style={styles.detailsLabel}>{row.label}</Text>
              <Text style={styles.detailsValue}>{row.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </LinearGradient>
  );
}

type PhotoStatusEvent = NonNullable<BluetoothSdkExampleModel['photoStatus']>;

function photoStatusOverlayInfo(status: PhotoStatusEvent | null, previewUrl: string | null) {
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
      : photoResolvedConfigDetail(status.resolvedConfig),
    failed,
    title: photoStatusTitle(status),
  };
}

function photoStatusTitle(status: PhotoStatusEvent) {
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

function ExposureControl({
  enabled,
  onEnabledChange,
  onIsoChange,
  onValueChange,
  iso,
  value,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onIsoChange: (iso: number) => void;
  onValueChange: (value: number) => void;
  iso: number;
  value: number;
}) {
  return (
    <View style={styles.settingCard}>
      <View style={styles.settingHeader}>
        <View>
          <Text style={styles.settingLabel}>EXPOSURE</Text>
          <Text style={styles.settingHint}>{enabled ? exposureLabel(value) : 'Auto exposure'}</Text>
        </View>
        <Switch
          ios_backgroundColor="rgba(15,42,29,0.18)"
          onValueChange={onEnabledChange}
          thumbColor="#fff"
          trackColor={{false: 'rgba(15,42,29,0.18)', true: colors.greenAccent}}
          value={enabled}
        />
      </View>
      <RangeSlider
        disabled={!enabled}
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
        disabled={!enabled}
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
  fov,
  onApply,
  onFovChange,
  onRoiChange,
  roiPosition,
  status,
}: {
  fov: number;
  onApply: () => Promise<void>;
  onFovChange: (fov: number) => void;
  onRoiChange: (roiPosition: (typeof CAMERA_ROI_POSITIONS)[number]['value']) => void;
  roiPosition: (typeof CAMERA_ROI_POSITIONS)[number]['value'];
  status: string;
}) {
  const roiDisabled = fov === CAMERA_FOV_MAX;
  return (
    <View style={styles.settingCard}>
      <View style={styles.settingHeader}>
        <View>
          <Text style={styles.settingLabel}>FIELD OF VIEW</Text>
          <Text style={styles.settingHint}>{fov}° · {roiDisabled ? 'full sensor' : `${roiLabel(roiPosition)} crop`}</Text>
        </View>
        <Pressable onPress={() => void onApply()} style={({pressed}) => [styles.applyChip, pressed && styles.copyChipPressed]}>
          <Text style={styles.applyChipText}>Apply</Text>
        </Pressable>
      </View>
      <RangeSlider
        disabled={false}
        max={CAMERA_FOV_MAX}
        min={CAMERA_FOV_MIN}
        onChange={onFovChange}
        step={CAMERA_FOV_STEP}
        value={fov}
      />
      <View style={styles.settingRangeRow}>
        <Text style={styles.settingRangeText}>{CAMERA_FOV_MIN}°</Text>
        <Pressable onPress={() => onFovChange(CAMERA_FOV_DEFAULT)}>
          <Text style={styles.settingHint}>Default {CAMERA_FOV_DEFAULT}°</Text>
        </Pressable>
        <Text style={styles.settingRangeText}>{CAMERA_FOV_MAX}°</Text>
      </View>
      <OptionGroup label="crop position">
        {CAMERA_ROI_POSITIONS.map((option) => (
          <Chip
            key={option.value}
            active={roiPosition === option.value}
            disabled={roiDisabled}
            value={option.label}
            onPress={() => onRoiChange(option.value)}
          />
        ))}
      </OptionGroup>
      <Text style={styles.settingDescription}>{status}. Applying FOV/ROI restarts the Mentra Live camera for about 5 seconds.</Text>
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

function BarcodeResult({scan}: {scan: BluetoothSdkExampleModel['barcodeScan']}) {
  if (scan.state === 'idle') {
    return null;
  }

  const foundValues = scan.barcodes
    .map((barcode) => barcode.rawValue ?? barcode.displayValue)
    .filter((value): value is string => Boolean(value));
  const copyValue = foundValues.join('\n');
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
  const body = isFound
    ? foundValues.join(' · ')
    : isError
      ? scan.error ?? 'Scanner failed'
      : isScanning
        ? 'Analyzing photo preview...'
        : 'Photo preview scanned';

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
        <Text style={styles.barcodeValue}>{body}</Text>
      </View>
      {isFound && copyValue ? (
        <Pressable
          hitSlop={8}
          onPress={() => Clipboard.setString(copyValue)}
          style={({pressed}) => [styles.barcodeCopyBtn, pressed && styles.copyChipPressed]}>
          <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.greenAccent} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M8 8h11v13H8z" />
            <Path d="M5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1" />
          </Svg>
          <Text style={styles.barcodeCopyText}>Copy</Text>
        </Pressable>
      ) : null}
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
    details.state === 'acknowledged' ? 'acknowledged' : 'preview ready',
  ].filter(Boolean).join(' · ');
}

function photoDetailsRows(details: PhotoPreviewDetails | null) {
  if (!details) {
    return [{label: 'Status', value: 'No photo metadata received yet'}];
  }
  const rows: Array<{label: string; value: string}> = [
    {label: 'Source', value: details.source},
    {label: 'State', value: details.state},
  ];
  if (details.requestId) rows.push({label: 'Request ID', value: details.requestId});
  if (details.byteCount) rows.push({label: 'Size', value: formatBytes(details.byteCount)});
  if (details.width && details.height) rows.push({label: 'Dimensions', value: `${details.width} x ${details.height}`});
  if (details.estimatedFov) rows.push({label: 'Estimated FOV', value: formatFovEstimate(details.estimatedFov)});
  else if (details.focalLength35mm) rows.push({label: 'Focal length', value: `${details.focalLength35mm}mm equiv.`});
  if (details.contentType) rows.push({label: 'Content type', value: details.contentType});
  if (details.uploadUrl) rows.push({label: 'Upload URL', value: details.uploadUrl});
  if (details.previewUrl) rows.push({label: 'Preview URL', value: details.previewUrl});
  if (details.timestamp) rows.push({label: 'SDK timestamp', value: new Date(details.timestamp).toLocaleTimeString()});
  if (details.uploadedAt) rows.push({label: 'Uploaded at', value: details.uploadedAt});
  if (details.error) rows.push({label: 'Error', value: details.error});
  return rows;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatFovEstimate(fov: NonNullable<PhotoPreviewDetails['estimatedFov']>) {
  return [
    `${Math.round(fov.diagonalDegrees)}° diag`,
    `${Math.round(fov.horizontalDegrees)}° H`,
    `${Math.round(fov.verticalDegrees)}° V`,
    `${fov.focalLength35mm}mm equiv.`,
  ].join(' · ');
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
  return 'Local setup: run python3 examples/local-demo-cloud/server.py from the Starter Kit repo root, then paste the printed Photo upload URL here. It looks like http://<computer-ip>:8787/upload.';
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
  card: { marginHorizontal: 16, marginTop: 8, borderRadius: 28, paddingTop: 8, paddingBottom: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8 },
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
  barcodeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, marginHorizontal: 6, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(15,42,29,0.08)', backgroundColor: 'rgba(15,42,29,0.04)', paddingVertical: 10, paddingHorizontal: 12 },
  barcodeRowScanning: { borderColor: 'rgba(52,199,89,0.24)', backgroundColor: 'rgba(52,199,89,0.08)' },
  barcodeRowFound: { borderColor: 'rgba(52,199,89,0.32)', backgroundColor: 'rgba(52,199,89,0.12)' },
  barcodeRowError: { borderColor: 'rgba(255,59,48,0.24)', backgroundColor: 'rgba(255,59,48,0.09)' },
  barcodeCopyBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(52,199,89,0.26)', backgroundColor: 'rgba(255,255,255,0.5)', paddingVertical: 7, paddingHorizontal: 9 },
  barcodeCopyText: { color: colors.greenAccent, fontSize: 11, fontWeight: '700' },
  barcodeTitle: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  barcodeValue: { color: colors.muted, fontSize: 11, fontWeight: '600', lineHeight: 15, marginTop: 2 },
  captureBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 18, paddingVertical: 16, marginTop: 14, marginHorizontal: 6, gap: 10 },
  captureText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  testBarcodeBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(52,199,89,0.26)', backgroundColor: 'rgba(255,255,255,0.5)', paddingVertical: 12, marginTop: 8, marginHorizontal: 6, gap: 8 },
  testBarcodeBtnPressed: { opacity: 0.65 },
  testBarcodeText: { color: colors.greenAccent, fontSize: 13, fontWeight: '700' },
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
  detailsValue: { color: colors.ink, fontSize: 12, fontWeight: '600', textAlign: 'right', flexShrink: 1 },

  uploadCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 22, paddingVertical: 16, paddingHorizontal: 18, gap: 12, borderWidth: 1, borderColor: colors.borderSoft },
  eyebrow: { color: colors.muted, fontSize: 10, fontWeight: '600', letterSpacing: 1.2 },
  cloudToggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, backgroundColor: 'rgba(15,42,29,0.04)', borderRadius: 12, paddingVertical: 9, paddingHorizontal: 12 },
  cloudToggleLabel: { color: colors.ink, fontSize: 14, fontWeight: '600' },
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
