import CoreModule from "core"
import {useFocusEffect} from "expo-router"
import {useCallback} from "react"
import {ScrollView, View} from "react-native"

import {Header, Screen} from "@/components/ignite"
import SliderSetting from "@/components/settings/SliderSetting"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"

export default function ScreenSettingsScreen() {
  const {goBack} = useNavigationHistory()
  const [dashboardDepth, setDashboardDepth] = useSetting(SETTINGS.dashboard_depth.key)
  const [dashboardHeight, setDashboardHeight] = useSetting(SETTINGS.dashboard_height.key)

  useFocusEffect(
    useCallback(() => {
      CoreModule.updateSettings({screen_disabled: true})
      return () => {
        CoreModule.updateSettings({screen_disabled: false})
      }
    }, []),
  )

  return (
    <Screen preset="fixed">
      <Header titleTx="positionSettings:title" leftIcon="chevron-left" onLeftPress={goBack} />

      <ScrollView>
        <View className="gap-6 pt-6">
          <SliderSetting
            label="Display Depth"
            subtitle="Adjust how far the content appears from you."
            value={dashboardDepth ?? 5}
            min={1}
            max={5}
            onValueChange={(_value) => {}}
            onValueSet={setDashboardDepth}
          />

          <SliderSetting
            label="Display Height"
            subtitle="Adjust the vertical position of the content."
            value={dashboardHeight ?? 4}
            min={1}
            max={8}
            onValueChange={(_value) => {}}
            onValueSet={setDashboardHeight}
          />
        </View>
      </ScrollView>
    </Screen>
  )
}
