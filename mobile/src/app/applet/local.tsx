import {useLocalSearchParams} from "expo-router"
import {File} from "expo-file-system"
import {useCallback, useEffect, useRef, useState} from "react"
import {ActivityIndicator, Image, Platform, View} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import {WebView, type WebViewMessageEvent} from "react-native-webview"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {getMentraJS} from "@/services/mentraJsBootstrap"
import {useNavigationStore} from "@/stores/navigation"
import {useStressTestStore} from "@/stores/stressTest"
import {storage} from "@/utils/storage/storage"
import MiniappSplash from "@/components/miniapp/MiniappSplash"
import {
  appRegistry,
  buildMentraUiShim,
  buildMiniappGlobalsScript,
  devServerBridge,
} from "@mentra/island"

/**
 * Mount destination for a dev or installed local miniapp.
 *
 * UI WebView is rendered inline in this route — same shape as
 * `/applet/webview` for cloud miniapps. The always-on JSContext
 * (transcription, button events, BLE) lives in MentraJSRouter and
 * survives navigation; only the WebView is torn down on nav-away.
 *
 * Two-layer flow:
 *   1. Dev: snapshot the dev server's bundle.zip into lmas/<pkg>/dev-<ts>/
 *      so the JSContext + WebView have an on-disk dist/ to read.
 *   2. Spawn the JSContext via MentraJSRouter.spawnAndRegister (idempotent).
 *   3. Render the WebView. ref.onMessage routes to MentraUIRouter; on
 *      mount the route calls uiRouter.bindWebView(packageName, injectFn).
 *
 * The back gesture mirrors `/applet/webview`: when the WebView has
 * forward/back history we let WKWebView's native swipe consume it; else
 * we re-enable React Navigation's gesture so the user can swipe to exit.
 */
