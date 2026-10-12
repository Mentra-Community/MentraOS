import {useFocusEffect} from "expo-router"
import {useCallback, useEffect} from "react"
import {View} from "react-native"

import {Header, Screen} from "@/components/ignite"
import SliderSetting from "@/components/settings/SliderSetting"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting, getModelCapabilities, engine} from "@mentra/engine"
import {useKonamiCode} from "@/utils/dev/konami"

export default function ScreenSettingsScreen() {
  const {goBack} = useNavigationStore.getState()
  const [dashboardDepth, setDashboardDepth] = useSetting(SETTINGS.dashboard_depth.key)
  const [dashboardHeight, setDashboardHeight] = useSetting(SETTINGS.dashboard_height.key)
  const [_screenDisabled, setScreenDisabled] = useSetting(SETTINGS.screen_disabled.key)
  const deviceModel = useEngineSnapshot(engine.glasses.info, (onChange) => engine.glasses.onInfo(onChange)).model
  const {setEnabled} = useKonamiCode()

  const isG1 = deviceModel === "Even Realities G1" || deviceModel === "evenrealities_g1" || deviceModel === "g1"
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const position = getModelCapabilities(defaultWearable).display?.position

  useFocusEffect(
    useCallback(() => {
      if (!isG1) return
      setScreenDisabled(true)
      return () => {
        setScreenDisabled(false)
      }
    }, [isG1, setScreenDisabled]),
  )

  useEffect(() => {
    setEnabled(false)
    return () => setEnabled(true)
  }, [setEnabled])

  return (
    <Screen preset="fixed">
      <Header titleTx="positionSettings:title" leftIcon="chevron-left" onLeftPress={goBack} />

      {position && (
        <View className="gap-6 pt-6">
          <SliderSetting
            label="Display Depth"
            subtitle="Adjust how far the content appears from you."
            value={Math.min(position.depth.max, Math.max(position.depth.min, dashboardDepth ?? 2))}
            min={position.depth.min}
            max={position.depth.max}
            onValueChange={(_value) => {}}
            onValueSet={setDashboardDepth}
          />

          <SliderSetting
            label="Display Height"
            subtitle="Adjust the vertical position of the content."
            value={Math.min(position.height.max, Math.max(position.height.min, dashboardHeight ?? 4))}
            min={position.height.min}
            max={position.height.max}
            onValueChange={(_value) => {}}
            onValueSet={setDashboardHeight}
          />
        </View>
      )}
    </Screen>
  )
}
