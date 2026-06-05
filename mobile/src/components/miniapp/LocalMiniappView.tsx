import {File} from "expo-file-system"
import {useCallback, useEffect, useRef, useState} from "react"
import {ActivityIndicator, Image, Platform, View} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import {WebView, type WebViewMessageEvent} from "react-native-webview"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {getMentraJS} from "@/services/mentraJsBootstrap"
import {useStressTestStore} from "@/stores/stressTest"
import {storage} from "@/utils/storage/storage"
import MiniappSplash from "@/components/miniapp/MiniappSplash"
import {
  appRegistry,
  BgTimer,
  buildMentraUiShim,
  buildMiniappGlobalsScript,
  decideDevLaunchRoute,
  devServerBridge,
  type InstalledMiniappManifest,
  useAppStatusStore,
} from "@mentra/island"
import {useNavigationStore} from "@/stores/navigation"
import CapsuleMenu, {captureScreenshot} from "@/effects/CapsuleMenu"
import {useRegisterCapsule} from "@/stores/capsule"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import { useSetting } from "@/stores/settings"

/**
 * LocalMiniappView — the UI half of a local (or dev) miniapp.
 *
 * Renders the miniapp's WebView and owns its lifecycle: dev-snapshot install,
 * JSContext spawn (idempotent), WebView mount + UI-router binding, loading
 * affordance, and dev hot-reload. The always-on JSContext lives in
 * MentraJSRouter and survives this component unmounting — only the WebView is
 * torn down (see the launch effect's cleanup, which unbinds the WebView).
 *
 * This was previously the body of the `/applet/local` route; it's now a
 * component so the <Compositor /> overlay can mount/unmount it as a miniapp is
 * foregrounded/backgrounded. The Compositor owns the opening animation,
 * back-swipe gesture, and capsule button. This component drives the navigation
 * store's `forceGestureEnabled` flag from the WebView's history state so the
 * Compositor only arms its edge-swipe once the WebView is at page 0.
 */

// Reload-retry tuning for the miniapp `ready` handshake (see readyTimerRef).
const READY_TIMEOUT_MS = 5000
const MAX_LOAD_ATTEMPTS = 5

interface LocalMiniappViewProps {
  packageName: string
  appName?: string
  version?: string
  devUrl?: string
  iconUrl?: string
  devPort?: string
  /** Called when the WebView's content process terminates / errors fatally. */
  onExit: () => void
  onShouldCapture?: () => void
}

