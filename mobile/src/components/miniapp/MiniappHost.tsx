import {useEffect, useState, useCallback, useRef} from "react"
import {View, Alert, Platform} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import {WebView, WebViewMessageEvent} from "react-native-webview"
import * as Sentry from "@sentry/react-native"
import CrustModule from "crust"

import LeftEdgeBackSwipe from "@/components/miniapp/LeftEdgeBackSwipe"
import MiniappSplash from "@/components/miniapp/MiniappSplash"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useStressTestStore} from "@/stores/stressTest"
import {
  devServerBridge,
  localDisplayManager,
  localMiniappRuntime,
  webviewBridge as miniComms,
  miniappRunningRegistry,
  buildMiniappGlobalsScript,
  getDeviceTierBackgroundSlots,
  getDeviceTierLabel,
  selectMiniappsToEvict,
  UNLIMITED_BACKGROUND_SLOTS,
} from "@mentra/island"

const BEFORE_EVICT_TIMEOUT_MS = 500

/**
 * Phase 0 LRU eviction — device's total RAM in bytes. Sampled once on
 * first read and memoized; never changes at runtime. On Android (and the
 * web/test fallback) the native shim returns 0, which the policy treats
 * as "unlimited" → eviction is disabled where it shouldn't apply.
 */
let cachedPhysicalMemoryBytes: number | null = null
function readPhysicalMemoryBytes(): number {
  if (cachedPhysicalMemoryBytes !== null) return cachedPhysicalMemoryBytes
  try {
    const fn = (CrustModule as unknown as {getPhysicalMemoryBytes?: () => number}).getPhysicalMemoryBytes
    const v = typeof fn === "function" ? fn.call(CrustModule) : 0
    cachedPhysicalMemoryBytes = typeof v === "number" && Number.isFinite(v) ? v : 0
  } catch {
    cachedPhysicalMemoryBytes = 0
  }
  return cachedPhysicalMemoryBytes
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MountedMiniapp {
  packageName: string
  source: {uri: string} | {html: string}
  developerMode: boolean
  isForeground: boolean
  isLoaded: boolean
  /**
   * Monotonic counter bumped on every mount/mountDev call for this package.
   * Used as the WebView's React `key` so a second scan forces a fresh
   * WebView instance (hard reload of the dev URL). Without this, React
   * reuses the WebView and `source` prop changes don't trigger a reload.
   */
  mountKey: number
  /**
   * Phase 0 LRU eviction: true when THIS mount session was kicked off after
   * a previous eviction (i.e. the user came back to a miniapp we had
   * dropped). Drives the "Restoring…" splash label. Set by mount/mountDev
   * when the evictedPackages set names this package; never re-evaluated
   * during the mount lifetime.
   */
  wasEvicted: boolean
  appName?: string
  iconUrl?: string
  onClose?: () => void
  onBack?: () => void
}

// ---------------------------------------------------------------------------
// Module-level singleton API
// ---------------------------------------------------------------------------

type CanGoBackListener = (canGoBack: boolean) => void

type MiniappMountOptions = {
  developerMode?: boolean
  appName?: string
  iconUrl?: string
  /**
   * Manifest data for the miniapp (permissions + hardwareRequirements).
   * The mounted miniapp's SUBSCRIBE / one-shot calls are gated against
   * the declared permissions, so we have to register the manifest with
   * the runtime before the bundle does its first SUBSCRIBE. Dev mounts
   * fetch this from the live server inside mountDev; installed mounts
   * pass it in here (the route loads it via appRegistry.getMiniappManifest).
   */
  manifest?: MountDevManifest
}

export type MountDevManifest = {
  permissions?: Array<{type: string; required?: boolean; description?: string}>
  hardwareRequirements?: Array<{type: string; level: string; description?: string}>
}

type MiniappHostAPI = {
  mount(packageName: string, bundleUri: string, options?: MiniappMountOptions): void
  mountDev(packageName: string, devUrl: string, options?: MiniappMountOptions): Promise<MountDevManifest | undefined>
  unmount(packageName: string): void
  setForeground(packageName: string, callbacks?: {onClose?: () => void; onBack?: () => void}): void
  setBackground(packageName: string): void
  isRunning(packageName: string): boolean
  /** Returns true if the WebView navigated back one page; false if there was no history. */
  goBackInWebView(packageName: string): boolean
  /** Current value of WebView.canGoBack for the given package. */
  canGoBack(packageName: string): boolean
  /** Subscribe to canGoBack changes for a package. Returns an unsubscribe fn. */
  subscribeCanGoBack(packageName: string, listener: CanGoBackListener): () => void
  /** Reload a mounted miniapp's WebView (used by dev server bridge). */
  reload(packageName: string): void
}

// Stubs that get replaced once the React component mounts.
export const miniappHost: MiniappHostAPI = {
  mount: (_packageName: string, _bundleUri: string, _options?: MiniappMountOptions) => {
    console.warn("MiniappHost: mount() called before component mounted")
  },
  mountDev: async (_packageName: string, _devUrl: string, _options?: MiniappMountOptions) => {
    console.warn("MiniappHost: mountDev() called before component mounted")
    return undefined
  },
  unmount: () => {
    console.warn("MiniappHost: unmount() called before component mounted")
  },
  setForeground: () => {
    console.warn("MiniappHost: setForeground() called before component mounted")
  },
  setBackground: () => {
    console.warn("MiniappHost: setBackground() called before component mounted")
  },
  isRunning: () => false,
  goBackInWebView: () => false,
  canGoBack: () => false,
  subscribeCanGoBack: () => () => {},
  reload: () => {
    console.warn("MiniappHost: reload() called before component mounted")
  },
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MiniappHost() {
  const [apps, setApps] = useState<Map<string, MountedMiniapp>>(new Map())
  const webViewRefs = useRef<Map<string, WebView>>(new Map())
  const canGoBackMap = useRef<Map<string, boolean>>(new Map())
  const canGoBackListeners = useRef<Map<string, Set<CanGoBackListener>>>(new Map())
  // Phase 0: name of the package currently in the foreground (or null when no
  // miniapp is foregrounded). Tracked separately from `apps` because setApps
  // is asynchronous and the eviction policy needs an authoritative read.
  // setForeground/setBackground/unmount keep this in sync; the registry's
  // markForeground() reads through it for the "last foregrounded" timestamp.
  const foregroundPackageRef = useRef<string | null>(null)
  // Phase 0: packages that were LRU-evicted in this session. When such a
  // package gets re-mounted, we render the "Restoring…" splash label so the
  // user understands the WebView is rehydrating from session.storage. Cleared
  // for that package on the next mount/mountDev (consumed once).
  const [evictedPackages, setEvictedPackages] = useState<Set<string>>(new Set())
  // Phase 0: enforceCapacity is defined further down (it needs to call
  // sendBeforeEvict + unmount, which are defined below mount/mountDev). The
  // ref lets mount/mountDev call enforceCapacity without a forward-reference
  // cycle. Set in an effect after enforceCapacity stabilises.
  const enforceCapacityRef = useRef<((protect?: string | null) => void) | null>(null)
  const insets = useSafeAreaInsets()
  const {theme} = useAppTheme()
  const colorScheme = theme.isDark ? "dark" : "light"

  // -- helpers that operate on the map via setApps --------------------------

  const registerRuntime = useCallback((packageName: string) => {
    // Register with LocalMiniappRuntime so CONNECT messages from this WebView
    // are accepted. The sendFn injects the already-serialized envelope string
    // into the right WebView via its ref. raw is a JSON string, so we wrap it
    // in JSON.stringify again to embed as a JS string literal inside the
    // injected code (the transport expects receiveNativeMessage(stringPayload)
    // and does its own JSON.parse).
    localMiniappRuntime.registerApp(packageName, (raw: string) => {
      const ref = webViewRefs.current.get(packageName)
      if (!ref) return
      ref.injectJavaScript(`window.receiveNativeMessage(${JSON.stringify(raw)}); true;`)
    })
  }, [])

  const mount = useCallback(
    (packageName: string, bundleUri: string, options?: MiniappMountOptions) => {
      // Phase 0: read the eviction flag from the set BEFORE we mutate it.
      // The flag rides into the mounted entry so the splash sees "Restoring…"
      // even after we clear the set.
      let wasEvicted = false
      setEvictedPackages((prev) => {
        if (!prev.has(packageName)) return prev
        wasEvicted = true
        const next = new Set(prev)
        next.delete(packageName)
        return next
      })
      setApps((prev) => {
        const next = new Map(prev)
        const prevEntry = next.get(packageName)
        next.set(packageName, {
          packageName,
          source: {uri: bundleUri},
          developerMode: options?.developerMode ?? false,
          appName: options?.appName,
          iconUrl: options?.iconUrl,
          isForeground: false,
          isLoaded: false,
          mountKey: (prevEntry?.mountKey ?? 0) + 1,
          wasEvicted,
        })
        return next
      })
      webViewRefs.current.delete(packageName)
      canGoBackMap.current.delete(packageName)
      registerRuntime(packageName)
      miniappRunningRegistry.add(packageName)
      if (options?.manifest) {
        localMiniappRuntime.setInstalledManifest(packageName, {
          permissions: options.manifest.permissions,
          hardwareRequirements: options.manifest.hardwareRequirements,
        })
      }
      localDisplayManager.onMount(packageName, options?.appName ?? packageName)
      // Phase 0: a new mount can push us over the tier cap. Protect the
      // just-mounted package so it isn't evicted before it gets a chance to
      // foreground (its lastForegroundAt is 0 by definition).
      enforceCapacityRef.current?.(packageName)
    },
    [registerRuntime],
  )

  const mountDev = useCallback(
    async (
      packageName: string,
      devUrl: string,
      options?: MiniappMountOptions,
    ): Promise<MountDevManifest | undefined> => {
      // Fetch the dev miniapp.json BEFORE mounting so its declared permissions
      // and hardwareRequirements are registered with the runtime before the
      // miniapp's JS runs and issues its first SUBSCRIBE. Otherwise subscribe()
      // races the fetch and may be rejected with PERMISSION_NOT_DECLARED.
      //
      // miniapp.json permissions MUST use the AppletPermission shape:
      // [{type: "MICROPHONE"}, ...] — plain strings are not supported.
      //
      // Returns the parsed manifest (if fetch succeeded) so callers can feed
      // hardwareRequirements into the applets store for compatibility checks.
      let manifest: MountDevManifest | undefined = options?.manifest
      if (!manifest) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 1500)
          const res = await fetch(`${devUrl.replace(/\/$/, "")}/miniapp.json`, {signal: controller.signal})
          clearTimeout(timer)
          manifest = (await res.json()) as MountDevManifest
        } catch (err) {
          console.warn(`MiniappHost: failed to fetch ${devUrl}/miniapp.json`, err)
        }
      }

      let wasEvicted = false
      setEvictedPackages((prev) => {
        if (!prev.has(packageName)) return prev
        wasEvicted = true
        const next = new Set(prev)
        next.delete(packageName)
        return next
      })
      setApps((prev) => {
        const next = new Map(prev)
        const prevEntry = next.get(packageName)
        next.set(packageName, {
          packageName,
          source: {uri: devUrl},
          developerMode: options?.developerMode ?? true,
          appName: options?.appName,
          iconUrl: options?.iconUrl,
          // Every mountDev is a fresh session — force remount via mountKey,
          // start in the splash state, do not inherit foreground from a
          // previous mount (caller sets foreground explicitly after).
          isForeground: false,
          isLoaded: false,
          mountKey: (prevEntry?.mountKey ?? 0) + 1,
          wasEvicted,
        })
        return next
      })
      webViewRefs.current.delete(packageName)
      canGoBackMap.current.delete(packageName)
      registerRuntime(packageName)
      miniappRunningRegistry.add(packageName)
      localMiniappRuntime.setInstalledManifest(packageName, {
        permissions: manifest?.permissions,
        hardwareRequirements: manifest?.hardwareRequirements,
      })
      localDisplayManager.onMount(packageName, options?.appName ?? packageName)
      enforceCapacityRef.current?.(packageName)
      return manifest
    },
    [registerRuntime],
  )

  const markLoaded = useCallback((packageName: string) => {
    setApps((prev) => {
      const next = new Map(prev)
      const entry = next.get(packageName)
      if (entry && !entry.isLoaded) {
        next.set(packageName, {...entry, isLoaded: true})
      }
      return next
    })
  }, [])

  /**
   * Send a beforeevict envelope to the miniapp and wait up to 500ms for it to
   * flush state to session.storage. Best-effort — if the WebView is already
   * dead the inject will fail silently and we proceed to unmount.
   *
   * Defined above unmount so the LRU eviction helper (which calls both) can
   * reference both stable callbacks. The wire format mirrors the existing
   * miniapp_color_scheme_change envelope: a JSON `payload` shipped via a
   * synthesized `message` event so the SDK's window.onmessage handler picks
   * it up the same way it does cloud-relayed events.
   */
  const sendBeforeEvict = useCallback(async (packageName: string): Promise<void> => {
    const ref = webViewRefs.current.get(packageName)
    if (!ref) return
    try {
      const envelope = JSON.stringify({
        payload: {type: "miniapp_before_evict"},
      })
      ref.injectJavaScript(
        `window.dispatchEvent(new MessageEvent('message', {data: ${JSON.stringify(envelope)}})); true;`,
      )
      // Give the miniapp up to BEFORE_EVICT_TIMEOUT_MS to persist state
      await new Promise((resolve) => setTimeout(resolve, BEFORE_EVICT_TIMEOUT_MS))
    } catch {
      // WebView may already be dead — proceed to unmount
    }
  }, [])

  const unmount = useCallback((packageName: string) => {
    // Graceful path: notify the miniapp first so its `beforeDisconnect`
    // handlers can flush a final message (e.g. `display.clear()`),
    // wait the 50ms grace, then tear the WebView down. Sync teardown
    // would race the heads-up out the door before the miniapp could
    // respond on its still-open transport.
    if (foregroundPackageRef.current === packageName) {
      foregroundPackageRef.current = null
    }
    void localMiniappRuntime.gracefullyUnregisterApp(packageName, "miniapp unmounted").finally(() => {
      setApps((prev) => {
        const next = new Map(prev)
        next.delete(packageName)
        return next
      })
      webViewRefs.current.delete(packageName)
      canGoBackMap.current.delete(packageName)
      canGoBackListeners.current.delete(packageName)
      setCanGoBackState((m) => {
        if (!m.has(packageName)) return m
        const next = new Map(m)
        next.delete(packageName)
        return next
      })
      miniComms.setWebViewMessageHandler(packageName, undefined)
      miniappRunningRegistry.remove(packageName)
      // Display teardown is handled inside gracefullyUnregisterApp →
      // unregisterApp → localDisplayManager.onUnmount; calling it
      // again here would re-push the saved coreAppDisplay snapshot
      // and cause a flicker.
      devServerBridge.disconnect(packageName)
    })
  }, [])

  /**
   * Phase 0 LRU eviction — when total mounted miniapps exceeds the device
   * tier's background-slot capacity, evict the oldest backgrounded WebViews
   * (oldest by `lastForegroundAt`). The foreground app is never a candidate.
   *
   * Fires after every membership / foreground change: mount, mountDev,
   * setForeground (in case capacity changed and the previously-foreground
   * app is now the freshly-stamped one), and setBackground. The
   * `additionalProtectedPackage` arg lets callers exclude a just-mounted
   * package that hasn't been foregrounded yet — without it, a freshly
   * sideloaded miniapp could be selected as the oldest and evicted right
   * after install (lastForegroundAt = 0).
   *
   * Phase 3 deletes the wiring here; the pure `selectMiniappsToEvict`
   * helper in `@mentra/island` survives as a unit-testable building block.
   */
  const enforceCapacity = useCallback(
    (additionalProtectedPackage?: string | null) => {
      const physMem = readPhysicalMemoryBytes()
      const capacity = getDeviceTierBackgroundSlots(physMem)
      if (capacity === UNLIMITED_BACKGROUND_SLOTS) return

      // foregroundPackageRef is the only authoritative source — apps state
      // may be lagging a setApps batch. additionalProtectedPackage covers
      // the just-mounted-not-yet-foregrounded edge case.
      const fg = foregroundPackageRef.current
      const protectedSet = new Set<string>()
      if (fg) protectedSet.add(fg)
      if (additionalProtectedPackage) protectedSet.add(additionalProtectedPackage)

      const snapshot = miniappRunningRegistry.getAllWithTimestamps()
      // We model `protectedSet` as a virtual foreground app for the policy:
      // bump every protected entry's timestamp to Infinity so they sort last.
      const adjusted = snapshot.map((e) => {
        if (protectedSet.has(e.packageName)) {
          return {...e, lastForegroundAt: Number.POSITIVE_INFINITY}
        }
        return e
      })
      const targets = selectMiniappsToEvict({
        entries: adjusted,
        foregroundPackage: fg ?? null,
        capacity,
      })
      if (targets.length === 0) return

      const tierLabel = getDeviceTierLabel(physMem)
      console.log(
        `MiniappHost: LRU evicting ${targets.length} miniapp(s) (capacity=${capacity}, tier=${tierLabel}): ${targets.join(", ")}`,
      )
      setEvictedPackages((prev) => {
        const next = new Set(prev)
        for (const t of targets) next.add(t)
        return next
      })
      for (const victim of targets) {
        try {
          Sentry.addBreadcrumb({
            category: "miniapp.evicted",
            level: "info",
            message: `Evicted ${victim} (capacity=${capacity}, tier=${tierLabel})`,
            data: {
              packageName: victim,
              capacity,
              tier: tierLabel,
              physicalMemoryBytes: physMem,
              totalRunning: snapshot.length,
            },
          })
        } catch {
          // Sentry may not be initialized in dev; we still log to console above.
        }
        useStressTestStore.getState().recordEvent({
          packageName: victim,
          at: Date.now(),
          kind: "evicted",
        })
        // Eviction is async: best-effort beforeevict envelope, then unmount.
        // Fire-and-forget — we don't await the chain because the caller is
        // setForeground / mount and shouldn't block on N teardown windows.
        void (async () => {
          try {
            await sendBeforeEvict(victim)
          } finally {
            unmount(victim)
          }
        })()
      }
    },
    [sendBeforeEvict, unmount],
  )

  const goBackInWebView = useCallback((packageName: string): boolean => {
    const ref = webViewRefs.current.get(packageName)
    const canGoBack = canGoBackMap.current.get(packageName) ?? false
    if (ref && canGoBack) {
      ref.goBack()
      return true
    }
    return false
  }, [])

  const canGoBack = useCallback((packageName: string): boolean => {
    return canGoBackMap.current.get(packageName) ?? false
  }, [])

  const subscribeCanGoBack = useCallback((packageName: string, listener: CanGoBackListener): (() => void) => {
    let set = canGoBackListeners.current.get(packageName)
    if (!set) {
      set = new Set()
      canGoBackListeners.current.set(packageName, set)
    }
    set.add(listener)
    // Fire once with current value so subscribers see initial state without racing.
    listener(canGoBackMap.current.get(packageName) ?? false)
    return () => {
      const s = canGoBackListeners.current.get(packageName)
      s?.delete(listener)
    }
  }, [])

  // React state mirror of canGoBack so that render-time consumers (e.g. the
  // WebView's `allowsBackForwardNavigationGestures` prop) re-read the value
  // when it changes. External subscribers still use the ref + listener fanout.
  const [canGoBackState, setCanGoBackState] = useState<Map<string, boolean>>(new Map())

  const handleNavStateChange = useCallback((packageName: string, canGo: boolean) => {
    const prev = canGoBackMap.current.get(packageName) ?? false
    if (prev === canGo) return
    canGoBackMap.current.set(packageName, canGo)
    setCanGoBackState((m) => {
      const next = new Map(m)
      next.set(packageName, canGo)
      return next
    })
    const listeners = canGoBackListeners.current.get(packageName)
    if (listeners) {
      for (const l of listeners) l(canGo)
    }
  }, [])

  const setForeground = useCallback((packageName: string, callbacks?: {onClose?: () => void; onBack?: () => void}) => {
    foregroundPackageRef.current = packageName
    // Phase 0: stamp lastForegroundAt so the LRU policy treats this package
    // as the freshest. Idempotent — safe to call even if the package isn't
    // registered yet (registry no-ops on unknown packages).
    miniappRunningRegistry.markForeground(packageName)
    setApps((prev) => {
      const next = new Map(prev)
      const entry = next.get(packageName)
      if (entry) {
        next.set(packageName, {...entry, isForeground: true, onClose: callbacks?.onClose, onBack: callbacks?.onBack})
      }
      // Demote any other app that was holding the foreground flag — only one
      // foreground at a time. (Callers typically setBackground() the previous
      // foreground first, but this is a belt-and-suspenders guard against
      // double-foreground state desync.)
      for (const [name, e] of next) {
        if (name !== packageName && e.isForeground) {
          next.set(name, {...e, isForeground: false})
        }
      }
      return next
    })
    localDisplayManager.onCoreAppChange(packageName)
    // No eviction here — setForeground refreshes the timestamp, which only
    // protects the foregrounded app from eviction. enforceCapacity is fired
    // from mount/mountDev/setBackground where membership / fg state actually
    // changes in ways that could push us over cap.
  }, [])

  const setBackground = useCallback((packageName: string) => {
    if (foregroundPackageRef.current === packageName) {
      foregroundPackageRef.current = null
    }
    setApps((prev) => {
      const next = new Map(prev)
      const entry = next.get(packageName)
      if (entry) {
        next.set(packageName, {...entry, isForeground: false})
        // Only clear the core app if this one was holding it. Another app may
        // have already taken foreground, in which case onCoreAppChange was
        // called with its packageName and we must not overwrite it with null.
        if (entry.isForeground) {
          localDisplayManager.onCoreAppChange(null)
        }
      }
      return next
    })
    // Phase 0: backgrounding can put us in over-capacity state when the
    // user has been swapping between many apps. The newly-backgrounded app
    // is fresh (timestamp just stamped on its previous setForeground) so the
    // policy will pick the *oldest* of the backgrounded set.
    enforceCapacityRef.current?.()
  }, [])

  const isRunning = useCallback(
    (packageName: string) => {
      return apps.has(packageName)
    },
    [apps],
  )

  const reload = useCallback((packageName: string) => {
    const ref = webViewRefs.current.get(packageName)
    if (!ref) {
      console.warn(`MiniappHost: reload(${packageName}) — no WebView ref`)
      return
    }
    try {
      ref.reload()
    } catch (e) {
      console.warn(`MiniappHost: reload(${packageName}) failed:`, e)
    }
  }, [])

  // Phase 0: keep the enforceCapacity ref in sync with the latest callback
  // identity. Mount/mountDev (defined above enforceCapacity) reach it
  // through this ref to avoid a forward-reference cycle.
  useEffect(() => {
    enforceCapacityRef.current = enforceCapacity
    return () => {
      enforceCapacityRef.current = null
    }
  }, [enforceCapacity])

  // -- wire up the module-level singleton on mount --------------------------

  useEffect(() => {
    miniappHost.mount = mount
    miniappHost.mountDev = mountDev
    miniappHost.unmount = unmount
    miniappHost.setForeground = setForeground
    miniappHost.setBackground = setBackground
    miniappHost.isRunning = isRunning
    miniappHost.goBackInWebView = goBackInWebView
    miniappHost.canGoBack = canGoBack
    miniappHost.subscribeCanGoBack = subscribeCanGoBack
    miniappHost.reload = reload

    // DevServerBridge fires onReload when a dev miniapp's laptop sends a
    // reload signal. Reload the corresponding WebView.
    devServerBridge.onReload((packageName) => {
      reload(packageName)
    })

    return () => {
      // Restore stubs on unmount so callers get a clear warning.
      miniappHost.mount = () => console.warn("MiniappHost: mount() called after unmount")
      miniappHost.mountDev = async () => {
        console.warn("MiniappHost: mountDev() called after unmount")
        return undefined
      }
      miniappHost.unmount = () => console.warn("MiniappHost: unmount() called after unmount")
      miniappHost.setForeground = () => console.warn("MiniappHost: setForeground() called after unmount")
      miniappHost.setBackground = () => console.warn("MiniappHost: setBackground() called after unmount")
      miniappHost.isRunning = () => false
      miniappHost.goBackInWebView = () => false
      miniappHost.canGoBack = () => false
      miniappHost.subscribeCanGoBack = () => () => {}
      miniappHost.reload = () => console.warn("MiniappHost: reload() called after unmount")
    }
  }, [
    mount,
    mountDev,
    unmount,
    setForeground,
    setBackground,
    isRunning,
    goBackInWebView,
    canGoBack,
    subscribeCanGoBack,
    reload,
  ])

  // -- WebView event handlers -----------------------------------------------

  const handleMessage = useCallback((packageName: string, event: WebViewMessageEvent) => {
    const data = event.nativeEvent.data
    localMiniappRuntime.handleRawMessage(packageName, data)
  }, [])

  const handleTerminate = useCallback(
    async (packageName: string) => {
      // Always record — stress test reads this even outside __DEV__
      useStressTestStore.getState().recordEvent({
        packageName,
        at: Date.now(),
        kind: "terminate",
      })
      if (__DEV__ && !useStressTestStore.getState().active) {
        Alert.alert(
          "Miniapp Terminated",
          `"${packageName}" was killed by the OS (out of memory). It has been unregistered.`,
        )
      }
      // beforeevict is best-effort — the JS context may already be gone on terminate
      await sendBeforeEvict(packageName)
      unmount(packageName)
    },
    [unmount, sendBeforeEvict],
  )

  const handleError = useCallback(
    async (packageName: string) => {
      useStressTestStore.getState().recordEvent({
        packageName,
        at: Date.now(),
        kind: "error",
      })
      if (__DEV__ && !useStressTestStore.getState().active) {
        Alert.alert("Miniapp Error", `"${packageName}" encountered a fatal error and has been unregistered.`)
      }
      await sendBeforeEvict(packageName)
      unmount(packageName)
    },
    [unmount, sendBeforeEvict],
  )

  // Register MiniComms handlers whenever the app map changes so messages can
  // be sent back to each running WebView.
  useEffect(() => {
    for (const [packageName] of apps) {
      const ref = webViewRefs.current.get(packageName)
      if (ref) {
        miniComms.setWebViewMessageHandler(packageName, (message: string) => {
          ref.injectJavaScript(`window.receiveNativeMessage(${message}); true;`)
        })
      }
    }
  }, [apps])

  // Broadcast COLOR_SCHEME_CHANGE to every mounted miniapp when the host theme flips.
  useEffect(() => {
    const envelope = JSON.stringify({
      payload: {type: "miniapp_color_scheme_change", colorScheme},
    })
    for (const [, ref] of webViewRefs.current) {
      try {
        ref.injectJavaScript(
          `window.dispatchEvent(new MessageEvent('message', {data: ${JSON.stringify(envelope)}})); true;`,
        )
      } catch {
        // WebView may have been unmounted concurrently — ignore.
      }
    }
  }, [colorScheme])

  // -- render ---------------------------------------------------------------

  const entries = Array.from(apps.values())

  console.log(
    `MINIAPP_HOST: render — ${entries.length} apps:`,
    entries.map((a) => `${a.packageName}[fg=${a.isForeground}]`).join(", "),
  )

  return (
    // MiniappHost sits above the Stack so the foregrounded WebView
    <View className="absolute inset-0 z-10" pointerEvents="box-none">
      {entries.map((app) => {
        const isFg = app.isForeground

        // Local WebViews render edge-to-edge: no top/bottom padding so the
        // miniapp can paint its own background all the way behind the status
        // bar. The SDK's useSafeArea() hook gives developers the inset values
        // to pad their own content. Left/right insets stay on the container —
        // those sit on physical display cutouts (landscape notch) rather than
        // system chrome developers would want to paint behind.
        const fgPadding = {
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }

        // Build the window.MentraOS globals for this miniapp. The miniapp reads
        // window.MentraOS.safeAreaInsets + .capsuleMenu to avoid painting under
        // the status bar / capsule menu.
        const injectedJS = buildMiniappGlobalsScript({
          packageName: app.packageName,
          miniappLocal: true,
          miniappDeveloperMode: app.developerMode,
          safeAreaInsets: {
            top: insets.top,
            bottom: Platform.OS === "android" ? insets.bottom : 0,
            left: insets.left,
            right: insets.right,
          },
          webviewFillsStatusBar: true,
          colorScheme,
        })

        return (
          <View
            key={app.packageName}
            // Off-screen holder for backgrounded WebViews — keeps them mounted
            // without affecting layout or receiving touches.
            className={isFg ? "flex-1 absolute inset-0" : "absolute -left-[10000px] -top-[10000px] w-px h-px opacity-0"}
            style={isFg ? fgPadding : undefined}
            pointerEvents={isFg ? "auto" : "none"}>
            <WebView
              // Remount on every mount/mountDev (mountKey bumps) so a QR
              // re-scan reloads the dev miniapp from scratch instead of
              // keeping the stale WebView.
              key={`${app.packageName}:${app.mountKey}`}
              ref={(ref) => {
                if (ref) {
                  webViewRefs.current.set(app.packageName, ref)
                }
              }}
              source={app.source}
              originWhitelist={["*"]}
              allowFileAccess={true}
              allowFileAccessFromFileURLs={true}
              // iOS WKWebView only grants read access to the file in
              // source.uri unless we explicitly widen the read scope to
              // its parent directory. Without this, sibling assets
              // (chunk-*.js, chunk-*.css) fail to load with "Operation
              // not permitted." For dev mounts (http URL), this prop is
              // ignored — file:// is the only path that needs it.
              allowingReadAccessToURL={(() => {
                const uri = (app.source as {uri?: string}).uri
                if (!uri || !uri.startsWith("file://")) return undefined
                return uri.replace(/\/[^/]+$/, "/")
              })()}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              injectedJavaScriptBeforeContentLoaded={injectedJS}
              onMessage={(e) => handleMessage(app.packageName, e)}
              onContentProcessDidTerminate={() => handleTerminate(app.packageName)}
              onError={() => handleError(app.packageName)}
              onNavigationStateChange={(navState) => handleNavStateChange(app.packageName, navState.canGoBack)}
              onLoadEnd={() => markLoaded(app.packageName)}
              // Only enable WKWebView's own edge-swipe when there's history to
              // pop. Otherwise the native gesture silently eats our left-edge
              // touches and LeftEdgeBackSwipe (the "exit miniapp" fallback)
              // never gets them.
              allowsBackForwardNavigationGestures={canGoBackState.get(app.packageName) ?? false}
              bounces={false}
              overScrollMode="never"
              automaticallyAdjustContentInsets={false}
              contentInsetAdjustmentBehavior="never"
              // Lock zoom: miniapps should feel like native apps, not pages.
              // The injected viewport meta handles most browsers; these props
              // disable Android's pinch-zoom controls + iOS page scaling for
              // miniapps that ship a viewport meta we can't override before
              // first paint.
              scalesPageToFit={false}
              setBuiltInZoomControls={false}
              setDisplayZoomControls={false}
              // Enable Safari Web Inspector / Chrome devtools attach in dev
              // builds so miniapp authors can debug their bundle. iOS 16.4+
              // and Android changed this to opt-in.
              webviewDebuggingEnabled={__DEV__}
              style={{flex: 1, backgroundColor: theme.colors.background}}
            />
            {isFg && (
              <MiniappSplash
                iconUrl={app.iconUrl}
                bgColor={theme.colors.background}
                isLoaded={app.isLoaded}
                restoring={app.wasEvicted}
              />
            )}
            {isFg && <LeftEdgeBackSwipe packageName={app.packageName} onBack={app.onBack} />}
          </View>
        )
      })}
    </View>
  )
}
