import {ScrollView, View} from "react-native"

import {Header, Screen} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Group} from "@/components/ui/Group"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@/stores/settings"

export default function DevModeSettingsScreen() {
  const {goBack} = useNavigationStore.getState()
  const [devMode, setDevMode] = useSetting(SETTINGS.public_dev_mode.key)

  return (
    <Screen preset="fixed">
      <Header title="Super Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-6 mt-6">
          <Group title="Settings">
            <ToggleSetting
              label="Dev Mode"
              subtitle="Enable dev mode"
              value={devMode}
              onValueChange={(value) => setDevMode(value)}
            />
          </Group>
        </View>
        <View className="flex h-16" />
      </ScrollView>
    </Screen>
  )
}
