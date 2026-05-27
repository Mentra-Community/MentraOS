import {useLocalSearchParams} from "expo-router"
import {useRef, useState, useEffect, useCallback} from "react"
import {Platform, View} from "react-native"
import {WebView} from "react-native-webview"
import Animated, {useSharedValue, useAnimatedStyle, withTiming} from "react-native-reanimated"

import {Header, Screen, Text} from "@/components/ignite"
import MiniappErrorScreen from "@/components/miniapps/MiniappErrorScreen"
import LoadingOverlay from "@/components/ui/LoadingOverlay"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import restComms from "@/services/RestComms"
import {webviewBridge as miniComms} from "@mentra/island"
import {WebSocketStatus} from "@/services/ws-types"
import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import {useAppStatusStore} from "@mentra/island"

import miniappCatalog from "@/services/miniapps/MiniappCatalog"
import {useConnectionStore} from "@/stores/connection"
import {captureScreenshot} from "@/effects/CapsuleMenu"
import AppIcon from "@/components/home/AppIcon"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {buildMiniappGlobalsScript} from "@mentra/island"
import {useRegisterCapsule} from "@/stores/capsule"

export default function AppWebView() {
  const {webviewURL, appName, packageName, isLocal: isLocalParam} = useLocalSearchParams()
  const isLocal = isLocalParam === "true"
  const [hasError, setHasError] = useState(false)
  const webViewRef = useRef<WebView>(null)

  const [finalUrl, setFinalUrl] = useState<string | null>(null)
  const [isLoadingToken, setIsLoadingToken] = useState(!isLocal)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [retryTrigger, setRetryTrigger] = useState(0)
  const {goBack, push} = useNavigationStore.getState()
  const viewShotRef = useRef(null)
  const insets = useSaferAreaInsets()
  const {theme} = useAppTheme()
  const colorScheme = theme.isDark ? "dark" : "light"

  // Track if the server-side app start failed
  const [appStartFailed, setAppStartFailed] = useState(false)

  // Track whether the WebView has back navigation history
  const [webViewCanGoBack, setWebViewCanGoBack] = useState(false)

  // Allow back to exit if route params are invalid (no X button on that screen)
  const hasValidParams =
    typeof webviewURL === "string" && typeof appName === "string" && typeof packageName === "string"

  const {setForceGestureEnabled} = useNavigationStore.getState()

  // Back press handler for CapsuleMenu/Header buttons and Android back button.
  const handleWebViewBack = useCallback(async () => {
    console.log("WEBVIEW: handleWebViewBack()")
    if (Platform.OS === "ios") {
      await captureScreenshot(viewShotRef, packageName.toString(), insets.top)
    }
    if (!hasValidParams) {
      if (Platform.OS === "android") {
        goBack()
      }
      return
    }
    if (webViewCanGoBack && webViewRef.current) {
      webViewRef.current.goBack()
    } else {
      if (Platform.OS === "android") {
        captureScreenshot(viewShotRef, packageName.toString(), insets.top)
        goBack()
      }
    }
  }, [webViewCanGoBack, hasValidParams, goBack])

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
    visibleOnRoutes: ["/applet/webview"],
    onBackPress: handleWebViewBack,
  })

  // Two conditions for showing the webview content:
  // 1. WebView HTML has loaded (onLoadEnd fired)
  const [isWebViewLoaded, setIsWebViewLoaded] = useState(false)
  // 2. Server confirmed the app is running (loading=false, running=true in store)
  //    Local miniapps skip the server handshake, so they are confirmed immediately.
  const [isServerConfirmed, setIsServerConfirmed] = useState(isLocal)
  // Splash screen stays up until BOTH are true
  const isWebViewReady = isWebViewLoaded && isServerConfirmed

  const webViewOpacity = useSharedValue(0)
  const loadingOpacity = useSharedValue(1)

  const webViewAnimatedStyle = useAnimatedStyle(() => ({
    opacity: webViewOpacity.value,
  }))

  const loadingAnimatedStyle = useAnimatedStyle(() => ({
    opacity: loadingOpacity.value,
  }))

  if (!hasValidParams) {
    return <Text>Missing required parameters</Text>
  }

  // Watch the applet's store state for server confirmation.
  // startApplet() sets loading=true, then refreshApplets() (at ~2s) fetches
  // the real state from the server which sets loading=false.
  // If running=false after server confirms, the app failed to start.
  // Local miniapps skip this entirely — they don't need server confirmation.
  //
  // Un-latch on positive confirmation: running=true clears a prior failure
  // (e.g. if the WS briefly dropped and the store observed running=false
  // during a cross-pod reconnect before the cloud re-hydrated the session).
  //
  // Suppress failure latching while the WS isn't CONNECTED or during a short
  // grace window after reconnect — the store is inherently stale in that
  // window and false-negatives there were causing "Cannot reach" mid-session.
  useEffect(() => {
    if (isLocal) return

    const POST_RECONNECT_GRACE_MS = 5_000
    // The island store's `loading: true` stamp lands ~1 frame AFTER nav
    // (beforeStart awaits an alert/network call before island.start() sets
    // it). Without this grace, the screen mounts seeing stale loading=false
    // running=false and immediately latches appStartFailed, causing the
    // "Can't connect" screen to flash for ~500ms before the real load.
    const MOUNT_GRACE_MS = 3_000
    const mountedAt = Date.now()

    const checkApplet = (state: {apps: Array<{packageName: string; loading: boolean; running: boolean}>}) => {
      const applet = state.apps.find((a) => a.packageName === packageName)
      if (!applet) return
      if (applet.loading) return

      if (applet.running) {
        setIsServerConfirmed(true)
        setAppStartFailed(false)
        return
      }

      if (Date.now() - mountedAt < MOUNT_GRACE_MS) return

      const connState = useConnectionStore.getState()
      if (connState.status !== WebSocketStatus.CONNECTED) return
      const lastConnectedAt = connState.lastConnectedAt?.getTime() ?? 0
      if (lastConnectedAt && Date.now() - lastConnectedAt < POST_RECONNECT_GRACE_MS) return

      setAppStartFailed(true)
    }

    checkApplet(useAppStatusStore.getState())

    const unsubApplets = useAppStatusStore.subscribe(checkApplet)
    const unsubConn = useConnectionStore.subscribe(() => {
      checkApplet(useAppStatusStore.getState())
    })
    // Re-run once the mount grace expires so a failure that latched silently
    // during the grace gets re-evaluated.
    const graceTimer = setTimeout(() => {
      checkApplet(useAppStatusStore.getState())
    }, MOUNT_GRACE_MS + 50)
    return () => {
      unsubApplets()
      unsubConn()
      clearTimeout(graceTimer)
    }
  }, [packageName, isLocal])

  // Fade in webview once both conditions are met
  useEffect(() => {
    if (isWebViewReady) {
      webViewOpacity.value = withTiming(1, {duration: 200})
      loadingOpacity.value = withTiming(0, {duration: 400})
    }
  }, [isWebViewReady])

  useEffect(() => {
    // Local miniapps don't need token generation — use the URL directly.
    if (isLocal) {
      if (webviewURL) {
        setFinalUrl(webviewURL as string)
        console.log(`WEBVIEW: local miniapp URL: ${webviewURL}`)
      } else {
        setTokenError("Webview URL is missing.")
      }
      return
    }

    const generateTokenAndSetUrl = async () => {
      console.log("WEBVIEW: generateTokenAndSetUrl()")
      setIsLoadingToken(true)
      setTokenError(null)

      if (!packageName) {
        setTokenError("App package name is missing. Cannot authenticate.")
        setIsLoadingToken(false)
        return
      }
      if (!webviewURL) {
        setTokenError("Webview URL is missing.")
        setIsLoadingToken(false)
        return
      }

      let res = await restComms.generateWebviewToken(packageName)
      if (res.is_error()) {
        console.error("Error generating webview token:", res.error)
        setTokenError(`Couldn't securely connect to ${appName}. Please try again.`)
        setIsLoadingToken(false)
        return
      }

      let tempToken = res.value

      res = await restComms.generateWebviewToken(packageName, "generate-webview-signed-user-token")
      if (res.is_error()) {
        console.warn("Failed to generate signed user token:", res.error)
      }
      let signedUserToken: string = res.value_or("")

      const cloudApiUrl = useSettingsStore.getState().getRestUrl()

      const url = new URL(webviewURL)
      url.searchParams.set("aos_temp_token", tempToken)
      if (signedUserToken) {
        url.searchParams.set("aos_signed_user_token", signedUserToken)
      }
      if (cloudApiUrl) {
        res = await restComms.hashWithApiKey(cloudApiUrl, packageName)
        if (res.is_error()) {
          console.error("Error hashing cloud API URL:", res.error)
          setIsLoadingToken(false)
          return
        }
        const checksum = res.value
        url.searchParams.set("cloudApiUrl", cloudApiUrl)
        url.searchParams.set("cloudApiUrlChecksum", checksum)
      }

      setFinalUrl(url.toString())
      console.log(`Constructed final webview URL: ${url.toString()}`)

      setIsLoadingToken(false)
    }

    generateTokenAndSetUrl()
  }, [packageName, webviewURL, appName, retryTrigger, isLocal])

  // Register with MiniComms for bridge messaging
  useEffect(() => {
    const sendToWebView = (message: string) => {
      if (webViewRef.current) {
        webViewRef.current.injectJavaScript(`
          window.receiveNativeMessage(${message});
        `)
      }
    }
    miniComms.setWebViewMessageHandler(packageName, sendToWebView)
    return () => {
      miniComms.setWebViewMessageHandler(packageName, undefined)
    }
  }, [packageName])

  // Push color scheme changes into the WebView so miniapps using
  // useColorScheme() can react. Skipped until the WebView has loaded.
  useEffect(() => {
    if (!webViewRef.current || !isWebViewLoaded) return
    const envelope = JSON.stringify({
      payload: {type: "miniapp_color_scheme_change", colorScheme},
    })
    try {
      webViewRef.current.injectJavaScript(
        `window.dispatchEvent(new MessageEvent('message', {data: ${JSON.stringify(envelope)}})); true;`,
      )
    } catch {
      // noop
    }
  }, [colorScheme, isWebViewLoaded])

  const handleWebViewMessage = (event: any) => {
    // Cloud app webviews don't send miniapp SDK envelopes.
    // Local miniapp WebViews are routed through MiniappHost → LocalMiniappRuntime.
    const _data = event.nativeEvent.data
  }

  const handleLoadStart = () => {
    // android tries to load the webview twice for some reason, and this does nothning so it's safe to disable:
    console.log("WEBVIEW: handleLoadStart()")
    // Reset states when starting to load
    // setIsWebViewReady(false)
    // webViewOpacity.value = 0
    // loadingOpacity.value = 1
  }

  const handleLoadEnd = () => {
    console.log("WEBVIEW: handleLoadEnd()")
    setHasError(false)
    setIsWebViewLoaded(true)
    setIsLoadingToken(false)
  }

  const handleError = (syntheticEvent: any) => {
    console.log("WEBVIEW: handleError()")
    const {nativeEvent} = syntheticEvent
    console.warn("WebView error: ", nativeEvent)
    setHasError(true)

    const errorDesc = nativeEvent.description || ""
    let friendlyMessage = `Unable to load ${appName}`

    if (
      errorDesc.includes("ERR_INTERNET_DISCONNECTED") ||
      errorDesc.includes("ERR_NETWORK_CHANGED") ||
      errorDesc.includes("ERR_CONNECTION_FAILED") ||
      errorDesc.includes("ERR_NAME_NOT_RESOLVED")
    ) {
      friendlyMessage = "No internet connection. Please check your network settings and try again."
    } else if (errorDesc.includes("ERR_CONNECTION_TIMED_OUT") || errorDesc.includes("ERR_TIMED_OUT")) {
      friendlyMessage = "Connection timed out. Please check your internet connection and try again."
    } else if (errorDesc.includes("ERR_CONNECTION_REFUSED")) {
      friendlyMessage = `Unable to connect to ${appName}. Please try again later.`
    } else if (errorDesc.includes("ERR_SSL") || errorDesc.includes("ERR_CERT")) {
      friendlyMessage = "Security error. Please check your device's date and time settings."
    } else if (errorDesc) {
      friendlyMessage = `Unable to load ${appName}. Please try again.`
    }

    setTokenError(friendlyMessage)
  }

  // const screenshotComponent = () => {
  //   const screenshot = useAppStatusStore.getState().apps.find((a) => a.packageName === packageName)?.screenshot
  //   if (screenshot) {
  //     return <Image source={{uri: screenshot}} style={{flex: 1, resizeMode: "cover"}} blurRadius={10} />
  //   }
  //   return null
  // }

  const renderLoadingOverlay = () => {
    const app = useAppStatusStore.getState().apps.find((a) => a.packageName === packageName)

    // disabled for now:
    // const screenshot = screenshotComponent()
    // if (screenshot) {
    //   return (
    //     <Animated.View
    //       className="absolute top-0 left-0 right-0 bottom-0 z-10"
    //       style={[loadingAnimatedStyle]}
    //       pointerEvents={isWebViewReady ? "none" : "auto"}>
    //       {screenshot}
    //     </Animated.View>
    //   )
    // }

    if (!app) {
      return (
        <Animated.View
          className="absolute top-0 left-0 right-0 bottom-0 z-10"
          style={[loadingAnimatedStyle]}
          pointerEvents={isWebViewReady ? "none" : "auto"}>
          <LoadingOverlay message={`Loading ${appName}...`} />
        </Animated.View>
      )
    }

    // force loading to false for the app icon:
    let appCopy = {...app, loading: false}

    return (
      <Animated.View
        className="absolute top-0 left-0 right-0 bottom-0 z-10"
        style={[loadingAnimatedStyle]}
        pointerEvents={isWebViewReady ? "none" : "auto"}>
        {/* show the app icon and app name */}
        <View className="flex-1 flex-row items-center justify-center">
          <View className="flex-col">
            <AppIcon app={appCopy} className="w-32 h-32" />
            {/* <Text text={appName} className="text-foreground text-2xl font-medium text-center" numberOfLines={1} /> */}
          </View>
        </View>
      </Animated.View>
    )
  }

  // Show error screen if: server-side start failed, token generation failed, or webview failed to load
  const showError = appStartFailed || (tokenError && !isLoadingToken) || hasError
  const errorMessage = appStartFailed
    ? `${appName} couldn't be started. The miniapp may be temporarily unavailable.`
    : tokenError || `Unable to load ${appName}. Please check your connection and try again.`

  if (showError) {
    return (
      <>
        <Screen preset="fixed" safeAreaEdges={["top"]} className="px-0">
          <MiniappErrorScreen
            packageName={packageName}
            appName={appName}
            message={errorMessage}
            onRetry={() => {
              setAppStartFailed(false)
              setHasError(false)
              setTokenError(null)
              setFinalUrl(null)
              setIsWebViewLoaded(false)
              setIsServerConfirmed(false)
              webViewOpacity.value = 0
              loadingOpacity.value = 1
              // Re-send the start request and poll for confirmation
              void miniappCatalog.retryStart(packageName as string)
              setRetryTrigger((prev) => prev + 1)
            }}
          />
        </Screen>
      </>
    )
  }

  // Build the window.MentraOS globals (safeAreaInsets, capsuleMenu, etc.) via
  // the shared util so cloud and local miniapps see identical shapes.
  const miniappGlobalsScript = buildMiniappGlobalsScript({
    packageName: packageName as string,
    miniappLocal: isLocal,
    safeAreaInsets: {
      top: insets.top,
      bottom: Platform.OS === "android" ? insets.bottom : 0,
      left: insets.left,
      right: insets.right,
    },
    colorScheme,
  })

  return (
    <Screen
      preset="fixed"
      safeAreaEdges={Platform.OS === "android" ? ["top", "bottom"] : ["top"]}
      KeyboardAvoidingViewProps={{enabled: false}}
      className="px-0"
      ref={viewShotRef}>
      {/* rainbow bars for debugging insets / screenshots */}
      {/* <View className="flex-1 absolute inset-0 z-10">
          <View className="flex-col">
            <View className="w-full h-2 bg-red-500" />
            <View className="w-full h-2 bg-green-500" />
            <View className="w-full h-2 bg-blue-500" />
            <View className="w-full h-2 bg-yellow-500" />
            <View className="w-full h-2 bg-purple-500" />
            <View className="w-full h-2 bg-orange-500" />
            <View className="w-full h-2 bg-pink-500" />
            <View className="w-full h-2 bg-gray-500" />
            <View className="w-full h-2 bg-teal-500" />
            <View className="w-full h-2 bg-indigo-500" />
          </View>
        </View>
        <View className="absolute bottom-0 left-0 right-0 z-10">
          <View className="flex-col">
            <View className="w-full h-2 bg-yellow-500" />
            <View className="w-full h-2 bg-purple-500" />
            <View className="w-full h-2 bg-orange-500" />
            <View className="w-full h-2 bg-pink-500" />
            <View className="w-full h-2 bg-gray-500" />
            <View className="w-full h-2 bg-teal-500" />
            <View className="w-full h-2 bg-indigo-500" />
            <View className="w-full h-2 bg-blue-500" />
            <View className="w-full h-2 bg-green-500" />
            <View className="w-full h-2 bg-red-500" />
          </View>
        </View> */}
      <View className="flex-1">
        {renderLoadingOverlay()}
        {finalUrl && (
          <Animated.View className="flex-1" style={[webViewAnimatedStyle]}>
            <WebView
              ref={webViewRef}
              source={{uri: finalUrl}}
              style={{flex: 1}}
              onLoadStart={handleLoadStart}
              onLoadEnd={handleLoadEnd}
              onError={handleError}
              onMessage={handleWebViewMessage}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              startInLoadingState={false}
              allowsInlineMediaPlayback={true}
              mediaPlaybackRequiresUserAction={false}
              scalesPageToFit={false}
              scrollEnabled={true}
              bounces={false}
              allowsBackForwardNavigationGestures={true}
              onNavigationStateChange={(navState) => setWebViewCanGoBack(navState.canGoBack)}
              automaticallyAdjustContentInsets={false}
              contentInsetAdjustmentBehavior="never"
              injectedJavaScriptBeforeContentLoaded={miniappGlobalsScript}
              injectedJavaScript={`
                  const meta = document.createElement('meta');
                  meta.setAttribute('name', 'viewport');
                  meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
                  document.getElementsByTagName('head')[0].appendChild(meta);
                  true;
                `}
            />
          </Animated.View>
        )}
      </View>
    </Screen>
  )
}
