/**
 * OfflineAppHost — renders a built-in offline app (Settings, Store, Mirror,
 * Gallery, Feedback) inside the Compositor overlay, the way LocalMiniappView
 * hosts local miniapp WebViews. The hosted screens are the unmodified
 * expo-router screen components; they are mounted here directly instead of
 * being pushed onto the root router stack.
 *
 * Navigation: hosted screens navigate via the global useNavigationStore. If
 * those calls reached expo-router they'd land on the root stack BEHIND the
 * overlay, invisible. While mounted, the host registers a NavInterceptor:
 *   - paths in the app's route table   → pushed/popped on an internal stack
 *   - anything else (pairing, sign-out) → clearForeground() first, then the
 *     call falls through to the real router under the fading overlay
 *
 * Back handling: hosted screens self-register capsule/back handlers on mount
 * (useRegisterCapsule). Their defaults would minimize the overlay on every
 * Android back. Child effects run before parent effects, so the host
 * re-asserts its own capsule registration and androidBackFn after every
 * internal stack change (effects keyed on depth) — the host always wins.
 */

import {useCallback, useEffect, useRef, useState, type ReactNode} from "react"
import {Dimensions, Platform, StyleSheet, View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated"

import CapsuleMenu from "@/effects/CapsuleMenu"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {offlineAppRegistry} from "@/components/miniapp/offlineAppRegistry"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useCapsuleStore} from "@/stores/capsule"
import {useNavigationStore, type NavInterceptor} from "@/stores/navigation"
import {BgTimer, useAppStatusStore} from "@mentra/island"

interface OfflineAppHostProps {
  packageName: string
  appName?: string
  iconUrl?: string
  /** Compositor's handleBack — captures a screenshot and clears foreground. */
  onExit: () => void
  /** Capture an app-switcher screenshot without exiting. */
  onShouldCapture?: () => void
}

interface StackEntry {
  path: string
  params?: any
}

// Internal pop swipe — same feel/thresholds as the Compositor's edge swipe
// (see Compositor.tsx for the rationale behind each value).
const EDGE_HIT_WIDTH = 24
const COMMIT_FRACTION = 0.5
const COMMIT_VELOCITY = 500
const MIN_FLICK_TRANSLATION = 12
const MAX_COMMIT_VELOCITY = 3000

