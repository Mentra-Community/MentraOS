// Mentra Live wear detection. Reachable from Debug settings.

import {ScrollView, View} from "react-native"

import {WearDetectionSettings} from "@/components/glasses/settings/WearDetectionSettings"
import {Header, Screen} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"

export default function WearTuningScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationStore.getState()

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
