import {useEffect, useRef} from "react"
import {ScrollView, View} from "react-native"
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"

import {Header, Screen} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Group} from "@/components/ui/Group"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@mentra/engine"
import {micSessionManager} from "@mentra/engine-host-internal"
import {SettingsCommandButton} from "@/components/glasses/settings/SettingsCommandButton"
import {RouteButton} from "@/components/ui/RouteButton"

export default function SuperSettingsScreen() {
  const {goBack, push} = useNavigationStore.getState()
  const [superMode, setSuperMode] = useSetting(SETTINGS.super_mode.key)
  const [useNativeDashboard, setUseNativeDashboard] = useSetting(SETTINGS.use_native_dashboard.key)
  const [debugNavigationHistoryEnabled, setDebugNavigationHistoryEnabled] = useSetting(
    SETTINGS.debug_navigation_history.key,
  )
  const [debugCoreStatusBarEnabled, setDebugCoreStatusBarEnabled] = useSetting(SETTINGS.debug_core_status_bar.key)
  const [iosAppSwitcherBottomSwipe, setIosAppSwitcherBottomSwipe] = useSetting(
    SETTINGS.ios_app_switcher_bottom_swipe.key,
  )

  // Only the on -> off edge should reset the glasses. Firing on mount with
  // super mode already off sent a cs_weartun reset every time this screen
  // opened, whether or not anything had been tuned.
  const previousSuperMode = useRef<boolean>(!!superMode)
  useEffect(() => {
    if (previousSuperMode.current && !superMode) void BluetoothSdk.resetWearTuning()
    previousSuperMode.current = !!superMode
  }, [superMode])

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

          <Group title="Mentra Live">
            <RouteButton label="Mic Tuning" onPress={() => push("/miniapps/settings/mic-tuning")} />
            <SettingsCommandButton
              label="Call gain sweep 15 → 14 → 15 → 13"
              subtitle="Needs a live Mentra Call. Talk normally for ~100s. Watch CALL_GAIN_SWEEP logs."
              onPress={() => {
                if (!micSessionManager.startCallGainSweep()) {
                  console.warn("CALL_GAIN_SWEEP: join Mentra Call first, then tap again")
                }
              }}
            />
          </Group>

          <Group title="Miniapps">
            <RouteButton label="Miniapp Developer" onPress={() => push("/miniapps/settings/miniapp-dev")} />
          </Group>
        </View>
        <View className="flex h-16" />
      </ScrollView>
    </Screen>
  )
}
