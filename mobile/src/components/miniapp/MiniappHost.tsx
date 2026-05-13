import {useEffect, useState, useCallback, useRef} from "react"
import {View, Alert, Platform} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import {WebView, WebViewMessageEvent} from "react-native-webview"

import LeftEdgeBackSwipe from "@/components/miniapp/LeftEdgeBackSwipe"
import MiniappSplash from "@/components/miniapp/MiniappSplash"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useStressTestStore} from "@/stores/stressTest"
import {devServerBridge} from "@mentra/island"
import {localDisplayManager} from "@mentra/island"
import {localMiniappRuntime} from "@mentra/island"
import {webviewBridge as miniComms, miniappRunningRegistry, buildMiniappGlobalsScript} from "@mentra/island"

const BEFORE_EVICT_TIMEOUT_MS = 500

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
  mountDev(
    packageName: string,
    devUrl: string,
    options?: MiniappMountOptions,
  ): Promise<MountDevManifest | undefined>
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
      let manifest: MountDevManifest | undefined
      try {
        const res = await fetch(`${devUrl.replace(/\/$/, "")}/miniapp.json`)
        manifest = (await res.json()) as MountDevManifest
      } catch (err) {
        console.warn(`MiniappHost: failed to fetch ${devUrl}/miniapp.json`, err)
      }

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

  const unmount = useCallback((packageName: string) => {
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
    localMiniappRuntime.unregisterApp(packageName)
    miniappRunningRegistry.remove(packageName)
    localDisplayManager.onUnmount(packageName)
    devServerBridge.disconnect(packageName)
  }, [])

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
    setApps((prev) => {
      const next = new Map(prev)
      const entry = next.get(packageName)
      if (entry) {
        next.set(packageName, {...entry, isForeground: true, onClose: callbacks?.onClose, onBack: callbacks?.onBack})
      }
      return next
    })
    localDisplayManager.onCoreAppChange(packageName)
  }, [])

  const setBackground = useCallback((packageName: string) => {
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

  /**
   * Send a beforeevict envelope to the miniapp and wait up to 500ms for it to
   * flush state to session.storage. Best-effort — if the WebView is already
   * dead the inject will fail silently and we proceed to unmount.
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
              />
            )}
            {isFg && <LeftEdgeBackSwipe packageName={app.packageName} onBack={app.onBack} />}
          </View>
        )
      })}
    </View>
  )
}

