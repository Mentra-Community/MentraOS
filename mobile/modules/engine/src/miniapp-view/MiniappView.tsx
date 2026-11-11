/**
 * MiniappView — a miniapp's screen: its UI WebView, wired to the miniapp's
 * background running in the engine.
 *
 * Mounting it opens the miniapp: the launcher starts its background context
 * (idempotent; a context that already runs is reused) and the view loads the
 * screen the launcher resolves, from the package's own origin. The view injects
 * the miniapp globals and the mentra-ui shim, binds the WebView to the UI
 * router, keeps the binding fresh across app resumes, and gates `ready` on the
 * page's own `mentra.ready()`. Unmounting it closes the screen only: the
 * background keeps running until `engine.miniapps.stop()`.
 *
 * Installed screens need the patched react-native-webview the Mentra App ships
 * (its `miniappOrigin` prop serves the bundle from the package's own origin).
 */
import {forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState} from "react"
import {AppState, Linking, Platform, type AppStateStatus} from "react-native"
import {WebView, type WebViewMessageEvent, type WebViewProps} from "react-native-webview"

import {getConfigValues} from "../runtime/bootstrap"
import devServerBridge from "../services/DevServerBridge"
import {fleetEvents} from "../services/fleet/fleetEvents"
import localMiniappRuntime from "../services/LocalMiniappRuntime"
import {buildMentraUiShim} from "../services/mentraUiShim"
import {miniappLauncher} from "../services/MiniappLauncher"
import {recordMiniappScreenOrigin} from "../services/miniappScreenOrigin"
import {getMiniappEngine} from "../services/MiniappEngine"
import {buildMiniappGlobalsScript, type MiniappColorScheme, type MiniappSafeArea} from "../utils/miniappGlobals"
import {BgTimer} from "../utils/timers"
import {miniappHistoryBridge} from "./historyBridge"
import {decideMiniappNavigation, miniappOriginWhitelist} from "./miniappNavigation"
import {getWebViewLoadErrorDiagnostics} from "./webViewLoadErrorDiagnostics"

// Ready-handshake tuning (see readyTimerRef). Reloads only retry a page the shim reached late or not at all.
const READY_TIMEOUT_MS = 5000
const MAX_LOAD_ATTEMPTS = 10
const UI_RESYNC_INTERVAL_MS = 10_000

const NO_INSETS: MiniappSafeArea = {top: 0, bottom: 0, left: 0, right: 0}

/** The screen the launcher resolved for this view, before the WebView loads it. */
export interface MiniappScreen {
  /** Where the screen loads from: the package's own origin, or a development build's server. */
  uiUri: string
  uiOrigin: string
  /** The installed bundle the origin serves, under `uiOriginName`; null for a development server. */
  uiRootDir: string | null
  uiOriginName: string | null
  /**
   * The miniapp's own files directory (its blobs, such as its photos), which the same origin serves under
   * /.mentra/files/. Null or absent when the origin serves none.
   */
  uiFilesDir?: string | null
  /** A development build: a live development server or a development snapshot. */
  devBuild: boolean
}

export type MiniappViewStatus =
  /** Opening. `attempt` counts the reloads of a page whose shim never arrived. */
  | {state: "loading"; attempt: number}
  /** The page called `mentra.ready()` and its background released it. */
  | {state: "ready"}
  /** The launch threw (the launcher's error, such as an age gate or a build this host can't run). */
  | {state: "failed"; reason: "launch"; error: Error}
  /**
   * `no_screen`: the miniapp has no screen to load. `never_ready`: the page loaded but never called
   * `mentra.ready()`. `load_timeout`: the page never reached the shim in any attempt.
   */
  | {state: "failed"; reason: "no_screen" | "never_ready" | "load_timeout"}

export interface MiniappViewHandle {
  /** Go back in the screen's own history; false when it has none. */
  goBack(): boolean
}

