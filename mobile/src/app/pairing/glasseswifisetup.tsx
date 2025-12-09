import {useLocalSearchParams, useFocusEffect} from "expo-router"
import {useCallback, useEffect} from "react"
import {BackHandler} from "react-native"

import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

export default function GlassesWifiSetupScreen() {
  const {deviceModel = "Glasses", returnTo, nextRoute} = useLocalSearchParams()
  const {goBack, replace} = useNavigationHistory()

  const handleGoBack = useCallback(() => {
    if (returnTo && typeof returnTo === "string") {
      replace(decodeURIComponent(returnTo))
    } else {
      goBack()
    }
    return true // Prevent default back behavior
  }, [returnTo])

  // Handle Android back button
  useFocusEffect(
    useCallback(() => {
      const backHandler = BackHandler.addEventListener("hardwareBackPress", handleGoBack)
      return () => backHandler.remove()
    }, [handleGoBack]),
  )

  // Immediately redirect to scan screen (using replace to avoid white screen on back)
  useEffect(() => {
    replace("/pairing/glasseswifisetup/scan", {deviceModel, returnTo, nextRoute})
  }, [])

  // Redirect screen - no UI needed
  return null
}
