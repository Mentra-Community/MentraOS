import {ScrollView, View} from "react-native"
import CoreModule from "@mentra/bluetooth-sdk"

import {Header, Screen} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Group} from "@/components/ui/Group"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@/stores/settings"
import {RouteButton} from "@/components/ui/RouteButton"

export default function SuperSettingsScreen() {
  const {goBack} = useNavigationStore.getState()
  const [superMode, setSuperMode] = useSetting(SETTINGS.super_mode.key)
  const [useNativeDashboard, setUseNativeDashboard] = useSetting(SETTINGS.use_native_dashboard.key)
  const [debugNavigationHistoryEnabled, setDebugNavigationHistoryEnabled] = useSetting(
    SETTINGS.debug_navigation_history.key,
  )
  const [debugCoreStatusBarEnabled, setDebugCoreStatusBarEnabled] = useSetting(SETTINGS.debug_core_status_bar.key)
  const {push} = useNavigationStore.getState()

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
              label="Debug Bluetooth Status Bar"
              value={debugCoreStatusBarEnabled}
              onValueChange={(value) => setDebugCoreStatusBarEnabled(value)}
            />

            <ToggleSetting
              label="Use Native G2 Dashboard"
              value={useNativeDashboard}
              onValueChange={(value) => setUseNativeDashboard(value)}
            />
          </Group>

          <Group title="Debug">
            <RouteButton label="dbg1()" onPress={() => CoreModule.dbg1()} />
            <RouteButton label="dbg2()" onPress={() => CoreModule.dbg2()} />
            <RouteButton label="Stress Test (Jetsam)" onPress={() => push("/miniapps/settings/stress-test")} />
          </Group>

          <Group title="Mini Apps">
            <RouteButton label="Miniapp Developer" onPress={() => push("/miniapps/settings/miniapp-developer")} />
          </Group>
        </View>
        <View className="flex h-16" />
      </ScrollView>
    </Screen>
  )
}
