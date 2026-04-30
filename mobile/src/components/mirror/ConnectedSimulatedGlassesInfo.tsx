import {useCameraPermissions} from "expo-camera"
import {Linking, TouchableOpacity, View, ViewStyle} from "react-native"

import {Button, Icon, Text} from "@/components/ignite"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import GlassView from "@/components/ui/GlassView"

export default function ConnectedSimulatedGlassesInfo({
  style,
  mirrorStyle,
  showHeader = true,
}: {
  style?: ViewStyle
  mirrorStyle?: ViewStyle
  showHeader?: boolean
}) {
  const {theme} = useAppTheme()
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
    <GlassView className="bg-primary-foreground p-5" style={style}>
      {showHeader && (
        <View className="flex-row justify-between items-center mb-4">
          <Text className="font-semibold text-secondary-foreground text-lg" tx="onboarding:phoneMode" />
        </View>
      )}
      <View>
        <GlassesDisplayMirror fallbackMessage="Glasses mirror" style={mirrorStyle} />
        {/* <TouchableOpacity style={{position: "absolute", bottom: 10, right: 10}} onPress={navigateToFullScreen}>
          <Icon name="fullscreen" size={24} color={theme.colors.secondary_foreground} />
        </TouchableOpacity> */}
        <Button
          className="mt-3"
          flex={false}
          flexContainer={false}
          tx="home:connectGlasses"
          preset="primary"
          onPress={() => push("/pairing/select-glasses-model")}></Button>
      </View>
    </GlassView>
  )
}
