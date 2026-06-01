import {useEffect} from "react"
import {Button, Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {translate} from "@/i18n"
import {focusEffectPreventBack, usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"
import BluetoothSdk from "@mentra/bluetooth-sdk"
import {SETTINGS, useSetting} from "@/stores/settings"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"
import {useCoreStore} from "@/stores/core"
import {View} from "react-native"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import CrustModule from "crust"

export default function BtClassicPairingScreen() {
  const {goBack} = useNavigationStore.getState()
  const pushPrevious = usePushPrevious()
  const bluetoothClassicConnected = useGlassesStore((state) => state.bluetoothClassicConnected)
  const otherBtConnected = useCoreStore((state) => state.otherBtConnected)
  const [deviceName] = useSetting(SETTINGS.device_name.key)
  const {theme} = useAppTheme()

  focusEffectPreventBack()

  const handleSuccess = () => {
    BluetoothSdk.connectDefault().catch((error) => {
      console.error("Failed to connect default glasses after Bluetooth Classic pairing:", error)
    })
    pushPrevious()
  }

  const handleBack = () => {
    goBack()
  }

  const handleOpenSettings = async () => {
    const success = await SettingsNavigationUtils.openBluetoothSettings()
    if (!success) {
      console.error("Failed to open Bluetooth settings")
    }
  }

  useEffect(() => {
    console.log("BTCLASSIC: check bluetoothClassicConnected", bluetoothClassicConnected)
    if (bluetoothClassicConnected) {
      handleSuccess()
    }
  }, [bluetoothClassicConnected])

  useEffect(() => {
    console.log("BTCLASSIC: check deviceName", deviceName)
    if (deviceName == "" || deviceName == null) {
      console.log("BTCLASSIC: deviceName is empty, cannot continue")
      handleBack()
      return
    }
  }, [deviceName])

  let steps: OnboardingStep[] = [
    {
      type: "image",
      source: require("@assets/onboarding/os/thumbnails/btclassic.png"),
      name: "Start Onboarding",
      transition: false,
      title: translate("onboarding:btClassicTitle"),
      subtitle: translate("onboarding:btClassicSubtitle", {name: deviceName}),
      numberedBullets: [
        translate("onboarding:btClassicStep1"),
        translate("onboarding:btClassicStep2"),
        translate("onboarding:btClassicStep3", {name: deviceName}),
        translate("onboarding:btClassicStep4"),
      ],
    },
  ]

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      {/* <Header leftIcon="chevron-left" onLeftPress={handleBack} /> */}
      <OnboardingGuide
        steps={steps}
        autoStart={true}
        showCloseButton={false}
        endButtonText={translate("onboarding:openSettings")}
        endButtonFn={handleOpenSettings}
        showSkipButton={false}
      />

      {otherBtConnected && (
        <View className="absolute bottom-16 w-full">
          <Button
            text={translate("onboarding:showDevicePicker")}
            preset="secondary"
            onPress={() => {
              CrustModule.showAVRoutePicker(theme.colors.text)
            }}
          />
        </View>
      )}
      {/* <ExpoAvRoutePickerView className="w-12 h-12 absolute bottom-16 z-10" activeTintColor={theme.colors.text}/> */}
      {/* <ExpoAvRoutePickerView
        style={{height: "100%"}}
        className="absolute bottom-16 z-10 w-full h-[10px]"
        activeTintColor={theme.colors.text}
      /> */}
    </Screen>
  )
}
