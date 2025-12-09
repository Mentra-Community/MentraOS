import {View, TouchableOpacity, ViewStyle} from "react-native"

import {Icon} from "@/components/ignite"
import {
  cameraPackageName,
  captionsPackageName,
  useRefreshApplets,
  useStopAllApplets,
  useStopApplet,
} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"

export const OfflineModeButton: React.FC = () => {
  const {theme, themed} = useAppTheme()
  const [offlineMode, setOfflineMode] = useSetting(SETTINGS.offline_mode.key)
  const stopApplet = useStopApplet()
  const stopAllApplets = useStopAllApplets()
  const refreshApplets = useRefreshApplets()

  const handlePress = () => {
    const title = offlineMode ? "Disable Offline Mode?" : "Enable Offline Mode?"
    const message = offlineMode
      ? "Switching to online mode will close all offline-only apps and allow you to use all online apps."
      : "Enabling offline mode will close all running online apps. You'll only be able to use apps that work without an internet connection, and all other apps will be shut down."
    const confirmText = offlineMode ? "Go Online" : "Go Offline"

    showAlert(
      title,
      message,
      [
        {text: "Cancel", style: "cancel"},
        {
          text: confirmText,
          onPress: async () => {
            if (!offlineMode) {
              // If enabling offline mode, stop all running apps
              await stopAllApplets()
            } else {
              // if disabling offline mode, stop all offline-only apps
              stopApplet(captionsPackageName)
              stopApplet(cameraPackageName)
            }
            setOfflineMode(!offlineMode)
            await refreshApplets()
          },
        },
      ],
      {
        iconName: offlineMode ? "wifi" : "wifi-off",
        iconColor: theme.colors.icon,
      },
    )
  }

  return (
    <View style={themed($container)}>
      <TouchableOpacity onPress={handlePress} style={themed($button)}>
        <Icon name={offlineMode ? "wifi-off" : "wifi"} size={24} color={theme.colors.icon} />
      </TouchableOpacity>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginLeft: spacing.s2,
  marginRight: spacing.s2,
})

const $button: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.s2,
  borderRadius: 20,
  justifyContent: "center",
  alignItems: "center",
})
