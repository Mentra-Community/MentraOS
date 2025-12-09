import {useFocusEffect} from "expo-router"
import {useCallback} from "react"
import {BackHandler} from "react-native"

import {GalleryScreen} from "@/components/glasses/Gallery/GalleryScreen"
import {Screen} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/utils/useAppTheme"

export default function AsgGallery() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationHistory()

  const handleGoBack = useCallback(() => {
    goBack()
    return true // Prevent default back behavior
  }, [goBack])

  // Handle Android back button
  useFocusEffect(
    useCallback(() => {
      const backHandler = BackHandler.addEventListener("hardwareBackPress", handleGoBack)
      return () => backHandler.remove()
    }, [handleGoBack]),
  )

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.s6}}>
      <GalleryScreen />
    </Screen>
  )
}
