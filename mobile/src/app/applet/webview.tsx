import {useLocalSearchParams, useFocusEffect} from "expo-router"
import {useRef, useState, useEffect, useCallback} from "react"
import {View, BackHandler} from "react-native"
import {WebView} from "react-native-webview"

import {Header, Screen, Text} from "@/components/ignite"
import InternetConnectionFallbackComponent from "@/components/misc/InternetConnectionFallbackComponent"
import LoadingOverlay from "@/components/misc/LoadingOverlay"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import restComms from "@/services/RestComms"
import {useSettingsStore} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"

export default function AppWebView() {
  const {theme, themed} = useAppTheme()
  const {webviewURL, appName, packageName} = useLocalSearchParams()
  const [hasError, setHasError] = useState(false)
  const webViewRef = useRef<WebView>(null)

  const [finalUrl, setFinalUrl] = useState<string | null>(null)
  const [isLoadingToken, setIsLoadingToken] = useState(true)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [retryTrigger, setRetryTrigger] = useState(0) // Trigger for retrying token generation
  const {goBack, push} = useNavigationHistory()

  if (typeof webviewURL !== "string" || typeof appName !== "string" || typeof packageName !== "string") {
    return <Text>Missing required parameters</Text>
  }

  // Handle Android back button
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        // Go back to previous screen
        goBack()
        return true
      }

      const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress)

      return () => subscription.remove()
    }, [goBack]),
  )

  // Set up the header with settings button if we came from app settings
  //   useEffect(() => {
  //     if (fromSettings && packageName) {
  //       navigation.setOptions({
  //         headerRight: () => (
  //           <View style={{ marginRight: 8 }}>
  //             <FontAwesome.Button
  //               name="cog"
  //               size={22}
  //               color={isDarkTheme ? '#FFFFFF' : '#000000'}
  //               backgroundColor="transparent"
  //               underlayColor="transparent"
  //               onPress={() => {
  //                 navigation.replace('AppSettings', {
  //                   packageName,
  //                   appName,
  //                   fromWebView: true
  //                 });
  //               }}
  //               style={{ padding: 0, margin: 0 }}
  //               iconStyle={{ marginRight: 0 }}
  //             />
  //           </View>
  //         )
  //       });
  //     }
  //   }, [fromSettings, packageName, appName]);

  // Theme colors
  const theme2 = {
    backgroundColor: theme.isDark ? "#1c1c1c" : "#f9f9f9",
    headerBg: theme.isDark ? "#333333" : "#fff",
    textColor: theme.isDark ? "#FFFFFF" : "#333333",
    secondaryTextColor: theme.isDark ? "#aaaaaa" : "#777777",
    borderColor: theme.isDark ? "#444444" : "#e0e0e0",
    buttonBg: theme.isDark ? "#444444" : "#eeeeee",
    buttonTextColor: theme.isDark ? "#ffffff" : "#333333",
    primaryColor: theme.colors.palette.primary300,
  }

  // Fetch temporary token on mount
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

      // Construct final URL
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
  }, [packageName, webviewURL, appName, retryTrigger]) // Dependencies

  // Handle WebView loading events
  const handleLoadStart = () => {
    // Called when the WebView starts loading
  }

  const handleLoadEnd = () => {
    setHasError(false)
  }
  const handleError = (syntheticEvent: any) => {
    // Use any for syntheticEvent
    const {nativeEvent} = syntheticEvent
    console.warn("WebView error: ", nativeEvent)
    setHasError(true)

    // Parse error message to show user-friendly text
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
      // For any other errors, just show a generic message without the technical error
      friendlyMessage = `Unable to load ${appName}. Please try again.`
    }

    setTokenError(friendlyMessage)
  }

  // Render loading state while fetching token
  if (isLoadingToken) {
    return (
      <View style={{flex: 1, backgroundColor: theme2.backgroundColor}}>
        <LoadingOverlay message={`Preparing secure access to ${appName}...`} />
      </View>
    )
  }

  // Render error state if token generation failed
  if (tokenError && !isLoadingToken) {
    return (
      <View style={{flex: 1, backgroundColor: theme2.backgroundColor}}>
        <InternetConnectionFallbackComponent
          retry={() => {
            // Reset state and retry token generation
            setTokenError(null)
            setRetryTrigger(prev => prev + 1) // Trigger useEffect to retry
          }}
          message={tokenError}
        />
      </View>
    )
  }

  // Render error state if WebView loading failed after token success
  if (hasError) {
    return (
      <View style={{flex: 1, backgroundColor: theme2.backgroundColor}}>
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

  // Render WebView only when finalUrl is ready
  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <Header
        title={appName}
        titleMode="center"
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        rightIcon="settings"
        rightIconColor={theme.colors.icon}
        onRightPress={() => {
          push("/applet/settings", {
            packageName: packageName as string,
            appName: appName as string,
            fromWebView: "true",
          })
        }}
        // style={{height: 44}}
        // containerStyle={{paddingTop: 0}}
      />
      <View style={{flex: 1, marginHorizontal: -theme.spacing.s6}}>
        {finalUrl ? (
          <WebView
            ref={webViewRef}
            source={{uri: finalUrl}} // Use the final URL with the token
            style={{flex: 1}}
            onLoadStart={handleLoadStart}
            onLoadEnd={handleLoadEnd}
            onError={handleError}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            startInLoadingState={true} // Keep this true for WebView's own loading indicator
            renderLoading={() => (
              // Show loading overlay while WebView itself loads
              <LoadingOverlay message={`Loading ${appName}...`} />
            )}
            // allow inline media playback:
            allowsInlineMediaPlayback={true}
            mediaPlaybackRequiresUserAction={false}
            // Disable zooming and scaling
            scalesPageToFit={false}
            scrollEnabled={true}
            bounces={false}
            // iOS specific props to disable zoom
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            // Inject meta viewport tag to prevent zooming
            injectedJavaScript={`
              const meta = document.createElement('meta');
              meta.setAttribute('name', 'viewport');
              meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
              document.getElementsByTagName('head')[0].appendChild(meta);
              true;
            `}
          />
        ) : (
          // This state should ideally not be reached if isLoadingToken handles it,
          // but added as a fallback.
          <LoadingOverlay message="Preparing..." />
        )}
        {/* Show loading overlay specifically for the WebView loading phase */}
        {/* {isLoading && finalUrl && (
           <LoadingOverlay message={`Loading ${appName}...`} isDarkTheme={isDarkTheme} />
        )} */}
      </View>
    </Screen>
  )
}
