import {getModelCapabilities, SETTINGS, useSetting, engine} from "@mentra/engine"
import {useState} from "react"
import {Alert, ScrollView, View} from "react-native"

import {Header, Screen} from "@/components/ignite"
import HeadUpAngleComponent from "@/components/settings/HeadUpAngleComponent"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {RouteButton} from "@/components/ui/RouteButton"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n/translate"

export default function DashboardSettingsScreen() {
  const {goBack} = useNavigationStore.getState()
  const [headUpAngleComponentVisible, setHeadUpAngleComponentVisible] = useState(false)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [headUpAngle, setHeadUpAngle] = useSetting(SETTINGS.head_up_angle.key)
  const [contextualDashboardEnabled, setContextualDashboardEnabled] = useSetting(SETTINGS.contextual_dashboard.key)
  const [metricSystemEnabled, setMetricSystemEnabled] = useSetting(SETTINGS.metric_system.key)
  const [twelveHourTimeEnabled, setTwelveHourTimeEnabled] = useSetting(SETTINGS.twelve_hour_time.key)
  const features = getModelCapabilities(defaultWearable)
  const glassesConnected =
    useEngineSnapshot(engine.glasses.status, (onChange) => engine.glasses.onStatus(onChange)).state === "connected"

  // -- Handlers --
  const onSaveHeadUpAngle = async (newHeadUpAngle: number) => {
    if (!glassesConnected) {
      Alert.alert("Glasses not connected", "Please connect your smart glasses first.")
      return
    }
    if (newHeadUpAngle == null) {
      return
    }

    setHeadUpAngleComponentVisible(false)
    await setHeadUpAngle(newHeadUpAngle)
  }

  const onCancelHeadUpAngle = () => {
    setHeadUpAngleComponentVisible(false)
  }

  return (
    <Screen preset="fixed">
      <Header titleTx="settings:dashboardSettings" leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView>
        <View className="gap-6 pt-6">
          <ToggleSetting
            label={translate("settings:contextualDashboardLabel")}
            subtitle={translate("settings:contextualDashboardSubtitle")}
            value={contextualDashboardEnabled}
            onValueChange={() => setContextualDashboardEnabled(!contextualDashboardEnabled)}
          />

          <ToggleSetting
            label={translate("settings:metricSystemLabel")}
            subtitle={translate("settings:metricSystemSubtitle")}
            value={metricSystemEnabled}
            onValueChange={() => setMetricSystemEnabled(!metricSystemEnabled)}
          />

          <ToggleSetting
            label={translate("settings:twelveHourTimeLabel")}
            subtitle={translate("settings:twelveHourTimeSubtitle")}
            value={twelveHourTimeEnabled}
            onValueChange={() => setTwelveHourTimeEnabled(!twelveHourTimeEnabled)}
          />

          {defaultWearable && features?.imu?.headUpAngle && (
            <RouteButton
              label={translate("settings:adjustHeadAngleLabel")}
              subtitle={translate("settings:adjustHeadAngleSubtitle")}
              onPress={() => setHeadUpAngleComponentVisible(true)}
            />
          )}

          {headUpAngle !== null && features?.imu?.headUpAngle && (
            <HeadUpAngleComponent
              visible={headUpAngleComponentVisible}
              initialAngle={Math.min(features.imu.headUpAngle.max, Math.max(features.imu.headUpAngle.min, headUpAngle))}
              maxAngle={features.imu.headUpAngle.max}
              onCancel={onCancelHeadUpAngle}
              onSave={onSaveHeadUpAngle}
            />
          )}
        </View>
      </ScrollView>
    </Screen>
  )
}
