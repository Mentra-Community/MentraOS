import {useEffect, useState} from "react"
import {Pressable, TextStyle, View, ViewStyle} from "react-native"

import {Text} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"
import {MediaLibraryPermissions} from "@mentra/engine"
import {
  cameraRollExportCoordinator,
  gallerySettingsService,
  type CameraRollExportSummary,
} from "@mentra/engine-host-internal"

const EMPTY_SUMMARY: CameraRollExportSummary = {
  enabled: false,
  total: 0,
  exported: 0,
  pending: 0,
  failed: 0,
  blockedPermission: 0,
  fullAccessRequired: 0,
  missing: 0,
  bytesPending: 0,
  isRunning: false,
}

export function GalleryCameraRollSetting() {
  const {themed} = useAppTheme()
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(true)
  const [summary, setSummary] = useState(EMPTY_SUMMARY)

  useEffect(() => {
    let mounted = true
    const unsubscribe = cameraRollExportCoordinator.subscribe((next) => {
      if (!mounted) return
      setSummary(next)
      setEnabled(next.enabled)
    })
    void (async () => {
      try {
        const settings = await gallerySettingsService.getSettings()
        if (mounted) setEnabled(settings.autoSaveToCameraRoll)
        await cameraRollExportCoordinator.initialize()
        if (mounted) setSummary(cameraRollExportCoordinator.getSummary())
      } finally {
        if (mounted) setBusy(false)
      }
    })()
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const applyToggle = async (value: boolean) => {
    setBusy(true)
    try {
      if (value) {
        const hasPermission = await MediaLibraryPermissions.checkPermission()
        const granted = hasPermission || (await MediaLibraryPermissions.requestPermission())
        if (!granted) {
          showAlert(
            "Camera Roll Access Required",
            "Allow photo-library access in Settings before enabling automatic saving.",
            [
              {text: translate("common:cancel"), style: "cancel"},
              {text: "Open Settings", onPress: () => void SettingsNavigationUtils.openAppSettings()},
            ],
          )
          return
        }
      }
      await cameraRollExportCoordinator.setEnabled(value)
      setEnabled(value)
    } catch (error) {
      console.error("[GallerySettings] Failed to update automatic camera-roll saving:", error)
      setEnabled(!value)
      showAlert("Error", "Could not update automatic saving. Please try again.", [{text: translate("common:ok")}])
    } finally {
      setBusy(false)
    }
  }

  const handleToggle = async (value: boolean) => {
    if (value) {
      await applyToggle(true)
      return
    }
    const settings = await gallerySettingsService.getSettings()
    if (settings.autoSaveDisableWarningShown) {
      await applyToggle(false)
      return
    }
    showAlert(
      "Turn Off Automatic Saving?",
      "New photos and videos will stay only inside the Mentra App. Turning this back on later will automatically save every item that is still missing from your camera roll.",
      [
        {text: translate("common:cancel"), style: "cancel"},
        {
          text: "Turn Off",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await gallerySettingsService.updateSettings({autoSaveDisableWarningShown: true})
              } catch (error) {
                console.warn("[GallerySettings] Failed to persist the automatic-saving warning state:", error)
              }
              await applyToggle(false)
            })()
          },
        },
      ],
    )
  }

  const status = getStatusText(summary, enabled)
  const needsAction = summary.blockedPermission > 0 || summary.failed > 0 || summary.missing > 0

  return (
    <View>
      <ToggleSetting
        label={translate("glasses:saveToCameraRoll")}
        subtitle={translate("glasses:saveToLibraryDescription")}
        value={enabled}
        disabled={busy}
        onValueChange={(value) => void handleToggle(value)}
      />
      <View style={themed($statusRow)}>
        <Text text={status} style={themed($statusText)} />
        {needsAction && (
          <Pressable
            onPress={() => {
              if (summary.blockedPermission > 0) void SettingsNavigationUtils.openAppSettings()
              else {
                void cameraRollExportCoordinator.retryNow().catch((error) => {
                  console.warn("[GallerySettings] Failed to retry camera-roll exports:", error)
                })
              }
            }}>
            <Text text={summary.blockedPermission > 0 ? "Open Settings" : "Retry"} style={themed($actionText)} />
          </Pressable>
        )}
      </View>
    </View>
  )
}

function getStatusText(summary: CameraRollExportSummary, enabled: boolean): string {
  if (!enabled) return "Automatic saving is off. Unsaved items will remain in the Mentra App."
  if (summary.fullAccessRequired > 0) {
    return `${summary.fullAccessRequired} legacy ${
      summary.fullAccessRequired === 1 ? "item needs" : "items need"
    } Full Photos Access to avoid duplicate copies.`
  }
  if (summary.blockedPermission > 0) {
    return `${summary.blockedPermission} ${
      summary.blockedPermission === 1 ? "item needs" : "items need"
    } photo-library access.`
  }
  if (summary.failed > 0) {
    return `${summary.failed} ${summary.failed === 1 ? "item needs" : "items need"} another export attempt.`
  }
  if (summary.pending > 0) {
    return `${summary.isRunning ? "Saving" : "Waiting to save"} ${summary.pending} ${
      summary.pending === 1 ? "item" : "items"
    } to your camera roll.`
  }
  if (summary.missing > 0) {
    return `${summary.missing} ${summary.missing === 1 ? "item is" : "items are"} no longer available to save.`
  }
  if (summary.total > 0) return `All ${summary.exported} items are saved to your camera roll.`
  return "New photos and videos will also be saved to your camera roll."
}

const $statusRow: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  gap: spacing.s3,
  marginTop: spacing.s2,
  paddingHorizontal: spacing.s2,
})

const $statusText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  flex: 1,
  fontSize: 12,
  lineHeight: 17,
})

const $actionText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.tint,
  fontSize: 12,
  fontWeight: "600",
})
