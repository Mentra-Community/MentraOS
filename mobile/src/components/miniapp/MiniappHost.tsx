import {useCallback, useEffect, useRef, useState} from "react"
import {Alert, Platform, View} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import {WebView, WebViewMessageEvent} from "react-native-webview"

import LeftEdgeBackSwipe from "@/components/miniapp/LeftEdgeBackSwipe"
import MiniappSplash from "@/components/miniapp/MiniappSplash"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useStressTestStore} from "@/stores/stressTest"
import {
  buildMentraUiShim,
  buildMiniappGlobalsScript,
  devServerBridge,
  type MentraUIRouter,
} from "@mentra/island"

// ---------------------------------------------------------------------------
// Two-layer UI host
//
// UI WebViews live ONLY when the user is looking at them. The always-on
// half (glasses events, BLE, transcription) runs in the miniapp's
// background JSContext owned by MentraJSRouter; this component only
// renders the optional UI WebView.
//
// Lifecycle:
//   openUI(pkg, opts)  → create a fresh WebView pointed at opts.uiUri,
//                        inject mentraUiShim, bind to MentraUIRouter so
//                        mentra.send/on flows to the JSContext.
//   closeUI(pkg)       → destroy the WebView, fire UI_CLOSE, drop refs.
//
// Only one WebView is alive at a time (matches the spec's "0 or 1
// WebView at a time" invariant). Opening a second package's UI closes
// any prior one automatically.
//
// Dev hot-reload (WebView.reload()) is handled internally — wired to
// devServerBridge.onReload — and not exposed through the singleton.
// ---------------------------------------------------------------------------

interface MountedMiniapp {
  packageName: string
  uiUri: string
  appName?: string
  iconUrl?: string
  developerMode: boolean
  isLoaded: boolean
  /** Bumped each open so a re-open forces a fresh WebView via React `key`. */
  mountKey: number
  onClose?: () => void
  onBack?: () => void
}

export type MiniappOpenUIOptions = {
  uiUri: string
  appName?: string
  iconUrl?: string
  developerMode?: boolean
  onClose?: () => void
  onBack?: () => void
}

type CanGoBackListener = (canGoBack: boolean) => void

type MiniappHostAPI = {
  /** Open a fresh WebView for the named miniapp's UI half. */
  openUI(packageName: string, options: MiniappOpenUIOptions): void
  /** Tear down the UI WebView. The JSContext is unaffected. */
  closeUI(packageName: string): void
  /** True iff a WebView is currently mounted for the package. */
  isOpen(packageName: string): boolean
  /** Returns true if WKWebView popped a page; false if no history. */
  goBackInWebView(packageName: string): boolean
  /** Current value of WebView.canGoBack for the named package. */
  canGoBack(packageName: string): boolean
  /** Subscribe to canGoBack changes. Returns an unsubscribe fn. */
  subscribeCanGoBack(packageName: string, listener: CanGoBackListener): () => void
  /** Wire the MentraUIRouter so mentra.send/on routes to the JSContext. */
  attachUIRouter(router: MentraUIRouter): void
}

const warnPreMount =
  (fn: string) =>
  (..._args: unknown[]): never => {
    console.warn(`MiniappHost.${fn}() called before component mounted`)
    return undefined as never
  }

export const miniappHost: MiniappHostAPI = {
  openUI: warnPreMount("openUI"),
  closeUI: warnPreMount("closeUI"),
  isOpen: () => false,
  goBackInWebView: () => false,
  canGoBack: () => false,
  subscribeCanGoBack: () => () => {},
  attachUIRouter: warnPreMount("attachUIRouter"),
}

