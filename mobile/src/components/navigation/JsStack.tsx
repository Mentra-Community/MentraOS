import {
  createStackNavigator,
  StackNavigationEventMap,
  StackNavigationOptions,
  TransitionPresets,
} from "@react-navigation/stack"
import {createNativeStackNavigator} from "@react-navigation/native-stack"
import {ParamListBase, TabNavigationState, StackNavigationState, EventMapBase} from "@react-navigation/native"
import {withLayoutContext} from "expo-router"
import {Animated, Easing, Platform} from "react-native"
import {StackAnimationTypes} from "react-native-screens"

const {Navigator} = createStackNavigator()
const {Navigator: NativeStackNavigator} = createNativeStackNavigator()

// @ts-ignore
// export const JsStack = withLayoutContext<StackNavigationOptions, typeof Navigator>(Navigator)
export const JsStack = withLayoutContext<
  StackNavigationOptions,
  typeof Navigator,
  StackNavigationState<ParamListBase>,
  StackNavigationEventMap
>(Navigator)
// @ts-ignore
// export const NativeJsStack = withLayoutContext<StackNavigationOptions, typeof NativeStackNavigator>(NativeStackNavigator)

export const NativeJsStack = withLayoutContext<
  StackNavigationOptions,
  typeof NativeStackNavigator,
  StackNavigationState<ParamListBase>,
  StackNavigationEventMap
>(NativeStackNavigator)

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
export const reverseZoomStyle = ({current, next, layouts}: any) => {
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

export const zoomStyle = ({current, next, layouts}: any) => {
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

export const simplePushStyle = ({current, next, layouts}: any) => {
  const {width} = layouts.screen

  const translateX = Animated.add(
    current.progress.interpolate({
      inputRange: [0, 1],
      outputRange: [width, 0],
      extrapolate: "clamp",
    }),
    next
      ? next.progress.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -width/2],
          extrapolate: "clamp",
        })
      : 0,
    // 0,
  )

  return {
    cardStyle: {
      transform: [{translateX}],
      opacity: 1,
      // zIndex: 1000,
    },
    overlayStyle: {
      opacity: 1,
    },
  }
}

const fadeStyle = ({current}: any) => {
  return {
    cardStyle: {
      opacity: current.progress,
    },
  }
}

const noneStyle = () => {
  return {
    cardStyle: {},
  }
}

export const getAnimation = (animation: StackAnimationTypes | "zoom") => {
  switch (animation) {
    case "none":
      return noneStyle
    case "zoom":
      return zoomStyle
    case "fade":
      return fadeStyle
    // case "reverse_zoom":
      // return reverseZoomCardStyleInterpolator
    default:
    case "simple_push":
      return simplePushStyle
  }
}

// Screen options with custom transitions
export const woltScreenOptions: StackNavigationOptions = {
  gestureEnabled: true,
  cardOverlayEnabled: true,
  headerShown: false,
  gestureDirection: "horizontal",
  animation: "default",
  detachPreviousScreen: false,
  // cardStyleInterpolator: customCardStyleInterpolator,
  // cardStyleInterpolator: simplePush,
  transitionSpec: {
    open: {
      animation: "spring",
      config: {
        overshootClamping: true,
        stiffness: 100,
        // duration: 1000,
        // easing: Easing.out(Easing.linear),
      },
    },
    close: {
      animation: "spring",
      config: {
        overshootClamping: true,
        stiffness: 100,
        // duration: 1000,
        // easing: Easing.in(Easing.linear),
      },
    },
  },
}
