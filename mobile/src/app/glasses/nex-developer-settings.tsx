import {Stack} from "expo-router"

import NexDeveloperSettings from "@/components/glasses/NexDeveloperSettings"
import {Screen, Header} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {$styles} from "@/theme"

export default function NexDeveloperSettingsPage() {
  const {themed} = useAppTheme()
  const {goBack} = useNavigationStore.getState()

  return (
    <Screen preset="fixed">
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
