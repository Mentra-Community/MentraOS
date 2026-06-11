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

import {useCallback, useEffect, useRef, useState} from "react"
import {View} from "react-native"

import CapsuleMenu from "@/effects/CapsuleMenu"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {offlineAppRegistry} from "@/components/miniapp/offlineAppRegistry"
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

  // Compositor edge-swipe backgrounds the app only from the root screen;
  // deeper screens use back (header/hardware) to pop, like LocalMiniappView
  // does with WebView history.
  useEffect(() => {
    setForceGestureEnabled(depth === 1)
    return () => setForceGestureEnabled(false)
  }, [depth, setForceGestureEnabled])

  if (!def) {
    console.error(`OfflineAppHost: no registry entry for ${packageName}`)
    return null
  }

  return (
    <View style={{flex: 1}} ref={viewShotRef} collapsable={false}>
      {stack.map((entry, i) => {
        const RouteComponent = def.routes[entry.path]
        if (!RouteComponent) return null
        return (
          // Keep every entry mounted (hidden when not top) so sub-screen
          // state survives back navigation, like a native stack.
          <View key={`${entry.path}-${i}`} style={{flex: 1, display: i === depth - 1 ? "flex" : "none"}}>
            <RouteComponent />
          </View>
        )
      })}
      <CapsuleMenu forceShow={true} />
    </View>
  )
}
