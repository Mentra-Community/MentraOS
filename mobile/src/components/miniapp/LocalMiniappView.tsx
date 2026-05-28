import {File} from "expo-file-system"
import {forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState} from "react"
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
  buildMentraUiShim,
  buildMiniappGlobalsScript,
  devServerBridge,
  useAppStatusStore,
} from "@mentra/island"
import {useNavigationStore} from "@/stores/navigation"
import CapsuleMenu, {captureScreenshot} from "@/effects/CapsuleMenu"
import {useRegisterCapsule} from "@/stores/capsule"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"

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
 * back-swipe gesture, and capsule button — this component just exposes a
 * `goBack()` handle so the gesture can pop in-WebView history before
 * backgrounding.
 */

export interface LocalMiniappViewHandle {
  /** Pop the WebView's in-app history. Returns true if it had history to pop. */
  goBack: () => boolean
  /** Whether the WebView currently has back history. */
  canGoBack: boolean
}

interface LocalMiniappViewProps {
  packageName: string
  appName?: string
  version?: string
  devUrl?: string
  iconUrl?: string
  devPort?: string
  /** Called when the WebView's content process terminates / errors fatally. */
  onExit: () => void
  /** Notified whenever the WebView's in-app back history availability changes. */
  onCanGoBackChange?: (canGoBack: boolean) => void
  onShouldCapture: () => void
}

