import {useState, useEffect} from "react"
import {View, ViewStyle, TextStyle, ScrollView} from "react-native"

import {Header, Screen, Text} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import InfoCardSection from "@/components/ui/InfoCard"
import {RouteButton} from "@/components/ui/RouteButton"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {gallerySettingsService} from "@/services/asg/gallerySettingsService"
import {localStorageService} from "@/services/asg/localStorageService"
import {SETTINGS, useSetting} from "@/stores/settings"
import {$styles, ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"

import {getModelCapabilities} from "@/../../cloud/packages/types/src"

export default function GallerySettingsScreen() {
  const {goBack, push} = useNavigationHistory()
  const {themed} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  const [autoSaveToCameraRoll, setAutoSaveToCameraRoll] = useState(true)
  const [localPhotoCount, setLocalPhotoCount] = useState(0)
  const [localVideoCount, setLocalVideoCount] = useState(0)
  const [glassesPhotoCount, setGlassesPhotoCount] = useState(0)
  const [glassesVideoCount, setGlassesVideoCount] = useState(0)
  const [totalStorageSize, setTotalStorageSize] = useState(0)
  const [isLoadingStats, setIsLoadingStats] = useState(true)

  // Load settings and stats on mount
  useEffect(() => {
    loadSettings()
    loadStats()
  }, [])

  const loadSettings = async () => {
    const settings = await gallerySettingsService.getSettings()
    setAutoSaveToCameraRoll(settings.autoSaveToCameraRoll)
  }

  const loadStats = async () => {
    try {
      setIsLoadingStats(true)
      // Get local photos
      const files = await localStorageService.getDownloadedFiles()
      const fileArray = Object.values(files)

      let photos = 0
      let videos = 0
      let size = 0

      fileArray.forEach(file => {
        if (file.is_video) {
          videos++
        } else {
          photos++
        }
        size += file.size
      })

      setLocalPhotoCount(photos)
      setLocalVideoCount(videos)
      setTotalStorageSize(size)

      // Try to get glasses status from global event if available
      // Note: This won't be real-time, just shows last known status
      // We don't have direct access to gallery status here, so we'll show 0
      // The real implementation would need to query this via BLE
      setGlassesPhotoCount(0)
      setGlassesVideoCount(0)
    } catch (error) {
      console.error("[GallerySettings] Error loading stats:", error)
    } finally {
      setIsLoadingStats(false)
    }
  }

  const handleToggleAutoSave = async (value: boolean) => {
    setAutoSaveToCameraRoll(value)
    await gallerySettingsService.setAutoSaveToCameraRoll(value)
  }

  const handleDeleteAll = async () => {
    const totalLocalMedia = localPhotoCount + localVideoCount

    if (totalLocalMedia === 0) {
      showAlert("No Photos", "There are no photos to delete", [{text: translate("common:ok")}])
      return
    }

    const itemText = totalLocalMedia === 1 ? "item" : "items"
    const message = `This will permanently delete all ${totalLocalMedia} ${itemText} from your device. Photos saved to your camera roll will not be affected. This action cannot be undone.`

    showAlert("Delete All Photos", message, [
      {text: translate("common:cancel"), style: "cancel"},
      {
        text: "Delete All",
        style: "destructive",
        onPress: async () => {
          try {
            await localStorageService.clearAllFiles()
            showAlert("Success", "All photos deleted from device storage", [{text: translate("common:ok")}])
            loadStats() // Refresh stats
          } catch {
            showAlert("Error", "Failed to delete photos", [{text: translate("common:ok")}])
          }
        },
      },
    ])
  }

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B"
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  let features = getModelCapabilities(defaultWearable)

  return (
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Header title="Gallery Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Camera Settings button for glasses with configurable button */}
        {features?.hasButton && (
          <View style={themed($section)}>
            <RouteButton label={translate("settings:cameraSettings")} onPress={() => push("/settings/camera")} />
          </View>
        )}

        <View style={themed($sectionCompact)}>
          <Text style={themed($sectionTitle)}>Automatic Sync</Text>
          <ToggleSetting
            label="Save to Camera Roll"
            value={autoSaveToCameraRoll}
            onValueChange={handleToggleAutoSave}
          />
        </View>

        <Text style={themed($sectionTitle)}>Storage info</Text>

        <View style={themed($section)}>
          <InfoCardSection
            items={[
              {
                label: "Photos on device",
                value: localPhotoCount.toString(),
              },
              {
                label: "Videos on device",
                value: localVideoCount.toString(),
              },
              {
                label: "Photos on glasses",
                value: glassesPhotoCount > 0 ? glassesPhotoCount.toString() : "—",
              },
              {
                label: "Videos on glasses",
                value: glassesVideoCount > 0 ? glassesVideoCount.toString() : "—",
              },
              {
                label: "Storage Used",
                value: formatBytes(totalStorageSize),
              },
            ]}
          />
        </View>

        <View style={themed($section)}>
          <RouteButton
            label={translate("glasses:deleteAllPhotos")}
            onPress={handleDeleteAll}
            variant="destructive"
            disabled={isLoadingStats || localPhotoCount + localVideoCount === 0}
          />
        </View>
      </ScrollView>
    </Screen>
  )
}

const $section: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s6,
})

const $sectionCompact: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s3,
})

const $sectionTitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.text,
  lineHeight: 20,
  letterSpacing: 0,
  marginBottom: spacing.s2,
  marginTop: spacing.s3,
})
