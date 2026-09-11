import {useCallback, useEffect, useRef, useState} from "react"
import {AppState, Platform, View, type AppStateStatus} from "react-native"
import {WebView, type WebViewMessageEvent} from "react-native-webview"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {getMentraJS} from "@/services/mentraJsBootstrap"
import {useStressTestStore} from "@/stores/stressTest"
import MiniappSplash from "@/components/miniapp/MiniappSplash"
import {BgTimer, engine} from "@mentra/engine"
import {buildMentraUiShim, buildMiniappGlobalsScript, miniappLauncher} from "@mentra/engine-host-internal"
import {devServerBridge} from "@mentra/engine-host-internal/devtools"
import {useNavigationStore} from "@/stores/navigation"
import CapsuleMenu from "@/effects/CapsuleMenu"
import {useRegisterCapsule} from "@/stores/capsule"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {SETTINGS, useSetting} from "@mentra/engine"

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
const MAX_LOAD_ATTEMPTS = 10
const UI_RESYNC_INTERVAL_MS = 10_000

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
  showCapsule?: boolean
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
  showCapsule = false,
}: LocalMiniappViewProps) {
  const {theme} = useAppTheme()
  const insets = useSaferAreaInsets()
  const colorScheme = theme.isDark ? "dark" : "light"

  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  // Read inside the launch effect's catch handler without adding appName/iconUrl
  // to its dependency array — they're display-only and shouldn't re-trigger a
  // JSContext respawn on their own (e.g. a store refresh resolving a lazy icon).
  const appNameRef = useRef(appName)
  appNameRef.current = appName
  const iconUrlRef = useRef(iconUrl)
  iconUrlRef.current = iconUrl

  const viewShotRef = useRef<View | null>(null)
  const webViewRef = useRef<WebView | null>(null)
  const appStateRef = useRef<AppStateStatus>(AppState.currentState)
  const [webViewCanGoBack, setWebViewCanGoBack] = useState(false)
  const [uiUri, setUiUri] = useState<string | null>(null)
  const [uiBaseDir, setUiBaseDir] = useState<string | null>(null)
  const [devMode] = useSetting(SETTINGS.dev_mode.key)

  // ----- Load-state tracking -------------------------------------------------
  //
  // The `ready` handshake has exactly one source of truth: `connected`.
  // onLoadEnd only means the WebView painted — not that the miniapp UI JS
  // mounted and called mentra.ready(). After each load we arm a timer; if no
  // `ready` envelope arrives within READY_TIMEOUT_MS we reload, up to
  // MAX_LOAD_ATTEMPTS total, then give up with an error.
  //
  //   connected     — state; drives the splash (isLoaded) and re-renders.
  //   connectedRef  — ref mirror read inside handleLoadEnd and the ready
  //                   timer. WebView events (onMessage `ready`, a trailing
  //                   onLoadEnd) can land in the same bridge flush, before a
  //                   re-render refreshes closures — a captured stale
  //                   `connected=false` there would arm a timer that later
  //                   reloads an already-live miniapp.
  //   loadAttempts  — state (not a ref) so the dev "Loading… (attempt N of
  //                   M)" splash label re-renders as attempts increment.
  //                   attemptsRef is the counter the timer reads/bumps (the
  //                   reload side effect can't live inside a setLoadAttempts
  //                   updater — updaters must stay pure).
  //   readyTimerRef — the pending ready-timeout timer, if any.
  const [connected, setConnected] = useState(false)
  const connectedRef = useRef(false)
  const [loadAttempts, setLoadAttempts] = useState(0)
  const attemptsRef = useRef(0)
  const readyTimerRef = useRef<number | null>(null)

  const clearReadyTimer = useCallback(() => {
    if (readyTimerRef.current) {
      BgTimer.clearTimeout(readyTimerRef.current)
      readyTimerRef.current = null
    }
  }, [])

  // The miniapp sent `ready` — handshake complete, stop any pending retry.
  const markConnected = useCallback(() => {
    connectedRef.current = true
    setConnected(true)
    clearReadyTimer()
  }, [clearReadyTimer])

  const refreshUiBinding = useCallback(
    (reason: string, log = true, probeBackground = false) => {
      if (!packageName) return
      const mj = getMentraJS()
      if (!mj?.uiRouter.isBound(packageName)) return
      if (log) {
        console.log(`LocalMiniappView: refreshing UI bridge for ${packageName} (${reason})`)
      }
      mj.uiRouter.notifyReopen(packageName)
      if (probeBackground) {
        mj.router.probeForegroundLiveness(packageName, reason)
      }
    },
    [packageName],
  )

  // Fresh handshake + retry budget — used on (re)launch and dev hot-reload.
  const resetLoadState = useCallback(() => {
    connectedRef.current = false
    setConnected(false)
    attemptsRef.current = 0
    setLoadAttempts(0)
    clearReadyTimer()
  }, [clearReadyTimer])

  const fail = useCallback(
    (msg: string) => {
      console.warn(`LocalMiniappView: ${packageName} ${msg}`)
      setLabel(undefined)
      setErrorMessage(msg)
      clearReadyTimer()
    },
    [packageName, clearReadyTimer],
  )

  // Splash copy: `label` is transient progress text, `errorMessage` is the
  // terminal failure line (set by fail() or by the retry loop giving up).
  const [label, setLabel] = useState<string | undefined>(undefined)
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)

  // WebView injections can be missed while Android/iOS is resuming or when the
  // host process thaws after a sleep/network interruption. The background
  // runtime owns canonical state, so periodically re-announce the mounted UI
  // while foregrounded; miniapps hydrate from their session.ui.onOpen snapshot.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      const prevState = appStateRef.current
      appStateRef.current = nextState
      if (prevState !== "active" && nextState === "active") {
        refreshUiBinding("app-active", true, true)
      }
    })

    const intervalId = BgTimer.setInterval(() => {
      if (!connectedRef.current || AppState.currentState !== "active") return
      refreshUiBinding("foreground-resync", false)
    }, UI_RESYNC_INTERVAL_MS)

    return () => {
      sub.remove()
      BgTimer.clearInterval(intervalId)
    }
  }, [refreshUiBinding])

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
        engine.miniapps.clearForeground()
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

    // Fresh attempt budget per (re)launch — a re-foreground / new package
    // restarts the ready handshake and reload-retry loop from scratch.
    resetLoadState()

    const ac = new AbortController()
    const {signal} = ac
    // RN's AbortSignal doesn't reliably ship throwIfAborted(), so roll our own.
    const checkpoint = () => {
      if (signal.aborted) throw Object.assign(new Error("launch superseded"), {name: "AbortError"})
    }

    const launch = async (): Promise<void> => {
      // Background spawn now lives in the runtime's MiniappLauncher (resolve the
      // bundle → read the manifest → spawn the JSContext, handling dev HTTP vs
      // released file:// snapshot). This component is render-only: it asks the
      // launcher to ensure the background context is running (idempotent — a
      // re-foreground of a live miniapp just rebuilds this WebView half) and
      // mounts the resolved UI entry it hands back. Errors throw and are caught
      // by launch().catch below.
      const result = await miniappLauncher.ensureRunning(packageName, {devUrl, version, devPort})

      // Deliberately AFTER the spawn, not before: if we were superseded while
      // spawning, leave the JSContext alive (background miniapps keep running
      // across UI close) but don't touch UI state for a view we no longer
      // show. The only cleanup this component owes is unbinding the WebView
      // (handled by the effect's return).
      checkpoint()

      setLabel(undefined)
      // Already-registered packages never throw from ensureRunning — a dropped
      // dev server returns {uiUri: null} instead. Route those reopens to the
      // offline recovery screen the same way as first-launch resolve failures.
      if (devUrl && !result.uiUri) {
        console.warn(`LocalMiniappView: ${packageName} already running but UI unresolved, routing to dev-offline`)
        engine.miniapps.clearForeground()
        useNavigationStore.getState().push("/applet/dev-offline", {
          packageName,
          name: appNameRef.current,
          iconUrl: iconUrlRef.current,
        })
        return
      }
      // Set unconditionally: when the launcher resolves no UI entry (e.g. a
      // re-foreground couldn't re-resolve a non-dev package), clearing prevents
      // the WebView from continuing to show a stale / previous URL.
      setUiUri(result.uiUri)
      setUiBaseDir(result.uiBaseDir)
    }

    launch().catch((e: Error) => {
      if (e.name === "AbortError") return // stale run — ignore entirely
      if (devUrl) {
        // Dev bundle couldn't be resolved (dev server unreachable, or the
        // manifest/background bundle fetch failed) — route to the dedicated
        // offline screen with "Try again" / "Re-scan QR" instead of leaving
        // the user stuck on a bare error splash with no recovery action.
        console.warn(`LocalMiniappView: ${packageName} dev bundle unresolvable, routing to dev-offline: ${e.message}`)
        engine.miniapps.clearForeground()
        useNavigationStore.getState().push("/applet/dev-offline", {
          packageName,
          name: appNameRef.current,
          iconUrl: iconUrlRef.current,
        })
        return
      }
      fail(e.message)
    })

    return () => {
      ac.abort()
      clearReadyTimer()
      getMentraJS()?.uiRouter.unbindWebView(packageName)
    }
  }, [packageName, version, devUrl, devPort, resetLoadState, clearReadyTimer, fail])

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
      BgTimer.setTimeout(() => {
        if (webViewRef.current === instance) {
          refreshUiBinding("bind", false, true)
        }
      }, 250)
    },
    [packageName, refreshUiBinding],
  )

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!packageName) return
      // Observe the miniapp's `ready` envelope (posted by mentra.ready() in
      // the WebView shim). This is the real "UI mounted and bridge wired up"
      // signal — gate the splash on it instead of onLoadEnd. We only observe;
      // the envelope still flows on to routeFromWebView below (which fires
      // UI_OPEN to the background), so we must NOT early-return here.
      if (!connectedRef.current && isReadyEnvelope(event.nativeEvent.data)) {
        markConnected()
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
    [packageName, markConnected],
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
    console.log("LocalMiniappView: handleLoadEnd, connected:", connectedRef.current)
    if (connectedRef.current) return
    clearReadyTimer()
    readyTimerRef.current = BgTimer.setTimeout(() => {
      readyTimerRef.current = null
      if (connectedRef.current) return
      // A real "ready never arrived" timeout — this counts as one attempt.
      const attempt = attemptsRef.current + 1
      attemptsRef.current = attempt
      setLoadAttempts(attempt)
      if (attempt >= MAX_LOAD_ATTEMPTS) {
        console.warn(`LocalMiniappView: ${packageName} never sent ready after ${MAX_LOAD_ATTEMPTS} attempts`)
        setErrorMessage("miniapp failed to load")
        setLabel(undefined)
      } else {
        console.log(`LocalMiniappView: reloading, attempt ${attempt} of ${MAX_LOAD_ATTEMPTS}`)
        try {
          webViewRef.current?.reload()
        } catch (e) {
          console.warn(`LocalMiniappView: reload(${packageName}) failed:`, e)
        }
      }
    }, READY_TIMEOUT_MS)
  }, [packageName, clearReadyTimer])

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
      resetLoadState()
      try {
        webViewRef.current?.reload()
      } catch (e) {
        console.warn(`LocalMiniappView: reload(${packageName}) failed:`, e)
      }
    })
  }, [packageName, devUrl, resetLoadState])

  if (!packageName) {
    return <Text text="Missing required parameters" />
  }

  const isDevApp = !!devUrl

  if (!uiUri) {
    return (
      <View ref={viewShotRef} collapsable={false} className="flex-1">
        <MiniappSplash
          name={appName}
          iconUrl={iconUrl}
          bgColor={theme.colors.background}
          isLoaded={false}
          error={errorMessage}
          label={label}
          devApp={isDevApp}
        />
        {showCapsule && <CapsuleMenu forceShow={true} />}
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

  // While the WebView is mounted but the miniapp hasn't sent `ready` yet,
  // show retry progress on the splash. Once connected, the splash hides;
  // once the retry budget is spent, errorMessage replaces the label.
  let connectingLabel = undefined
  if (loadAttempts > 0 && devMode && !errorMessage) {
    connectingLabel = `Loading… (attempt ${loadAttempts + 1} of ${MAX_LOAD_ATTEMPTS})`
  }

  return (
    <View ref={viewShotRef} collapsable={false} className="flex-1 bg-black">
      <WebView
        ref={handleRef}
        source={{uri: uiUri}}
        originWhitelist={["*"]}
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowingReadAccessToURL={uiBaseDir ?? undefined}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        // Miniapps such as Livestreamer render muted autoplay previews using
        // either an inline WebRTC <video> or an HLS player iframe. WKWebView
        // blocks both unless the native host explicitly permits inline,
        // non-user-initiated media playback.
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo={true}
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
        style={{flex: 1}}
      />
      <MiniappSplash
        name={appName}
        iconUrl={iconUrl}
        bgColor={theme.colors.background}
        isLoaded={connected}
        error={errorMessage}
        label={connectingLabel}
        devApp={isDevApp}
        disableFadeIn={true}
      />
      {/* <View className="flex-1 bg-red-500"/> */}
      {showCapsule && <CapsuleMenu forceShow={true} />}
    </View>
  )
}

export default LocalMiniappView

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