export interface MiniappViewProps {
  packageName: string
  version?: string
  /** A development build's server, and its port. */
  devUrl?: string
  devPort?: string
  colorScheme?: MiniappColorScheme
  /** Insets the page should keep clear; the WebView fills the view edge to edge. */
  safeAreaInsets?: MiniappSafeArea
  onStatus?: (status: MiniappViewStatus) => void
  /** The screen's content process ended; it closes and nothing restarts it until it is opened again. */
  onExit?: () => void
  /** Whether the screen has history of its own to go back through. */
  onCanGoBackChange?: (canGoBack: boolean) => void
  /**
   * Runs once the launcher resolved the screen, before the WebView loads it. `checkpoint` throws once this launch
   * is superseded.
   */
  prepareScreen?: (screen: MiniappScreen, checkpoint: () => void) => Promise<void>
  /** Injected before everything else in each document, such as the page's kept localStorage. */
  beforeContentScript?: string
  /** Mount the WebView without loading the screen yet. */
  holdSource?: boolean
  /** Sees every message from the page first; returning true consumes it. */
  onMessage?: (data: string) => boolean
  /** The WebView instance as it mounts and unmounts. */
  onWebView?: (webView: WebView | null) => void
  onLoadError?: () => void
}

export const MiniappView = forwardRef<MiniappViewHandle, MiniappViewProps>(function MiniappView(
  {
    packageName,
    version,
    devUrl,
    devPort,
    colorScheme = "light",
    safeAreaInsets = NO_INSETS,
    onStatus,
    onExit,
    onCanGoBackChange,
    prepareScreen,
    beforeContentScript = "",
    holdSource = false,
    onMessage,
    onWebView,
    onLoadError,
  },
  ref,
) {
  // Callbacks are read through refs so a host re-render never relaunches the miniapp.
  const callbacks = useRef({onStatus, onExit, onCanGoBackChange, prepareScreen, onMessage, onWebView, onLoadError})
  callbacks.current = {onStatus, onExit, onCanGoBackChange, prepareScreen, onMessage, onWebView, onLoadError}
  const holdSourceRef = useRef(holdSource)
  holdSourceRef.current = holdSource

  const webViewRef = useRef<WebView | null>(null)
  const appStateRef = useRef<AppStateStatus>(AppState.currentState)
  const spaDepth = useRef(0)
  const nativeCanGoBack = useRef(false)
  const [screen, setScreen] = useState<MiniappScreen | null>(null)

  // ----- Load-state tracking -------------------------------------------------
  //
  // The `ready` handshake has exactly one source of truth: `connected`.
  // onLoadEnd only means the WebView painted — not that the miniapp UI JS
  // mounted and called mentra.ready(). After each load we arm a timer; if no
  // `ready` envelope arrives within READY_TIMEOUT_MS, a page that announced
  // `page_loaded` (the shim only does so when it ran before the page's
  // scripts) never called mentra.ready() and fails at once. Any other page
  // lost the shim injection race: reload it, up to MAX_LOAD_ATTEMPTS total,
  // then give up with an error.
  //
  //   connected     — state; with uiReleased, reports `ready`.
  //   connectedRef  — ref mirror read inside handleLoadEnd and the ready
  //                   timer. WebView events (onMessage `ready`, a trailing
  //                   onLoadEnd) can land in the same bridge flush, before a
  //                   re-render refreshes closures — a captured stale
  //                   `connected=false` there would arm a timer that later
  //                   reloads an already-live miniapp.
  //   attemptsRef   — the reload counter the timer reads/bumps.
  //   readyTimerRef — the pending ready-timeout timer, if any.
  //   pageLoadedRef — the shim announced `page_loaded` for the current document.
  const [connected, setConnected] = useState(false)
  const connectedRef = useRef(false)
  // The UI router holds this UI for its background until the background's init
  // settles: its session.ui handlers may not exist before.
  const [uiReleased, setUiReleased] = useState(false)
  const attemptsRef = useRef(0)
  const readyTimerRef = useRef<number | null>(null)
  const pageLoadedRef = useRef(false)

  const report = useCallback((status: MiniappViewStatus) => callbacks.current.onStatus?.(status), [])

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

  useEffect(() => {
    if (connected && uiReleased) report({state: "ready"})
  }, [connected, uiReleased, report])

  const fail = useCallback(
    (status: MiniappViewStatus & {state: "failed"}) => {
      console.warn(`MiniappView: ${packageName} failed (${status.reason})`)
      clearReadyTimer()
      report(status)
    },
    [packageName, clearReadyTimer, report],
  )

  const refreshUiBinding = useCallback(
    (reason: string, log = true, probeBackground = false) => {
      const mj = getMiniappEngine()
      if (!mj?.uiRouter.isBound(packageName)) return
      if (log) console.log(`MiniappView: refreshing UI bridge for ${packageName} (${reason})`)
      mj.uiRouter.notifyReopen(packageName)
      if (probeBackground) {
        // Returning from the Wi-Fi panel (or any system overlay) during a SoftAP join
        // often takes the WebView longer than 2.5s to pong. Killing Mentra-Call then
        // respawns it into a Cloudflare restore that tears the SoftAP listener down.
        mj.router.probeForegroundLiveness(packageName, reason, reason === "app-active" ? 12_000 : undefined)
      }
    },
    [packageName],
  )

  // Fresh handshake + retry budget — used on (re)launch and dev hot-reload.
  const resetLoadState = useCallback(() => {
    connectedRef.current = false
    setConnected(false)
    pageLoadedRef.current = false
    attemptsRef.current = 0
    clearReadyTimer()
    report({state: "loading", attempt: 0})
  }, [clearReadyTimer, report])

  // WebView injections can be missed while Android/iOS is resuming or when the
  // host process thaws after a sleep/network interruption. The background
  // runtime owns canonical state, so periodically re-announce the mounted UI
  // while foregrounded; miniapps hydrate from their session.ui.onOpen snapshot.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      const prevState = appStateRef.current
      appStateRef.current = nextState
      if (prevState !== "active" && nextState === "active") refreshUiBinding("app-active", true, true)
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

  useImperativeHandle(
    ref,
    () => ({
      goBack: () => {
        if (!webViewRef.current) return false
        if (spaDepth.current > 0) {
          webViewRef.current.injectJavaScript("window.history.back(); true;")
          return true
        }
        if (nativeCanGoBack.current) {
          webViewRef.current.goBack()
          return true
        }
        return false
      },
    }),
    [],
  )

  useEffect(() => {
    // Fresh attempt budget per (re)launch — a re-foreground / new package
    // restarts the ready handshake and reload-retry loop from scratch.
    resetLoadState()
    setUiReleased(false)

    let superseded = false
    // RN's AbortSignal doesn't reliably ship throwIfAborted(), so roll our own.
    const checkpoint = () => {
      if (superseded) throw Object.assign(new Error("launch superseded"), {name: "AbortError"})
    }

    const launch = async (): Promise<void> => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      checkpoint()
      // The launcher resolves the bundle, reads the manifest and spawns the
      // background context (dev HTTP vs released file:// snapshot); it is
      // idempotent, so a re-foreground of a live miniapp only rebuilds this
      // WebView half. A context this spawns is the person opening the
      // miniapp's screen: a user launch to Fleet.
      const result = await miniappLauncher.ensureRunning(packageName, {devUrl, version, devPort}, {trigger: "user"})
      // Superseded while spawning: leave the context alive (it keeps running
      // across UI close) but don't touch UI state for a view we no longer show.
      checkpoint()
      setUiReleased(!getMiniappEngine()?.uiRouter.isUiHeld(packageName))
      const next: MiniappScreen | null =
        result.uiUri && result.uiOrigin
          ? {
              ...result,
              uiUri: result.uiUri,
              uiOrigin: result.uiOrigin,
              // Asked once the context is registered: its build kind decides which data partition holds its files.
              uiFilesDir: result.uiRootDir ? localMiniappRuntime.ownFilesDirectoryUri(packageName) : null,
            }
          : null
      if (next) await callbacks.current.prepareScreen?.(next, checkpoint)
      checkpoint()
      // The screen about to load decides where the miniapp's own files get their URLs. A miniapp that keeps
      // running can reopen on another one: a development build moves between its server and its snapshot as the
      // server comes and goes. The launcher's record from the spawn stands until a screen opens.
      if (next) recordMiniappScreenOrigin(packageName, next.uiRootDir ? next.uiOrigin : null)
      // Set unconditionally: clearing a screen the launcher no longer resolves
      // keeps the WebView from showing a stale URL.
      setScreen(next)
      // No WebView means no ready event or timeout can report anything.
      if (!next) fail({state: "failed", reason: "no_screen"})
    }

    launch().catch((error: Error) => {
      if (superseded || error.name === "AbortError") return
      fail({state: "failed", reason: "launch", error})
    })

    return () => {
      superseded = true
      clearReadyTimer()
      getMiniappEngine()?.uiRouter.unbindWebView(packageName)
    }
  }, [packageName, version, devUrl, devPort, resetLoadState, clearReadyTimer, fail])

  useEffect(
    () =>
      getMiniappEngine()?.uiRouter.onUiReleased((releasedPackage) => {
        if (releasedPackage === packageName) setUiReleased(true)
      }),
    [packageName],
  )

  // Bind the UI router on ref attach so mentra.send/on routes outbound messages
  // through injectJavaScript. The launch effect's cleanup unbinds it, so closing
  // the screen fires UI_CLOSE on the background side.
  const handleRef = useCallback(
    (instance: WebView | null) => {
      webViewRef.current = instance
      callbacks.current.onWebView?.(instance)
      if (!instance) return
      getMiniappEngine()?.uiRouter.bindWebView(packageName, (js: string) => {
        try {
          instance.injectJavaScript(js)
        } catch (e) {
          console.warn(`MiniappView: inject failed for ${packageName}:`, e)
        }
      })
      BgTimer.setTimeout(() => {
        if (webViewRef.current === instance) refreshUiBinding("bind", false, true)
      }, 250)
    },
    [packageName, refreshUiBinding],
  )

  const setCanGoBack = useCallback((canGoBack: boolean) => callbacks.current.onCanGoBackChange?.(canGoBack), [])

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const data = event.nativeEvent.data
      if (callbacks.current.onMessage?.(data)) return
      try {
        const message = JSON.parse(data)
        if (message.type === "mentra_history" && Number.isInteger(message.depth) && message.depth >= 0) {
          spaDepth.current = message.depth
          setCanGoBack(message.depth > 0 || nativeCanGoBack.current)
          return
        }
        if (message.type === "page_loaded") {
          pageLoadedRef.current = true
          return
        }
      } catch {
        /* Other envelopes are handled by the UI router. */
      }
      // Observe the miniapp's `ready` envelope (posted by mentra.ready() in the
      // shim): the real "UI mounted and bridge wired up" signal. Only observed;
      // it still flows on to routeFromWebView, which fires UI_OPEN.
      if (!connectedRef.current && isReadyEnvelope(data)) markConnected()
      if (forwardWebViewDevLog(packageName, data)) return
      getMiniappEngine()?.uiRouter.routeFromWebView(packageName, data)
    },
    [packageName, markConnected, setCanGoBack],
  )

  // The miniapp's own document stays on its origin; frames may show web content;
  // a top-level link elsewhere opens in the system browser.
  const uiOrigin = screen?.uiOrigin ?? null
  const handleShouldStartLoad = useCallback<NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>>(
    (request) => {
      if (!uiOrigin) return false
      const isHostLink = (url: string) => getConfigValues().isHostLink?.(url) === true
      const decision = decideMiniappNavigation(request, uiOrigin, isHostLink)
      if (decision === "open_externally") {
        Linking.openURL(request.url).catch((e) =>
          console.warn(`MiniappView: couldn't open a link from ${packageName}`, e),
        )
      } else if (decision === "refuse") {
        console.warn(
          `MiniappView: ${packageName} navigation refused (${request.isTopFrame === false ? "frame" : "top"})`,
        )
      }
      return decision === "load"
    },
    [packageName, uiOrigin],
  )

  const handleNavStateChange = useCallback(
    ({canGoBack}: {canGoBack: boolean}) => {
      nativeCanGoBack.current = canGoBack
      setCanGoBack(canGoBack || spaDepth.current > 0)
    },
    [setCanGoBack],
  )

  // A new document (a reload, a dev reload, the held source arriving) has not
  // heard from its own shim yet.
  const handleLoadStart = useCallback(() => {
    pageLoadedRef.current = false
  }, [])

  // onLoadEnd means the WebView painted, not that the miniapp is ready. Arm a
  // timer; if the `ready` envelope hasn't arrived by READY_TIMEOUT_MS and the
  // shim announced `page_loaded`, the page never called mentra.ready() and a
  // reload would only repeat that. Otherwise the shim ran late or not at all:
  // count a failed attempt and reload, up to MAX_LOAD_ATTEMPTS, then fail.
  //
  // The attempt counter is bumped only when a timer actually fires without
  // `ready` — NOT on every onLoadEnd. A single page load can fire onLoadEnd
  // several times (redirects, SPA history changes, sub-frame loads); each of
  // those just re-arms the timer.
  const handleLoadEnd = useCallback(() => {
    // The placeholder document shown while the source is held is not the miniapp.
    if (connectedRef.current || holdSourceRef.current) return
    clearReadyTimer()
    readyTimerRef.current = BgTimer.setTimeout(() => {
      readyTimerRef.current = null
      if (connectedRef.current) return
      if (pageLoadedRef.current) {
        devServerBridge.forwardLog(
          packageName,
          "error",
          [
            "The page loaded but never called mentra.ready(). Wrap the app in <MentraProvider>, or call mentra.ready() once it has mounted.",
          ],
          Date.now(),
          "ui",
        )
        fail({state: "failed", reason: "never_ready"})
        return
      }
      // A real "ready never arrived" timeout — this counts as one attempt.
      const attempt = attemptsRef.current + 1
      attemptsRef.current = attempt
      if (attempt >= MAX_LOAD_ATTEMPTS) {
        fail({state: "failed", reason: "load_timeout"})
        return
      }
      console.log(`MiniappView: reloading, attempt ${attempt} of ${MAX_LOAD_ATTEMPTS}`)
      report({state: "loading", attempt})
      try {
        webViewRef.current?.reload()
      } catch (e) {
        console.warn(`MiniappView: reload(${packageName}) failed:`, e)
      }
    }, READY_TIMEOUT_MS)
  }, [packageName, clearReadyTimer, fail, report])

  const handleTerminate = useCallback(() => {
    // Fleet: the miniapp's screen crashed and closes; nothing restarts it until the person opens it again.
    const versionName = localMiniappRuntime.installedVersionOf(packageName)
    fleetEvents.crash({
      packageName,
      ...(versionName ? {versionName} : {}),
      surface: "webview",
      category: "content_process_terminated",
      outcome: "closed",
      crashesInWindow: 1,
    })
    callbacks.current.onExit?.()
  }, [packageName])

  const handleError = useCallback<NonNullable<WebViewProps["onError"]>>(
    (event) => {
      console.warn(`[MiniappView:${packageName}] WebView load error`, getWebViewLoadErrorDiagnostics(event.nativeEvent))
      callbacks.current.onLoadError?.()
    },
    [packageName],
  )

  // Dev hot-reload: when the dev server signals a reload for THIS miniapp,
  // refresh the WebView. The dev UI loads straight off the dev server with
  // cache-control: no-store, so a plain reload re-fetches the fresh build. The
  // background respawn for src/background/ changes is the MiniappEngine's.
  useEffect(() => {
    if (!devUrl) return
    devServerBridge.onReload((pkg) => {
      if (pkg !== packageName) return
      resetLoadState()
      try {
        webViewRef.current?.reload()
      } catch (e) {
        console.warn(`MiniappView: reload(${packageName}) failed:`, e)
      }
    })
  }, [packageName, devUrl, resetLoadState])

  const {top, bottom, left, right} = safeAreaInsets
  const injectedJS = useMemo(
    () =>
      [
        // First, so the host's script (such as kept localStorage) runs before anything else.
        beforeContentScript,
        buildMiniappGlobalsScript({
          packageName,
          miniappLocal: true,
          miniappDeveloperMode: !!devUrl,
          safeAreaInsets: {top, bottom, left, right},
          webviewFillsStatusBar: true,
          colorScheme,
        }),
        buildMentraUiShim({packageName}),
        Platform.OS === "android" ? miniappHistoryBridge : "",
      ].join("\n"),
    [beforeContentScript, packageName, devUrl, top, bottom, left, right, colorScheme],
  )

  if (!screen) return null

  return (
    <WebView
      // A new bundle root (an update) is a new document on the same URL.
      key={screen.uiRootDir ?? screen.uiUri}
      ref={handleRef}
      source={holdSource ? undefined : {uri: screen.uiUri}}
      // An installed bundle loads from its own origin, which serves only that
      // bundle and never has file access: the package's for a release, a
      // development origin for a development snapshot. A live development
      // build loads from its server.
      miniappOrigin={
        screen.uiRootDir
          ? {
              packageName: screen.uiOriginName ?? packageName,
              rootDir: screen.uiRootDir,
              ...(screen.uiFilesDir ? {filesDir: screen.uiFilesDir} : {}),
            }
          : undefined
      }
      originWhitelist={miniappOriginWhitelist(screen.uiOrigin, getConfigValues().hostLinkPatterns)}
      onShouldStartLoadWithRequest={handleShouldStartLoad}
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
      injectedJavaScript={Platform.OS === "android" ? miniappHistoryBridge : undefined}
      onMessage={handleMessage}
      onLoadStart={handleLoadStart}
      onLoadEnd={handleLoadEnd}
      onContentProcessDidTerminate={handleTerminate}
      onError={handleError}
      onNavigationStateChange={handleNavStateChange}
      // ALWAYS true: WKWebView only arms its back-forward snapshot system when
      // this is true at mount time. A host's back gesture pops in-WebView
      // history first (through goBack) and only then closes the screen.
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
      // mid-pinch. Fixes pinch-zoom freeze on JS-driven maps (Google Maps)
      // where the second finger's touchend gets eaten and the recognizer
      // stays stuck in zoom mode. See flutter#182828,
      // react-native-webview#1649, manuelstofer/pinchzoom#115.
      nestedScrollEnabled={true}
      webviewDebuggingEnabled={__DEV__}
      style={{flex: 1}}
    />
  )
})

/**
 * True iff `raw` is the shim's `{type:"ready"}` envelope, posted by
 * `mentra.ready()` (mentraUiShim.ts) once the miniapp UI has mounted and wired
 * up its `window.mentra` bridge.
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
 * `{payload:{type:"dev_log", level, args, ...}}`. MentraUIRouter drops
 * envelopes it doesn't know, so without this WebView console output would
 * reach neither the dev sidecar nor the React Native console.
 *
 * Forwards to the `mentra-miniapp dev` terminal (a no-op with no sidecar
 * connected) and to the React Native console, so installed-miniapp errors are
 * still inspectable with no laptop attached. Returns true when it handled one.
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
