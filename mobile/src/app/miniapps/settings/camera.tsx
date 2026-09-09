import {getModelCapabilities} from "@mentra/engine"
import {useEffect} from "react"
import {View, ScrollView, ViewStyle, TextStyle} from "react-native"

import {Text, Screen, Header} from "@/components/ignite"
import {OptionList} from "@/components/ui/Options"
import {ThemedSlider} from "@/components/settings/ThemedSlider"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import Toast from "react-native-toast-message"
import {SETTINGS, useSetting} from "@mentra/engine"
import {spacing, ThemedStyle} from "@/theme"
import {engine} from "@mentra/engine"

type PhotoSize = "low" | "medium" | "high" | "max"
// The Mentra Live sensor only records 1080p/720p — 1440p/4K wedge the camera.
type VideoResolution = "720p" | "1080p"
type VideoFps = "30" | "15" | "5"
type MaxRecordingTime = "3m" | "5m" | "10m" | "15m" | "20m"
type CameraRoiPosition = 0 | 1 | 2 // 0=Center, 1=Bottom, 2=Top

const CAMERA_FOV_MIN = 62
const CAMERA_FOV_MAX = 118

const PHOTO_SIZE_OPTIONS = [
  {key: "low" as PhotoSize, label: "Low (960×720)"},
  {key: "medium" as PhotoSize, label: "Medium (1440×1088)"},
  {key: "high" as PhotoSize, label: "High (3264×2448)"},
  {key: "max" as PhotoSize, label: "Max (4032×3024)"},
]

function normalizeButtonPhotoSize(value?: string): PhotoSize {
  switch (value) {
    case "small":
      return "low"
    case "large":
      return "high"
    case "low":
    case "medium":
    case "high":
    case "max":
      return value
    default:
      return "medium"
  }
}

const VIDEO_RESOLUTION_OPTIONS = [
  {key: "720p" as VideoResolution, label: "720p (1280×720)"},
  {key: "1080p" as VideoResolution, label: "1080p (1920×1080)"},
]

const VIDEO_FPS_OPTIONS = [
  {key: "30" as VideoFps, label: "30 fps"},
  {key: "15" as VideoFps, label: "15 fps"},
  {key: "5" as VideoFps, label: "5 fps"},
]

const MAX_RECORDING_TIME_OPTIONS = [
  {key: "3m" as MaxRecordingTime, label: "3 minutes"},
  {key: "5m" as MaxRecordingTime, label: "5 minutes"},
  {key: "10m" as MaxRecordingTime, label: "10 minutes"},
  {key: "15m" as MaxRecordingTime, label: "15 minutes"},
  {key: "20m" as MaxRecordingTime, label: "20 minutes"},
]

const ROI_POSITION_OPTIONS = [
  {key: "0", label: "Center"},
  {key: "1", label: "Bottom"},
  {key: "2", label: "Top"},
]

// The Mentra Live sensor only records 1080p/720p. Older installs may have
// persisted 1440p/4K button-video dimensions that the glasses now reject, so
// fold any stored/unknown resolution down to the nearest supported one before
// we echo it back to the device.
function normalizeVideoResolution(width?: number, height?: number): {width: number; height: number} {
  if (width === 1280 && height === 720) return {width: 1280, height: 720}
  // Everything else — incl. legacy 1440p/4K and unknowns — maps to 1080p.
  return {width: 1920, height: 1080}
}

