import {ScrollView, View} from "react-native"

import {Header, Screen} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Group} from "@/components/ui/Group"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@/stores/settings"
import {translate} from "@/i18n"

export default function MiniappDeveloperModeSettingsScreen() {
  const {goBack} = useNavigationStore.getState()
  const [miniappDevMode, setMiniappDevMode] = useSetting(SETTINGS.miniapp_dev_mode.key)

  return (
    <Screen preset="fixed">
      <Header titleTx="miniappDeveloperSettings:title" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-6 mt-6">
          <Group title="Settings">
            <ToggleSetting
              label={translate("miniappDeveloperSettings:miniappDeveloperMode")}
              subtitle={translate("miniappDeveloperSettings:miniappDeveloperModeSubtitle")}
              value={miniappDevMode}
              onValueChange={(value) => setMiniappDevMode(value)}
            />
          </Group>
        </View>
        <View className="flex h-16" />
      </ScrollView>
    </Screen>
  )
}
