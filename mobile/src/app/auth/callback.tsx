import {Screen} from "@/components/ignite"
import {SplashVideo} from "@/components/splash/SplashVideo"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {View} from "react-native"

export default function AuthCallback() {
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const {theme} = useAppTheme()

  if (superMode) {
    return (
      <Screen preset="fixed">
        <SplashVideo colorOverride={theme.colors.chart_5} />
      </Screen>
    )
  }

  return (
    <Screen preset="fixed">
      <SplashVideo />
    </Screen>
  )
}