export default function CameraSettingsScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationStore.getState()
  const [_devMode, _setDevMode] = useSetting(SETTINGS.debug_mode.key)
  const [storedPhotoSize, setPhotoSize] = useSetting(SETTINGS.button_photo_size.key)
  const photoSize = normalizeButtonPhotoSize(storedPhotoSize)
  const [videoSettings, setVideoSettings] = useSetting(SETTINGS.button_video_settings.key)
  const [maxRecordingTime, setMaxRecordingTime] = useSetting(SETTINGS.button_max_recording_time.key)
  const [cameraFovSetting, setCameraFovSetting] = useSetting(SETTINGS.camera_fov.key)
  const [postProcessing, setPostProcessing] = useSetting(SETTINGS.media_post_processing.key)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const glassesConnected =
    useEngineSnapshot(engine.glasses.status, (onChange) => engine.glasses.onStatus(onChange)).state === "connected"

  const currentFov: number =
    typeof cameraFovSetting?.fov === "number" &&
    cameraFovSetting.fov >= CAMERA_FOV_MIN &&
    cameraFovSetting.fov <= CAMERA_FOV_MAX
      ? Math.round(cameraFovSetting.fov)
      : CAMERA_FOV_MAX
  const currentRoi: CameraRoiPosition =
    typeof cameraFovSetting?.roi_position === "number" &&
    cameraFovSetting.roi_position >= 0 &&
    cameraFovSetting.roi_position <= 2
      ? (cameraFovSetting.roi_position as CameraRoiPosition)
      : 0

  // Derive video resolution from settings, normalizing legacy 1440p/4K down to
  // a supported option so the picker never highlights an unsupported value.
  const normalizedVideo = normalizeVideoResolution(videoSettings?.width, videoSettings?.height)
  const videoResolution: VideoResolution = normalizedVideo.width === 1280 ? "720p" : "1080p"

  // One-time migration: rewrite any persisted legacy 1440p/4K dimensions to a
  // supported resolution so the stored value and future sends stay consistent.
  // This only corrects the saved setting (no BLE push to the glasses — the
  // change handlers below do that when the user actually picks a value).
  useEffect(() => {
    if (!videoSettings) return
    const norm = normalizeVideoResolution(videoSettings.width, videoSettings.height)
    if (norm.width !== videoSettings.width || norm.height !== videoSettings.height) {
      setVideoSettings({width: norm.width, height: norm.height, fps: videoSettings.fps ?? 30})
    }
  }, [videoSettings, setVideoSettings])

  useEffect(() => {
    if (!storedPhotoSize) return
    const normalized = normalizeButtonPhotoSize(storedPhotoSize)
    if (normalized !== storedPhotoSize) {
      setPhotoSize(normalized)
    }
  }, [storedPhotoSize, setPhotoSize])

  // Derive video fps from settings (snap to the nearest offered option)
  const videoFps: VideoFps = (() => {
    const fps = videoSettings?.fps ?? 30
    if (fps <= 7) return "5"
    if (fps <= 22) return "15"
    return "30"
  })()

  // Derive max recording time key from stored number
  const maxRecordingTimeKey: MaxRecordingTime = maxRecordingTime ? (`${maxRecordingTime}m` as MaxRecordingTime) : "5m"

  const handlePhotoSizeChange = (size: PhotoSize) => {
    if (!glassesConnected) {
      console.log("Cannot change photo size - glasses not connected")
      return
    }
    setPhotoSize(size)
  }

  const handleVideoResolutionChange = (resolution: VideoResolution) => {
    if (!glassesConnected) {
      console.log("Cannot change video resolution - glasses not connected")
      return
    }
    const width = resolution === "1080p" ? 1920 : 1280
    const height = resolution === "1080p" ? 1080 : 720
    const fps = videoSettings?.fps ?? 30
    setVideoSettings({width, height, fps})
  }

  const handleVideoFpsChange = (fpsKey: VideoFps) => {
    if (!glassesConnected) {
      console.log("Cannot change video fps - glasses not connected")
      return
    }
    const {width, height} = normalizeVideoResolution(videoSettings?.width, videoSettings?.height)
    const fps = parseInt(fpsKey, 10)
    setVideoSettings({width, height, fps})
  }

  const handleMaxRecordingTimeChange = (time: MaxRecordingTime) => {
    if (!glassesConnected) {
      console.log("Cannot change max recording time - glasses not connected")
      return
    }
    const minutes = parseInt(time.replace("m", ""))
    setMaxRecordingTime(minutes)
  }

  const handleCameraFovChange = (fov: number, roiPosition: CameraRoiPosition) => {
    if (!glassesConnected) {
      console.log("Cannot change camera FOV - glasses not connected")
      return
    }
    try {
      const clampedFov = Math.round(Math.max(CAMERA_FOV_MIN, Math.min(CAMERA_FOV_MAX, fov)))
      const effectiveRoi = clampedFov === CAMERA_FOV_MAX ? 0 : roiPosition
      setCameraFovSetting({fov: clampedFov, roi_position: effectiveRoi})
    } catch (error) {
      console.error("Failed to update camera FOV:", error)
    }
  }

  const handleCameraFovSet = (fov: number, roiPosition: CameraRoiPosition) => {
    handleCameraFovChange(fov, roiPosition)
    Toast.show({type: "info", text1: translate("settings:cameraRestartBanner")})
  }

  // Check if glasses support camera button feature using capabilities
  const features = getModelCapabilities(defaultWearable)
  const supportsCameraButton = features?.hasButton && features?.hasCamera

  if (!supportsCameraButton) {
    return (
      <Screen preset="fixed">
        <Header leftIcon="chevron-left" onLeftPress={() => goBack()} title={translate("settings:cameraSettings")} />
        <View style={themed($emptyStateContainer)}>
          <Text style={themed($emptyStateText)}>Camera settings are not available for this device.</Text>
        </View>
      </Screen>
    )
  }

  const roiDisabled = currentFov === CAMERA_FOV_MAX

  return (
    <Screen preset="fixed">
      <Header leftIcon="chevron-left" onLeftPress={() => goBack()} title={translate("settings:cameraSettings")} />
      <ScrollView
        style={{marginRight: -theme.spacing.s4, paddingRight: theme.spacing.s4}}
        contentInsetAdjustmentBehavior="automatic">
        <View style={themed($section)}>
          <Text style={themed($sectionTitle)}>Action Button Photo Settings</Text>
          <Text style={themed($sectionSubtitle)}>Choose the resolution for photos taken with the action button.</Text>
          <OptionList options={PHOTO_SIZE_OPTIONS} selected={photoSize} onSelect={handlePhotoSizeChange} />
        </View>

        <View style={themed($section)}>
          <Text style={themed($sectionTitle)}>Action Button Video Settings</Text>
          <Text style={themed($sectionSubtitle)}>
            Choose the resolution for videos recorded with the action button.
          </Text>
          <OptionList
            options={VIDEO_RESOLUTION_OPTIONS}
            selected={videoResolution}
            onSelect={handleVideoResolutionChange}
          />
        </View>

        <View style={themed($section)}>
          <Text style={themed($sectionTitle)}>Action Button Video Frame Rate</Text>
          <Text style={themed($sectionSubtitle)}>Choose how many frames are captured per second.</Text>
          <OptionList options={VIDEO_FPS_OPTIONS} selected={videoFps} onSelect={handleVideoFpsChange} />
        </View>

        <View style={themed($section)}>
          <Text style={themed($sectionTitle)}>Maximum Recording Time</Text>
          <Text style={themed($sectionSubtitle)}>Maximum duration for button-triggered video recording</Text>
          <OptionList
            options={MAX_RECORDING_TIME_OPTIONS}
            selected={maxRecordingTimeKey}
            onSelect={handleMaxRecordingTimeChange}
          />
        </View>

        <View style={themed($section)}>
          <Text style={themed($sectionTitle)}>{translate("settings:cameraFovRoiTitle")}</Text>
          <Text style={themed($sectionSubtitle)}>{translate("settings:cameraFovRoiExplanation")}</Text>

          <ThemedSlider
            value={currentFov}
            min={CAMERA_FOV_MIN}
            max={CAMERA_FOV_MAX}
            onValueChange={() => {}}
            onSlidingComplete={(val) => {
              const rounded = Math.round(val)
              handleCameraFovSet(rounded, rounded === CAMERA_FOV_MAX ? 0 : currentRoi)
            }}
          />

          <Text style={[themed($sectionSubtitle), {marginTop: theme.spacing.s4}]}>ROI position</Text>
          <View style={{opacity: roiDisabled ? 0.5 : 1}} pointerEvents={roiDisabled ? "none" : "auto"}>
            <OptionList
              options={ROI_POSITION_OPTIONS}
              selected={String(currentRoi)}
              onSelect={(key) => handleCameraFovChange(currentFov, Number(key) as CameraRoiPosition)}
            />
          </View>
        </View>
        {_devMode && (
          <View style={themed($section)}>
            <ToggleSetting
              label={translate("settings:postProcessing")}
              subtitle={translate("settings:postProcessingSubtitle")}
              value={postProcessing}
              onValueChange={(v) => setPostProcessing(v)}
            />
          </View>
        )}
      </ScrollView>
    </Screen>
  )
}

const $section: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingVertical: 14,
  paddingHorizontal: 16,
  marginVertical: spacing.s3,
})

const $sectionTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
  fontWeight: "600",
  marginBottom: spacing.s1,
})

const $sectionSubtitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: 12,
  marginBottom: spacing.s3,
})

const $emptyStateContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: spacing.s12,
  minHeight: 300,
})

const $emptyStateText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  textAlign: "center",
})
