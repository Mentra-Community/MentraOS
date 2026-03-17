import "react-native-get-random-values" // Must be first - required for tweetnacl crypto (UDP encryption)
import "@/utils/polyfills/event" // Must be before any livekit imports
import {registerGlobals} from "@livekit/react-native-webrtc"
import * as Sentry from "@sentry/react-native"
import {useFonts} from "expo-font"
import {useNavigationContainerRef} from "expo-router"
import * as SplashScreen from "expo-splash-screen"
import {useEffect, useState} from "react"

import {SentryNavigationIntegration, SentrySetup} from "@/effects/SentrySetup"
import {initI18n} from "@/i18n"
import {useSettingsStore} from "@/stores/settings"
import {customFontsToLoad} from "@/theme"
import {loadDateFnsLocale} from "@/utils/formatDate"
import {AllEffects} from "@/effects/AllEffects"
import {AllProviders} from "@/contexts/AllProviders"
import "@/global.css"
import {logBuffer} from "@/utils/dev/logging"

SentrySetup()
logBuffer.startConsoleInterception()

// initialize the settings store
useSettingsStore.getState().loadAllSettings()

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync()
SplashScreen.setOptions({
  duration: 1000,
  fade: true,
})

function Root() {
  const [_fontsLoaded, fontError] = useFonts(customFontsToLoad)
  const [loaded, setLoaded] = useState(false)

  const loadAssets = async () => {
    try {
      await initI18n()
      await loadDateFnsLocale()
      // initialize webrtc
      await registerGlobals()
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

  return (
    <AllProviders>
      <AllEffects />
    </AllProviders>
  )
}

export default Sentry.wrap(Root)
