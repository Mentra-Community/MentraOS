import {useEffect, useRef} from "react"
import {Button, Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {translate} from "@/i18n"
import {focusEffectPreventBack, usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {selectGlassesConnected, useGlassesStore} from "@/stores/glasses"
import {DeviceTypes} from "@/../../cloud/packages/types/src"
import BluetoothSdk, {type DeviceModel} from "@mentra/bluetooth-sdk"
import {SETTINGS, useSetting} from "@/stores/settings"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"
import {useCoreStore} from "@/stores/core"
import {View} from "react-native"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import CrustModule from "@mentra/crust"

export default function BtClassicPairingScreen() {
  const {goBack} = useNavigationStore.getState()
  const pushPrevious = usePushPrevious()
  const bluetoothClassicConnected = useGlassesStore((state) => state.bluetoothClassicConnected)
  const glassesConnected = useGlassesStore(selectGlassesConnected)
  const otherBtConnected = useCoreStore((state) => state.otherBtConnected)
  const searchResults = useCoreStore((state) => state.searchResults)
  const [deviceName] = useSetting(SETTINGS.device_name.key)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const {theme} = useAppTheme()

  // Nimo has no classic AUDIO profile, so `bluetoothClassicConnected` never flips
  // (that flag is set from iOS audio-session detection). Instead we drive the whole
  // flow off the real BLE connection: keep re-scanning until the glasses appear as
  // system-connected after the user pairs in Settings, then connect and complete.
  const isNimo = defaultWearable === DeviceTypes.NIMO
  const nimoConnectTriggeredRef = useRef(false)
  const nimoAdvancedRef = useRef(false)

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

  // Nimo: poll a non-destructive scan (startScan does NOT arm the connect-time
  // pairing timeout the way connect does) so the glasses can be detected as
  // system-connected as soon as the user finishes pairing in Settings.
  useEffect(() => {
    if (!isNimo || !defaultWearable) return
    if (glassesConnected) return
    let cancelled = false
    const scanOnce = () => {
      BluetoothSdk.startScan(defaultWearable as DeviceModel).catch(() => undefined)
    }
    scanOnce()
    const interval = setInterval(() => {
      if (!cancelled) scanOnce()
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [isNimo, defaultWearable, glassesConnected])

  // Nimo: once our glasses show up in the scan results (system-connected after the
  // Settings pairing), connect once. They're already present, so this connects fast.
  useEffect(() => {
    if (!isNimo || nimoConnectTriggeredRef.current) return
    if (!searchResults.some((d) => d.name === deviceName)) return
    nimoConnectTriggeredRef.current = true
    BluetoothSdk.connectDefault().catch((error) => {
      console.error("Failed to connect Nimo after Bluetooth Classic pairing:", error)
    })
  }, [isNimo, searchResults, deviceName])

  // Nimo: complete on the real glasses connection (not the audio-only classic flag).
  // Hand back to the loading screen underneath, which advances to success.
  useEffect(() => {
    if (!isNimo || nimoAdvancedRef.current) return
    if (!glassesConnected) return
    nimoAdvancedRef.current = true
    pushPrevious()
  }, [isNimo, glassesConnected])

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
