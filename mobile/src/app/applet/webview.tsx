import {useLocalSearchParams} from "expo-router"
import {useRef, useState, useEffect} from "react"
import {View} from "react-native"
import {WebView} from "react-native-webview"
import Animated, {useSharedValue, useAnimatedStyle, withTiming} from "react-native-reanimated"

import {Header, Screen, Text} from "@/components/ignite"
import InternetConnectionFallbackComponent from "@/components/ui/InternetConnectionFallbackComponent"
import LoadingOverlay from "@/components/ui/LoadingOverlay"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import restComms from "@/services/RestComms"
import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"
import {useAppletStatusStore} from "@/stores/applets"
import {MiniAppDualButtonHeader} from "@/components/miniapps/DualButton"
import {Image} from "expo-image"
import AppIcon from "@/components/home/AppIcon"

export default function AppWebView() {
  const {webviewURL, appName, packageName} = useLocalSearchParams()
  const [hasError, setHasError] = useState(false)
  const webViewRef = useRef<WebView>(null)

  const [finalUrl, setFinalUrl] = useState<string | null>(null)
  const [isLoadingToken, setIsLoadingToken] = useState(true)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [retryTrigger, setRetryTrigger] = useState(0)
  const {goBack, push} = useNavigationHistory()
  const viewShotRef = useRef(null)
  const [appSwitcherUi] = useSetting(SETTINGS.app_switcher_ui.key)

  // WebView loading state
  const [isWebViewReady, setIsWebViewReady] = useState(false)
  const webViewOpacity = useSharedValue(0)
  const loadingOpacity = useSharedValue(1)

  const webViewAnimatedStyle = useAnimatedStyle(() => ({
    opacity: webViewOpacity.value,
  }))

  const loadingAnimatedStyle = useAnimatedStyle(() => ({
    opacity: loadingOpacity.value,
  }))

  if (typeof webviewURL !== "string" || typeof appName !== "string" || typeof packageName !== "string") {
    return <Text>Missing required parameters</Text>
  }

  useEffect(() => {
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
        setTokenError(`Failed to prepare secure access: ${res.error.message}`)
        showAlert("Authentication Error", `Could not securely connect to ${appName}. Please try again later.`, [
          {text: "OK", onPress: () => goBack()},
        ])
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
  }, [packageName, webviewURL, appName, retryTrigger])

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
    setIsWebViewReady(true)
    setIsLoadingToken(false)

    // Fade in WebView, fade out loading
    webViewOpacity.value = withTiming(1, {duration: 200})
    loadingOpacity.value = withTiming(0, {duration: 800})
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

  const screenshotComponent = () => {
    const screenshot = useAppletStatusStore.getState().apps.find((a) => a.packageName === packageName)?.screenshot
    if (screenshot) {
      return <Image source={{uri: screenshot}} style={{flex: 1, resizeMode: "cover"}} blurRadius={10} />
    }
    return null
  }

  const renderLoadingOverlay = () => {
    const app = useAppletStatusStore.getState().apps.find((a) => a.packageName === packageName)

    const screenshot = screenshotComponent()
    if (screenshot) {
      return (
        <Animated.View
          className="absolute top-0 left-0 right-0 bottom-0 z-10"
          style={[loadingAnimatedStyle]}
          pointerEvents={isWebViewReady ? "none" : "auto"}>
          {screenshot}
        </Animated.View>
      )
    }

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

    return (
      <Animated.View
        className="absolute top-0 left-0 right-0 bottom-0 z-10"
        style={[loadingAnimatedStyle]}
        pointerEvents={isWebViewReady ? "none" : "auto"}>
        {/* show the app icon and app name */}
        <View className="flex-1 flex-row items-center justify-center">
          <View className="flex-col">
            <AppIcon app={app} className="w-32 h-32" />
            {/* <Text text={appName} className="text-foreground text-2xl font-medium text-center" numberOfLines={1} /> */}
          </View>
        </View>
      </Animated.View>
    )
  }

  if (tokenError && !isLoadingToken) {
    return (
      <View className="flex-1 bg-background">
        <InternetConnectionFallbackComponent
          retry={() => {
            setTokenError(null)
            setRetryTrigger((prev) => prev + 1)
          }}
          message={tokenError}
        />
      </View>
    )
  }

  if (hasError) {
    return (
      <View className="flex-1 bg-background">
        <InternetConnectionFallbackComponent
          retry={() => {
            setHasError(false)
            setTokenError(null)
            if (webViewRef.current) {
              webViewRef.current.reload()
            }
          }}
          message={tokenError || `Unable to load ${appName}. Please check your connection and try again.`}
        />
      </View>
    )
  }

  return (
    <Screen
      preset="fixed"
      safeAreaEdges={[appSwitcherUi && "top"]}
      KeyboardAvoidingViewProps={{enabled: true}}
      ref={viewShotRef}>
      {appSwitcherUi && <MiniAppDualButtonHeader packageName={packageName} viewShotRef={viewShotRef} />}
      {!appSwitcherUi && (
        <Header
          leftIcon="chevron-left"
          onLeftPress={() => goBack()}
          title={appName}
          rightIcon="settings"
          onRightPress={() => {
            push("/applet/settings", {
              packageName: packageName as string,
              appName: appName as string,
              fromWebView: "true",
            })
          }}
        />
      )}
      <View className="flex-1 -mx-6">
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
              javaScriptEnabled={true}
              domStorageEnabled={true}
              startInLoadingState={false}
              allowsInlineMediaPlayback={true}
              mediaPlaybackRequiresUserAction={false}
              scalesPageToFit={false}
              scrollEnabled={true}
              bounces={false}
              automaticallyAdjustContentInsets={false}
              contentInsetAdjustmentBehavior="never"
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
