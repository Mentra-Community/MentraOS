import {ScrollView, View} from "react-native"
import CoreModule from "core"

import {Header, Screen} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Group} from "@/components/ui/Group"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {RouteButton} from "@/components/ui/RouteButton"

export default function SuperSettingsScreen() {
  const {goBack} = useNavigationHistory()
  const [superMode, setSuperMode] = useSetting(SETTINGS.super_mode.key)
  const [debugNavigationHistoryEnabled, setDebugNavigationHistoryEnabled] = useSetting(
    SETTINGS.debug_navigation_history.key,
  )
  const [debugCoreStatusBarEnabled, setDebugCoreStatusBarEnabled] = useSetting(SETTINGS.debug_core_status_bar.key)
  const [appSwitcherUi, setAppSwitcherUi] = useSetting(SETTINGS.app_switcher_ui.key)
  const {push} = useNavigationHistory()

  return (
    <Screen preset="fixed">
      <Header title="Super Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-6 mt-6">
          <Group title="Settings">
            <ToggleSetting
              label="Super Mode"
              subtitle="Enable super mode"
              value={superMode}
              onValueChange={(value) => setSuperMode(value)}
            />

            <ToggleSetting
              label="Debug Navigation History"
              value={debugNavigationHistoryEnabled}
              onValueChange={(value) => setDebugNavigationHistoryEnabled(value)}
            />

            <ToggleSetting
              label="Debug Core Status Bar"
              value={debugCoreStatusBarEnabled}
              onValueChange={(value) => setDebugCoreStatusBarEnabled(value)}
            />

            <ToggleSetting
              label="App Switcher UI"
              value={appSwitcherUi}
              onValueChange={(value) => setAppSwitcherUi(value)}
            />
          </Group>

          <Group title="Debug">
            <RouteButton label="dbg1()" onPress={() => CoreModule.dbg1()} />
            <RouteButton label="dbg2()" onPress={() => CoreModule.dbg2()} />
          </Group>

          <Group title="Mini Apps">
            <RouteButton label="React Example" onPress={() => push("/miniapps/dev/react-example")} />
            <RouteButton label="Local Captions Example" onPress={() => push("/miniapps/dev/local-captions")} />
            <RouteButton label="LMA Installer" onPress={() => push("/miniapps/dev/mini-app-installer")} />
          </Group>
        </View>
        <View className="flex h-16"/>
      </ScrollView>
    </Screen>
  )
}
