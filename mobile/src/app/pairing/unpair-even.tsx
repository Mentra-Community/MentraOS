import {DeviceTypes, engine} from "@mentra/engine"
import {useRoute} from "@react-navigation/native"
import {View} from "react-native"

import {Button, Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"
import {getG2ResetInstructions, isG2RecoveryError} from "@/utils/pairing/g2Recovery"

export default function UnpairEvenScreen() {
  const route = useRoute()
  const {deviceModel, error} = route.params as {deviceModel: string; error?: string}
  const recoveryError = deviceModel === DeviceTypes.G2 && isG2RecoveryError(error) ? error : undefined
  const {clearHistory, replace} = useNavigationStore.getState()

  focusEffectPreventBack()

  const handleOpenSettings = async () => {
    const success = await SettingsNavigationUtils.openBluetoothSettings()
    if (!success) {
      console.error("Failed to open Bluetooth settings")
    }
  }

  const handleTryAgain = () => {
    // Clears the failed attempt; a pre-existing pairing (re-pair) is preserved.
    void engine.pairing.abandonAttempt().catch((error) => {
      console.warn("Pairing retry cleanup failed:", error)
    })
    clearHistory()
    replace("/pairing/prep", {deviceModel})
  }

  const steps: OnboardingStep[] = [
    {
      type: "image",
      source: recoveryError
        ? require("@assets/glasses/even_realities_g2/even_realities_g2.png")
        : require("@assets/onboarding/os/thumbnails/unpair_even.png"),
      name: "Unpair Even",
      transition: false,
      compactHeader: Boolean(recoveryError),
      title: translate(recoveryError ? "pairing:g2ReconnectTitle" : "onboarding:unpairEvenTitle"),
      subtitle: recoveryError
        ? `${translate(recoveryError)}\n\n${getG2ResetInstructions()}`
        : translate("onboarding:unpairEvenSubtitle"),
    },
  ]

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <OnboardingGuide
        steps={steps}
        autoStart={true}
        showCloseButton={false}
        endButtonText={translate(recoveryError ? "onboarding:unpairEvenTryAgain" : "onboarding:openSettings")}
        endButtonFn={recoveryError ? handleTryAgain : handleOpenSettings}
        showSkipButton={false}
      />

      <View className={recoveryError ? "mt-3 w-full" : "absolute bottom-16 w-full"}>
        <Button
          text={translate(recoveryError ? "onboarding:openSettings" : "onboarding:unpairEvenTryAgain")}
          preset="secondary"
          onPress={recoveryError ? handleOpenSettings : handleTryAgain}
        />
      </View>
    </Screen>
  )
}