function LocalMiniappView({
  packageName,
  appName,
  version,
  devUrl,
  iconUrl,
  devPort,
  onExit,
  onShouldCapture = () => undefined,
}: LocalMiniappViewProps) {
  const {theme} = useAppTheme()
  const insets = useSaferAreaInsets()
  const colorScheme = theme.isDark ? "dark" : "light"

  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  const viewShotRef = useRef<View | null>(null)
  const webViewRef = useRef<WebView | null>(null)
  const [webViewCanGoBack, setWebViewCanGoBack] = useState(false)
  const [uiUri, setUiUri] = useState<string | null>(null)
  const [uiBaseDir, setUiBaseDir] = useState<string | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [miniappConnected, setMiniappConnected] = useState(false)
  const [androidGatePassed, setAndroidGatePassed] = useState(false)
  const [devMode, setDevMode] = useSetting(SETTINGS.dev_mode.key)

  // Reload-retry state for the "ready" handshake. `onLoadEnd` only means the
  // WebView painted — not that the miniapp UI JS actually mounted and called
  // mentra.ready(). After each load we start a timer; if no `ready` envelope
  // arrives within READY_TIMEOUT_MS we reload, up to MAX_LOAD_ATTEMPTS total
  // loads, then give up with an error.
  const miniappConnectedRef = useRef(false)
  const readyTimerRef = useRef<number | null>(null)
  // State (not a ref) so the "Connecting… (N of 5)" splash label re-renders
  // as attempts increment. Counts completed load attempts; initial load is 1.
  const [loadAttempts, setLoadAttempts] = useState(0)

  // Phase machine for the pre-WebView affordance. "ready" means we have a
  // uiUri and the WebView is mounted; the loading card is rendered for
  // every phase prior so the user always sees something happening.
  const [phase, setPhase] = useState<"initializing" | "installing" | "spawning" | "opening" | "ready" | "error">(
    devUrl || version ? "initializing" : "error",
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (Platform.OS !== "android") return
    // android is slow to start (and doesn't handle opacity properly) so we need to wait for the animation to complete
    // before attempting to load the webview or we'll get visual jank
    BgTimer.setTimeout(() => {
      setAndroidGatePassed(true)
    }, 1000)
  }, [])

  const {setForceGestureEnabled} = useNavigationStore.getState()

  // Back press handler for CapsuleMenu/Header buttons and Android back button.
  const handleWebViewBack = useCallback(async () => {
    console.log("WEBVIEW: handleWebViewBack()")
    if (Platform.OS === "ios") {
      // await captureScreenshot(viewShotRef, packageName.toString(), insets.top)
      onShouldCapture()
    }
    // if (!hasValidParams) {
    //   if (Platform.OS === "android") {
    //     goBack()
    //   }
    //   return
    // }
    if (webViewCanGoBack && webViewRef.current) {
      webViewRef.current.goBack()
    } else {
      if (Platform.OS === "android") {
        // captureScreenshot(viewShotRef, packageName.toString(), insets.top)
        onShouldCapture()
        useAppStatusStore.getState().clearForeground()
      }
    }
  }, [webViewCanGoBack])

  // Block native back gesture/button — route through handleWebViewBack for Android.
  // focusEffectPreventBack(handleWebViewBack, false)

  // Dynamically toggle the Compositor's left-edge swipe-to-back gesture based on
  // the WebView's navigation state (via the shared `forceGestureEnabled` flag):
  // - Page 0 (no history): enable the Compositor swipe so a back-swipe
  //   backgrounds the miniapp with the real iOS animation.
  // - Has history: disable the Compositor swipe so the WebView's own
  //   allowsBackForwardNavigationGestures handles in-webview back navigation.
  useEffect(() => {
    setForceGestureEnabled(!webViewCanGoBack)
    return () => setForceGestureEnabled(false)
  }, [webViewCanGoBack, setForceGestureEnabled])

  useRegisterCapsule({
    packageName: packageName as string,
    viewShotRef,
    visibleOnRoutes: ["/intentionally-not-a-real-route"],
    onBackPress: handleWebViewBack,
  })

  useEffect(() => {
    if (!packageName) return
    let cancelled = false

    // Fresh attempt budget per (re)launch — a re-foreground / new package
    // restarts the ready handshake and reload-retry loop from scratch.
    miniappConnectedRef.current = false
    setLoadAttempts(0)
    setMiniappConnected(false)
    setIsLoaded(false)

    const fail = (msg: string) => {
      if (cancelled) return
      console.warn(`LocalMiniappView: ${packageName} ${msg}`)
      setErrorMessage(msg)
      setPhase("error")
    }

    const launch = async () => {
      // Entry sources, resolved differently for dev (HTTP, straight off the
      // running dev server) vs released (file:// from the installed snapshot).
      //   bgSource : the background JS *text* to feed spawnAndRegister.
      //   uiEntry  : the WebView source uri (http:// for dev, file:// for release).
      let bgSource: string | null = null
      let uiEntry: string | null = null
      let declaredPermissions: string[] = []
      let installedManifest: InstalledMiniappManifest | undefined

      if (devUrl) {
        // Dev miniapps load directly off the local dev server over HTTP — the
        // normal web-dev-server model. No zip download / file:// snapshot, so
        // a plain WebView.reload() (and a JSContext respawn) picks up freshly
        // built code. The bundle.zip / install path stays for store installs.
        setPhase("installing")
        const portNum = resolveDevPort(devPort, packageName)
        if (portNum === null) {
          fail("no dev port configured")
          return
        }
        const base = devUrl.replace(/\/$/, "")

        // Reachability + manifest in one round trip. Callers pre-flight this
        // before navigating here, so an "offline" result means the server
        // dropped between pre-flight and mount — surface it as an error.
        const route = await decideDevLaunchRoute(packageName, devUrl)
        if (cancelled) return
        if (route.decision === "offline" || !route.manifest) {
          fail("dev server unreachable")
          return
        }
        const manifest = route.manifest
        const entry = manifest.entry as {background?: string; ui?: string} | undefined
        if (!entry?.background) {
          fail("miniapp.json missing entry.background")
          return
        }
        // entry.* are bundle-root paths (dist/ stripped); the dev server
        // serves files relative to cwd, so prepend dist/.
        const bgUrl = `${base}/dist/${entry.background.replace(/^\.?\/+/, "")}`
        uiEntry = entry.ui ? `${base}/dist/${entry.ui.replace(/^\.?\/+/, "")}` : null

        const perms = manifest.permissions as Array<{type?: string} | string> | undefined
        declaredPermissions = (perms ?? [])
          .map((p) => (typeof p === "string" ? p : p?.type))
          .filter((t): t is string => typeof t === "string")
        installedManifest = {
          permissions: manifest.permissions as InstalledMiniappManifest["permissions"],
          hardwareRequirements: manifest.hardwareRequirements as InstalledMiniappManifest["hardwareRequirements"],
        }

        try {
          const res = await fetch(bgUrl)
          if (!res.ok) {
            fail(`background fetch failed: ${res.status}`)
            return
          }
          bgSource = await res.text()
        } catch (e) {
          fail(`background fetch failed: ${(e as Error).message}`)
          return
        }
        if (cancelled) return
        devServerBridge.connect(packageName, devUrl, portNum)
      } else if (version) {
        console.log("LocalMiniappView: launching released miniapp", packageName, version)
        // Released local miniapp — resolve from the installed file:// snapshot.
        const entryPaths = appRegistry.getMiniappEntryPaths(packageName, version)
        if (!entryPaths?.background) {
          fail(`${version} missing entry.background`)
          return
        }
        const manifest = appRegistry.getMiniappManifest(packageName, version) as {
          permissions?: Array<{type: string; required?: boolean; description?: string}>
          hardwareRequirements?: Array<{type: string; level: string; description?: string}>
        } | null
        declaredPermissions = (manifest?.permissions ?? [])
          .map((p) => p.type)
          .filter((t): t is string => typeof t === "string")
        installedManifest = manifest
          ? {
              permissions: manifest.permissions,
              hardwareRequirements: manifest.hardwareRequirements,
            }
          : undefined
        bgSource = new File(entryPaths.background).textSync()
        uiEntry = entryPaths.ui
      } else {
        fail("no devUrl or version — cannot launch")
        return
      }

      if (cancelled || bgSource === null) return

      const mj = getMentraJS()
      if (!mj) {
        fail("MentraJS runtime not bootstrapped")
        return
      }

      setPhase("spawning")

      // Spawn the JSContext if it isn't already alive. Re-foregrounding a
      // running miniapp just rebuilds the WebView half.
      if (!mj.router.registeredPackages().includes(packageName)) {
        const ok = await mj.router.spawnAndRegister(packageName, bgSource, {
          permissions: declaredPermissions,
          installedManifest,
        })
        if (!ok) {
          fail("spawn failed — see logs")
          return
        }
      }

      // If the user backgrounded the app while we were spawning, leave the
      // JSContext alive — background miniapps keep running across UI close.
      // The only cleanup this component owes is unbinding the WebView
      // (handled by the effect's return).
      if (cancelled) return

      setPhase("opening")
      if (uiEntry) {
        setUiUri(uiEntry)
        setUiBaseDir(uiEntry.replace(/\/[^/]+$/, "/"))
      }
      if (!cancelled) {
        setPhase("ready")
      }
    }

    launch()

    return () => {
      cancelled = true
      if (readyTimerRef.current) {
        BgTimer.clearTimeout(readyTimerRef.current)
        readyTimerRef.current = null
      }
      const mj = getMentraJS()
      mj?.uiRouter.unbindWebView(packageName)
    }
  }, [packageName, version, devUrl, devPort])

  // ----- WebView bindings ----------------------------------------------------

  // Bind UI router on ref attach so mentra.send/on routes outbound messages
  // through `webViewRef.current.injectJavaScript(...)`. Unbinds on cleanup
  // (see the launch effect's return) so backgrounding fires UI_CLOSE on the
  // JSContext side and clears the inject hook.
  const handleRef = useCallback(
    (instance: WebView | null) => {
      webViewRef.current = instance
      if (!instance || !packageName) return
      const mj = getMentraJS()
      if (!mj) return
      mj.uiRouter.bindWebView(packageName, (js: string) => {
        try {
          instance.injectJavaScript(js)
        } catch (e) {
          console.warn(`LocalMiniappView: inject failed for ${packageName}:`, e)
        }
      })
    },
    [packageName],
  )

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!packageName) return
      // Observe the miniapp's `ready` envelope (posted by mentra.ready() in
      // the WebView shim). This is the real "UI mounted and bridge wired up"
      // signal — gate isLoaded on it instead of onLoadEnd. We only observe;
      // the envelope still flows on to routeFromWebView below (which fires
      // UI_OPEN to the background), so we must NOT early-return here.
      if (!miniappConnectedRef.current && isReadyEnvelope(event.nativeEvent.data)) {
        miniappConnectedRef.current = true
        setMiniappConnected(true)
        if (readyTimerRef.current) {
          BgTimer.clearTimeout(readyTimerRef.current)
          readyTimerRef.current = null
        }
      }
      // Intercept `dev_log` envelopes from the WebView's console-tap shim
      // (miniappGlobals.ts wraps console.log/warn/error to post these).
      // MentraUIRouter does NOT handle dev_log — it drops unknown
      // envelopes silently — so without this interception WebView console
      // output never reaches the dev sidecar or the RN console. Affects
      // both iOS and Android: the legacy single-bundle webview.tsx had
      // its own forwardWebViewDevLog helper that did this, but
      // LocalMiniappView (the two-layer path) lacked the equivalent
      // until now.
      if (forwardWebViewDevLog(packageName, event.nativeEvent.data)) return
      const mj = getMentraJS()
      mj?.uiRouter.routeFromWebView(packageName, event.nativeEvent.data)
    },
    [packageName],
  )

  const handleNavStateChange = useCallback(({canGoBack}: {canGoBack: boolean}) => {
    setWebViewCanGoBack(canGoBack)
  }, [])

  // onLoadEnd means the WebView painted, not that the miniapp is ready. Arm a
  // timer; if the `ready` envelope hasn't arrived by READY_TIMEOUT_MS we count
  // it as a failed attempt and reload, up to MAX_LOAD_ATTEMPTS, then error.
  //
  // The attempt counter is bumped only when a timer actually fires without
  // `ready` — NOT on every onLoadEnd. A single page load can fire onLoadEnd
  // several times (redirects, SPA history changes, sub-frame loads); each of
  // those just re-arms the timer. Counting per-onLoadEnd would inflate the
  // number (you'd see ~4 attempts on a normal load before `ready` lands).
  const handleLoadEnd = useCallback(() => {
    if (miniappConnectedRef.current) return
    if (readyTimerRef.current) {
      BgTimer.clearTimeout(readyTimerRef.current)
      readyTimerRef.current = null
    }
    readyTimerRef.current = BgTimer.setTimeout(() => {
      readyTimerRef.current = null
      if (miniappConnectedRef.current) return
      // A real "ready never arrived" timeout — this counts as one attempt.
      setLoadAttempts((n) => {
        const attempt = n + 1
        if (attempt >= MAX_LOAD_ATTEMPTS) {
          console.warn(`LocalMiniappView: ${packageName} never sent ready after ${MAX_LOAD_ATTEMPTS} attempts`)
          setErrorMessage("miniapp failed to load")
          setPhase("error")
        } else {
          console.log(`LocalMiniappView: reloading, attempt ${attempt} of ${MAX_LOAD_ATTEMPTS}`)
          try {
            webViewRef.current?.reload()
          } catch (e) {
            console.warn(`LocalMiniappView: reload(${packageName}) failed:`, e)
          }
        }
        return attempt
      })
    }, READY_TIMEOUT_MS)
  }, [packageName])

  // Dismiss the splash once the miniapp UI has connected (sent `ready`).
  // miniappConnected is the source of truth; isLoaded drives MiniappSplash.
  useEffect(() => {
    if (miniappConnected) setIsLoaded(true)
  }, [miniappConnected])

  const handleTerminate = useCallback(() => {
    if (!packageName) return
    useStressTestStore.getState().recordEvent({
      packageName,
      at: Date.now(),
      kind: "terminate",
    })
    onExitRef.current()
  }, [packageName])

  const handleError = useCallback(() => {
    if (!packageName) return
    useStressTestStore.getState().recordEvent({
      packageName,
      at: Date.now(),
      kind: "error",
    })
  }, [packageName])

  // Dev hot-reload: when the dev server signals a reload for THIS miniapp
  // (e.g. a file under src/ui/ changed), refresh the WebView. Because the dev
  // UI is loaded straight off the dev server over HTTP (with cache-control:
  // no-store), a plain reload re-fetches the freshly built index.html + its
  // content-hashed chunks — no re-install needed. The JSContext respawn for
  // src/background/ changes is handled by mentraJsBootstrap via
  // devServerBridge.onRespawnBackground.
  useEffect(() => {
    if (!packageName || !devUrl) return
    devServerBridge.onReload((pkg) => {
      if (pkg !== packageName) return
      // Fresh content → fresh ready handshake + reload-retry budget.
      miniappConnectedRef.current = false
      setLoadAttempts(0)
      if (readyTimerRef.current) {
        BgTimer.clearTimeout(readyTimerRef.current)
        readyTimerRef.current = null
      }
      try {
        webViewRef.current?.reload()
      } catch (e) {
        console.warn(`LocalMiniappView: reload(${packageName}) failed:`, e)
      }
    })
  }, [packageName, devUrl])

  if (!packageName) {
    return <Text text="Missing required parameters" />
  }

  // if (Platform.OS === "android" && !androidGatePassed) {
  //   return (
  //     <View className="flex-1">
  //       <MiniappSplash iconUrl={iconUrl} bgColor={theme.colors.background} isLoaded={false} />
  //     </View>
  //   )
  // }

  // Loading affordance: the WebView only mounts once entry resolution +
  // JSContext spawn complete. The splash covers the early frames where the
  // WebView is mounted but hasn't painted yet.
  let androidGateNotPassed = Platform.OS === "android" && !androidGatePassed

  if (phase !== "ready" || !uiUri) {
    let label = undefined
    switch (phase) {
      case "installing":
        label = "Downloading..."
        break
      case "spawning":
        label = "Starting…"
        break
      case "opening":
        label = "Opening…"
        break
      case "initializing":
        label = undefined
        break
      default:
        label = "Couldn't open"
        break
    }
    let error = phase === "error" ? (errorMessage ?? "Couldn't open") : undefined
    return (
      <View className="flex-1">
        <MiniappSplash
          iconUrl={iconUrl}
          bgColor={theme.colors.background}
          isLoaded={false}
          name={appName}
          error={error}
          label={label}
        />
      </View>
    )
  }

  const globalsScript = buildMiniappGlobalsScript({
    packageName,
    miniappLocal: true,
    miniappDeveloperMode: !!devUrl,
    safeAreaInsets: {
      top: insets.top,
      bottom: Platform.OS === "android" ? insets.bottom : 0,
      left: insets.left,
      right: insets.right,
    },
    webviewFillsStatusBar: true,
    colorScheme,
  })
  const uiShim = buildMentraUiShim({packageName})
  const injectedJS = `${globalsScript}\n${uiShim}`

  if (androidGateNotPassed) {
    return (
      <View className="flex-1 bg-transparent" style={{borderRadius: theme.spacing.s12}}>
        <View className="w-1 h-1">
          <WebView
            ref={handleRef}
            source={{uri: uiUri}}
            originWhitelist={["*"]}
            allowFileAccess={true}
            allowFileAccessFromFileURLs={true}
            allowingReadAccessToURL={uiBaseDir ?? undefined}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            injectedJavaScriptBeforeContentLoaded={injectedJS}
            onMessage={handleMessage}
            onLoadEnd={handleLoadEnd}
            onContentProcessDidTerminate={handleTerminate}
            onError={handleError}
            onNavigationStateChange={handleNavStateChange}
            allowsBackForwardNavigationGestures={true}
            bounces={false}
            overScrollMode="never"
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            scalesPageToFit={false}
            setBuiltInZoomControls={false}
            setDisplayZoomControls={false}
            // Android-only: forces the WebView to call
            // `requestDisallowInterceptTouchEvent(true)` on every touch,
            // so the React Native parent ViewGroup can't steal multi-touch
            // events mid-pinch. Without this, fast pinches on JS-driven
            // maps (Google Maps) lose their second-finger touchend events
            // and the recognizer stays stuck in zoom mode — surviving
            // finger keeps zooming. Independently reported as Android
            // System WebView behavior in flutter#182828,
            // react-native-webview#1649, manuelstofer/pinchzoom#115.
            nestedScrollEnabled={true}
            webviewDebuggingEnabled={__DEV__}
            style={{flex: 1, borderRadius: theme.spacing.s12}}
          />
        </View>
        <MiniappSplash iconUrl={iconUrl} bgColor={theme.colors.background} isLoaded={false} />
        <CapsuleMenu forceShow={true} />
      </View>
    )
  }

  // While the WebView is mounted but the miniapp hasn't sent `ready` yet,
  // show retry progress on the splash. Once connected, isLoaded hides it.
  let connectingLabel = undefined
  if (loadAttempts > 0 && devMode) {
    connectingLabel = `Connecting… attempt (${Math.max(loadAttempts, 1)} of ${MAX_LOAD_ATTEMPTS})`
  }

  return (
    <View className="flex-1 bg-black" style={{borderRadius: theme.spacing.s12}}>
      <WebView
        ref={handleRef}
        source={{uri: uiUri}}
        originWhitelist={["*"]}
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowingReadAccessToURL={uiBaseDir ?? undefined}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        injectedJavaScriptBeforeContentLoaded={injectedJS}
        onMessage={handleMessage}
        onLoadEnd={handleLoadEnd}
        onContentProcessDidTerminate={handleTerminate}
        onError={handleError}
        onNavigationStateChange={handleNavStateChange}
        // ALWAYS true — matches /applet/webview. WKWebView only arms its
        // back-forward snapshot system when this is true at *mount* time.
        // The Compositor's back-swipe gesture pops in-WebView history first
        // (via the imperative goBack handle) and only backgrounds the app
        // once there's no history left.
        allowsBackForwardNavigationGestures={true}
        bounces={false}
        overScrollMode="never"
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        scalesPageToFit={false}
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        // Android: forces requestDisallowInterceptTouchEvent(true) on every
        // touch so the RN parent ViewGroup can't steal multi-touch events
        // mid-pinch. Fixes pinch-zoom freeze on JS-driven maps (Google
        // Maps) where the second finger's touchend gets eaten and the
        // recognizer stays stuck in zoom mode. See flutter#182828,
        // react-native-webview#1649, manuelstofer/pinchzoom#115.
        nestedScrollEnabled={true}
        webviewDebuggingEnabled={__DEV__}
        style={{flex: 1, borderRadius: theme.spacing.s12}}
      />
      <MiniappSplash iconUrl={iconUrl} bgColor={theme.colors.background} isLoaded={isLoaded} label={connectingLabel} />
      {/* <View className="flex-1 bg-red-500"/> */}
      <CapsuleMenu forceShow={true} />
    </View>
  )
}

