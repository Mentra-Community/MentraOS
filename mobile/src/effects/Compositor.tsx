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

import {useCallback, useEffect, useRef, useState} from "react"
import {Dimensions, Platform, View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated"

import LocalMiniappView from "@/components/miniapp/LocalMiniappView"
import {captureScreenshot} from "@/effects/CapsuleMenu"
import {useAppStatusStore, useForegroundApp} from "@mentra/island"
import {Screen} from "@/components/ignite/Screen"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
const EDGE_HIT_WIDTH = 24
// Distance past which a slow drag commits the back gesture (fraction of screen
// width). UIKit's interactive pop commits at ~50%; we sit a hair under that.
const COMMIT_FRACTION = 0.5
// Rightward fling speed (px/s) that commits regardless of how far the drag got,
// matching the native "flick to go back" feel. Tuned to ignore slow drags.
const COMMIT_VELOCITY = 500
// Below this translation a fast flick is treated as an accidental swipe, not a
// deliberate back gesture — guards against twitchy taps near the edge.
const MIN_FLICK_TRANSLATION = 12
// Cap the velocity we hand to the commit spring so a frantic flick doesn't
// blow past the off-screen target and snap back visibly.
const MAX_COMMIT_VELOCITY = 3000
const FADE_IN_DELAY_MS = 0
const FADE_IN_DURATION_MS = 1000
const FADE_IN_SCALE_FROM = 0.4
const FADE_OUT_DURATION_MS = 300
const FADE_OUT_SCALE_TO = 0.4

export default function Compositor() {
  const foregroundApp = useForegroundApp()
  const didSwipeToExit = useRef(false)
  const viewShotRef = useRef<View | null>(null)
  const insets = useSaferAreaInsets()

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

  const handleBack = useCallback(() => {
    console.log("handleBack", insets.top)
    captureScreenshot(viewShotRef as any, foregroundApp?.packageName ?? "", insets.top)
    useAppStatusStore.getState().clearForeground()
  }, [foregroundApp?.packageName])

  const handleShouldCapture = useCallback(() => {
    console.log("handleShouldCapture()")
    captureScreenshot(viewShotRef, foregroundApp?.packageName ?? "", insets.top)
  }, [foregroundApp?.packageName, insets.top])

  const swipeTranslateX = useSharedValue(0)
  const fadeOpacity = useSharedValue(0)
  const fadeScale = useSharedValue(1)
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: fadeOpacity.value,
    transform: [{translateX: swipeTranslateX.value}, {scale: fadeScale.value}],
  }))

  const markSwipedToExit = () => {
    didSwipeToExit.current = true
  }

  const swipeGesture = Gesture.Pan()
    .activeOffsetX(10)
    .failOffsetY([-15, 15])
    .onUpdate((e) => {
      if (Platform.OS !== "ios") return
      // Track the finger, clamped to [0, screenWidth] so the release spring
      // starts from a sane position.
      swipeTranslateX.value = Math.min(screenWidth, Math.max(0, e.translationX))
    })
    .onEnd((e) => {
      // Commit when the drag passed the distance threshold OR was released as a
      // fast rightward flick (past a small minimum travel) — same dual
      // criterion UIKit's interactive pop uses.
      let committed =
        e.translationX > commitThreshold || (e.velocityX > COMMIT_VELOCITY && e.translationX > MIN_FLICK_TRANSLATION)

      if (e.velocityX < -100) {
        committed = false
      }

      if (Platform.OS !== "ios") {
        if (committed) runOnJS(handleBack)()
        return
      }

      if (committed) {
        // Continue off-screen carrying the release velocity so finger → spring
        // is seamless. Clamp the seed so a violent flick doesn't overshoot.
        const velocity = Math.min(Math.max(e.velocityX, 0), MAX_COMMIT_VELOCITY)
        runOnJS(markSwipedToExit)()
        swipeTranslateX.value = withSpring(
          screenWidth,
          {damping: 50, stiffness: 800, velocity, overshootClamping: true},
          (finished) => {
            if (finished) runOnJS(handleBack)()
          },
        )

        // swipeTranslateX.value = withTiming(screenWidth*1.1, {duration: 100}, (finished) => {
        //   if (finished) runOnJS(handleBack)()
        // })
      } else {
        // Snap back to rest, also respecting the release velocity (which may be
        // negative — leftward — when the user reverses to cancel).
        swipeTranslateX.value = withSpring(0, {
          // ...SWIPE_SPRING,
          velocity: e.velocityX,
          damping: 50,
          stiffness: 800,
          overshootClamping: true,
        })
      }
    })

  //   // Register a capsule handler whenever a miniapp is foregrounded so the
  // // global house/X button reflects the Compositor-managed app. The X press
  // // backgrounds the app (clearForeground), same as the swipe gesture.
  // useEffect(() => {
  //   if (!foregroundApp) return
  //   const {setActive} = useCapsuleStore.getState()
  //   setActive({
  //     packageName: foregroundApp.packageName,
  //     viewShotRef: {current: null},
  //     appNameOverride: foregroundApp.name,
  //     iconUrlOverride: foregroundApp.logoUrl,
  //     handleLeftPress: () => {
  //       handleBack()
  //     },
  //     handleRightPress: () => {
  //       handleBack()
  //       BgTimer.setTimeout(() => {
  //         useAppStatusStore.getState().stop(foregroundApp.packageName)
  //       }, 100)
  //     },
  //   })
  //   return () => {
  //     const current = useCapsuleStore.getState().active
  //     if (current?.packageName === foregroundApp.packageName) {
  //       setActive(null)
  //     }
  //   }
  // }, [foregroundApp, viewShotRef])

  // Drive fade-in(foreground) and fade-out + shrink (clear).
  useEffect(() => {
    if (isForeground) {
      didSwipeToExit.current = false // reset the flag so we can animate out again
      swipeTranslateX.value = 0
      fadeOpacity.value = 0
      // Zoom-in on launch: scale up from FADE_IN_SCALE_FROM → 1 alongside the
      // opacity fade so the app surface grows into place.
      fadeScale.value = FADE_IN_SCALE_FROM
      fadeOpacity.value = withDelay(FADE_IN_DELAY_MS, withTiming(1, {duration: FADE_IN_DURATION_MS}))
      fadeScale.value = withDelay(FADE_IN_DELAY_MS, withTiming(1, {duration: FADE_IN_DURATION_MS}))
    } else {
      // only animate out if we didn't swipe to exit:
      if (!didSwipeToExit.current) {
        fadeOpacity.value = withTiming(0, {duration: FADE_OUT_DURATION_MS}, (finished) => {
          // Unmount (tear down the WebView) only after the fade-out has played.
          if (finished) runOnJS(setRenderedApp)(null)
        })
        fadeScale.value = withTiming(FADE_OUT_SCALE_TO, {duration: FADE_OUT_DURATION_MS})
      }
    }
  }, [isForeground, swipeTranslateX, fadeOpacity, fadeScale])

  if (!renderedApp) return null

  return (
    <Animated.View
      pointerEvents={isForeground ? "auto" : "box-none"}
      style={[{position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 10}, animatedStyle]}>
      {/* <View ref={viewShotRef} className="h-30 w-30 absolute inset-0"> */}
      <Screen
        preset="fixed"
        backgroundColor="transparent"
        // safeAreaEdges={Platform.OS === "android" ? ["top", "bottom"] : ["top"]}
        KeyboardAvoidingViewProps={{enabled: false}}
        className="px-0"
        ref={viewShotRef}>
        <LocalMiniappView
          packageName={renderedApp.packageName}
          appName={renderedApp.name}
          version={renderedApp.version}
          devUrl={renderedApp.devUrl}
          iconUrl={renderedApp.logoUrl}
          onExit={handleBack}
          onShouldCapture={handleShouldCapture}
        />
      </Screen>
      {/* </View> */}
      {isForeground && Platform.OS === "ios" && (
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
      {/* {isForeground && <CapsuleMenu forceShow={true} />} */}
    </Animated.View>
  )
}
