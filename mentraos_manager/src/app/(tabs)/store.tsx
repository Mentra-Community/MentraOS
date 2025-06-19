import React, {useRef, useState, useCallback, useEffect} from "react"
import {View, StyleSheet, ActivityIndicator, BackHandler} from "react-native"
import {SafeAreaView} from "react-native-safe-area-context"
import {WebView} from "react-native-webview"
import Config from "react-native-config"
import InternetConnectionFallbackComponent from "@/components/misc/InternetConnectionFallbackComponent"
import {RouteProp, useFocusEffect} from "@react-navigation/native"
import {RootStackParamList} from "@/components/misc/types"
import {useAppStatus} from "@/contexts/AppStatusProvider"
import {useAppStoreWebviewPrefetch} from "@/contexts/AppStoreWebviewPrefetchProvider"
import {useAppTheme} from "@/utils/useAppTheme"
import {useLocalSearchParams} from "expo-router"
import {Text} from "@/components/ignite"

// Define package name for the store webview
const STORE_PACKAGE_NAME = "org.mentraos.store"

export default function AppStoreWeb() {
  const [webviewLoading, setWebviewLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  // const packageName = route?.params?.packageName;
  const {packageName} = useLocalSearchParams()
  const [canGoBack, setCanGoBack] = useState(false)
  const {
    appStoreUrl,
    webviewLoading: prefetchedWebviewLoading,
    webViewRef: prefetchedWebviewRef,
  } = useAppStoreWebviewPrefetch()
  const {refreshAppStatus} = useAppStatus()
  const {theme, themed} = useAppTheme()
  const isDarkTheme = theme.isDark

  // Theme colors - using theme system instead of hardcoded values
  const theme2 = {
    backgroundColor: theme.colors.background,
    headerBg: theme.colors.background,
    textColor: theme.colors.text,
    secondaryTextColor: theme.colors.textDim,
    borderColor: theme.colors.border,
    buttonBg: theme.colors.palette.gray200,
    buttonTextColor: theme.colors.text,
    primaryColor: theme.colors.palette.blue500,
  }

  // Handle WebView loading events
  const handleLoadStart = () => setWebviewLoading(true)
  const handleLoadEnd = () => setWebviewLoading(false)
  const handleError = () => {
    setWebviewLoading(false)
    setHasError(true)
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
        await refreshAppStatus()
      }
    }, []),
  )

  // Show loading state while getting the URL
  if (!appStoreUrl) {
    return (
      <View style={[styles.loadingOverlay, {backgroundColor: theme.colors.background}]}>
        <ActivityIndicator size="large" color={theme2.primaryColor} />
        <Text text="Preparing App Store..." style={[styles.loadingText, {color: theme2.textColor}]} />
      </View>
    )
  }

  // If the prefetched WebView is ready, show it in the correct style
  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {hasError ? (
        <InternetConnectionFallbackComponent retry={() => setHasError(false)} />
      ) : (
        <View style={styles.webViewContainer}>
          {/* Show the prefetched WebView, but now visible and full size */}
          <WebView
            ref={prefetchedWebviewRef}
            source={{uri: appStoreUrl}}
            style={styles.webView}
            onLoadStart={() => setWebviewLoading(true)}
            onLoadEnd={() => setWebviewLoading(false)}
            onError={handleError}
            onNavigationStateChange={navState => setCanGoBack(navState.canGoBack)}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            startInLoadingState={true}
            scalesPageToFit={false}
            injectedJavaScript={`
              const meta = document.createElement('meta');
              meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
              meta.setAttribute('name', 'viewport');
              document.getElementsByTagName('head')[0].appendChild(meta);
              true;
            `}
            renderLoading={() => (
              <View style={[styles.loadingOverlay, {backgroundColor: theme.colors.background}]}>
                <ActivityIndicator size="large" color={theme2.primaryColor} />
                <Text text="Loading App Store..." style={[styles.loadingText, {color: theme2.textColor}]} />
              </View>
            )}
          />
        </View>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0, // Keep this overlay as is since it's theme-neutral
  },
  loadingText: {
    fontSize: 16,
    marginTop: 10,
  },
  webView: {
    flex: 1,
  },
  webViewContainer: {
    flex: 1,
  },
})