const LocalMiniappView = ({
  packageName,
  appName,
  version,
  devUrl,
  iconUrl,
  devPort,
  onExit,
  onCanGoBackChange,
  onShouldCapture,
}: LocalMiniappViewProps) => {
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

  // Phase machine for the pre-WebView affordance. "ready" means we have a
  // uiUri and the WebView is mounted; the loading card is rendered for
  // every phase prior so the user always sees something happening.
  const [phase, setPhase] = useState<"installing" | "spawning" | "opening" | "ready" | "error">(
    devUrl || version ? "installing" : "error",
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // // Expose an imperative handle so the Compositor's back-swipe can pop
  // // in-WebView history before committing to backgrounding the app.
  // useImperativeHandle(
  //   ref,
  //   () => ({
  //     goBack: () => {
  //       if (webViewCanGoBack && webViewRef.current) {
  //         webViewRef.current.goBack()
  //         return true
  //       }
  //       return false
  //     },
  //     canGoBack: webViewCanGoBack,
  //   }),
  //   [webViewCanGoBack],
  // )

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

  // Dynamically toggle gesture handling based on webview navigation state:
  // - Page 0 (no history): disable WebView's gesture, force-enable React Navigation's
  //   native swipe-back so user can exit miniapp with the real iOS animation.
  // - Has history: enable WebView's gesture for in-webview navigation,
  //   React Navigation's gesture stays blocked by focusEffectPreventBack.
  useEffect(() => {
    if (!webViewCanGoBack) {
      // Page 0: force React Navigation gesture on, WebView gesture off
      setForceGestureEnabled(true)
    } else {
      // Has history: let focusEffectPreventBack handle it (gesture disabled),
      // WebView's allowsBackForwardNavigationGestures handles in-webview swipe
      setForceGestureEnabled(false)
    }

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

    const fail = (msg: string) => {
      if (cancelled) return
      console.warn(`LocalMiniappView: ${packageName} ${msg}`)
      setErrorMessage(msg)
      setPhase("error")
    }

    const launch = async () => {
      let resolvedVersion: string | null = null

      if (devUrl) {
        setPhase("installing")
        const portNum = resolveDevPort(devPort, packageName)
        if (portNum === null) {
          fail("no dev port configured")
          return
        }
        const sidecarBase = buildSidecarBaseUrl(devUrl, portNum)
        if (!sidecarBase) {
          fail(`bad dev URL "${devUrl}"`)
          return
        }
        const versionOverride = `dev-${Date.now()}`
        const installRes = await appRegistry.installFromUrl(`${sidecarBase}/__mentra_dev/bundle.zip`, {versionOverride})
        if (installRes.is_error()) {
          fail(`dev snapshot failed: ${installRes.error?.message ?? installRes.error}`)
          return
        }
        appRegistry.gcDevVersions(packageName, 2)
        devServerBridge.connect(packageName, devUrl, portNum)
        storage.save(`${packageName}_dev_last_reachable`, Date.now())
        resolvedVersion = await appRegistry.getActiveVersion(packageName)
      } else if (version) {
        resolvedVersion = version
      } else {
        fail("no devUrl or version — cannot launch")
        return
      }

      if (!resolvedVersion || cancelled) return

      const entryPaths = appRegistry.getMiniappEntryPaths(packageName, resolvedVersion)
      if (!entryPaths?.background) {
        fail(`${resolvedVersion} missing entry.background`)
        return
      }
      const manifest = appRegistry.getMiniappManifest(packageName, resolvedVersion) as {
        permissions?: Array<{type: string; required?: boolean; description?: string}>
        hardwareRequirements?: Array<{type: string; level: string; description?: string}>
      } | null
      const declaredPermissions = (manifest?.permissions ?? [])
        .map((p) => p.type)
        .filter((t): t is string => typeof t === "string")
      const installedManifest = manifest
        ? {
            permissions: manifest.permissions,
            hardwareRequirements: manifest.hardwareRequirements,
          }
        : undefined

      const mj = getMentraJS()
      if (!mj) {
        fail("MentraJS runtime not bootstrapped")
        return
      }

      if (cancelled) return
      setPhase("spawning")

      // Spawn the JSContext if it isn't already alive. Re-foregrounding a
      // running miniapp just rebuilds the WebView half.
      if (!mj.router.registeredPackages().includes(packageName)) {
        const bgSource = new File(entryPaths.background).textSync()
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
      if (entryPaths.ui) {
        setUiUri(entryPaths.ui)
        setUiBaseDir(entryPaths.ui.replace(/\/[^/]+$/, "/"))
      }
      if (!cancelled) setPhase("ready")
    }

    launch()

    return () => {
      cancelled = true
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
      const mj = getMentraJS()
      mj?.uiRouter.routeFromWebView(packageName, event.nativeEvent.data)
    },
    [packageName],
  )

  const handleNavStateChange = useCallback(
    ({canGoBack}: {canGoBack: boolean}) => {
      setWebViewCanGoBack(canGoBack)
      onCanGoBackChange?.(canGoBack)
    },
    [onCanGoBackChange],
  )

  const handleLoadEnd = useCallback(() => {
    setIsLoaded(true)
  }, [])

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
  // (e.g. a file under src/ui/ changed), refresh the WebView. The JSContext
  // respawn for src/background/ changes is handled by mentraJsBootstrap via
  // devServerBridge.onRespawnBackground.
  useEffect(() => {
    if (!packageName || !devUrl) return
    devServerBridge.onReload((pkg) => {
      if (pkg !== packageName) return
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

  // Loading affordance: the WebView only mounts once entry resolution +
  // JSContext spawn complete. The splash covers the early frames where the
  // WebView is mounted but hasn't painted yet.
  if (phase !== "ready" || !uiUri) {
    let label
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
      default:
        label = "Couldn't open"
        break
    }
    return (
      <View className="flex-1 items-center justify-center px-8 bg-background">
        <View className="items-center gap-4">
          {iconUrl ? (
            <Image source={{uri: iconUrl}} style={{width: 72, height: 72, borderRadius: 16}} resizeMode="cover" />
          ) : (
            <View
              style={{
                width: 72,
                height: 72,
                borderRadius: 16,
                backgroundColor: "rgba(120,120,120,0.2)",
              }}
            />
          )}
          {appName ? <Text className="text-base font-semibold text-center" text={appName} /> : null}
          {phase === "error" ? (
            <Text
              className="text-[13px] text-center text-red-500 max-w-[280px]"
              text={errorMessage ?? "Couldn't open"}
            />
          ) : (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator />
              <Text className="text-[13px] text-muted-foreground" text={label} />
            </View>
          )}
        </View>
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
        webviewDebuggingEnabled={__DEV__}
        style={{flex: 1, borderRadius: theme.spacing.s12}}
      />
      <MiniappSplash iconUrl={iconUrl} bgColor={theme.colors.background} isLoaded={isLoaded} />
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

function buildSidecarBaseUrl(devUrl: string, sidecarPort: number): string | null {
  try {
    const url = new URL(devUrl)
    return `${url.protocol}//${url.hostname}:${sidecarPort}`
  } catch {
    return null
  }
}
