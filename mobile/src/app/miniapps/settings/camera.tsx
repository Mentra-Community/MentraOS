import {getModelCapabilities} from "@/../../cloud/packages/types/src"
import {View, ScrollView, ViewStyle, TextStyle} from "react-native"

import {Text, Screen, Header} from "@/components/ignite"
import {OptionList} from "@/components/ui/Options"
import {ThemedSlider} from "@/components/settings/ThemedSlider"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import Toast from "react-native-toast-message"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {spacing, ThemedStyle} from "@/theme"
import CoreModule from "core"

type PhotoSize = "small" | "medium" | "large"
type VideoResolution = "720p" | "1080p" // | "1440p" | "4K"
type MaxRecordingTime = "3m" | "5m" | "10m" | "15m" | "20m"
type CameraRoiPosition = 0 | 1 | 2 // 0=Center, 1=Bottom, 2=Top

const CAMERA_FOV_MIN = 82
const CAMERA_FOV_MAX = 118

const PHOTO_SIZE_OPTIONS = [
  {key: "small" as PhotoSize, label: "Low (960×720)"},
  {key: "medium" as PhotoSize, label: "Medium (1440×1088)"},
  {key: "large" as PhotoSize, label: "High (3264×2448)"},
]

const VIDEO_RESOLUTION_OPTIONS = [
  {key: "720p" as VideoResolution, label: "720p (1280×720)"},
  {key: "1080p" as VideoResolution, label: "1080p (1920×1080)"},
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

export default function CameraSettingsScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationHistory()
  const [_devMode, _setDevMode] = useSetting(SETTINGS.dev_mode.key)
  const [photoSize, setPhotoSize] = useSetting(SETTINGS.button_photo_size.key)
  const [_ledEnabled, setLedEnabled] = useSetting(SETTINGS.button_camera_led.key)
  const [videoSettings, setVideoSettings] = useSetting(SETTINGS.button_video_settings.key)
  const [maxRecordingTime, setMaxRecordingTime] = useSetting(SETTINGS.button_max_recording_time.key)
  const [cameraFovSetting, setCameraFovSetting] = useSetting(SETTINGS.camera_fov.key)
  const [postProcessing, setPostProcessing] = useSetting(SETTINGS.media_post_processing.key)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const glassesConnected = useGlassesStore((state) => state.connected)

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

  // Derive video resolution from settings
  const videoResolution: VideoResolution = (() => {
    if (!videoSettings) return "1080p"
    if (videoSettings.width >= 3840) return "4K"
    if (videoSettings.width >= 2560) return "1440p"
    if (videoSettings.width >= 1920) return "1080p"
    return "720p"
  })()

  // Derive max recording time key from stored number
  const maxRecordingTimeKey: MaxRecordingTime = maxRecordingTime ? (`${maxRecordingTime}m` as MaxRecordingTime) : "5m"

  const handlePhotoSizeChange = (size: PhotoSize) => {
    if (!glassesConnected) {
      console.log("Cannot change photo size - glasses not connected")
      return
    }
    setPhotoSize(size)
    CoreModule.updateCore({button_photo_size: size}).catch((error: any) => {
      console.error("Failed to update photo size on glasses:", error)
    })
  }

  const handleVideoResolutionChange = (resolution: VideoResolution) => {
    if (!glassesConnected) {
      console.log("Cannot change video resolution - glasses not connected")
      return
    }
    const width = resolution === "4K" ? 3840 : resolution === "1440p" ? 2560 : resolution === "1080p" ? 1920 : 1280
    const height = resolution === "4K" ? 2160 : resolution === "1440p" ? 1920 : resolution === "1080p" ? 1080 : 720
    const fps = resolution === "4K" ? 15 : 30
    setVideoSettings({width, height, fps})
    CoreModule.updateCore({button_video_width: width, button_video_height: height, button_video_fps: fps}).catch(
      (error: any) => {
        console.error("Failed to update video settings on glasses:", error)
      },
    )
  }

  const _handleLedToggle = (enabled: boolean) => {
    if (!glassesConnected) {
      console.log("Cannot toggle LED - glasses not connected")
      return
    }
    setLedEnabled(enabled)
  }

  const handleMaxRecordingTimeChange = (time: MaxRecordingTime) => {
    if (!glassesConnected) {
      console.log("Cannot change max recording time - glasses not connected")
      return
    }
    const minutes = parseInt(time.replace("m", ""))
    setMaxRecordingTime(minutes)
    CoreModule.updateCore({button_max_recording_time: minutes}).catch((error: any) => {
      console.error("Failed to update max recording time on glasses:", error)
    })
  }

  const handleCameraFovChange = (fov: number, roi_position: CameraRoiPosition) => {
    if (!glassesConnected) {
      console.log("Cannot change camera FOV - glasses not connected")
      return
    }
    try {
      const clampedFov = Math.round(Math.max(CAMERA_FOV_MIN, Math.min(CAMERA_FOV_MAX, fov)))
      const effectiveRoi = clampedFov === CAMERA_FOV_MAX ? 0 : roi_position
      setCameraFovSetting({fov: clampedFov, roi_position: effectiveRoi})
    } catch (error) {
      console.error("Failed to update camera FOV:", error)
    }
  }

  const handleCameraFovSet = (fov: number, roi_position: CameraRoiPosition) => {
    handleCameraFovChange(fov, roi_position)
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
