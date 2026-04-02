import {getModelCapabilities} from "@/../../cloud/packages/types/src"
import {useState, useEffect} from "react"
import {View, ViewStyle, TextStyle, ScrollView} from "react-native"

import {Header, Screen, Text} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import InfoCardSection from "@/components/ui/InfoCard"
import {RouteButton} from "@/components/ui/RouteButton"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {gallerySettingsService} from "@/services/asg/gallerySettingsService"
import {localStorageService} from "@/services/asg/localStorageService"
import {useGallerySyncStore} from "@/stores/gallerySync"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"

export default function GallerySettingsScreen() {
  const {goBack, push} = useNavigationHistory()
  const {theme, themed} = useAppTheme()
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

      fileArray.forEach((file) => {
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
            // console.log("[GallerySettings] 🗑️ Clearing all downloaded files and sync queue")
            await localStorageService.clearAllFiles()

            // Clear the sync queue in Zustand store to remove zombie files
            const gallerySyncStore = useGallerySyncStore.getState()
            gallerySyncStore.clearQueue()
            // console.log("[GallerySettings] ✅ Cleared sync queue from store")

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
    <Screen preset="fixed">
      <Header title={translate("glasses:gallerySettings")} leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}>
        {/* Camera Settings button for glasses with configurable button */}
        {features?.hasButton && (
          <View style={[themed($section), {marginTop: theme.spacing.s4}]}>
            <RouteButton
              label={translate("settings:cameraSettings")}
              onPress={() => push("/miniapps/settings/camera")}
            />
          </View>
        )}

        <View style={themed($sectionCompact)}>
          <Text style={themed($sectionTitle)}>{translate("glasses:automaticSync")}</Text>
          <ToggleSetting
            label={translate("glasses:saveToCameraRoll")}
            subtitle={translate("glasses:saveToLibraryDescription")}
            value={autoSaveToCameraRoll}
            onValueChange={handleToggleAutoSave}
          />
        </View>

        <Text style={themed($sectionTitle)}>{translate("glasses:storageInfo")}</Text>

        <View style={themed($section)}>
          <InfoCardSection
            items={[
              {
                label: translate("glasses:photosOnPhone"),
                value: localPhotoCount.toString(),
              },
              {
                label: translate("glasses:videosOnPhone"),
                value: localVideoCount.toString(),
              },
              {
                label: translate("glasses:photosOnGlasses", {
                  glassesName: defaultWearable || translate("glasses:title"),
                }),
                value: glassesPhotoCount > 0 ? glassesPhotoCount.toString() : "—",
              },
              {
                label: translate("glasses:videosOnGlasses", {
                  glassesName: defaultWearable || translate("glasses:title"),
                }),
                value: glassesVideoCount > 0 ? glassesVideoCount.toString() : "—",
              },
              {
                label: translate("glasses:storageUsed"),
                value: formatBytes(totalStorageSize),
              },
            ]}
          />
        </View>

        <View style={themed($section)}>
          <RouteButton
            label={translate("glasses:deleteAllPhotos")}
            onPress={handleDeleteAll}
            preset="destructive"
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
