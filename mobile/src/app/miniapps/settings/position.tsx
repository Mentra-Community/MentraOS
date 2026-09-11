import {useFocusEffect} from "expo-router"
import {useCallback, useEffect} from "react"
import {View} from "react-native"

import {Header, Screen} from "@/components/ignite"
import SliderSetting from "@/components/settings/SliderSetting"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@mentra/engine"
import {useKonamiCode} from "@/utils/dev/konami"
import {engine} from "@mentra/engine"

export default function ScreenSettingsScreen() {
  const {goBack} = useNavigationStore.getState()
  const [dashboardDepth, setDashboardDepth] = useSetting(SETTINGS.dashboard_depth.key)
  const [dashboardHeight, setDashboardHeight] = useSetting(SETTINGS.dashboard_height.key)
  const [_screenDisabled, setScreenDisabled] = useSetting(SETTINGS.screen_disabled.key)
  const deviceModel = useEngineSnapshot(engine.glasses.info, (onChange) => engine.glasses.onInfo(onChange)).model
  const {setEnabled} = useKonamiCode()

  const isG1 = deviceModel === "Even Realities G1" || deviceModel === "evenrealities_g1" || deviceModel === "g1"
  const isNex = deviceModel === "Mentra Display" || deviceModel === "Mentra Nex" || deviceModel === "mentra_display"

  // Only Mentra Display supports a 4th depth tier; every other device keeps the original 1-3 range.
  const depthMax = isNex ? 4 : 3

  const depthClamped = Math.min(depthMax, Math.max(1, Number(dashboardDepth ?? 2)))

  useFocusEffect(
    useCallback(() => {
      if (!isG1) return
      setScreenDisabled(true)
      return () => {
        setScreenDisabled(false)
      }
    }, [isG1]),
  )

  useEffect(() => {
    setEnabled(false)
    return () => setEnabled(true)
  }, [setEnabled])

  return (
    <Screen preset="fixed">
      <Header titleTx="positionSettings:title" leftIcon="chevron-left" onLeftPress={goBack} />

      <View className="gap-6 pt-6">
        <SliderSetting
          label="Display Depth"
          subtitle="Adjust how far the content appears from you."
          value={depthClamped}
          min={1}
          max={depthMax}
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
    </Screen>
  )
}
