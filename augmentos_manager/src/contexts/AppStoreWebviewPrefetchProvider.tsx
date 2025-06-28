import React, {createContext, useContext, useEffect, useRef, useState} from "react"
import {WebView} from "react-native-webview"
import Constants from "expo-constants"
import BackendServerComms from "../backend_comms/BackendServerComms"
import {View} from "react-native"
import {useAppTheme} from "@/utils/useAppTheme"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

const STORE_PACKAGE_NAME = "org.augmentos.store"

interface AppStoreWebviewPrefetchContextType {
  appStoreUrl: string
  webviewLoading: boolean
  webViewRef: React.RefObject<WebView>
  reloadWebview: () => void
}

const AppStoreWebviewPrefetchContext = createContext<AppStoreWebviewPrefetchContextType | undefined>(undefined)

export const useAppStoreWebviewPrefetch = () => {
  const ctx = useContext(AppStoreWebviewPrefetchContext)
  if (!ctx) throw new Error("useAppStoreWebviewPrefetch must be used within AppStoreWebviewPrefetchProvider")
  return ctx
}

export const AppStoreWebviewPrefetchProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [appStoreUrl, setAppStoreUrl] = useState("")
  const [webviewLoading, setWebviewLoading] = useState(true)
  const webViewRef = useRef<WebView>(null)
  const {theme} = useAppTheme()

  // Prefetch logic
  const prefetchWebview = async () => {
    setWebviewLoading(true)

    try {
      const baseUrl = Constants.expoConfig?.extra?.MENTRAOS_APPSTORE_URL
      const backendComms = BackendServerComms.getInstance()
      const url = new URL(baseUrl)
      url.searchParams.set("theme", theme.isDark ? "dark" : "light")

      // Check if core token exists before trying to generate webview tokens
      if (!backendComms.getCoreToken()) {
        console.log("AppStoreWebviewPrefetchProvider: No core token available, skipping token generation")
        setAppStoreUrl(url.toString())
        return
      }

      console.log("AppStoreWebviewPrefetchProvider: Generating webview tokens")
      const tempToken = await backendComms.generateWebviewToken(STORE_PACKAGE_NAME)
      console.log("AppStoreWebviewPrefetchProvider: Temp token generated successfully")

      let signedUserToken: string | undefined
      try {
        signedUserToken = await backendComms.generateWebviewToken(
          STORE_PACKAGE_NAME,
          "generate-webview-signed-user-token",
        )
        console.log("AppStoreWebviewPrefetchProvider: Signed user token generated successfully")
      } catch (error) {
        console.warn("AppStoreWebviewPrefetchProvider: Failed to generate signed user token:", error)
        signedUserToken = undefined
      }

      url.searchParams.set("aos_temp_token", tempToken)
      if (signedUserToken) {
        url.searchParams.set("aos_signed_user_token", signedUserToken)
      }

      console.log("AppStoreWebviewPrefetchProvider: Final URL ready with tokens")
      setAppStoreUrl(url.toString())
    } catch (error) {
      console.error("AppStoreWebviewPrefetchProvider: Error during prefetch:", error)
      // fallback to base URL
      const baseUrl = Constants.expoConfig?.extra?.MENTRAOS_APPSTORE_URL
      const url = new URL(baseUrl)
      url.searchParams.set("theme", theme.isDark ? "dark" : "light")
      setAppStoreUrl(url.toString())
    } finally {
      setWebviewLoading(false)
    }
  }

  useEffect(() => {
    // Check if we already have a core token
    const backendComms = BackendServerComms.getInstance()
    if (backendComms.getCoreToken()) {
      prefetchWebview().catch(error => {
        console.error("AppStoreWebviewPrefetchProvider: Error during initial prefetch:", error)
      })
    }

    // Listen for when core token is set
    const handleCoreTokenSet = () => {
      console.log("AppStoreWebviewPrefetchProvider: Core token set, prefetching webview")
      prefetchWebview().catch(error => {
        console.error("AppStoreWebviewPrefetchProvider: Error during core token prefetch:", error)
      })
    }

    GlobalEventEmitter.on("CORE_TOKEN_SET", handleCoreTokenSet)

    return () => {
      GlobalEventEmitter.removeListener("CORE_TOKEN_SET", handleCoreTokenSet)
    }
  }, [theme.isDark]) // Re-run when theme changes

  // Listen for logout events to clear WebView data
  useEffect(() => {
    const handleClearWebViewData = () => {
      console.log("AppStoreWebviewPrefetchProvider: Clearing WebView data on logout")

      // Clear WebView cache and data
      if (webViewRef.current) {
        webViewRef.current.clearCache?.(true)
        webViewRef.current.clearFormData?.()
        webViewRef.current.clearHistory?.()
      }

      // Reset the URL state to force fresh token generation
      setAppStoreUrl("")

      // Reload with fresh tokens after clearing
      setTimeout(() => {
        prefetchWebview().catch(error => {
          console.error("AppStoreWebviewPrefetchProvider: Error during clear webview data prefetch:", error)
        })
      }, 100)
    }

    GlobalEventEmitter.on("CLEAR_WEBVIEW_DATA", handleClearWebViewData)

    return () => {
      GlobalEventEmitter.removeListener("CLEAR_WEBVIEW_DATA", handleClearWebViewData)
    }
  }, [])

  // Expose a reload method (e.g., for logout/login)
  const reloadWebview = () => {
    prefetchWebview().catch(error => {
      console.error("AppStoreWebviewPrefetchProvider: Error during reload webview:", error)
    })
  }

  return (
    <AppStoreWebviewPrefetchContext.Provider value={{appStoreUrl, webviewLoading, webViewRef, reloadWebview}}>
      {/* Hidden WebView for prefetching */}
      {appStoreUrl ? (
        <View style={{width: 0, height: 0, position: "absolute", opacity: 0}} pointerEvents="none">
          <WebView
            ref={webViewRef}
            source={{uri: appStoreUrl}}
            style={{width: 0, height: 0}}
            onLoadStart={() => setWebviewLoading(true)}
            onLoadEnd={() => setWebviewLoading(false)}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            startInLoadingState={false}
            scalesPageToFit={false}
            injectedJavaScript={`
              const meta = document.createElement('meta');
              meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
              meta.setAttribute('name', 'viewport');
              document.getElementsByTagName('head')[0].appendChild(meta);
              true;
            `}
          />
        </View>
      ) : null}
      {children}
    </AppStoreWebviewPrefetchContext.Provider>
  )
}
