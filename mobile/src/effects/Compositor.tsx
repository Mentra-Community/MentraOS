/**
 * Compositor — renders the foregrounded local miniapp over the rest of the app.
 *
 * Subscribes to the island apps store's `foregrounded` flag (set by
 * setForeground, e.g. from the AppSwitcher press path). At most one app is
 * foregrounded at a time. When an app becomes foreground the Compositor:
 *   1. Mounts <LocalMiniappView /> — which spawns the JSContext (idempotent)
 *      and renders the UI WebView — inside an Animated.View overlay.
 *   2. Plays an opening animation (fade + subtle scale-in).
 *   3. Registers the global capsule (house/X button) for the active miniapp.
 *   4. Owns the iOS-style left-edge swipe-to-back gesture; on commit it
 *      clears foreground. The overlay slides/fades off and the WebView
 *      unmounts — the JSContext stays alive (backgrounded, not stopped).
 *
 * The always-on JSContext is owned by MentraJSRouter; the WebView is only
 * mounted while the miniapp is foreground.
 */

import {useEffect, useRef, useState} from "react"
import {BackHandler, Dimensions, Platform, View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated"

import LocalMiniappView, {type LocalMiniappViewHandle} from "@/components/miniapp/LocalMiniappView"
import CapsuleMenu from "@/effects/CapsuleMenu"
import {useCapsuleStore} from "@/stores/capsule"
import {useAppStatusStore, useForegroundApp} from "@mentra/island"

const EDGE_HIT_WIDTH = 24
const COMMIT_FRACTION = 0.4
const COMMIT_DURATION_MS = 220
const FADE_IN_DELAY_MS = 100
const FADE_IN_DURATION_MS = 500
const FADE_IN_SCALE_FROM = 0.4
const FADE_OUT_DURATION_MS = 300
const FADE_OUT_SCALE_TO = 0.4

function clearForeground() {
  useAppStatusStore.getState().clearForeground()
}

// Module-level handle to the foregrounded view's in-WebView goBack(), so the
// gesture's module-level handleBack (called via runOnJS) can reach it without
// closing over component scope. Returns true if it popped in-app history.
const viewBackRef: {current: (() => boolean) | null} = {current: null}

function handleBack() {
  const wentBack = viewBackRef.current?.() ?? false
  if (!wentBack) {
    clearForeground()
  }
}

export default function Compositor() {
  const foregroundApp = useForegroundApp()
  const viewRef = useRef<LocalMiniappViewHandle | null>(null)

  // Keep the app mounted through the exit animation. `foregroundApp` flips to
  // null the instant clearForeground runs, but we hold `renderedApp` until the
  // fade-out completes so the overlay can animate off-screen before unmount.
  const [renderedApp, setRenderedApp] = useState(foregroundApp)
  useEffect(() => {
    if (foregroundApp) setRenderedApp(foregroundApp)
  }, [foregroundApp])

  const isForeground = foregroundApp != null
  const screenWidth = Dimensions.get("window").width
  const commitThreshold = screenWidth * COMMIT_FRACTION

  // Keep the module-level back handle pointed at the current view's goBack so
  // the gesture's handleBack (and the Android/capsule paths) can pop in-WebView
  // history before backgrounding.
  viewBackRef.current = () => viewRef.current?.goBack() ?? false

  // Register a capsule handler whenever a miniapp is foregrounded so the
  // global house/X button reflects the Compositor-managed app. The X press
  // backgrounds the app (clearForeground), same as the swipe gesture.
  useEffect(() => {
    if (!foregroundApp) return
    const {setActive} = useCapsuleStore.getState()
    setActive({
      packageName: foregroundApp.packageName,
      viewShotRef: {current: null},
      appNameOverride: foregroundApp.name,
      iconUrlOverride: foregroundApp.logoUrl,
      handleExit: () => {
        handleBack()
      },
    })
    return () => {
      const current = useCapsuleStore.getState().active
      if (current?.packageName === foregroundApp.packageName) {
        setActive(null)
      }
    }
  }, [foregroundApp])

  // Android hardware back: pop in-WebView history, else background the app.
  useEffect(() => {
    if (!isForeground || Platform.OS !== "android") return
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      handleBack()
      return true
    })
    return () => sub.remove()
  }, [isForeground])

  const swipeTranslateX = useSharedValue(0)
  const fadeOpacity = useSharedValue(0)
  const fadeScale = useSharedValue(1)
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: fadeOpacity.value,
    transform: [{translateX: swipeTranslateX.value}, {scale: fadeScale.value}],
  }))

  const swipeGesture = Gesture.Pan()
    .activeOffsetX(10)
    .failOffsetY([-15, 15])
    .onUpdate((e) => {
      if (Platform.OS !== "ios") return
      swipeTranslateX.value = Math.max(0, e.translationX)
    })
    .onEnd((e) => {
      if (Platform.OS !== "ios") {
        if (e.translationX > commitThreshold) {
          runOnJS(handleBack)()
        }
        return
      }
      if (e.translationX > commitThreshold) {
        swipeTranslateX.value = withTiming(screenWidth, {duration: COMMIT_DURATION_MS}, (finished) => {
          if (finished) runOnJS(handleBack)()
        })
      } else {
        swipeTranslateX.value = withSpring(0, {damping: 20, stiffness: 200, overshootClamping: true})
      }
    })

  // Drive fade-in(foreground) and fade-out + shrink (clear).
  useEffect(() => {
    if (isForeground) {
      swipeTranslateX.value = 0
      fadeOpacity.value = 0
      // Zoom-in on launch: scale up from FADE_IN_SCALE_FROM → 1 alongside the
      // opacity fade so the app surface grows into place.
      fadeScale.value = FADE_IN_SCALE_FROM
      fadeOpacity.value = withDelay(FADE_IN_DELAY_MS, withTiming(1, {duration: FADE_IN_DURATION_MS}))
      fadeScale.value = withDelay(FADE_IN_DELAY_MS, withTiming(1, {duration: FADE_IN_DURATION_MS}))
    } else {
      fadeOpacity.value = withTiming(0, {duration: FADE_OUT_DURATION_MS}, (finished) => {
        // Unmount (tear down the WebView) only after the fade-out has played.
        if (finished) runOnJS(setRenderedApp)(null)
      })
      fadeScale.value = withTiming(FADE_OUT_SCALE_TO, {duration: FADE_OUT_DURATION_MS})
    }
  }, [isForeground, swipeTranslateX, fadeOpacity, fadeScale])

  if (!renderedApp) return null

  return (
    <Animated.View
      pointerEvents={isForeground ? "auto" : "box-none"}
      style={[{position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 10}, animatedStyle]}>
      <LocalMiniappView
        ref={viewRef}
        packageName={renderedApp.packageName}
        appName={renderedApp.name}
        version={renderedApp.version}
        devUrl={renderedApp.devUrl}
        iconUrl={renderedApp.logoUrl}
        onExit={clearForeground}
      />
      {isForeground && (
        <GestureDetector gesture={swipeGesture}>
          <View
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: EDGE_HIT_WIDTH,
              zIndex: 10,
            }}
          />
        </GestureDetector>
      )}
      {isForeground && <CapsuleMenu forceShow={true} />}
    </Animated.View>
  )
}
