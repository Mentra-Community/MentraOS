/**
 * MiniappSplash — covers the WebView while it boots. Shows just the miniapp
 * icon centered on the host's background color. Styled to match AppIcon on
 * the home screen: 128px squircle with memory-disk image caching.
 *
 * Fades + scales in on mount so foregrounding feels like a soft zoom rather
 * than a hard cut. Fades out (opacity 1 → 0) when `isLoaded` flips true so
 * the WebView's first paint isn't preceded by a hard splash unmount + white
 * flash.
 */

import {Image} from "expo-image"
import {SquircleView} from "expo-squircle-view"
import {useEffect, useState} from "react"
import {StyleSheet} from "react-native"
import Animated, {runOnJS, useAnimatedStyle, useSharedValue, withTiming} from "react-native-reanimated"

import {useAppTheme} from "@/contexts/ThemeContext"

interface MiniappSplashProps {
  iconUrl?: string
  bgColor: string
  isLoaded?: boolean
}

const FADE_IN_DURATION_MS = 200
const FADE_OUT_DURATION_MS = 300
const MIN_VISIBLE_MS = 700
const SCALE_FROM = 0.4

export default function MiniappSplash({iconUrl, bgColor, isLoaded = false}: MiniappSplashProps) {
  const {theme} = useAppTheme()
  const size = 128
  const borderRadius = theme.spacing.s3

  const opacity = useSharedValue(0)
  const scale = useSharedValue(SCALE_FROM)
  const [hidden, setHidden] = useState(false)
  const [minVisibleElapsed, setMinVisibleElapsed] = useState(false)

  useEffect(() => {
    opacity.value = withTiming(1, {duration: FADE_IN_DURATION_MS})
    scale.value = withTiming(1, {duration: FADE_IN_DURATION_MS})
    const t = setTimeout(() => setMinVisibleElapsed(true), MIN_VISIBLE_MS)
    return () => clearTimeout(t)
  }, [opacity, scale])

  useEffect(() => {
    if (!isLoaded || !minVisibleElapsed) return
    opacity.value = withTiming(0, {duration: FADE_OUT_DURATION_MS}, (finished) => {
      if (finished) runOnJS(setHidden)(true)
    })
  }, [isLoaded, minVisibleElapsed, opacity])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{scale: scale.value}],
  }))

  if (hidden) return null

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.root, {backgroundColor: bgColor}, animatedStyle]}>
      {iconUrl && (
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
          <Image
            source={iconUrl}
            style={{width: "100%", height: "100%"}}
            contentFit="cover"
            transition={200}
            cachePolicy="memory-disk"
          />
        </SquircleView>
      )}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    justifyContent: "center",
  },
})
