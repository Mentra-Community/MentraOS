import {Screen} from "@/components/ignite"
import {SplashVideo} from "@/components/splash/SplashVideo"
import {SETTINGS, useSetting} from "@/stores/settings"
import {View} from "react-native"

export default function AuthCallback() {
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  if (superMode) {
    return (
      <Screen preset="fixed">
        <View className="flex-1 justify-center items-center bg-chart-4">
          <SplashVideo />
        </View>
      </Screen>
    )
  }

  return (
    <Screen preset="fixed">
      <SplashVideo />
    </Screen>
  )
}
