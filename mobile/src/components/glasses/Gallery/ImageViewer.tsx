/**
 * Custom image viewer with proper zoom and pan
 */

import {Image} from "expo-image"
import {useState} from "react"
import {View, TouchableOpacity, Modal, Dimensions, StatusBar} from "react-native"
import {GestureDetector, Gesture, GestureHandlerRootView} from "react-native-gesture-handler"
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  runOnJS,
  interpolate,
  Extrapolate,
  withTiming,
  Easing,
} from "react-native-reanimated"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"

import {spacing} from "@/theme"
import {PhotoInfo} from "@/types/asg"

const AnimatedImage = Animated.createAnimatedComponent(Image)
const AnimatedView = Animated.View

interface ImageViewerProps {
  visible: boolean
  photo: PhotoInfo | null
  onClose: () => void
  onShare?: () => void
}

const {width: screenWidth, height: screenHeight} = Dimensions.get("window")
const DISMISS_THRESHOLD = 150 // Vertical distance to trigger dismiss
const VELOCITY_THRESHOLD = 500 // Velocity to trigger dismiss regardless of distance

export function ImageViewer({visible, photo, onClose, onShare}: ImageViewerProps) {
  const insets = useSafeAreaInsets()
  const [showHeader, setShowHeader] = useState(true)

  // Gesture values
  const scale = useSharedValue(1)
  const savedScale = useSharedValue(1)
  const translationX = useSharedValue(0)
  const translationY = useSharedValue(0)
  const savedTranslationX = useSharedValue(0)
  const savedTranslationY = useSharedValue(0)

  // Dismiss gesture values
  const dismissTranslationY = useSharedValue(0)
  const dismissScale = useSharedValue(1)
  const backgroundOpacity = useSharedValue(1)

  if (!photo) return null

  const resetZoom = () => {
    "worklet"
    scale.value = withSpring(1)
    savedScale.value = 1
    translationX.value = withSpring(0)
    translationY.value = withSpring(0)
    savedTranslationX.value = 0
    savedTranslationY.value = 0
  }

  const resetDismissValues = () => {
    "worklet"
    // Use timing with easing for snappy return to exact origin
    const config = {
      duration: 120,
      easing: Easing.out(Easing.cubic),
    }
    dismissTranslationY.value = withTiming(0, config)
    dismissScale.value = withTiming(1, config)
    backgroundOpacity.value = withTiming(1, config)
  }

  const toggleHeader = () => {
    setShowHeader(prev => !prev)
  }

  const triggerClose = () => {
    onClose()
  }

  // Pinch gesture
  const pinchGesture = Gesture.Pinch()
    .onUpdate(e => {
      scale.value = savedScale.value * e.scale
    })
    .onEnd(() => {
      if (scale.value < 1) {
        scale.value = withSpring(1)
        savedScale.value = 1
      } else if (scale.value > 5) {
        scale.value = withSpring(5)
        savedScale.value = 5
      } else {
        savedScale.value = scale.value
      }
    })

  // Pan gesture removed - functionality merged into dismissGesture

  // Dismiss gesture - vertical drag to dismiss
  const dismissGesture = Gesture.Pan()
    .onUpdate(e => {
      // Only allow dismiss gesture when not zoomed
      if (scale.value <= 1) {
        dismissTranslationY.value = e.translationY

        // Calculate scale based on drag distance (scale down as user drags)
        const dragProgress = Math.abs(e.translationY) / screenHeight
        dismissScale.value = interpolate(dragProgress, [0, 0.4], [1, 0.7], Extrapolate.CLAMP)

        // Fade background based on drag distance
        backgroundOpacity.value = interpolate(
          Math.abs(e.translationY),
          [0, DISMISS_THRESHOLD * 2],
          [1, 0.2],
          Extrapolate.CLAMP,
        )
      } else {
        // When zoomed, allow normal panning
        translationX.value = savedTranslationX.value + e.translationX
        translationY.value = savedTranslationY.value + e.translationY
      }
    })
    .onEnd(e => {
      if (scale.value <= 1) {
        // Check if should dismiss
        const shouldDismiss = Math.abs(e.translationY) > DISMISS_THRESHOLD || Math.abs(e.velocityY) > VELOCITY_THRESHOLD

        if (shouldDismiss) {
          // Animate out and close
          dismissTranslationY.value = withTiming(
            e.translationY > 0 ? screenHeight : -screenHeight,
            {duration: 200},
            () => {
              runOnJS(triggerClose)()
            },
          )
          dismissScale.value = withTiming(0.5, {duration: 200})
          backgroundOpacity.value = withTiming(0, {duration: 200})
        } else {
          // Snap back to exact origin position
          resetDismissValues()
        }
      } else {
        // Save pan position when zoomed
        savedTranslationX.value = translationX.value
        savedTranslationY.value = translationY.value
      }
    })

  // Double tap gesture
  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        resetZoom()
      } else {
        scale.value = withSpring(2)
        savedScale.value = 2
      }
    })

  // Single tap gesture
  const singleTapGesture = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      runOnJS(toggleHeader)()
    })

  const composed = Gesture.Simultaneous(
    Gesture.Exclusive(doubleTapGesture, singleTapGesture),
    pinchGesture,
    dismissGesture,
  )

  const animatedImageStyle = useAnimatedStyle(() => ({
    transform: [
      {translateX: translationX.value},
      {translateY: translationY.value + dismissTranslationY.value},
      {scale: scale.value * dismissScale.value},
    ],
  }))

  const animatedBackgroundStyle = useAnimatedStyle(() => ({
    opacity: backgroundOpacity.value,
  }))

  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <GestureHandlerRootView style={$container}>
        <StatusBar hidden={!showHeader} />

        {/* Animated Background */}
        <AnimatedView style={[$background, animatedBackgroundStyle]} />

        {/* Image */}
        <GestureDetector gesture={composed}>
          <AnimatedImage
            source={{uri: photo.url}}
            style={[$image, animatedImageStyle]}
            contentFit="contain"
            transition={200}
          />
        </GestureDetector>

        {/* Header */}
        {showHeader && (
          <View style={[$header, {paddingTop: insets.top}]}>
            <TouchableOpacity onPress={onClose} style={$closeButton}>
              <MaterialCommunityIcons name="chevron-left" size={32} color="white" />
            </TouchableOpacity>
            <View style={{flex: 1}} />
            {onShare && (
              <TouchableOpacity onPress={onShare} style={$actionButton}>
                <MaterialCommunityIcons name="share-variant" size={24} color="white" />
              </TouchableOpacity>
            )}
          </View>
        )}
      </GestureHandlerRootView>
    </Modal>
  )
}

const $container = {
  flex: 1,
  backgroundColor: "black",
}

const $background = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "black",
}

const $image = {
  width: screenWidth,
  height: screenHeight,
}

const $header = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  right: 0,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
  paddingHorizontal: spacing.s4,
  paddingBottom: spacing.s3,
  backgroundColor: "rgba(0,0,0,0.7)",
}

const $closeButton = {
  padding: spacing.s3,
}

const $actionButton = {
  padding: spacing.s3,
}
