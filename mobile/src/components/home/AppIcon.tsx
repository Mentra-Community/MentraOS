import {Image} from "expo-image"
import {SquircleView} from "expo-squircle-view"
import {memo, useEffect, useState} from "react"
import {ActivityIndicator, StyleProp, StyleSheet, Text, TouchableOpacity, View, ViewStyle} from "react-native"
import {withUniwind} from "uniwind"

import {Icon} from "@/components/ignite"
import {DevIcon, DevMiniappBadge} from "@/components/miniapps/DevIcons"
import {useAppTheme} from "@/contexts/ThemeContext"
import {
  isRemoteImageSourceFailed,
  markRemoteImageSourceFailed,
  useCachedRemoteImageSource,
} from "@/hooks/useCachedRemoteImageSource"
import type {ClientApp} from "@mentra/engine"
import React from "react"

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
  app: ClientApp
  onClick?: () => void
  style?: StyleProp<ViewStyle>
  disableLoader?: boolean
  /**
   * Skip the fade-in transition. Use when the caller has already prefetched the
   * image and wants it to appear instantly (e.g. the all-apps grid reveals every
   * icon at once after gating on prefetch completion).
   */
  instant?: boolean
  resolveCachedSource?: boolean
}

const AppIcon = ({app, onClick, style, disableLoader, instant, resolveCachedSource = true}: AppIconProps) => {
  const {theme} = useAppTheme()
  const WrapperComponent = onClick ? TouchableOpacity : View
  const flatStyle = extractStyleProps(style)
  const imageSource = useCachedRemoteImageSource(app.logoUrl, {enabled: resolveCachedSource})
  const [iconFailed, setIconFailed] = useState(() => isRemoteImageSourceFailed(app.logoUrl))
  const isRemoteLogo =
    typeof app.logoUrl === "string" && (app.logoUrl.startsWith("http://") || app.logoUrl.startsWith("https://"))
  const imageUri = typeof imageSource === "object" && imageSource !== null && "uri" in imageSource ? imageSource.uri : null
  const remoteUnavailable = isRemoteLogo && !imageUri

  useEffect(() => {
    setIconFailed(isRemoteImageSourceFailed(app.logoUrl))
  }, [app.logoUrl])

  const iconSize = {
    width: flatStyle?.width ?? 64,
    height: flatStyle?.height ?? 64,
    borderRadius: flatStyle?.borderRadius ?? theme.spacing.s3,
  }

  return (
    <View className={`items-center justify-center ${app.compatibility?.isCompatible ? "" : "opacity-15"}`}>
      <WrapperComponent
        onPress={onClick}
        activeOpacity={onClick ? 0.7 : undefined}
        style={style}
        accessibilityLabel={onClick ? `Launch ${app.name}` : undefined}
        accessibilityRole={onClick ? "button" : undefined}
        className="overflow-hidden">
        <SquircleView
          cornerSmoothing={100}
          preserveSmoothing={true}
          style={{
            overflow: "hidden",
            alignItems: "center",
            justifyContent: "center",
            ...iconSize,
          }}>
          {app.loading && !disableLoader && (
            <View className="absolute inset-0 justify-center items-center z-10 bg-black/40">
              <ActivityIndicator size="large" color={theme.colors.palette.white} />
            </View>
          )}
          {!app.iconComponent && app.isMiniappDev && (!app.logoUrl || iconFailed || remoteUnavailable) && (
            <DevIcon size={iconSize.width as number} />
          )}
          {!app.iconComponent && !app.isMiniappDev && (iconFailed || remoteUnavailable) && (
            <View
              style={{
                width: "100%",
                height: "100%",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: theme.colors.palette.neutral200,
              }}>
              <Text
                style={{
                  color: theme.colors.textDim,
                  fontSize: Math.max(18, Number(iconSize.width) * 0.38),
                  fontWeight: "700",
                }}>
                {(app.name || app.packageName || "?").trim().charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
          {!app.iconComponent && !iconFailed && !remoteUnavailable && (app.logoUrl || !app.isMiniappDev) && (
            <Image
              source={imageSource}
              style={{width: "100%", height: "100%", resizeMode: "cover"}}
              contentFit="cover"
              transition={instant ? 0 : 200}
              cachePolicy="memory-disk"
              // Icons can be animated GIFs/WebPs (devs upload anything). A single
              // looping GIF icon keeps the frame decoder + render pipeline running
              // forever and measurably heats the phone — render the first frame only.
              autoplay={false}
              onError={() => {
                markRemoteImageSourceFailed(app.logoUrl)
                setIconFailed(true)
              }}
            />
          )}
          {app.iconComponent &&
            React.cloneElement(app.iconComponent as React.ReactElement<{size?: number}>, {
              size: iconSize.width as number,
            })}
          {/* {!app.compatibility?.isCompatible && !app.packageName.startsWith("@") && (
            <View
              style={{
                ...StyleSheet.absoluteFill,
                backgroundColor: "gray",
                mixBlendMode: "saturation",
              }}
            />
          )} */}
        </SquircleView>
      </WrapperComponent>
      {!app.healthy && (
        <View className="absolute -right-1 -top-1 bg-primary-foreground border-primary-foreground border-1 rounded-full">
          <Icon name="alert" size={theme.spacing.s4} color={theme.colors.error} />
        </View>
      )}
      {app.isMiniappDev && <DevMiniappBadge />}
      {/* Show wifi-off badge for offline apps (excluding camera app) */}
      {/* disabled for now */}
      {/* {app.offline && app.packageName !== getMoreAppsApplet().packageName && app.packageName !== cameraPackageName && (
        <View className="absolute -right-1 -bottom-1 bg-primary-foreground border-primary-foreground border-1 rounded-full">
          <Icon name="wifi-off" size={theme.spacing.s4} color={theme.colors.text} />
        </View>
      )} */}
    </View>
  )
}

export default withUniwind(memo(AppIcon))
