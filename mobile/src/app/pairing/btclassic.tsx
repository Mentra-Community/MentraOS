import {useRoute} from "@react-navigation/native"
import {useEffect, useMemo} from "react"
import {Button, Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n"
import {focusEffectPreventBack, usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {engine} from "@mentra/engine"
import type {Device} from "@mentra/bluetooth-sdk"
import {SETTINGS, useSetting} from "@mentra/engine"
import {routePairingKickoffFailure} from "@/utils/PairingUtils"
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
  //
  // This screen is ALSO entered without a device from paired contexts — the
  // pairing-success step stack and the home-screen "Bluetooth Classic
  // disconnected" recovery alert — where the saved default identity is the
  // device to (re)connect.
  const device = useMemo((): Device | null => {
    const {device: deviceJson} = (route.params ?? {}) as {device?: string}
    if (!deviceJson) return null
    try {
      return JSON.parse(deviceJson) as Device
    } catch {
      return null
    }
  }, [route.params])
  const bluetoothClassicConnected = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  ).bluetoothClassicConnected
  const otherBtConnected = useEngineSnapshot(engine.pairing.otherBtConnected, (onChange) =>
    engine.pairing.onOtherBtConnected(onChange),
  )
  const [savedDeviceName] = useSetting(SETTINGS.device_name.key)
  const deviceName = device?.name || savedDeviceName || ""
  const {theme} = useAppTheme()

  focusEffectPreventBack()

  const handleSuccess = () => {
    if (device) {
      engine.glasses.connect(device, {saveAsDefault: false}).catch((error) => {
        console.error("Failed to connect glasses after Bluetooth Classic pairing:", error)
        routePairingKickoffFailure(device.model)
      })
    } else {
      // Paired contexts (success step stack / recovery alert): reconnect the
      // saved default device.
      engine.glasses.connectDefault().catch((error) => {
        console.error("Failed to connect default glasses after Bluetooth Classic pairing:", error)
        // Identity read-model, not raw keys: the failure copy names whatever
        // identity model exists at rejection time (paired or pending).
        const identity = engine.pairing.identity()
        routePairingKickoffFailure(identity.kind === "none" ? undefined : identity.model)
      })
    }
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
    if (!device) return
    // The Pair Audio step advances when native detects the picked device's
    // Classic audio route — prime the native watcher with that device (it no
    // longer learns it from a selection-time identity write). If the audio
    // device is already paired, the resulting immediate check advances the
    // screen right away.
    void engine.pairing.setBluetoothClassicTarget(device).catch((error) => {
      console.warn("BTCLASSIC: failed to set the Bluetooth Classic target:", error)
    })
  }, [device])

  useEffect(() => {
    console.log("BTCLASSIC: check bluetoothClassicConnected", bluetoothClassicConnected)
    if (bluetoothClassicConnected) {
      handleSuccess()
    }
  }, [bluetoothClassicConnected])

  useEffect(() => {
    if (device) return
    let cancelled = false
    // Paired-context entry (no scan device): stay only when a default device
    // actually exists — the same precondition connectDefault() has, read
    // hydration-aware. Fail open (stay) on a read error; connectDefault()'s
    // catch is the fallback for a genuinely missing device.
    engine.glasses
      .hasDefaultDevice()
      .catch(() => true)
      .then((hasDefault) => {
        if (cancelled || hasDefault) return
        console.log("BTCLASSIC: no device threaded from scan and no default device, cannot continue")
        handleBack()
      })
    return () => {
      cancelled = true
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
