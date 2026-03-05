import {SplashVideo} from "@/components/splash/SplashVideo"
import {Screen} from "@/components/ignite"
import {useCallback, useEffect, useRef} from "react"
import {useFocusEffect, useLocalSearchParams} from "expo-router"
import {BackgroundTimer} from "@/utils/timers"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import * as WebBrowser from "expo-web-browser"
import {AppState} from "react-native"

export default function WebSplash() {
  const {goBack} = useNavigationHistory()
  const {url} = useLocalSearchParams()
  const timerRef = useRef<number | null>(null)

  // goBack() if we stay on this screen for more than 1 second:
  //   useFocusEffect(
  //     useCallback(() => {
  //       const timeout = BackgroundTimer.setTimeout(() => {
  //         goBack()
  //       }, 2000)
  //       return () => BackgroundTimer.clearTimeout(timeout)
  //     }, [goBack]),
  //   )

  useEffect(() => {
    console.log("WebSplash: url", url)
    const openBrowser = async () => {
      if (url) {
        await WebBrowser.openBrowserAsync(url as string)
      }
    }
    openBrowser()
  }, [url])

  // Add a listener for app state changes to detect when the app comes back from background
  useEffect(() => {
    const handleAppStateChange = async (nextAppState: any) => {
      console.log("RECONNECT: App state changed to:", nextAppState)
      // If app comes back to foreground, hide the loading overlay
      if (nextAppState === "active") {
        if (timerRef.current) {
          BackgroundTimer.clearTimeout(timerRef.current)
          timerRef.current = null
        }
        // goBack() if we stay on this screen for more than 1.5 seconds:
        timerRef.current = BackgroundTimer.setTimeout(() => {
          goBack()
        }, 1500)
      }
    }

    // Subscribe to app state changes
    const appStateSubscription = AppState.addEventListener("change", handleAppStateChange)

    return () => {
      appStateSubscription.remove()
      // clear the timeout if it's still set:
      if (timerRef.current) {
        BackgroundTimer.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  return (
    <Screen preset="fixed">
      <SplashVideo />
    </Screen>
  )
}