export default function MiniappHost() {
  // Only one mounted miniapp at a time — null when no WebView is open.
  const [mounted, setMounted] = useState<MountedMiniapp | null>(null)
  const webViewRef = useRef<WebView | null>(null)
  const canGoBackRef = useRef<boolean>(false)
  const canGoBackListenersRef = useRef<Set<CanGoBackListener>>(new Set())
  const uiRouterRef = useRef<MentraUIRouter | null>(null)
  const insets = useSafeAreaInsets()
  const {theme} = useAppTheme()
  const colorScheme = theme.isDark ? "dark" : "light"
  // React-state mirror so prop-driven render reads see the latest value.
  const [canGoBackState, setCanGoBackState] = useState(false)

  // ----- public API implementations ---------------------------------------

  const attachUIRouter = useCallback((router: MentraUIRouter) => {
    uiRouterRef.current = router
  }, [])

  const openUI = useCallback((packageName: string, options: MiniappOpenUIOptions) => {
    setMounted((prev) => {
      // Closing a prior binding (different package) is handled by
      // unbindWebView when its WebView ref tears down on unmount.
      return {
        packageName,
        uiUri: options.uiUri,
        appName: options.appName,
        iconUrl: options.iconUrl,
        developerMode: options.developerMode ?? false,
        isLoaded: false,
        mountKey: (prev?.packageName === packageName ? prev.mountKey : 0) + 1,
        onClose: options.onClose,
        onBack: options.onBack,
      }
    })
    webViewRef.current = null
    canGoBackRef.current = false
    setCanGoBackState(false)
  }, [])

  const closeUI = useCallback((packageName: string) => {
    setMounted((prev) => {
      if (!prev || prev.packageName !== packageName) return prev
      return null
    })
    // Router unbind triggers UI_CLOSE → JSContext side fires session.ui.onClose.
    uiRouterRef.current?.unbindWebView(packageName)
    webViewRef.current = null
    canGoBackRef.current = false
    setCanGoBackState(false)
    canGoBackListenersRef.current.clear()
  }, [])

  const isOpen = useCallback(
    (packageName: string) => mounted?.packageName === packageName,
    [mounted],
  )

  const goBackInWebView = useCallback(
    (packageName: string): boolean => {
      if (!mounted || mounted.packageName !== packageName) return false
      const ref = webViewRef.current
      if (ref && canGoBackRef.current) {
        ref.goBack()
        return true
      }
      return false
    },
    [mounted],
  )

  const canGoBack = useCallback(
    (packageName: string): boolean =>
      mounted?.packageName === packageName ? canGoBackRef.current : false,
    [mounted],
  )

  const subscribeCanGoBack = useCallback(
    (packageName: string, listener: CanGoBackListener): (() => void) => {
      // listeners are shared across packages — the only ever-mounted package
      // is the current one, so we just fire with the current value.
      canGoBackListenersRef.current.add(listener)
      listener(mounted?.packageName === packageName ? canGoBackRef.current : false)
      return () => {
        canGoBackListenersRef.current.delete(listener)
      }
    },
    [mounted],
  )

  const reload = useCallback((packageName: string) => {
    if (!mounted || mounted.packageName !== packageName) return
    try {
      webViewRef.current?.reload()
    } catch (e) {
      console.warn(`MiniappHost: reload(${packageName}) failed:`, e)
    }
  }, [mounted])

  // ----- singleton wire-up -----------------------------------------------

  useEffect(() => {
    miniappHost.openUI = openUI
    miniappHost.closeUI = closeUI
    miniappHost.isOpen = isOpen
    miniappHost.goBackInWebView = goBackInWebView
    miniappHost.canGoBack = canGoBack
    miniappHost.subscribeCanGoBack = subscribeCanGoBack
    miniappHost.attachUIRouter = attachUIRouter

    devServerBridge.onReload((packageName) => {
      reload(packageName)
    })

    return () => {
      miniappHost.openUI = warnPreMount("openUI")
      miniappHost.closeUI = warnPreMount("closeUI")
      miniappHost.isOpen = () => false
      miniappHost.goBackInWebView = () => false
      miniappHost.canGoBack = () => false
      miniappHost.subscribeCanGoBack = () => () => {}
      miniappHost.attachUIRouter = warnPreMount("attachUIRouter")
    }
  }, [openUI, closeUI, isOpen, goBackInWebView, canGoBack, subscribeCanGoBack, reload, attachUIRouter])

  // ----- WebView event handlers ------------------------------------------

  const handleMessage = useCallback(
    (packageName: string, event: WebViewMessageEvent) => {
      const router = uiRouterRef.current
      if (!router) return
      router.routeFromWebView(packageName, event.nativeEvent.data)
    },
    [],
  )

  const markLoaded = useCallback((packageName: string) => {
    setMounted((prev) => {
      if (!prev || prev.packageName !== packageName || prev.isLoaded) return prev
      return {...prev, isLoaded: true}
    })
  }, [])

  const handleTerminate = useCallback(
    (packageName: string) => {
      useStressTestStore.getState().recordEvent({
        packageName,
        at: Date.now(),
        kind: "terminate",
      })
      if (__DEV__ && !useStressTestStore.getState().active) {
        Alert.alert(
          "Miniapp Terminated",
          `"${packageName}" was killed by the OS (out of memory).`,
        )
      }
      closeUI(packageName)
    },
    [closeUI],
  )

  const handleError = useCallback(
    (packageName: string) => {
      useStressTestStore.getState().recordEvent({
        packageName,
        at: Date.now(),
        kind: "error",
      })
      if (__DEV__ && !useStressTestStore.getState().active) {
        Alert.alert("Miniapp Error", `"${packageName}" encountered a fatal error.`)
      }
      closeUI(packageName)
    },
    [closeUI],
  )

  const handleNavStateChange = useCallback((packageName: string, canGo: boolean) => {
    if (mounted?.packageName !== packageName) return
    if (canGoBackRef.current === canGo) return
    canGoBackRef.current = canGo
    setCanGoBackState(canGo)
    for (const l of canGoBackListenersRef.current) l(canGo)
  }, [mounted])

  // ----- render -----------------------------------------------------------

  if (!mounted) {
    return null
  }

  const app = mounted
  const fgPadding = {
    paddingLeft: insets.left,
    paddingRight: insets.right,
  }

  const globalsScript = buildMiniappGlobalsScript({
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
  const uiShim = buildMentraUiShim({packageName: app.packageName})
  const injectedJS = `${globalsScript}\n${uiShim}`

  return (
    <View className="absolute inset-0 z-10" pointerEvents="box-none">
      <View
        key={app.packageName}
        className="flex-1 absolute inset-0"
        style={fgPadding}
        pointerEvents="auto">
        <WebView
          key={`${app.packageName}:${app.mountKey}`}
          ref={(ref) => {
            if (ref) {
              webViewRef.current = ref
              // Bind: route mentra.send/on through to the JSContext
              // via injectJavaScript. The router unbinds on closeUI.
              uiRouterRef.current?.bindWebView(app.packageName, (js: string) => {
                try {
                  ref.injectJavaScript(js)
                } catch (e) {
                  console.warn(
                    `MiniappHost: inject failed for ${app.packageName}:`,
                    e,
                  )
                }
              })
            }
          }}
          source={{uri: app.uiUri}}
          originWhitelist={["*"]}
          allowFileAccess={true}
          allowFileAccessFromFileURLs={true}
          allowingReadAccessToURL={(() => {
            const uri = app.uiUri
            if (!uri.startsWith("file://")) return undefined
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
          allowsBackForwardNavigationGestures={canGoBackState}
          bounces={false}
          overScrollMode="never"
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          scalesPageToFit={false}
          setBuiltInZoomControls={false}
          setDisplayZoomControls={false}
          webviewDebuggingEnabled={__DEV__}
          style={{flex: 1, backgroundColor: theme.colors.background}}
        />
        <MiniappSplash
          iconUrl={app.iconUrl}
          bgColor={theme.colors.background}
          isLoaded={app.isLoaded}
        />
        <LeftEdgeBackSwipe packageName={app.packageName} onBack={app.onBack} />
      </View>
    </View>
  )
}
