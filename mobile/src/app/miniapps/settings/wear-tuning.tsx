// Mentra Live wear detection. Reachable from glasses settings while Super
// Mode is on. expo-router routes are addressable, so the guard below is the
// one that actually holds.

import {useEffect} from "react"
import {ScrollView, View} from "react-native"

import {WearDetectionSettings} from "@/components/glasses/settings/WearDetectionSettings"
import {Header, Screen} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@mentra/engine"

export default function WearTuningScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationStore.getState()
  const [superMode] = useSetting<boolean>(SETTINGS.super_mode.key)

  useEffect(() => {
    if (!superMode) goBack()
  }, [superMode, goBack])

  if (!superMode) return null

  return (
    <Screen preset="fixed">
      <Header title="Wear Detection" leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <ScrollView style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}>
        <View className="pt-6 pb-16">
          <WearDetectionSettings />
        </View>
      </ScrollView>
    </Screen>
  )
}
