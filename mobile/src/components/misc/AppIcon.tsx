import {Image} from "expo-image"
import {SquircleView} from "expo-squircle-view"
import {memo} from "react"
import {ActivityIndicator, ImageStyle, StyleProp, TouchableOpacity, View, ViewStyle} from "react-native"

import {Icon} from "@/components/ignite"
import {ClientAppletInterface, getMoreAppsApplet} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import {withUniwind} from "uniwind"
import {StyleSheet} from "react-native"

interface AppIconProps {
  app: ClientAppletInterface
  onClick?: () => void
  style?: StyleProp<ViewStyle>
}

const AppIcon = ({app, onClick, style}: AppIconProps) => {
  const {themed, theme} = useAppTheme()
  const [enableSquircles] = useSetting(SETTINGS.enable_squircles.key)
  const WrapperComponent = onClick ? TouchableOpacity : View
  const flatStyle = StyleSheet.flatten(style)

  return (
    <View style={{alignItems: "center"}}>
      <WrapperComponent
        onPress={onClick}
        activeOpacity={onClick ? 0.7 : undefined}
        style={[themed($container), style]}
        accessibilityLabel={onClick ? `Launch ${app.name}` : undefined}
        accessibilityRole={onClick ? "button" : undefined}>
        {enableSquircles ? (
          <SquircleView
            cornerSmoothing={100}
            preserveSmoothing={true}
            style={{
              overflow: "hidden", // use as a mask
              alignItems: "center",
              justifyContent: "center",
              width: flatStyle?.width ?? 64,
              height: flatStyle?.height ?? 64,
              borderRadius: flatStyle?.borderRadius ?? theme.spacing.s4,
            }}>
            {app.loading && (
              <View style={themed($loadingContainer)}>
                <ActivityIndicator size="small" color={theme.colors.palette.white} />
              </View>
            )}
            <Image
              source={app.logoUrl}
              style={themed($icon)}
              contentFit="cover"
              transition={200}
              cachePolicy="memory-disk"
            />
          </SquircleView>
        ) : (
          <>
            {app.loading && (
              <View style={themed($loadingContainer)}>
                <ActivityIndicator size="large" color={theme.colors.tint} />
              </View>
            )}
            <Image
              source={app.logoUrl}
              style={[
                themed($icon),
                {borderRadius: 60, width: flatStyle?.width ?? 64, height: flatStyle?.height ?? 64},
              ]}
              contentFit="cover"
              transition={200}
              cachePolicy="memory-disk"
            />
          </>
        )}
      </WrapperComponent>
      {!app.healthy && (
        <View style={themed($unhealthyBadge)}>
          <Icon name="alert" size={theme.spacing.s4} color={theme.colors.error} />
        </View>
      )}
      {/* Show wifi-off badge for offline apps */}
      {app.offline && app.packageName !== getMoreAppsApplet().packageName && (
        <View style={themed($offlineBadge)}>
          <Icon name="wifi-off" size={theme.spacing.s4} color={theme.colors.text} />
        </View>
      )}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  overflow: "hidden",
})

const $loadingContainer: ThemedStyle<ViewStyle> = () => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  justifyContent: "center",
  alignItems: "center",
  zIndex: 10,
  backgroundColor: "rgba(0, 0, 0, 0.2)", // Much more subtle overlay
})

const $icon: ThemedStyle<ImageStyle> = () => ({
  width: "100%",
  height: "100%",
  resizeMode: "cover",
})

const $unhealthyBadge: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  position: "absolute",
  top: -spacing.s1,
  right: -spacing.s1,
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  borderWidth: spacing.s1,
  borderColor: colors.primary_foreground,
})

const $offlineBadge: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  position: "absolute",
  right: -spacing.s1,
  bottom: -spacing.s1,
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  borderWidth: spacing.s1,
  borderColor: colors.primary_foreground,
})

export default withUniwind(memo(AppIcon))
