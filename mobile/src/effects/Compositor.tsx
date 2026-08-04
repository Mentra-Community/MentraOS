/**
 * Compositor — renders the foregrounded local miniapp over the rest of the app.
 *
 * Subscribes to the island apps store's `foregrounded` flag (set by
 * setForeground, e.g. from the AppSwitcher press path). At most one app is
 * foregrounded at a time. When an app becomes foreground the Compositor:
 *   1. Mounts <LocalMiniappView /> — which spawns the JSContext (idempotent)
 *      and renders the UI WebView — inside an Animated.View overlay.
 *   2. Plays an opening animation: a horizontal slide-in from the right edge,
 *      mimicking the native OS stack push. The same slide is used for
 *      offline-hosted apps (Settings, glasses mirror) so all local apps open
 *      and close consistently.
 *   3. Registers the global capsule (house/X button) for the active miniapp.
 *   4. Owns the iOS-style left-edge swipe-to-back gesture; on commit it
 *      clears foreground. The overlay slides/fades off and the WebView
 *      unmounts — the JSContext stays alive (backgrounded, not stopped).
 *
 * The always-on JSContext is owned by MentraJSRouter; the WebView is only
 * mounted while the miniapp is foreground.
 */

import {useCallback, useEffect, useRef, useState} from "react"
import {Dimensions, Keyboard, Platform, View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated"

import LocalMiniappView from "@/components/miniapp/LocalMiniappView"
import OfflineAppHost from "@/components/miniapp/OfflineAppHost"
import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {captureScreenshot} from "@/effects/CapsuleMenu"
import {engine, useForegroundApp, SETTINGS, useSetting} from "@mentra/engine"
import {Screen} from "@/components/ignite/Screen"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {appSwitcherProgress, OPEN_SPRING, SWIPE_DISTANCE_THRESHOLD, SWIPE_PERCENT_THRESHOLD} from "@/stores/appSwitcher"
import {useNavigationStore} from "@/stores/navigation"
import {hapticBuzz} from "@/utils/utils"
import CrustModule from "@mentra/crust"
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
// Scale the overlay shrinks to when committing the bottom swipe-up to the app
// switcher (a deliberate zoom-out, distinct from the open/close slide).
const FADE_OUT_SCALE_TO = 0.4
// Standard OS-style open/close: the overlay slides in horizontally from the
// right edge (push) and slides back out to the right (pop), mimicking the
// native stack transition rather than the old fade+zoom. The slide distance is
// the full screen width (set per-render below).
const SLIDE_DURATION_MS = Platform.OS === "ios" ? 300 : 260
// iOS liquid-glass warm-up for offline-hosted apps: the overlay mounts fully
// opaque (parked off-screen to the right) for this long so the glass views
// configure under an opaque ancestor before the real slide-in plays.
const GLASS_WARMUP_MS = 10

export default function Compositor() {
  const foregroundApp = useForegroundApp()
  // Last foregrounded packageName (null = none) — lets the keyboard-dismiss
  // effect below fire only on real identity changes, not reference churn.
  const prevForegroundPackageRef = useRef<string | null>(null)
  const didSwipeToExit = useRef(false)
  const viewShotRef = useRef<View | null>(null)
  const insets = useSaferAreaInsets()

  // Keep the app mounted through the exit animation. `foregroundApp` flips to
  // null the instant clearForeground runs, but we hold `renderedApp` until the
  // fade-out completes so the overlay can animate off-screen before unmount.
  const [renderedApp, setRenderedApp] = useState(foregroundApp)
  // The capsule (house/X button) is hidden during the open animation and only
  // revealed once the fade-in/zoom-in completes, so it doesn't pop in while the
  // overlay is still growing into place.
  const [capsuleVisible, setCapsuleVisible] = useState(false)
  const [iosAppSwitcherBottomSwipe, setIosAppSwitcherBottomSwipe] = useSetting(
    SETTINGS.ios_app_switcher_bottom_swipe.key,
  )
  useEffect(() => {
    // A TextInput focused in one miniapp/screen can otherwise keep the IME's
    // served view across a switch to a different app (or back to none on
    // minimize), causing the keyboard to pop back up over a screen with no
    // visible input field. This is the single choke point both directions
    // funnel through. Gate on the foregrounded IDENTITY, not the object:
    // refresh() hands this effect a new foregroundApp reference on every
    // store poll even while the same miniapp stays foregrounded, and
    // dismissing on those would drop the keyboard mid-typing (e.g. an RN
    // TextInput on a settings screen) with no actual app switch.
    const currentPackage = foregroundApp?.packageName ?? null
    if (currentPackage !== prevForegroundPackageRef.current) {
      prevForegroundPackageRef.current = currentPackage
      Keyboard.dismiss()
    }
    if (foregroundApp) {
      // Only swap renderedApp when a DIFFERENT app is foregrounded. refresh()
      // hands us a new foregroundApp object reference on every poll even when
      // it's the same app; re-setting state with it would re-render the overlay
      // (and its Animated.View) mid-slide and hitch the open animation. Freezing
      // the reference for the lifetime of one open keeps the slide on the UI
      // thread, uninterrupted. (Fields like name/url are read once at mount via
      // the package-keyed child, so a stale reference here is fine.)
      setRenderedApp((prev) => (prev?.packageName === foregroundApp.packageName ? prev : foregroundApp))
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
    engine.miniapps.clearForeground()
  }, [foregroundApp?.packageName])

  const handleShouldCapture = useCallback(() => {
    console.log("handleShouldCapture()")
    captureScreenshot(viewShotRef, foregroundApp?.packageName ?? "", insets.top)
  }, [foregroundApp?.packageName, insets.top])

  // Exit for the swipe-commit paths: the screenshot was already captured at
  // commit time (while the overlay was still mounted — the CLOSE effect
  // unmounts swipe exits immediately, so capturing here would race teardown).
  const finishSwipeExit = useCallback(() => {
    engine.miniapps.clearForeground()
  }, [])

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
    // Swipe exits bypass OfflineAppHost's beginExit(), so the host never gets
    // to stand its NavInterceptor down itself. Clear it here so pushes landing
    // during the exit spring reach the real router instead of the dying host's
    // internal stack. (Identity-guarded cleanups make this safe: the host's
    // unmount cleanup only clears an interceptor that is still its own.)
    useNavigationStore.getState().setInterceptor(null)
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
        // Capture the app-switcher card now, while the overlay is guaranteed
        // mounted for the whole spring (the swipe exit unmounts right after
        // clearForeground, unlike the button close's slide-out grace period).
        runOnJS(handleShouldCapture)()
        swipeTranslateX.value = withSpring(
          screenWidth,
          {damping: 50, stiffness: 800, velocity, overshootClamping: true},
          (finished) => {
            if (finished) runOnJS(finishSwipeExit)()
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
    engine.miniapps.clearForeground()
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
      ty = Math.max(ty, -screenHeight / 4)
      // swipeTranslateY.value = interpolate(ty, [0, screenHeight * 0.5], [0, ty*0.8], Extrapolation.CLAMP)
      let translateY = ty - (fadeScale.value * screenHeight) / 2 + screenHeight / 2
      // console.log("translateY", translateY, -screenHeight/4)
      swipeTranslateY.value = Math.max(-screenHeight / 2, translateY)
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

  // OPEN: slide the overlay in from the right edge once the app is actually
  // mounted. This is keyed on `renderedApp` (not `isForeground`) on purpose:
  // on tap, `foregroundApp` flips to non-null but `renderedApp` is set one
  // render later by the effect above, so the overlay doesn't exist yet on the
  // first foreground render. Driving the slide off `renderedApp` guarantees the
  // animation starts on the same render the <Animated.View> first mounts —
  // otherwise the withTiming runs against an unmounted view and the app just
  // pops in. We standardize this slide for BOTH local miniapps and
  // offline-hosted apps (Settings, glasses mirror, …) so every local app opens
  // like a native OS stack push.
  const openedPackageRef = useRef<string | null>(null)
  useEffect(() => {
    if (!renderedApp || !isForeground) return
    // Only play the open slide when a NEW app is foregrounded, not on unrelated
    // re-renders (e.g. capsule/gesture state changes) while it's already open.
    if (openedPackageRef.current === renderedApp.packageName) return
    openedPackageRef.current = renderedApp.packageName

    didSwipeToExit.current = false // reset so we can animate out again
    setCapsuleVisible(false) // hide the capsule until the open slide finishes
    // Opacity and scale stay at 1 for the whole slide — the OS push doesn't
    // fade or zoom, it just translates the new surface in from the edge.
    fadeScale.value = 1
    swipeTranslateY.value = 0
    fadeOpacity.value = 1

    const slideIn = () =>
      withTiming(0, {duration: SLIDE_DURATION_MS, easing: Easing.out(Easing.cubic)}, (finished) => {
        // Reveal the capsule only after the open animation completes.
        if (finished) runOnJS(setCapsuleVisible)(true)
      })

    // iOS offline-hosted apps: liquid-glass surfaces misrender when they're
    // configured while an ancestor is mid-transition. Warm-up trick: mount
    // fully OPAQUE but parked off-screen to the right for ~10ms so the glass
    // initializes under an opaque ancestor, then slide in normally.
    if (Platform.OS === "ios" && isOfflineHosted(renderedApp.packageName)) {
      swipeTranslateX.value = screenWidth // park off-screen right while glass configures
      swipeTranslateX.value = withSequence(
        withTiming(screenWidth, {duration: GLASS_WARMUP_MS}), // hold parked while glass configures
        slideIn(),
      )
    } else {
      swipeTranslateX.value = screenWidth // start fully off-screen to the right
      swipeTranslateX.value = slideIn()
    }
    // Depend on the package STRING, not the renderedApp object. refresh() is
    // event-driven and re-creates app objects on every poll, so depending on the
    // object re-ran this effect (and re-rendered the overlay) mid-slide — the
    // source of the open-animation hitch. The package only changes when a truly
    // different app is foregrounded, which is the only time we want to re-slide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedApp?.packageName, isForeground, swipeTranslateX, swipeTranslateY, fadeOpacity, fadeScale, screenWidth])

  // CLOSE: slide the overlay back out to the right, then unmount. The swipe-to-
  // back / swipe-up-to-switcher paths drive their own off-screen animation, so
  // we only run this for the button/X (non-swipe) close.
  useEffect(() => {
    if (isForeground) return
    openedPackageRef.current = null // allow the next open to re-trigger the slide
    if (didSwipeToExit.current) {
      // The swipe gesture already drove the overlay off-screen (edge swipe) or
      // faded it out (switcher swipe-up) before clearing foreground — unmount
      // immediately. Skipping the unmount here left renderedApp set forever:
      // the host stayed mounted invisibly, and for offline-hosted apps its
      // still-registered NavInterceptor silently swallowed every later push()
      // to a route it owns (e.g. home's glasses card → /miniapps/settings/main
      // after swiping out of Settings).
      setRenderedApp(null)
      return
    }
    fadeOpacity.value = 1
    fadeScale.value = 1
    swipeTranslateX.value = withTiming(
      screenWidth,
      {duration: SLIDE_DURATION_MS, easing: Easing.in(Easing.cubic)},
      (finished) => {
        // Unmount (tear down the WebView) only after the slide-out has played.
        if (finished) runOnJS(setRenderedApp)(null)
      },
    )
  }, [isForeground, swipeTranslateX, fadeOpacity, fadeScale, screenWidth])

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
            // Key by package for the same reason as LocalMiniappView below:
            // switching between two offline-hosted apps must mount a fresh host
            // (the internal stack only seeds from def.initialRoute on mount, so
            // a reused instance would keep the previous app's stack).
            key={renderedApp.packageName}
            packageName={renderedApp.packageName}
            appName={renderedApp.name}
            iconUrl={renderedApp.logoUrl}
            onExit={handleBack}
            onShouldCapture={handleShouldCapture}
            // show capsule once the open animation is complete:
            showCapsule={capsuleVisible}
          />
        ) : (
          <LocalMiniappView
            // Key by package so switching from app A to app B mounts a FRESH
            // WebView instead of navigating the existing one to B's URL. Reusing
            // the instance left A's page in WKWebView's back-history, so
            // `webViewCanGoBack` became true under B — which disabled the
            // Compositor's minimize-swipe and made the back-swipe pop to A's
            // page instead of returning home.
            key={renderedApp.packageName}
            packageName={renderedApp.packageName}
            appName={renderedApp.name}
            version={renderedApp.version}
            devUrl={renderedApp.devUrl}
            devPort={renderedApp.devPort != null ? String(renderedApp.devPort) : undefined}
            iconUrl={renderedApp.logoUrl}
            onExit={handleBack}
            onShouldCapture={handleShouldCapture}
            // show capsule once the open animation is complete:
            showCapsule={capsuleVisible}
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
