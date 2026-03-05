import {createStackNavigator, StackNavigationOptions, TransitionPresets} from "@react-navigation/stack"
import {withLayoutContext} from "expo-router"
import {Animated, Easing, Platform} from "react-native"
import {StackAnimationTypes} from "react-native-screens"

const {Navigator} = createStackNavigator()

export const JsStack = withLayoutContext<StackNavigationOptions, typeof Navigator>(Navigator)

// Constants for the transition effects
const INITIAL_SCALE = 0.1
const OVERLAY_OPACITY_MAX = 0.0

// Configurable origin point for zoom animation (normalized: 0-1)
// Default: left-center (x: 0, y: 0.5)
export let zoomOrigin = {x: 0.17, y: 0.63}

export const setZoomOrigin = (x: number, y: number) => {
  zoomOrigin = {x, y}
}

// iOS-style zoom transition from a specific point
export const customCardStyleInterpolator = ({current, next, layouts}: any) => {
  const {width, height} = layouts.screen

  // Calculate origin point in pixels from center
  const originX = (zoomOrigin.x - 0.5) * width
  const originY = (zoomOrigin.y - 0.5) * height

  // Scale from INITIAL_SCALE to 1.0 for entering screen
  const scale = current.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [INITIAL_SCALE, 1],
  })

  // Translate from origin point to center as we scale up
  const translateX = current.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [originX, 0],
  })

  const translateY = current.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [originY, 0],
  })

  // Fade in from 0 to 1
  const opacity = current.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  })

  // Overlay opacity for background dimming
  const overlayOpacity = current.progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, OVERLAY_OPACITY_MAX],
  })

  return {
    cardStyle: {
      transform: [{scale}],
      opacity,
    },
    overlayStyle: {
      opacity: overlayOpacity,
    },
  }
}

export const simplePush = ({current, next, layouts}: any) => {
  const {width} = layouts.screen

  const translateX = Animated.add(
    current.progress.interpolate({
      inputRange: [0, 1],
      outputRange: [width, 0],
    }),
    next
      ? next.progress.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -width * 0.3],
        })
      : 0,
  )

  return {
    cardStyle: {
      transform: [{translateX}],
    },
  }
}

const fadeCardStyleInterpolator = ({current}: any) => {
  return {
    cardStyle: {
      opacity: current.progress,
    },
  }
}

const noneCardStyleInterpolator = () => {
  return {
    cardStyle: {},
  }
}

export const getAnimation = (animation: StackAnimationTypes | "zoom") => {
  switch (animation) {
    case "none":
      return noneCardStyleInterpolator
    case "zoom":
      return customCardStyleInterpolator
    case "fade":
      return fadeCardStyleInterpolator
    default:
    case "simple_push":
      return simplePush
  }
}

// Screen options with custom transitions
export const woltScreenOptions: StackNavigationOptions = {
  gestureEnabled: true,
  cardOverlayEnabled: true,
  headerShown: false,
  gestureDirection: "horizontal",
  // cardStyleInterpolator: customCardStyleInterpolator,
  // cardStyleInterpolator: simplePush,
  transitionSpec: {
    open: {
      animation: "timing",
      config: {
        duration: 200,
        easing: Easing.out(Easing.bounce),
      },
    },
    close: {
      animation: "timing",
      config: {
        duration: 200,
        easing: Easing.in(Easing.cubic),
      },
    },
  },
}
