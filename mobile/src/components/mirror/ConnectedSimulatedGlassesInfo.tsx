import {useCameraPermissions} from "expo-camera"
import {Linking, TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"

import {Button, Icon, Text} from "@/components/ignite"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n/translate"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"

export default function ConnectedSimulatedGlassesInfo({
  style,
  mirrorStyle,
  showHeader = true,
}: {
  style?: ViewStyle
  mirrorStyle?: ViewStyle
  showHeader?: boolean
}) {
  const {themed, theme} = useAppTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const {push} = useNavigationHistory()

  // Function to navigate to fullscreen mode
  const navigateToFullScreen = async () => {
    // Check if camera permission is already granted
    if (permission?.granted) {
      push("/mirror/fullscreen")
      return
    }

    // Show alert asking for camera permission
    showAlert(
      translate("mirror:cameraPermissionRequired"),
      translate("mirror:cameraPermissionRequiredMessage"),
      [
        {
          text: translate("common:continue"),
          onPress: async () => {
            const permissionResult = await requestPermission()
            if (permissionResult.granted) {
              // Permission granted, navigate to fullscreen
              push("/mirror/fullscreen")
            } else if (!permissionResult.canAskAgain) {
              // Permission permanently denied, show settings alert
              showAlert(
                translate("mirror:cameraPermissionRequired"),
                translate("mirror:cameraPermissionRequiredMessage"),
                [
                  {
                    text: translate("common:cancel"),
                    style: "cancel",
                  },
                  {
                    text: translate("mirror:openSettings"),
                    onPress: () => Linking.openSettings(),
                  },
                ],
              )
            }
            // If permission denied but can ask again, do nothing (user can try again)
          },
        },
      ],
      {
        iconName: "camera",
      },
    )
  }

  return (
    <View style={[themed($connectedContent), style]}>
      {showHeader && (
        <View style={themed($header)}>
          <Text style={themed($title)} tx="home:simulatedGlasses" />
          <Button flex={false} flexContainer={false} preset="alternate" onPress={() => push("/settings/glasses")}>
            <Icon name="settings" size={18} color={theme.colors.secondary_foreground} />
          </Button>
        </View>
      )}
      <View>
        <GlassesDisplayMirror fallbackMessage="Glasses Mirror" style={mirrorStyle} />
        <TouchableOpacity style={{position: "absolute", bottom: 10, right: 10}} onPress={navigateToFullScreen}>
          <Icon name="fullscreen" size={24} color={theme.colors.text} />
        </TouchableOpacity>
      </View>
    </View>
  )
}

const $connectedContent: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  padding: spacing.s6,
  // paddingVertical: spacing.s6,
  // paddingHorizontal: spacing.s6,
})

const $header: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: spacing.s4,
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.secondary_foreground,
})
