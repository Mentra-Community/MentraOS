import {getModelCapabilities} from "@/../../cloud/packages/types/src"
import {View, ScrollView, TouchableOpacity, Platform, ViewStyle, TextStyle} from "react-native"

import bridge from "@/bridge/MantleBridge"
import {Icon, Text, Screen, Header} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {spacing, ThemedStyle} from "@/theme"

type PhotoSize = "small" | "medium" | "large"
type VideoResolution = "720p" | "1080p" // | "1440p" | "4K"
type MaxRecordingTime = "3m" | "5m" | "10m" | "15m" | "20m"

const PHOTO_SIZE_LABELS: Record<PhotoSize, string> = {
  small: "Low (960×720)",
  medium: "Medium (1440×1088)",
  large: "High (3264×2448)",
}

const VIDEO_RESOLUTION_LABELS: Record<VideoResolution, string> = {
  "720p": "720p (1280×720)",
  "1080p": "1080p (1920×1080)",
  // "1440p": "1440p (2560×1920)",
  // "4K": "4K (3840×2160)",
}

const MAX_RECORDING_TIME_LABELS: Record<MaxRecordingTime, string> = {
  "3m": "3 minutes",
  "5m": "5 minutes",
  "10m": "10 minutes",
  "15m": "15 minutes",
  "20m": "20 minutes",
}

