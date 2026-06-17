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
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated"

import LocalMiniappView from "@/components/miniapp/LocalMiniappView"
import OfflineAppHost from "@/components/miniapp/OfflineAppHost"
import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {captureScreenshot} from "@/effects/CapsuleMenu"
import {useAppStatusStore, useForegroundApp} from "@mentra/island"
import {Screen} from "@/components/ignite/Screen"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {appSwitcherProgress, OPEN_SPRING, SWIPE_DISTANCE_THRESHOLD, SWIPE_PERCENT_THRESHOLD} from "@/stores/appSwitcher"
import {useNavigationStore} from "@/stores/navigation"
import {hapticBuzz} from "@/utils/utils"
import CrustModule from "@mentra/crust"
import { SETTINGS, useSetting } from "@/stores/settings"
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
// Upward fling speed (px/s) that commits the bottom swipe-up to the app
// switcher regardless of how far the drag got.
const SWITCHER_COMMIT_VELOCITY = -500
// How far the overlay shrinks while the bottom swipe-up follows the finger.
const SWIPE_UP_SCALE_TO = 0.5
const FADE_IN_DELAY_MS = 0
const FADE_IN_DURATION_MS = Platform.OS === "ios" ? 450 : 1200
const FADE_IN_SCALE_FROM = 0.4
const FADE_OUT_DURATION_MS = 300
const FADE_OUT_SCALE_TO = 0.4
// iOS liquid-glass warm-up for offline-hosted apps: the overlay mounts fully
// opaque (but shrunk to a dot) for this long so the glass views configure
// under an opaque ancestor before the real open animation plays.
const GLASS_WARMUP_MS = 10
const GLASS_WARMUP_SCALE = 0.15

