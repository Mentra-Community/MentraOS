/**
 * Floating Image Layer - Pure geometry interpolation for iOS Photos-style transitions
 * A single image that moves between grid thumbnail position and fullscreen position
 */

import {Image} from "expo-image"
import {View} from "react-native"
import {GestureDetector, Gesture} from "react-native-gesture-handler"
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolate,
  SharedValue,
} from "react-native-reanimated"

import {PhotoInfo} from "@/types/asg"

const DISMISS_THRESHOLD = 150
const VELOCITY_THRESHOLD = 800

interface FloatingImageLayerProps {
  photo: PhotoInfo
  x: SharedValue<number>
  y: SharedValue<number>
  width: SharedValue<number>
  height: SharedValue<number>
  opacity: SharedValue<number>
  borderRadius: SharedValue<number>
  backgroundOpacity: SharedValue<number>
  backgroundColor: string
  onDismiss: () => void
  onDismissStart?: () => void // Called when dismiss animation starts
}

export function FloatingImageLayer({
  photo,
  x,
  y,
  width,
  height,
  opacity,
  borderRadius,
  backgroundOpacity,
  backgroundColor,
  onDismiss,
  onDismissStart,
}: FloatingImageLayerProps) {
  // Drag state (reversible gesture)
  const dragOffset = useSharedValue(0)
  const dragScale = useSharedValue(1)

  const dismissGesture = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .failOffsetX([-30, 30])
    .onUpdate(e => {
      "worklet"
      // Only vertical drag
      if (Math.abs(e.velocityX) > Math.abs(e.velocityY)) return

      dragOffset.value = e.translationY

      // Derive scale and background opacity from drag distance
      const progress = Math.abs(e.translationY) / 300
      dragScale.value = interpolate(progress, [0, 1], [1, 0.85], Extrapolate.CLAMP)
      backgroundOpacity.value = interpolate(progress, [0, 1], [1, 0], Extrapolate.CLAMP)
    })
    .onEnd(e => {
      "worklet"
      const shouldDismiss = Math.abs(e.translationY) > DISMISS_THRESHOLD || Math.abs(e.velocityY) > VELOCITY_THRESHOLD

      if (shouldDismiss) {
        // Branch B - Dismiss
        // CRITICAL: Merge dragOffset into y.value AND ensure scale is exactly 1.0
        const currentDragOffset = dragOffset.value
        const currentScale = dragScale.value
        const currentY = y.value

        // Merge the drag offset into base position
        const mergedY = currentY + currentDragOffset
        y.value = mergedY

        // Force reset all drag transforms to 0/1 IMMEDIATELY
        dragOffset.value = 0
        dragScale.value = 1.0

        console.log("[FloatingImageLayer] Merging drag offset into position:", currentDragOffset)

        // Notify parent that dismiss is starting
        if (onDismissStart) {
          runOnJS(onDismissStart)()
        }

        // Then trigger actual dismiss animation
        runOnJS(onDismiss)()
      } else {
        // Branch A - Cancel: snap back to fullscreen - linear timing only
        dragOffset.value = withTiming(0, {duration: 200})
        dragScale.value = withTiming(1, {duration: 200})
        backgroundOpacity.value = withTiming(1, {duration: 200})
      }
    })

  const imageStyle = useAnimatedStyle(() => {
    // Only apply scale if it's not 1.0 (optimization and prevents rounding errors)
    const transforms = dragScale.value !== 1.0 ? [{scale: dragScale.value}] : []

    return {
      position: "absolute",
      left: x.value,
      top: y.value + dragOffset.value,
      width: width.value,
      height: height.value,
      opacity: opacity.value,
      borderRadius: borderRadius.value,
      transform: transforms,
      overflow: "hidden",
    }
  })

  const backgroundStyle = useAnimatedStyle(() => ({
    opacity: backgroundOpacity.value,
  }))

  const imageUri = photo.filePath
    ? photo.filePath.startsWith("file://")
      ? photo.filePath
      : `file://${photo.filePath}`
    : photo.url

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }}
      pointerEvents="box-none">
      {/* Background */}
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor,
          },
          backgroundStyle,
        ]}
      />

      {/* Floating image */}
      <GestureDetector gesture={dismissGesture}>
        <Animated.View style={imageStyle} pointerEvents="box-only">
          <Image source={{uri: imageUri}} style={{width: "100%", height: "100%"}} contentFit="cover" />
        </Animated.View>
      </GestureDetector>
    </View>
  )
}
