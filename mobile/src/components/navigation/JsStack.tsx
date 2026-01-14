import {createStackNavigator, StackNavigationOptions, TransitionPresets} from "@react-navigation/stack"
import {withLayoutContext} from "expo-router"
import {Animated, Easing, Platform} from "react-native"

const {Navigator} = createStackNavigator()

export const JsStack = withLayoutContext<StackNavigationOptions, typeof Navigator>(Navigator)

// Constants for the transition effects
const ROTATE_VALUES = ["-0.08rad", "0.08rad", "0rad"] as const
const INITIAL_SCALE = 1.15
const FINAL_SCALE = 0.85
const OVERLAY_OPACITY_MAX = 0.5
const NEXT_SCREEN_OPACITY_MIN = 0.8

// Custom card style interpolator for smooth Wolt-like transitions
export const customCardStyleInterpolator = ({current, next, layouts}: any) => {
  const {width} = layouts.screen

  // Translation effect
  const translateX = current.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [width * 1.6, 0],
  })

  const nextTranslateX = next
    ? next.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, -width * 0.3],
      })
    : 0

  // Rotation effect with bezier easing for page-closing animation
  const rotate = current.progress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ROTATE_VALUES,
    easing: Easing.bezier(0.5, 0.1, 0.5, 1.0),
  })

  // Scale effect
  const scale = current.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [INITIAL_SCALE, 1],
  })

  const nextScale = next
    ? next.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [1, FINAL_SCALE],
      })
    : 1

  // Overlay opacity for background dimming
  const overlayOpacity = current.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, OVERLAY_OPACITY_MAX],
  })

  // Next screen opacity for smooth fade-in
  const nextScreenOpacity = next
    ? next.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [1, NEXT_SCREEN_OPACITY_MIN],
      })
    : 1

  return {
    cardStyle: {
      transform: [
        {translateX},
        {translateX: nextTranslateX},
        {rotate},
        {scale},
        {scale: nextScale},
        {perspective: 1000},
      ],
      opacity: nextScreenOpacity,
    },
    overlayStyle: {
      opacity: overlayOpacity,
    },
  }
}

// Screen options with custom transitions
export const woltScreenOptions: StackNavigationOptions = {
  gestureEnabled: true,
  cardOverlayEnabled: true,
  headerShown: false,
  cardStyleInterpolator: customCardStyleInterpolator,
  transitionSpec: {
    open: {
      animation: "timing",
      config: {
        duration: 550,
        // easing: Easing.out(Easing.ease),
      },
    },
    close: {
      animation: "timing",
      config: {
        duration: 550,
        // easing: Easing.out(Easing.ease),
      },
    },
  },
}
