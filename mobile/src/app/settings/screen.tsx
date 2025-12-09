import CoreModule from "core"
import {useFocusEffect} from "expo-router"
import {useCallback} from "react"
import {ScrollView} from "react-native"

import {Header, Screen} from "@/components/ignite"
import SliderSetting from "@/components/settings/SliderSetting"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {$styles} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export default function ScreenSettingsScreen() {
  const {theme, themed} = useAppTheme()
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
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Header titleTx="screenSettings:title" leftIcon="chevron-left" onLeftPress={goBack} />

      <ScrollView>
        <SliderSetting
          label="Display Depth"
          subtitle="Adjust how far the content appears from you."
          value={dashboardDepth ?? 5}
          min={1}
          max={5}
          onValueChange={_value => {}}
          onValueSet={setDashboardDepth}
        />

        <Spacer height={theme.spacing.s4} />

        <SliderSetting
          label="Display Height"
          subtitle="Adjust the vertical position of the content."
          value={dashboardHeight ?? 4}
          min={1}
          max={8}
          onValueChange={_value => {}}
          onValueSet={setDashboardHeight}
        />
      </ScrollView>
    </Screen>
  )
}
