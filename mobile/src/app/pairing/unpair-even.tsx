import {useRoute} from "@react-navigation/native"
import {View} from "react-native"
import BluetoothSdk from "@mentra/bluetooth-sdk"

import {Button, Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"

export default function UnpairEvenScreen() {
  const route = useRoute()
  const {deviceModel} = route.params as {deviceModel: string}
  const {clearHistory, replace} = useNavigationStore.getState()

  focusEffectPreventBack()

  const handleOpenSettings = async () => {
    const success = await SettingsNavigationUtils.openBluetoothSettings()
    if (!success) {
      console.error("Failed to open Bluetooth settings")
    }
  }

  const handleTryAgain = () => {
    BluetoothSdk.forget()
    clearHistory()
    replace("/pairing/prep", {deviceModel})
  }

  const steps: OnboardingStep[] = [
    {
      type: "image",
      source: require("@assets/onboarding/os/thumbnails/unpair_even.png"),
      name: "Unpair Even",
      transition: false,
      title: translate("onboarding:unpairEvenTitle"),
      subtitle: translate("onboarding:unpairEvenSubtitle"),
    },
  ]

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <OnboardingGuide
        steps={steps}
        autoStart={true}
        showCloseButton={false}
        endButtonText={translate("onboarding:openSettings")}
        endButtonFn={handleOpenSettings}
        showSkipButton={false}
      />

      <View className="absolute bottom-16 w-full">
        <Button text={translate("onboarding:unpairEvenTryAgain")} preset="secondary" onPress={handleTryAgain} />
      </View>
    </Screen>
  )
}