export default function CameraSettingsScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationHistory()
  const [_devMode, _setDevMode] = useSetting(SETTINGS.dev_mode.key)
  const [photoSize, setPhotoSize] = useSetting(SETTINGS.button_photo_size.key)
  const [_ledEnabled, setLedEnabled] = useSetting(SETTINGS.button_camera_led.key)
  const [videoSettings, setVideoSettings] = useSetting(SETTINGS.button_video_settings.key)
  const [maxRecordingTime, setMaxRecordingTime] = useSetting(SETTINGS.button_max_recording_time.key)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const glassesConnected = useGlassesStore(state => state.connected)

  // Derive video resolution from settings
  const videoResolution: VideoResolution = (() => {
    if (!videoSettings) return "1080p"
    if (videoSettings.width >= 3840) return "4K"
    if (videoSettings.width >= 2560) return "1440p"
    if (videoSettings.width >= 1920) return "1080p"
    return "720p"
  })()

  const handlePhotoSizeChange = async (size: PhotoSize) => {
    if (!glassesConnected) {
      console.log("Cannot change photo size - glasses not connected")
      return
    }

    try {
      setPhotoSize(size)
      await bridge.updateButtonPhotoSize(size)
    } catch (error) {
      console.error("Failed to update photo size:", error)
    }
  }

  const handleVideoResolutionChange = async (resolution: VideoResolution) => {
    if (!glassesConnected) {
      console.log("Cannot change video resolution - glasses not connected")
      return
    }

    try {
      // Convert resolution to width/height/fps
      const width = resolution === "4K" ? 3840 : resolution === "1440p" ? 2560 : resolution === "1080p" ? 1920 : 1280
      const height = resolution === "4K" ? 2160 : resolution === "1440p" ? 1920 : resolution === "1080p" ? 1080 : 720
      const fps = resolution === "4K" ? 15 : 30

      setVideoSettings({width, height, fps})
      await bridge.updateButtonVideoSettings(width, height, fps)
    } catch (error) {
      console.error("Failed to update video resolution:", error)
    }
  }

  const _handleLedToggle = async (enabled: boolean) => {
    if (!glassesConnected) {
      console.log("Cannot toggle LED - glasses not connected")
      return
    }

    try {
      setLedEnabled(enabled)
    } catch (error) {
      console.error("Failed to update LED setting:", error)
    }
  }

  const handleMaxRecordingTimeChange = async (time: MaxRecordingTime) => {
    if (!glassesConnected) {
      console.log("Cannot change max recording time - glasses not connected")
      return
    }

    try {
      const minutes = parseInt(time.replace("m", ""))
      setMaxRecordingTime(minutes)
    } catch (error) {
      console.error("Failed to update max recording time:", error)
    }
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

  return (
    <Screen preset="fixed">
      <Header leftIcon="chevron-left" onLeftPress={() => goBack()} title={translate("settings:cameraSettings")} />
      <ScrollView
        style={{marginRight: -theme.spacing.s4, paddingRight: theme.spacing.s4}}
        contentInsetAdjustmentBehavior="automatic">
        <View style={themed($settingsGroup)}>
          <Text style={themed($settingLabel)}>Action Button Photo Settings</Text>
          <Text style={themed($settingSubtitle)}>Choose the resolution for photos taken with the action button.</Text>

          {Object.entries(PHOTO_SIZE_LABELS).map(([value, label], index, arr) => {
            const isFirst = index === 0
            const isLast = index === arr.length - 1
            return (
              <TouchableOpacity
                key={value}
                style={[
                  themed($optionItem),
                  {
                    borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderWidth: photoSize === value ? 1 : undefined,
                    borderColor: photoSize === value ? theme.colors.primary : undefined,
                  },
                ]}
                onPress={() => handlePhotoSizeChange(value as PhotoSize)}>
                <Text style={themed($optionText)}>{label}</Text>
                {photoSize === value && <Icon name="check" size={24} color={theme.colors.primary} />}
              </TouchableOpacity>
            )
          })}
        </View>

        <View style={themed($settingsGroup)}>
          <Text style={themed($settingLabel)}>Action Button Video Settings</Text>
          <Text style={themed($settingSubtitle)}>
            Choose the resolution for videos recorded with the action button.
          </Text>

          {Object.entries(VIDEO_RESOLUTION_LABELS).map(([value, label], index, arr) => {
            const isFirst = index === 0
            const isLast = index === arr.length - 1
            return (
              <TouchableOpacity
                key={value}
                style={[
                  themed($optionItem),
                  {
                    borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderWidth: videoResolution === value ? 1 : undefined,
                    borderColor: videoResolution === value ? theme.colors.primary : undefined,
                  },
                ]}
                onPress={() => handleVideoResolutionChange(value as VideoResolution)}>
                <Text style={themed($optionText)}>{label}</Text>
                {videoResolution === value && <Icon name="check" size={24} color={theme.colors.primary} />}
              </TouchableOpacity>
            )
          })}
        </View>

        {Platform.OS === "ios" && (
          <View style={themed($settingsGroup)}>
            <Text style={themed($settingLabel)}>Maximum Recording Time</Text>
            <Text style={themed($settingSubtitle)}>Maximum duration for button-triggered video recording</Text>

            {Object.entries(MAX_RECORDING_TIME_LABELS).map(([value, label], index, arr) => {
              const isFirst = index === 0
              const isLast = index === arr.length - 1
              return (
                <TouchableOpacity
                  key={value}
                  style={[
                    themed($optionItem),
                    {
                      borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                      borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                      borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                      borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                      borderWidth: maxRecordingTime === parseInt(value.replace("m", "")) ? 1 : undefined,
                      borderColor:
                        maxRecordingTime === parseInt(value.replace("m", "")) ? theme.colors.primary : undefined,
                    },
                  ]}
                  onPress={() => handleMaxRecordingTimeChange(value as MaxRecordingTime)}>
                  <Text style={themed($optionText)}>{label}</Text>
                  {maxRecordingTime === parseInt(value.replace("m", "")) && (
                    <Icon name="check" size={24} color={theme.colors.primary} />
                  )}
                </TouchableOpacity>
              )
            })}
          </View>
        )}
      </ScrollView>
    </Screen>
  )
}

const $settingsGroup: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.backgroundAlt,
  paddingVertical: 14,
  paddingHorizontal: 16,
  borderRadius: spacing.s4,
  marginVertical: spacing.s3,
})

const $settingLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
  fontWeight: "600",
  marginBottom: spacing.s1,
})

const $settingSubtitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: 12,
  marginBottom: spacing.s3,
})

const $optionItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  padding: spacing.s4,
  backgroundColor: colors.background,
  marginBottom: spacing.s2,
})

const $optionText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
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
