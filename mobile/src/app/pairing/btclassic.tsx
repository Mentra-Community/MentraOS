import {useRoute} from "@react-navigation/native"
import {useEffect, useMemo} from "react"
import {Button, Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {useToolkitSnapshot} from "@/hooks/useToolkitSnapshot"
import {translate} from "@/i18n"
import {focusEffectPreventBack, usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {toolkit} from "@mentra/island"
import type {Device} from "@mentra/bluetooth-sdk"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"
import {View} from "react-native"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import CrustModule from "@mentra/crust"

export default function BtClassicPairingScreen() {
  const {goBack} = useNavigationStore.getState()
  const pushPrevious = usePushPrevious()
  const route = useRoute()
  // The device the user picked on the scan screen, threaded through the route.
  // Two-phase identity: it is NOT the default device yet — the connect below
  // marks it pending, and the native layer promotes it on pairing success.
  const device = useMemo((): Device | null => {
    const {device: deviceJson} = (route.params ?? {}) as {device?: string}
    if (!deviceJson) return null
    try {
      return JSON.parse(deviceJson) as Device
    } catch {
      return null
    }
  }, [route.params])
  const bluetoothClassicConnected = useToolkitSnapshot(toolkit.pairing.readiness, (onChange) =>
    toolkit.pairing.onReadiness(onChange),
  ).bluetoothClassicConnected
  const otherBtConnected = useToolkitSnapshot(toolkit.pairing.otherBtConnected, (onChange) =>
    toolkit.pairing.onOtherBtConnected(onChange),
  )
  const deviceName = device?.name ?? ""
  const {theme} = useAppTheme()

  focusEffectPreventBack()

  const handleSuccess = () => {
    if (!device) return
    toolkit.glasses.connect(device, {saveAsDefault: false}).catch((error) => {
      console.error("Failed to connect glasses after Bluetooth Classic pairing:", error)
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
    if (!device) {
      console.log("BTCLASSIC: no device threaded from the scan screen, cannot continue")
      handleBack()
    }
  }, [device])

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
