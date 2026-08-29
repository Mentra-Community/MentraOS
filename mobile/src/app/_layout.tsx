import "react-native-get-random-values" // Must be first - required for tweetnacl crypto (UDP encryption)
import "@/utils/polyfills/event" // Must be before any livekit imports
// import {registerGlobals} from "@livekit/react-native-webrtc"
import * as Sentry from "@sentry/react-native"
import {useFonts} from "expo-font"
import {useNavigationContainerRef} from "expo-router"
import * as SplashScreen from "expo-splash-screen"
import {useEffect, useState} from "react"
import {Platform} from "react-native"

import {SentryNavigationIntegration, SentrySetup} from "@/effects/SentrySetup"
import {initI18n} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {engine} from "@mentra/engine"
import {customFontsToLoad} from "@/theme"
import {loadDateFnsLocale} from "@/utils/formatDate"
import {AllEffects} from "@/effects/AllEffects"
import {AllProviders} from "@/contexts/AllProviders"
import "@/global.css"
import {logBuffer} from "@mentra/engine-host-internal"

SentrySetup()
logBuffer.startConsoleInterception()

// initialize the settings store
engine.settings.loadAll()

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync()
// Android: hard cut from the OS splash to the app (no fade). iOS keeps the fade.
SplashScreen.setOptions({
  duration: Platform.OS === "android" ? 0 : 1000,
  fade: Platform.OS !== "android",
})

// The Bluetooth foreground service keeps this JS runtime alive when the user
// fully closes the app, so reopening remounts a fresh React tree on the same
// runtime instead of cold-starting. expo-router's module-level router store
// survives with the runtime, and on Android it then restores the previous
// session's navigation state instead of booting through "/" — skipping the
// InitScreen boot flow entirely and stranding the app on the loading screen.
// Track whether a previous root tree unmounted so the next one can detect the
// warm relaunch and re-enter the normal boot route.
let previousRootUnmounted = false

function Root() {
  const [_fontsLoaded, fontError] = useFonts(customFontsToLoad)
  const [loaded, setLoaded] = useState(false)

  const loadAssets = async () => {
    try {
      await initI18n()
      await loadDateFnsLocale()
      // initialize webrtc
      // await registerGlobals()
    } catch (error) {
      console.error("Error loading assets:", error)
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    loadAssets()
  }, [])

  useEffect(() => {
    if (fontError) throw fontError
  }, [fontError])

  useEffect(() => {
    return () => {
      previousRootUnmounted = true
    }
  }, [])

  // Runs after the Stack subtree has mounted (child effects run first), so the
  // navigator is registered and can handle the dispatch.
  useEffect(() => {
    if (!loaded || !previousRootUnmounted) return
    previousRootUnmounted = false
    console.log("ROOT: warm relaunch on a live JS runtime — rebooting through /")
    useNavigationStore.getState().replaceAll("/")
  }, [loaded])

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync()
    }
  }, [loaded])

  const ref = useNavigationContainerRef()
  useEffect(() => {
    if (ref) {
      SentryNavigationIntegration.registerNavigationContainer(ref)
    }
  }, [ref])

  if (!loaded) {
    return null
  }

  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!! ROOT RENDERED !!!!!!!!!!!!!!!!!!!!!!!!!!!!")

  return (
    <AllProviders>
      <AllEffects />
    </AllProviders>
  )
}

export default Sentry.wrap(Root)
