import {Stack} from "expo-router"

import NexDeveloperSettings from "@/components/glasses/NexDeveloperSettings"
import {Screen, Header} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {$styles} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export default function NexDeveloperSettingsPage() {
  const {themed} = useAppTheme()
  const {goBack} = useNavigationHistory()

  return (
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Stack.Screen
        options={{
          headerShown: false,
        }}
      />
      <Header title="Nex Developer Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <NexDeveloperSettings />
    </Screen>
  )
}
