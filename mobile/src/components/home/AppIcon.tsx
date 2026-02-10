import {Image} from "expo-image"
import {SquircleView} from "expo-squircle-view"
import {memo} from "react"
import {ActivityIndicator, StyleProp, TouchableOpacity, View, ViewStyle} from "react-native"
import {withUniwind} from "uniwind"

import {Icon} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ClientAppletInterface, cameraPackageName, getMoreAppsApplet} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"

// Helper to extract style properties for width/height override
const extractStyleProps = (style: StyleProp<ViewStyle>): Partial<ViewStyle> => {
  if (!style) return {}
  if (typeof style === "number") return {}
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter((s) => s && typeof s === "object"))
  }
  return style as ViewStyle
}

interface AppIconProps {
  app: ClientAppletInterface
  onClick?: () => void
  style?: StyleProp<ViewStyle>
}

const AppIcon = ({app, onClick, style}: AppIconProps) => {
  const {theme} = useAppTheme()
  const [enableSquircles] = useSetting(SETTINGS.enable_squircles.key)
  const WrapperComponent = onClick ? TouchableOpacity : View
  const flatStyle = extractStyleProps(style)

  const iconSize = {
    width: flatStyle?.width ?? 64,
    height: flatStyle?.height ?? 64,
    borderRadius: flatStyle?.borderRadius ?? theme.spacing.s4,
  }

  return (
    <View className="items-center">
      <WrapperComponent
        onPress={onClick}
        activeOpacity={onClick ? 0.7 : undefined}
        style={style}
        accessibilityLabel={onClick ? `Launch ${app.name}` : undefined}
        accessibilityRole={onClick ? "button" : undefined}
        className="overflow-hidden">
        {enableSquircles ? (
          <SquircleView
            cornerSmoothing={100}
            preserveSmoothing={true}
            style={{
              overflow: "hidden",
              alignItems: "center",
              justifyContent: "center",
              ...iconSize,
            }}>
            {app.loading && (
              <View className="absolute inset-0 justify-center items-center z-10 bg-black/40">
                <ActivityIndicator size="large" color={theme.colors.palette.white} />
              </View>
            )}
            <Image
              source={app.logoUrl}
              style={{width: "100%", height: "100%", resizeMode: "cover"}}
              contentFit="cover"
              transition={200}
              cachePolicy="memory-disk"
            />
          </SquircleView>
        ) : (
          <>
            {app.loading && (
              <View className="absolute inset-0 justify-center items-center z-10 bg-black/40">
                <ActivityIndicator size="large" color={theme.colors.tint} />
              </View>
            )}
            <Image
              source={app.logoUrl}
              style={{
                borderRadius: 60,
                width: flatStyle?.width ?? 64,
                height: flatStyle?.height ?? 64,
                resizeMode: "cover",
              }}
              contentFit="cover"
              transition={200}
              cachePolicy="memory-disk"
            />
          </>
        )}
      </WrapperComponent>
      {!app.healthy && (
        <View className="absolute -right-1 -top-1 bg-primary-foreground border-primary-foreground border-1 rounded-full">
          <Icon name="alert" size={theme.spacing.s4} color={theme.colors.error} />
        </View>
      )}
      {/* Show wifi-off badge for offline apps (excluding camera app) */}
      {app.offline && app.packageName !== getMoreAppsApplet().packageName && app.packageName !== cameraPackageName && (
        <View className="absolute -right-1 -bottom-1 bg-primary-foreground border-primary-foreground border-1 rounded-full">
          <Icon name="wifi-off" size={theme.spacing.s4} color={theme.colors.text} />
        </View>
      )}
    </View>
  )
}

export default withUniwind(memo(AppIcon))