export default LocalMiniappView

function resolveDevPort(searchParam: string | undefined, packageName: string): number | null {
  if (searchParam) {
    const n = parseInt(searchParam, 10)
    if (Number.isFinite(n)) return n
  }
  const stored = storage.load<number>(`${packageName}_dev_port`)
  if (stored.is_ok()) return stored.value
  return null
}

/**
 * True iff `raw` is the WebView shim's `{type:"ready"}` envelope, posted by
 * `mentra.ready()` (mentraUiShim.ts) once the miniapp UI has mounted and
 * wired up its `window.mentra` bridge. LocalMiniappView uses this as the
 * real "loaded" signal — onLoadEnd only means the WebView painted.
 */
function isReadyEnvelope(raw: string): boolean {
  try {
    return (JSON.parse(raw) as {type?: string}).type === "ready"
  } catch {
    return false
  }
}

/**
 * Intercept the WebView's console-tap `dev_log` envelope. The shim in
 * miniappGlobals.ts wraps `console.log/warn/error/info/debug` to post
 * `{payload:{type:"dev_log", level, args, ...}}` via
 * `window.ReactNativeWebView.postMessage`. Without this interception
 * `MentraUIRouter` would drop the envelope silently (it only knows
 * `msg` / `cancel` shapes) and the dev sidecar would never receive UI
 * logs — that's the root cause of "WebView console output never reaches
 * the terminal on iOS" we hit while debugging long-press.
 *
 * Forwards to:
 *   1. `devServerBridge.forwardLog(packageName, level, args, ts, "ui")` —
 *      ships to the laptop's `mentra-miniapp dev` terminal. No-op when no
 *      sidecar is connected.
 *   2. The React Native console — surfaces the log in Metro / Xcode /
 *      adb logcat so installed-miniapp errors are still inspectable when
 *      there's no laptop attached.
 *
 * Returns true when the frame was a dev_log envelope and was handled
 * (caller should stop routing); false otherwise.
 */
function forwardWebViewDevLog(packageName: string, raw: string): boolean {
  let env: {payload?: {type?: string; level?: string; args?: unknown; timestamp?: number}}
  try {
    env = JSON.parse(raw)
  } catch {
    return false
  }
  const payload = env.payload
  if (!payload || payload.type !== "dev_log") return false
  const level = typeof payload.level === "string" ? payload.level : "log"
  const args = Array.isArray(payload.args) ? (payload.args as unknown[]) : []
  const timestamp = typeof payload.timestamp === "number" ? payload.timestamp : Date.now()
  devServerBridge.forwardLog(packageName, level, args, timestamp, "ui")
  const tag = `[MINIAPP ${packageName}]`
  const fn = (console as unknown as Record<string, (...a: unknown[]) => void>)[level] ?? console.log
  try {
    fn(tag, ...args)
  } catch {
    console.log(tag, ...args)
  }
  return true
}