export default function Compositor() {
  const foregroundApp = useForegroundApp()
  const didSwipeToExit = useRef(false)
  const viewShotRef = useRef<View | null>(null)
  const insets = useSaferAreaInsets()

  // Keep the app mounted through the exit animation. `foregroundApp` flips to
  // null the instant clearForeground runs, but we hold `renderedApp` until the
  // fade-out completes so the overlay can animate off-screen before unmount.
  const [renderedApp, setRenderedApp] = useState(foregroundApp)
  const [iosAppSwitcherBottomSwipe, setIosAppSwitcherBottomSwipe] = useSetting(SETTINGS.ios_app_switcher_bottom_swipe.key)
  useEffect(() => {
    if (foregroundApp) {
      setRenderedApp(foregroundApp)
    }
    if (Platform.OS === "ios" && iosAppSwitcherBottomSwipe) {
      if (foregroundApp) {
        CrustModule.setDeferredSystemGestures(["bottom"]).catch((e) =>
          console.warn("MANTLE: setDeferredSystemGestures failed", e),
        )
      } else {
        CrustModule.setDeferredSystemGestures([]).catch((e) =>
          console.warn("MANTLE: setDeferredSystemGestures failed", e),
        )
      }
    }
  }, [foregroundApp])

  const isForeground = foregroundApp != null
  // LocalMiniappView toggles this off while the foregrounded miniapp's WebView
  // has in-app history (so the WebView's own back-swipe handles it) and back on
  // once the WebView is at page 0 (so our edge swipe backgrounds the miniapp).
  const gestureEnabled = useNavigationStore((s) => s.forceGestureEnabled)
  const screenWidth = Dimensions.get("window").width
  const screenHeight = Dimensions.get("window").height
  const commitThreshold = screenWidth * COMMIT_FRACTION

  const handleBack = useCallback(() => {
    captureScreenshot(viewShotRef as any, foregroundApp?.packageName ?? "", insets.top)
    useAppStatusStore.getState().clearForeground()
  }, [foregroundApp?.packageName])

  const handleShouldCapture = useCallback(() => {
    console.log("handleShouldCapture()")
    captureScreenshot(viewShotRef, foregroundApp?.packageName ?? "", insets.top)
  }, [foregroundApp?.packageName, insets.top])

  const swipeTranslateX = useSharedValue(0)
  const swipeTranslateY = useSharedValue(0)
  const fadeOpacity = useSharedValue(0)
  const fadeScale = useSharedValue(1)
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: fadeOpacity.value,
    transform: [{translateX: swipeTranslateX.value}, {translateY: swipeTranslateY.value}, {scale: fadeScale.value}],
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

  // Bottom swipe-up → app switcher (iOS home-indicator style). Commits by
  // backgrounding the miniapp and leaving the AppSwitcher open on /home.
  const commitToSwitcher = useCallback(() => {
    const {getCurrentRoute, clearHistoryAndGoHome} = useNavigationStore.getState()
    // The switcher lives on the home route — make sure it's underneath us.
    if (getCurrentRoute() !== "/home") clearHistoryAndGoHome()
    // Not handleBack(): the overlay is already shrunk/faded, so capturing here
    // would overwrite the fresh screenshot taken at gesture begin.
    useAppStatusStore.getState().clearForeground()
  }, [])

  const hasBuzzed = useSharedValue(false)
  const swipeUpGesture = Gesture.Pan()
    .activeOffsetY(-10)
    .failOffsetY(15)
    .onBegin(() => {
      // Fresh screenshot before any transform so the switcher card is current.
      runOnJS(handleShouldCapture)()
    })
    .onUpdate((e) => {
      let ty = Math.min(0, e.translationY)
      ty = Math.max(ty, -screenHeight/4)
      // swipeTranslateY.value = interpolate(ty, [0, screenHeight * 0.5], [0, ty*0.8], Extrapolation.CLAMP)
      let translateY = ty - (fadeScale.value * screenHeight) / 2 + screenHeight / 2
      // console.log("translateY", translateY, -screenHeight/4)
      swipeTranslateY.value = Math.max(-screenHeight/2, translateY)
      // Shrink toward the center following the finger.
      fadeScale.value = interpolate(-ty, [0, screenHeight * 0.3], [1, 0.5], Extrapolation.CLAMP)
      // Reveal the switcher behind us, capped below 1 until release (matching
      // AppSwitcherButton) so the open snap only fires on commit.
      // appSwitcherProgress.value = Math.min(0.9, -ty / SWIPE_DISTANCE_THRESHOLD)

      // Reveal the switcher behind us, capped below 1 until release (matching
      // AppSwitcherButton) so the open snap only fires on commit.
      // appSwitcherProgress.value = Math.min(0.9, -ty / SWIPE_DISTANCE_THRESHOLD)

      let val = Math.min(0.9, -ty / SWIPE_DISTANCE_THRESHOLD)
      const shouldOpen = val > SWIPE_PERCENT_THRESHOLD || -ty > SWIPE_DISTANCE_THRESHOLD
      if (shouldOpen && !hasBuzzed.value) {
        hasBuzzed.value = true
        runOnJS(hapticBuzz)()
      }
    })
    .onEnd((e) => {
      hasBuzzed.value = false
      const distance = -e.translationY
      let val = Math.min(0.9, distance / SWIPE_DISTANCE_THRESHOLD)
      const committed =
        val > SWIPE_PERCENT_THRESHOLD ||
        distance > SWIPE_DISTANCE_THRESHOLD ||
        (e.velocityY < SWITCHER_COMMIT_VELOCITY && distance > MIN_FLICK_TRANSLATION)

      if (committed) {
        runOnJS(markSwipedToExit)()
        appSwitcherProgress.value = withSpring(1, OPEN_SPRING)
        // Keep drifting up and shrinking while the fade-out plays.
        // swipeTranslateY.value = withSpring(e.translationY - 60, {damping: 50, stiffness: 800})
        fadeScale.value = withSpring(FADE_OUT_SCALE_TO, {damping: 50, stiffness: 800})
        fadeOpacity.value = withTiming(0, {duration: 200}, (finished) => {
          if (finished) runOnJS(commitToSwitcher)()
        })
      } else {
        swipeTranslateY.value = withSpring(0, {
          velocity: e.velocityY,
          damping: 50,
          stiffness: 800,
          overshootClamping: true,
        })
        fadeScale.value = withSpring(1, {damping: 50, stiffness: 800, overshootClamping: true})
        // appSwitcherProgress.value = withSpring(0, {damping: 20, stiffness: 500, overshootClamping: true})
      }
    })

  // Drive fade-in(foreground) and fade-out + shrink (clear).
  useEffect(() => {
    if (isForeground) {
      didSwipeToExit.current = false // reset the flag so we can animate out again
      swipeTranslateX.value = 0
      swipeTranslateY.value = 0
      // iOS offline-hosted apps: liquid-glass surfaces misrender when they're
      // configured while an ancestor animates opacity. Warm-up trick: mount
      // fully OPAQUE but scaled to a dot for ~10ms so the glass initializes
      // under an opaque ancestor, then snap to the normal animation's start
      // state and play the usual fade+zoom.
      if (Platform.OS === "ios" && foregroundApp && isOfflineHosted(foregroundApp.packageName)) {
        fadeOpacity.value = 1
        fadeScale.value = GLASS_WARMUP_SCALE
        // Park the overlay off-screen during the warm-up so the opaque
        // surface never actually paints in view; snap back as the real
        // animation starts.
        // swipeTranslateY.value = screenHeight
        // swipeTranslateY.value = withSequence(
        //   withTiming(screenHeight, {duration: GLASS_WARMUP_MS}),
        //   withTiming(0, {duration: 0}),
        // )
        fadeOpacity.value = withSequence(
          withTiming(1, {duration: GLASS_WARMUP_MS}), // hold opaque while glass configures
          withTiming(0, {duration: 0}), // snap invisible
          withTiming(1, {duration: FADE_IN_DURATION_MS}), // normal fade-in
        )
        fadeScale.value = withSequence(
          withTiming(GLASS_WARMUP_SCALE, {duration: GLASS_WARMUP_MS}),
          withTiming(FADE_IN_SCALE_FROM, {duration: 0}),
          withTiming(1, {duration: FADE_IN_DURATION_MS}), // normal zoom-in
        )
      } else {
        fadeOpacity.value = 0
        // Zoom-in on launch: scale up from FADE_IN_SCALE_FROM → 1 alongside the
        // opacity fade so the app surface grows into place.
        fadeScale.value = FADE_IN_SCALE_FROM
        fadeOpacity.value = withDelay(FADE_IN_DELAY_MS, withTiming(1, {duration: FADE_IN_DURATION_MS}))
        fadeScale.value = withDelay(FADE_IN_DELAY_MS, withTiming(1, {duration: FADE_IN_DURATION_MS}))
      }
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
  }, [isForeground, swipeTranslateX, swipeTranslateY, fadeOpacity, fadeScale])

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
        {isOfflineHosted(renderedApp.packageName) ? (
          <OfflineAppHost
            packageName={renderedApp.packageName}
            appName={renderedApp.name}
            iconUrl={renderedApp.logoUrl}
            onExit={handleBack}
            onShouldCapture={handleShouldCapture}
          />
        ) : (
          <LocalMiniappView
            packageName={renderedApp.packageName}
            appName={renderedApp.name}
            version={renderedApp.version}
            devUrl={renderedApp.devUrl}
            devPort={renderedApp.devPort != null ? String(renderedApp.devPort) : undefined}
            iconUrl={renderedApp.logoUrl}
            onExit={handleBack}
            onShouldCapture={handleShouldCapture}
          />
        )}
      </Screen>
      {/* </View> */}
      {isForeground && gestureEnabled && Platform.OS === "ios" && (
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
      {/* Bottom swipe-up to the app switcher — always available while
          foregrounded (unlike the edge swipe, it doesn't defer to webview
          history via forceGestureEnabled). */}
      {isForeground && Platform.OS === "ios" && iosAppSwitcherBottomSwipe && (
        <GestureDetector gesture={swipeUpGesture}>
          <View
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: Math.max(insets.bottom, 24),
              zIndex: 11,
            }}
          />
        </GestureDetector>
      )}
      {/* {isForeground && <CapsuleMenu forceShow={true} />} */}
    </Animated.View>
  )
}
