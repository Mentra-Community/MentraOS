import React, {useRef, useState, useEffect} from "react"
import {View, StyleSheet, Text} from "react-native"
import {WebView} from "react-native-webview"
import LoadingOverlay from "@/components/misc/LoadingOverlay"
import InternetConnectionFallbackComponent from "@/components/misc/InternetConnectionFallbackComponent"
import {SafeAreaView} from "react-native-safe-area-context"
import FontAwesome from "react-native-vector-icons/FontAwesome"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"
import {router, useLocalSearchParams} from "expo-router"
import {Header, Screen} from "@/components/ignite"

export default function AppWebView() {
  //   const webviewURL = route.params?.webviewURL;
  //   const appName = route.params?.appName || 'App';
  //   const packageName = route.params?.packageName;
  //   const fromSettings = route.params?.fromSettings === true;
  const {themed, theme} = useAppTheme()
  const {webviewURL, appName, packageName, fromSettings} = useLocalSearchParams()
  const isFromSettings = fromSettings === "true"
  const [isLoading, setIsLoading] = useState(true) // For WebView loading itself
  const [hasError, setHasError] = useState(false)
  const webViewRef = useRef<WebView>(null)

  const [finalUrl, setFinalUrl] = useState<string | null>(null)
  const [isLoadingToken, setIsLoadingToken] = useState(true)
  const [tokenError, setTokenError] = useState<string | null>(null)

  if (typeof webviewURL !== "string" || typeof appName !== "string" || typeof packageName !== "string") {
    return <Text>Missing required parameters</Text>
  }

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

  function determineCloudUrl(): string | undefined {
    const cloudHostName =
      process.env.CLOUD_PUBLIC_HOST_NAME || process.env.CLOUD_HOST_NAME || process.env.MENTRAOS_HOST
    if (
      cloudHostName &&
      cloudHostName.trim() !== "prod.mentra.glass" &&
      cloudHostName.trim() !== "cloud" &&
      cloudHostName.includes(".")
    ) {
      console.log(`For TPA webview token verification, using cloud host name: ${cloudHostName}`)
      return `https://${cloudHostName}`
    }
    return undefined
  }

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

      try {
        const backendComms = BackendServerComms.getInstance()
        const tempToken = await backendComms.generateWebviewToken(packageName)
        let signedUserToken: string | undefined
        try {
          signedUserToken = await backendComms.generateWebviewToken(packageName, "generate-webview-signed-user-token")
        } catch (error) {
          console.warn("Failed to generate signed user token:", error)
          signedUserToken = undefined
        }
        const cloudApiUrl = determineCloudUrl()

        // Construct final URL
        const url = new URL(webviewURL)
        url.searchParams.set("aos_temp_token", tempToken)
        if (signedUserToken) {
          url.searchParams.set("aos_signed_user_token", signedUserToken)
        }
        if (cloudApiUrl) {
          const checksum = await backendComms.hashWithApiKey(cloudApiUrl, packageName)
          url.searchParams.set("cloudApiUrl", cloudApiUrl)
          url.searchParams.set("cloudApiUrlChecksum", checksum)
        }

        setFinalUrl(url.toString())
        console.log(`Constructed final webview URL: ${url.toString()}`)
      } catch (error: any) {
        console.error("Error generating webview token:", error)
        setTokenError(`Failed to prepare secure access: ${error.message}`)
        showAlert(
          "Authentication Error",
          `Could not securely connect to ${appName}. Please try again later. Details: ${error.message}`,
          [{text: "OK", onPress: () => router.back()}], // Option to go back
        )
      } finally {
        setIsLoadingToken(false)
      }
    }

    generateTokenAndSetUrl()
  }, [packageName, webviewURL, appName]) // Dependencies

  // Handle WebView loading events
  const handleLoadStart = () => setIsLoading(true)
  const handleLoadEnd = () => setIsLoading(false)
  const handleError = (syntheticEvent: any) => {
    // Use any for syntheticEvent
    const {nativeEvent} = syntheticEvent
    console.warn("WebView error: ", nativeEvent)
    setIsLoading(false)
    setHasError(true)
    setTokenError(`Failed to load ${appName}: ${nativeEvent.description}`) // Show WebView load error
  }

  // Render loading state while fetching token
  if (isLoadingToken) {
    return (
      <View style={[styles.container, {backgroundColor: theme.backgroundColor}]}>
        <LoadingOverlay message={`Preparing secure access to ${appName}...`} />
      </View>
    )
  }

  // Render error state if token generation failed
  if (tokenError) {
    return (
      <View style={[styles.container, {backgroundColor: theme2.backgroundColor}]}>
        <InternetConnectionFallbackComponent
          retry={() => {
            /* Implement retry logic if desired, e.g., refetch token */
          }}
        />
        <Text style={[styles.errorText, {color: theme2.textColor}]}>{tokenError}</Text>
      </View>
    )
  }

  // Render error state if WebView loading failed after token success
  if (hasError) {
    return (
      <View style={[styles.container, {backgroundColor: theme2.backgroundColor}]}>
        <InternetConnectionFallbackComponent
          retry={() => {
            setHasError(false)
            // Optionally re-trigger token generation or just reload
            if (webViewRef.current) {
              webViewRef.current.reload()
            }
          }}
        />
        <Text style={[styles.errorText, {color: theme2.textColor}]}>{tokenError || `Failed to load ${appName}`}</Text>
      </View>
    )
  }

  // Render WebView only when finalUrl is ready
  return (
    // <Screen preset="auto" style={{paddingHorizontal: theme.spacing.md}}>
    <View style={{flex: 1}}>
      <Header
        title={appName}
        titleMode="center"
        leftIcon="caretLeft"
        style={{paddingLeft: 16}}
        onLeftPress={() => router.back()}
        rightIcon="settings"
        rightIconColor={theme.colors.icon}
        onRightPress={() => {
          router.replace({
            pathname: "/tpa/settings",
            params: {
              packageName: packageName as string,
              appName: appName as string,
              fromWebView: "true",
            },
          })
        }}
      />
      <View style={styles.container}>
        {finalUrl ? (
          <WebView
            ref={webViewRef}
            source={{uri: finalUrl}} // Use the final URL with the token
            style={styles.webView}
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
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  errorText: {
    marginTop: -40,
    paddingHorizontal: 20,
    textAlign: "center",
  },
  webView: {
    flex: 1,
  },
})