export default function LocalMiniAppPage() {
  const {appName, packageName, version, devUrl, iconUrl, devPort} = useLocalSearchParams<{
    appName: string
    packageName: string
    version?: string
    devUrl?: string
    iconUrl?: string
    devPort?: string
  }>()
  const {goBack, setForceGestureEnabled} = useNavigationStore.getState()
  const {theme} = useAppTheme()
  const insets = useSafeAreaInsets()
  const colorScheme = theme.isDark ? "dark" : "light"

  const goBackRef = useRef(goBack)
  goBackRef.current = goBack

  const webViewRef = useRef<WebView | null>(null)
  const [webViewCanGoBack, setWebViewCanGoBack] = useState(false)
  const [uiUri, setUiUri] = useState<string | null>(null)
  const [uiBaseDir, setUiBaseDir] = useState<string | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)

  // Phase machine for the pre-WebView affordance. "ready" means we have a
  // uiUri and the WebView is mounted; the loading card is rendered for
  // every phase prior so the user always sees something happening.
  const [phase, setPhase] = useState<
    "installing" | "spawning" | "opening" | "ready" | "error"
  >(devUrl || version ? "installing" : "error")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!packageName) return
    let cancelled = false

    const fail = (msg: string) => {
      if (cancelled) return
      console.warn(`local.tsx: ${packageName} ${msg}`)
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
        const installRes = await appRegistry.installFromUrl(
          `${sidecarBase}/__mentra_dev/bundle.zip`,
          {versionOverride},
        )
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

      // Spawn the JSContext if it isn't already alive. Re-entering this
      // route for a running miniapp just rebuilds the WebView half.
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

      // If the user navigated away while we were spawning, leave the
      // JSContext alive — background miniapps keep running across UI
      // close. The only cleanup the route owes is unbinding the WebView
      // (handled by the effect's return).
      if (cancelled) return

      setPhase("opening")
      if (entryPaths.ui) {
        setUiUri(entryPaths.ui)
        setUiBaseDir(entryPaths.ui.replace(/\/[^/]+$/, "/"))
      }
      if (!cancelled) setPhase("ready")
    }

    void launch()

    return () => {
      cancelled = true
      const mj = getMentraJS()
      mj?.uiRouter.unbindWebView(packageName)
    }
  }, [packageName, version, devUrl, devPort])

  // ----- WebView bindings ----------------------------------------------------

  // Bind UI router on ref attach so mentra.send/on routes outbound messages
  // through `webViewRef.current.injectJavaScript(...)`. Unbinds on cleanup
  // (see the launch effect's return) so closing the route fires UI_CLOSE on
  // the JSContext side and clears the inject hook.
  const handleRef = useCallback(
    (ref: WebView | null) => {
      webViewRef.current = ref
      if (!ref || !packageName) return
      const mj = getMentraJS()
      if (!mj) return
      mj.uiRouter.bindWebView(packageName, (js: string) => {
        try {
          ref.injectJavaScript(js)
        } catch (e) {
          console.warn(`local.tsx: inject failed for ${packageName}:`, e)
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

  const handleNavStateChange = useCallback(({canGoBack}: {canGoBack: boolean}) => {
    setWebViewCanGoBack(canGoBack)
  }, [])

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
    goBackRef.current()
  }, [packageName])

  const handleError = useCallback(() => {
    if (!packageName) return
    useStressTestStore.getState().recordEvent({
      packageName,
      at: Date.now(),
      kind: "error",
    })
  }, [packageName])

  // Drive React Navigation's swipe-back gesture: enabled only when the
  // WebView has no in-app history. Same pattern as the cloud webview
  // route so iOS users get the native iOS pop-gesture animation when
  // exiting the miniapp.
  useEffect(() => {
    setForceGestureEnabled(!webViewCanGoBack)
    return () => setForceGestureEnabled(false)
  }, [webViewCanGoBack, setForceGestureEnabled])

  // Hardware back / capsule back: pop the WebView's history first, else
  // pop the route. Mirrors webview.tsx's handleWebViewBack.
  useEffect(() => {
    if (!packageName) return
    // Currently no capsule registration here — the route's native
    // back-swipe gesture handles exit. If we ever need capsule wiring,
    // hook useRegisterCapsule with a handler that calls handleBack().
  }, [packageName])

  // Dev hot-reload: when the dev server signals a reload for THIS
  // miniapp (e.g. a file under src/ui/ changed), refresh the WebView.
  // The JSContext respawn for src/background/ changes is handled by
  // mentraJsBootstrap via devServerBridge.onRespawnBackground.
  useEffect(() => {
    if (!packageName || !devUrl) return
    devServerBridge.onReload((pkg) => {
      if (pkg !== packageName) return
      try {
        webViewRef.current?.reload()
      } catch (e) {
        console.warn(`local.tsx: reload(${packageName}) failed:`, e)
      }
    })
  }, [packageName, devUrl])

  if (!packageName) {
    return <Text>Missing required parameters</Text>
  }

  // Loading affordance: the WebView only mounts once entry resolution +
  // JSContext spawn complete. The splash covers the early frames where
  // the WebView is mounted but hasn't painted yet.
  if (phase !== "ready" || !uiUri) {
    const label =
      phase === "installing"
        ? "Downloading…"
        : phase === "spawning"
          ? "Starting…"
          : phase === "opening"
            ? "Opening…"
            : "Couldn't open"
    return (
      <View className="flex-1 items-center justify-center px-8">
        <View className="items-center gap-4">
          {iconUrl ? (
            <Image
              source={{uri: iconUrl}}
              style={{width: 72, height: 72, borderRadius: 16}}
              resizeMode="cover"
            />
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
          {appName ? (
            <Text className="text-base font-semibold text-center" text={appName} />
          ) : null}
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
    <View className="flex-1" style={{backgroundColor: theme.colors.background}}>
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
        allowsBackForwardNavigationGestures={webViewCanGoBack}
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
        iconUrl={iconUrl}
        bgColor={theme.colors.background}
        isLoaded={isLoaded}
      />
    </View>
  )
}

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
