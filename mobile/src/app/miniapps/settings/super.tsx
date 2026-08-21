import {ScrollView, View} from "react-native"
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"

import {Header, Screen} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Group} from "@/components/ui/Group"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@mentra/engine"
import {RouteButton} from "@/components/ui/RouteButton"

export default function SuperSettingsScreen() {
  const {goBack} = useNavigationStore.getState()
  const [superMode, setSuperMode] = useSetting(SETTINGS.super_mode.key)
  const [forceHotspotOta, setForceHotspotOta] = useSetting(SETTINGS.ota_force_hotspot.key)
  const [useNativeDashboard, setUseNativeDashboard] = useSetting(SETTINGS.use_native_dashboard.key)
  const [debugNavigationHistoryEnabled, setDebugNavigationHistoryEnabled] = useSetting(
    SETTINGS.debug_navigation_history.key,
  )
  const [debugCoreStatusBarEnabled, setDebugCoreStatusBarEnabled] = useSetting(SETTINGS.debug_core_status_bar.key)
  const [iosAppSwitcherBottomSwipe, setIosAppSwitcherBottomSwipe] = useSetting(
    SETTINGS.ios_app_switcher_bottom_swipe.key,
  )
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
              label="Force Hotspot OTA"
              subtitle="Use the production hotspot path even when glasses Wi-Fi is connected"
              value={forceHotspotOta}
              onValueChange={(value) => setForceHotspotOta(value)}
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

            <ToggleSetting
              label="Enable iOS App Switcher Bottom Swipe"
              value={iosAppSwitcherBottomSwipe}
              onValueChange={(value) => setIosAppSwitcherBottomSwipe(value)}
            />
          </Group>

          <Group title="Debug">
            <RouteButton label="dbg1()" onPress={() => BluetoothSdk.dbg1()} />
            <RouteButton label="dbg2()" onPress={() => BluetoothSdk.dbg2()} />
            <RouteButton label="Stress Test (Jetsam)" onPress={() => push("/miniapps/settings/stress-test")} />
          </Group>

          <Group title="Mini Apps">
            <RouteButton label="Miniapp Developer" onPress={() => push("/miniapps/settings/miniapp-dev")} />
          </Group>
        </View>
        <View className="flex h-16" />
      </ScrollView>
    </Screen>
  )
}
