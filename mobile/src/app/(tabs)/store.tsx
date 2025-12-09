import {useFocusEffect} from "@react-navigation/native"
import {useLocalSearchParams} from "expo-router"
import {useState, useCallback, useMemo, useEffect} from "react"
import {View, ViewStyle, ActivityIndicator, BackHandler, TextStyle} from "react-native"
import {WebView} from "react-native-webview"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Text, Screen, Header} from "@/components/ignite"
import InternetConnectionFallbackComponent from "@/components/misc/InternetConnectionFallbackComponent"
import {useAppStoreWebviewPrefetch} from "@/contexts/AppStoreWebviewPrefetchProvider"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useRefreshApplets} from "@/stores/applets"
import {$styles, ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export default function AppStoreWeb() {
  const [_webviewLoading, setWebviewLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")
  const {packageName} = useLocalSearchParams()
  const [canGoBack, setCanGoBack] = useState(false)
  const [isAuthReady, setIsAuthReady] = useState(false)
  const {push} = useNavigationHistory()
  const {appStoreUrl, webViewRef: prefetchedWebviewRef} = useAppStoreWebviewPrefetch()
  const refreshApplets = useRefreshApplets()
  const {theme, themed} = useAppTheme()

  // Construct the final URL with packageName if provided
  const finalUrl = useMemo(() => {
    if (!appStoreUrl) return null

    const url = new URL(appStoreUrl)
    console.log("AppStoreWeb: appStoreUrl", appStoreUrl)
    console.log("AppStoreWeb: packageName", packageName)
    if (packageName && typeof packageName === "string") {
      // If packageName is provided, update the path to point to the app details page
      url.pathname = `/package/${packageName}`
    }
    url.searchParams.set("theme", theme.isDark ? "dark" : "light")
    console.log("AppStoreWeb: finalUrl", url.toString())
    return url.toString()
  }, [appStoreUrl, packageName])

  // Reset auth ready state when URL changes (e.g., new tokens, theme change)
  useEffect(() => {
    setIsAuthReady(false)
  }, [finalUrl])

  const handleError = (syntheticEvent: any) => {
    const {nativeEvent} = syntheticEvent
    console.error("WebView error:", nativeEvent)
    setWebviewLoading(false)
    setHasError(true)

    // Parse error message to show user-friendly text
    const errorDesc = nativeEvent.description || ""
    let friendlyMessage = "Unable to load the App Store"

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
      friendlyMessage = "Unable to connect to the App Store server. Please try again later."
    } else if (errorDesc.includes("ERR_SSL") || errorDesc.includes("ERR_CERT")) {
      friendlyMessage = "Security error. Please check your device's date and time settings."
    } else if (errorDesc) {
      // For any other errors, just show a generic message without the technical error
      friendlyMessage = "Unable to load the App Store. Please try again."
    }

    setErrorMessage(friendlyMessage)
  }

  const handleRetry = () => {
    setHasError(false)
    setErrorMessage("")
    if (prefetchedWebviewRef.current) {
      prefetchedWebviewRef.current.reload()
    }
  }

  // Handle messages from WebView
  const handleWebViewMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data)

      // Handle auth ready message from store - hides loading overlay
      if (data.type === "AUTH_READY") {
        console.log("AppStoreWeb: Received AUTH_READY from store")
        setIsAuthReady(true)
        return
      }

      if ((data.type === "OPEN_APP_SETTINGS" || data.type === "OPEN_TPA_SETTINGS") && data.packageName) {
        // Navigate to TPA settings page
        push("/applet/settings", {packageName: data.packageName})
      }
    } catch (error) {
      console.error("Error handling WebView message:", error)
    }
  }

  // Handle Android back button press
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        if (prefetchedWebviewRef.current && canGoBack) {
          prefetchedWebviewRef.current.goBack()
          return true // Prevent default back action
        }
        return false // Allow default back action (close screen)
      }

      const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress)

      return () => subscription.remove() // Cleanup listener on blur
    }, [canGoBack, prefetchedWebviewRef]), // Re-run effect if canGoBack or ref changes
  )

  // propagate any changes in app lists when this screen is unmounted:
  useFocusEffect(
    useCallback(() => {
      return async () => {
        await refreshApplets()
      }
    }, []),
  )

  // Show loading state while getting the URL
  if (!finalUrl) {
    return (
      <Screen preset="fixed" style={themed($styles.screen)}>
        <Header leftTx="store:title" RightActionComponent={<MentraLogoStandalone />} />
        <View style={[themed($loadingContainer), {marginHorizontal: -theme.spacing.s4}]}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text text="Preparing App Store..." style={themed($loadingText)} />
        </View>
      </Screen>
    )
  }

  if (hasError) {
    return (
      <Screen preset="fixed" style={themed($styles.screen)}>
        <Header leftTx="store:title" RightActionComponent={<MentraLogoStandalone />} />
        <InternetConnectionFallbackComponent
          retry={handleRetry}
          message={errorMessage || "Unable to load the App Store. Please check your connection and try again."}
        />
      </Screen>
    )
  }

  // If the prefetched WebView is ready, show it in the correct style
  return (
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Header leftTx="store:title" RightActionComponent={<MentraLogoStandalone />} />
      <View style={[themed($webViewContainer), {marginHorizontal: -theme.spacing.s6}]}>
        {/* Show the prefetched WebView, but now visible and full size */}
        <WebView
          ref={prefetchedWebviewRef}
          source={{uri: finalUrl}}
          style={themed($webView)}
          onLoadStart={() => setWebviewLoading(true)}
          onLoadEnd={() => {
            setWebviewLoading(false)
            setIsAuthReady(true)
          }}
          onError={handleError}
          onNavigationStateChange={navState => setCanGoBack(navState.canGoBack)}
          onMessage={handleWebViewMessage}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={false}
          scalesPageToFit={false}
          bounces={false}
          scrollEnabled={true}
        />
        {/* Loading overlay - stays visible until store confirms auth ready */}
        {!isAuthReady && (
          <View style={themed($loadingOverlay)}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text text="Loading App Store..." style={themed($loadingText)} />
          </View>
        )}
      </View>
    </Screen>
  )
}

// Themed styles using ThemedStyle pattern
const $loadingContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: colors.background,
})

const $loadingOverlay: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  backgroundColor: "rgba(0, 0, 0, 0.3)",
  bottom: 0,
  justifyContent: "center",
  left: 0,
  position: "absolute",
  right: 0,
  top: 0,
})

const $loadingText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: spacing.s4,
  marginTop: 10,
  color: colors.text,
})

const $webView: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  backgroundColor: colors.background,
})

const $webViewContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  backgroundColor: colors.background,
})
