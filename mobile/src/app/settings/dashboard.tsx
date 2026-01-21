import {getModelCapabilities} from "@/../../cloud/packages/types/src"
import {useState} from "react"
import {Alert, ScrollView, View} from "react-native"

import {Header, Screen} from "@/components/ignite"
import HeadUpAngleComponent from "@/components/settings/HeadUpAngleComponent"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {RouteButton} from "@/components/ui/RouteButton"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"

export default function DashboardSettingsScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationHistory()
  const [headUpAngleComponentVisible, setHeadUpAngleComponentVisible] = useState(false)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [headUpAngle, setHeadUpAngle] = useSetting(SETTINGS.head_up_angle.key)
  const [contextualDashboardEnabled, setContextualDashboardEnabled] = useSetting(SETTINGS.contextual_dashboard.key)
  const [metricSystemEnabled, setMetricSystemEnabled] = useSetting(SETTINGS.metric_system.key)
  const features = getModelCapabilities(defaultWearable)
  const glassesConnected = useGlassesStore((state) => state.connected)

  // -- Handlers --
  const toggleContextualDashboard = async () => {
    const newVal = !contextualDashboardEnabled
    await setContextualDashboardEnabled(newVal)
  }

  const toggleMetricSystem = async () => {
    const newVal = !metricSystemEnabled
    try {
      await setMetricSystemEnabled(newVal)
    } catch (error) {
      console.error("Error toggling metric system:", error)
    }
  }

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
            onValueChange={toggleContextualDashboard}
          />

          <ToggleSetting
            label={translate("settings:metricSystemLabel")}
            subtitle={translate("settings:metricSystemSubtitle")}
            value={metricSystemEnabled}
            onValueChange={toggleMetricSystem}
          />

          {defaultWearable && features?.hasIMU && (
            <RouteButton
              label={translate("settings:adjustHeadAngleLabel")}
              subtitle={translate("settings:adjustHeadAngleSubtitle")}
              onPress={() => setHeadUpAngleComponentVisible(true)}
            />
          )}

          {headUpAngle !== null && (
            <HeadUpAngleComponent
              visible={headUpAngleComponentVisible}
              initialAngle={headUpAngle}
              onCancel={onCancelHeadUpAngle}
              onSave={onSaveHeadUpAngle}
            />
          )}
        </View>
      </ScrollView>
    </Screen>
  )
}
