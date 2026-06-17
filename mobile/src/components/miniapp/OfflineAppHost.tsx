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
 * The internal stack renders through react-native-screens' <ScreenStack>, so
 * push/pop get REAL native stack transitions (UINavigationController on iOS,
 * fragment transitions on Android) plus the native interactive back-swipe on
 * sub-screens — no hand-rolled gesture/animation. The root screen's native
 * gesture is disabled so the Compositor's own edge swipe handles
 * minimize-to-home from there.
 *
 * Back handling: hosted screens self-register capsule/back handlers on mount
 * (useRegisterCapsule). Their defaults would minimize the overlay on every
 * Android back. Child effects run before parent effects, so the host
 * re-asserts its own capsule registration and androidBackFn after every
 * internal stack change (effects keyed on depth) — the host always wins.
 */

import {useCallback, useEffect, useRef, useState} from "react"
import {StyleSheet, View} from "react-native"
import {Screen as NativeScreen, ScreenStack} from "react-native-screens"

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
      // Removing the top <NativeScreen> plays the native pop transition.
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
            // Appending a <NativeScreen> plays the native push transition.
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
        // wait until after the animation is complete to stop the miniapp:
        BgTimer.setTimeout(() => {
          useAppStatusStore.getState().stop(packageName)
        }, 800)
      },
    }
    useCapsuleStore.getState().setActive(registration)
    return () => {
      if (useCapsuleStore.getState().active === registration) {
        useCapsuleStore.getState().setActive(null)
      }
    }
  }, [packageName, appName, iconUrl, depth])

  // The Compositor's edge swipe (minimize-to-home) is only armed at the root
  // screen; deeper screens use the native stack's own back-swipe instead.
  useEffect(() => {
    setForceGestureEnabled(depth === 1)
    return () => setForceGestureEnabled(false)
  }, [depth, setForceGestureEnabled])

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
      <ScreenStack style={{flex: 1}}>
        {stack.map((entry, i) => {
          const RouteComponent = def.routes[entry.path]
          if (!RouteComponent) return null
          return (
            <NativeScreen
              key={`${entry.path}-${i}`}
              style={StyleSheet.absoluteFill}
              // The host mounts with its root screen already in place — only
              // sub-screens animate (native slide).
              stackAnimation={i === 0 ? "none" : "slide_from_right"}
              // Native interactive back-swipe pops sub-screens; the root
              // screen leaves the edge to the Compositor's minimize swipe.
              gestureEnabled={i > 0}
              onDismissed={() => {
                // Native gesture dismissed this screen — sync the JS stack.
                // After a JS-driven pop this is a no-op (entry already gone).
                setStack((s) => (s.length > i ? s.slice(0, i) : s))
              }}>
              <RouteComponent />
            </NativeScreen>
          )
        })}
      </ScreenStack>
      <CapsuleMenu forceShow={true} />
    </View>
  )
}
