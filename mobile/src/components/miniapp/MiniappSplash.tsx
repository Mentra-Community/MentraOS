/**
 * MiniappSplash — covers the WebView while it boots. Shows just the miniapp
 * icon centered on the host's background color. Styled to match AppIcon on
 * the home screen: 128px squircle with memory-disk image caching.
 *
 * Fades in on mount so foregrounding feels soft rather than a hard cut. Fades
 * out (opacity 1 → 0) when `isLoaded` flips true so the WebView's first paint
 * isn't preceded by a hard splash unmount + white flash.
 */

import {Image} from "expo-image"
import {SquircleView} from "expo-squircle-view"
import {useEffect, useState} from "react"
import {ActivityIndicator, StyleSheet, View} from "react-native"
import Animated, {runOnJS, useAnimatedStyle, useSharedValue, withTiming} from "react-native-reanimated"

import {useAppTheme} from "@/contexts/ThemeContext"
import {Text} from "@/components/ignite"
import {DevIcon, DevMiniappBadge} from "@/components/miniapps/DevIcons"

interface MiniappSplashProps {
  iconUrl?: string
  bgColor: string
  isLoaded?: boolean
  name?: string
  error?: string
  label?: string
  devApp?: boolean
  /** Render at full opacity immediately instead of fading in (fade out still applies). */
  disableFadeIn?: boolean
}

const FADE_IN_DURATION_MS = 50
const FADE_OUT_DURATION_MS = 200
const MIN_VISIBLE_MS = 700

export default function MiniappSplash({
  iconUrl,
  bgColor,
  isLoaded = false,
  name,
  error,
  label,
  devApp = false,
  disableFadeIn = false,
}: MiniappSplashProps) {
  const {theme} = useAppTheme()
  const size = 128
  const borderRadius = theme.spacing.s3

  const opacity = useSharedValue(disableFadeIn ? 1 : 0)
  const [hidden, setHidden] = useState(false)
  const [minVisibleElapsed, setMinVisibleElapsed] = useState(false)

  useEffect(() => {
    if (!disableFadeIn) {
      opacity.value = withTiming(1, {duration: FADE_IN_DURATION_MS})
    }
    const t = setTimeout(() => setMinVisibleElapsed(true), MIN_VISIBLE_MS)
    return () => clearTimeout(t)
  }, [opacity, disableFadeIn])

  useEffect(() => {
    if (!isLoaded || !minVisibleElapsed) return
    opacity.value = withTiming(0, {duration: FADE_OUT_DURATION_MS}, (finished) => {
      if (finished) runOnJS(setHidden)(true)
    })
  }, [isLoaded, minVisibleElapsed, opacity])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }))

  if (hidden) return null

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {backgroundColor: bgColor, justifyContent: "center", alignItems: "center"},
        animatedStyle,
      ]}>
      {/* Always mounted: iconUrl can resolve a beat after the splash appears
          (lazy icon resolution), and conditionally mounting this block made
          the name text jump down when the icon landed. An empty squircle is
          invisible, so reserving the space costs nothing. */}
      <View style={{position: "relative"}}>
        <SquircleView
          cornerSmoothing={100}
          preserveSmoothing={true}
          style={{
            width: size,
            height: size,
            borderRadius,
            overflow: "hidden",
            alignItems: "center",
            justifyContent: "center",
          }}>
          {iconUrl ? (
            <Image
              source={iconUrl}
              style={{width: "100%", height: "100%"}}
              contentFit="cover"
              transition={200}
              cachePolicy="memory-disk"
            />
          ) : devApp ? (
            <DevIcon size={size} />
          ) : null}
        </SquircleView>
        {devApp && <DevMiniappBadge size={18} />}
      </View>

      <View className="h-16 items-center justify-center w-full mt-4">
        {name && <Text className="text-lg h-10 font-semibold text-center" text={name} />}
        {error && <Text className="text-lg text-center text-red-500 max-w-[280px]" text={error} />}
        {label && (
          <View className="flex-row items-center gap-2">
            <ActivityIndicator />
            <Text className="text-[13px] text-muted-foreground" text={label} />
          </View>
        )}
      </View>
    </Animated.View>
  )
}