export default function OfflineAppHost({packageName, appName, iconUrl, onExit, onShouldCapture}: OfflineAppHostProps) {
  const def = offlineAppRegistry[packageName]

  const [stack, setStack] = useState<StackEntry[]>(() => (def ? [{path: def.initialRoute}] : []))
  const stackRef = useRef(stack)
  stackRef.current = stack
  const depth = stack.length

  const viewShotRef = useRef<View | null>(null)
  const setForceGestureEnabled = useNavigationStore((s) => s.setForceGestureEnabled)

  const {theme} = useAppTheme()

  // Latest-callback refs so the mount-once interceptor never closes over
  // stale props.
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onShouldCaptureRef = useRef(onShouldCapture)
  onShouldCaptureRef.current = onShouldCapture

  const popOrExit = useCallback(() => {
    if (stackRef.current.length > 1) {
      setStack((s) => s.slice(0, -1))
    } else {
      onExitRef.current()
    }
  }, [])

  // The host stays mounted through the Compositor's fade-out (renderedApp
  // lingers after clearForeground). During that window the interceptor must
  // stand down so real navigation works again.
  const isHostForegrounded = useCallback(
    () => useAppStatusStore.getState().apps.some((a) => a.foregrounded && a.packageName === packageName),
    [packageName],
  )

  useEffect(() => {
    if (!def) return
    const interceptor: NavInterceptor = {
      push: (path, params) => {
        if (!isHostForegrounded()) return false
        if (def.routes[path]) {
          const top = stackRef.current[stackRef.current.length - 1]
          if (top?.path !== path) {
            setStack((s) => [...s, {path, params}])
          }
          return true
        }
        // External route — close the overlay and let the real push proceed.
        onShouldCaptureRef.current?.()
        useAppStatusStore.getState().clearForeground()
        return false
      },
      replace: (path, params) => {
        if (!isHostForegrounded()) return false
        if (def.routes[path]) {
          setStack((s) => [...s.slice(0, -1), {path, params}])
          return true
        }
        // e.g. sign-out replace("/") — close the overlay first.
        useAppStatusStore.getState().clearForeground()
        return false
      },
      goBack: () => {
        if (!isHostForegrounded()) return false
        popOrExit()
        return true
      },
    }
    useNavigationStore.getState().setInterceptor(interceptor)
    return () => {
      if (useNavigationStore.getState().interceptor === interceptor) {
        useNavigationStore.getState().setInterceptor(null)
      }
    }
  }, [def, popOrExit, isHostForegrounded])

  // Android hardware back / iOS beforeRemove. The depth dependency gives the
  // callback a fresh identity after every internal navigation, which re-runs
  // the focus effect AFTER the just-mounted hosted screen registered its own
  // androidBackFn — re-asserting the host's handler.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleHostBack = useCallback(() => {
    popOrExit()
  }, [popOrExit, depth])
  focusEffectPreventBack(handleHostBack, false)

  // Capsule (house/X). Registered directly — useRegisterCapsule's default
  // handlers call goBack(), which the interceptor would turn into an internal
  // pop instead of a minimize. Re-asserted on depth changes for the same
  // clobbering reason as androidBackFn above.
  useEffect(() => {
    const registration = {
      packageName,
      viewShotRef,
      appNameOverride: appName,
      iconUrlOverride: iconUrl,
      // The global CapsuleMenu instance keys off real routes; the host renders
      // its own <CapsuleMenu forceShow /> below (same trick as LocalMiniappView).
      visibleOnRoutes: ["/intentionally-not-a-real-route"],
      handleLeftPress: () => {
        onExitRef.current()
      },
      handleRightPress: () => {
        onExitRef.current()
        BgTimer.setTimeout(() => {
          useAppStatusStore.getState().stop(packageName)
        }, 100)
      },
    }
    useCapsuleStore.getState().setActive(registration)
    return () => {
      if (useCapsuleStore.getState().active === registration) {
        useCapsuleStore.getState().setActive(null)
      }
    }
  }, [packageName, appName, iconUrl, depth])

  // The Compositor's own edge swipe (minimize-to-home) is only armed at the
  // root screen; deeper screens get the host's pop swipe below instead.
  useEffect(() => {
    setForceGestureEnabled(depth === 1)
    return () => setForceGestureEnabled(false)
  }, [depth, setForceGestureEnabled])

  // Interactive iOS pop swipe for depth > 1 (e.g. appearance → main): the top
  // screen follows the finger and slides off, revealing the screen beneath
  // (which stays mounted behind it). Commit criteria mirror the Compositor's
  // minimize swipe so the two gestures feel identical.
  const screenWidth = Dimensions.get("window").width
  const popTranslateX = useSharedValue(0)
  // Index of the entry the gesture is dragging. The transform binds to THIS
  // index (not "whoever is top"), so after a committed pop the outgoing
  // screen stays parked off-screen until React unmounts it — resetting the
  // translation before the unmount flashed the old screen back over the
  // revealed one for a frame.
  const popTargetIndex = useSharedValue(-1)
  const popTop = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
  }, [])

  // Clear the gesture values only after the pop has committed; by then the
  // popped index no longer exists, so nothing visibly snaps.
  useEffect(() => {
    popTargetIndex.value = -1
    popTranslateX.value = 0
  }, [depth, popTargetIndex, popTranslateX])

  const topIndex = depth - 1
  const popSwipeGesture = Gesture.Pan()
    .activeOffsetX(10)
    .failOffsetY([-15, 15])
    .onStart(() => {
      popTargetIndex.value = topIndex
    })
    .onUpdate((e) => {
      popTranslateX.value = Math.min(screenWidth, Math.max(0, e.translationX))
    })
    .onEnd((e) => {
      let committed =
        e.translationX > screenWidth * COMMIT_FRACTION ||
        (e.velocityX > COMMIT_VELOCITY && e.translationX > MIN_FLICK_TRANSLATION)
      if (e.velocityX < -100) committed = false

      if (committed) {
        const velocity = Math.min(Math.max(e.velocityX, 0), MAX_COMMIT_VELOCITY)
        popTranslateX.value = withSpring(
          screenWidth,
          {damping: 50, stiffness: 800, velocity, overshootClamping: true},
          (finished) => {
            if (finished) runOnJS(popTop)()
          },
        )
      } else {
        popTranslateX.value = withSpring(
          0,
          {
            velocity: e.velocityX,
            damping: 50,
            stiffness: 800,
            overshootClamping: true,
          },
          (finished) => {
            if (finished) popTargetIndex.value = -1
          },
        )
      }
    })

  if (!def) {
    console.error(`OfflineAppHost: no registry entry for ${packageName}`)
    return null
  }

  return (
    // Opaque themed backdrop: the Compositor's Screen wrapper is transparent
    // (so its scale animation reveals home behind the overlay), but liquid
    // glass surfaces in the hosted screens sample whatever is behind them —
    // without this they'd pick up the home screen instead of the app
    // background they sat on when pushed as routes.
    // Rounded corners match LocalMiniappView's surface (same radius). Unlike
    // the WebView there — which clips itself — the hosted screens are plain
    // views, so the root must clip them via overflow:hidden for the radius
    // to show.
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.background,
        borderRadius: theme.spacing.s12,
        borderCurve: "continuous",
        overflow: "hidden",
      }}
      ref={viewShotRef}
      collapsable={false}>
      {stack.map((entry, i) => {
        const RouteComponent = def.routes[entry.path]
        if (!RouteComponent) return null
        const isTop = i === depth - 1
        // The entry directly beneath the top stays visible (fully covered by
        // the opaque top screen) so the pop swipe reveals it mid-gesture.
        const isUnderTop = i === depth - 2
        return (
          // Keep every entry mounted (hidden when not top) so sub-screen
          // state survives back navigation, like a native stack.
          <HostStackEntry
            key={`${entry.path}-${i}`}
            index={i}
            visible={isTop || isUnderTop}
            popTargetIndex={popTargetIndex}
            popTranslateX={popTranslateX}>
            <RouteComponent />
          </HostStackEntry>
        )
      })}
      {depth > 1 && Platform.OS === "ios" && (
        <GestureDetector gesture={popSwipeGesture}>
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
      <CapsuleMenu forceShow={true} />
    </View>
  )
}

/**
 * One mounted screen of the host's internal stack. Owns its own animated
 * style so the pop translation applies only to the entry whose index the
 * gesture targeted — see popTargetIndex above.
 */
function HostStackEntry({
  index,
  visible,
  popTargetIndex,
  popTranslateX,
  children,
}: {
  index: number
  visible: boolean
  popTargetIndex: SharedValue<number>
  popTranslateX: SharedValue<number>
  children: ReactNode
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{translateX: popTargetIndex.value === index ? popTranslateX.value : 0}],
  }))
  return (
    <Animated.View style={[StyleSheet.absoluteFill, animatedStyle, {display: visible ? "flex" : "none"}]}>
      {children}
    </Animated.View>
  )
}
