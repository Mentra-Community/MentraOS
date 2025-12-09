import {ArrowLeftIcon} from "assets/icons/component/ArrowLeftIcon"
import {CloseXIcon} from "assets/icons/component/CloseXIcon"
import {ImageStyle, TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"

import {Text} from "@/components/ignite"
import AppIcon from "@/components/misc/AppIcon"
import {Badge} from "@/components/ui"
import {Group} from "@/components/ui/Group"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {ClientAppletInterface, useBackgroundApps, useStopApplet} from "@/stores/applets"
import {ThemedStyle} from "@/theme"
import {showAlert} from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"

export const ActiveBackgroundApps: React.FC = () => {
  const {themed, theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const {active} = useBackgroundApps()
  const stopApplet = useStopApplet()

  const handlePress = (applet: ClientAppletInterface) => {
    if (applet) {
      // Handle offline apps - navigate directly to React Native route
      if (applet.offline) {
        const offlineRoute = applet.offlineRoute
        if (offlineRoute) {
          push(offlineRoute)
          return
        }
      }

      // Check if app has webviewURL and navigate directly to it
      if (applet.webviewUrl && applet.healthy) {
        push("/applet/webview", {
          webviewURL: applet.webviewUrl,
          appName: applet.name,
          packageName: applet.packageName,
        })
      } else {
        push("/applet/settings", {
          packageName: applet.packageName,
          appName: applet.name,
        })
      }
    }
  }

  const handleLongPress = (applet: ClientAppletInterface) => {
    if (applet) {
      showAlert("Stop App", `Do you want to stop ${applet.name}?`, [
        {text: "Cancel", style: "cancel"},
        {
          text: "Stop",
          style: "destructive",
          onPress: async () => {
            stopApplet(applet.packageName)
          },
        },
      ])
    }
  }

  const handleStopApp = async (applet: ClientAppletInterface, event: any) => {
    if (applet?.loading) {
      // don't do anything if still loading
      return
    }

    // Prevent the parent TouchableOpacity from triggering
    event.stopPropagation()

    if (applet) {
      stopApplet(applet.packageName)
    }
  }

  if (active.length === 0) {
    // Show placeholder when no active app
    return (
      <View style={themed($container)}>
        <View style={themed($placeholderContent)}>
          <Text style={themed($placeholderText)} tx="home:appletPlaceholder" />
        </View>
      </View>
    )
  }

  return (
    <Group>
      {active.map((applet: ClientAppletInterface) => (
        <TouchableOpacity
          key={applet.packageName}
          style={themed($container)}
          onPress={() => handlePress(applet)}
          onLongPress={() => handleLongPress(applet)}
          activeOpacity={0.7}>
          <View style={themed($rowContent)}>
            <AppIcon app={applet} style={themed($appIcon)} />
            <View style={themed($appInfo)}>
              <Text style={themed($appName)} numberOfLines={1} ellipsizeMode="tail">
                {applet.name}
              </Text>
              <View style={themed($tagContainer)}>
                <Badge text="Active" />
              </View>
            </View>
            {!applet.loading && (
              <TouchableOpacity
                onPress={e => handleStopApp(applet, e)}
                style={themed($closeButton)}
                activeOpacity={0.7}>
                <CloseXIcon size={24} color={theme.colors.textDim} />
              </TouchableOpacity>
            )}
            <View style={themed($iconContainer)}>
              <ArrowLeftIcon size={24} color={theme.colors.text} />
            </View>
          </View>
        </TouchableOpacity>
      ))}
    </Group>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  //   marginVertical: spacing.s2,
  minHeight: 72,
  // borderWidth: 2,
  // borderColor: colors.border,
  borderRadius: spacing.s4,
  backgroundColor: colors.backgroundAlt,
  paddingHorizontal: spacing.s2,
})

const $iconContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  padding: spacing.s3,
  width: spacing.s12,
  height: spacing.s12,
  borderRadius: spacing.s12,
  transform: [{scaleX: -1}],
  alignItems: "center",
})

const $rowContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  paddingHorizontal: spacing.s2,
  paddingVertical: spacing.s3,
  gap: spacing.s3,
})

const $appIcon: ThemedStyle<ImageStyle> = () => ({
  width: 64,
  height: 64,
})

const $appInfo: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
})

const $appName: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  fontWeight: "500",
  color: colors.text,
  marginBottom: spacing.s1,
})

const $tagContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.s2,
})

const $closeButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.s2,
  justifyContent: "center",
  alignItems: "center",
})

const $placeholderContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.s6,
  alignItems: "center",
  justifyContent: "center",
  paddingVertical: spacing.s8,
})

const $placeholderText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  color: colors.textDim,
  textAlign: "center",
})
