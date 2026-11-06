import {DeviceTypes} from "@mentra/engine"
import {useRoute} from "@react-navigation/native"
import {useEffect, useRef} from "react"
import {AppState} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Header, Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"
import {iosBluetoothDeviceLabel, type ForgetIosPairingThen} from "@/utils/pairing/iosStaleBond"

const SCAN_ROUTE = "/pairing/scan"

/**
 * "Forget the old pairing" (S8). iOS only (the Mac app too): an app there can't remove a Bluetooth
 * bond, so the person does it in Settings. `/pairing/loading` opens it when the SDK reports
 * `pair_failure.code === "ios_forget_pairing"`, and Unpair and sign-out open it as they leave the
 * glasses (`then`).
 *
 * Back and returning from Settings both go on: to the scan list after a failed pairing, where the user
 * picks the glasses again, to Home after Unpair, or to sign-in after sign-out. None starts a connection.
 */
export default function ForgetIosPairingScreen() {
  const route = useRoute()
  const {deviceModel, deviceName, then} = (route.params ?? {}) as {
    deviceModel?: string
    deviceName?: string
    then?: ForgetIosPairingThen
  }
  const returnedRef = useRef(false)

  const returnToScanList = (alreadyLeaving = false) => {
    if (returnedRef.current) return
    returnedRef.current = true
    const {history, goBack, replace, clearHistoryAndGoHome, replaceAll} = useNavigationStore.getState()
    if (then === "home") return clearHistoryAndGoHome()
    if (then === "sign-in") return replaceAll("/auth/start")
    // Loading replaced itself with this screen, so the scan list is the entry underneath. Pop to it
    // rather than stack a second scan screen.
    if (history?.[history.length - 2] === SCAN_ROUTE) {
      // An iOS back swipe is already popping this screen onto the scan list. A goBack() would run
      // after it and pop the scan list too.
      if (!alreadyLeaving) goBack()
      return
    }
    replace(SCAN_ROUTE, {deviceModel: deviceModel ?? DeviceTypes.LIVE})
  }

  focusEffectPreventBack((event) => {
    if (event && event.actionType !== "GO_BACK" && event.actionType !== "POP") return
    returnToScanList(!!event)
  }, true)

  // Coming back from Settings (or the app switcher) means the user is done forgetting the device.
  useEffect(() => {
    let previous = AppState.currentState
    const subscription = AppState.addEventListener("change", (next) => {
      const cameBack = previous !== "active" && next === "active"
      previous = next
      if (cameBack) returnToScanList()
    })
    return () => subscription.remove()
    // returnToScanList is guarded by a ref and reads fresh store state on every call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleOpenSettings = async () => {
    const success = await SettingsNavigationUtils.openBluetoothSettings()
    if (!success) {
      console.error("Failed to open Bluetooth settings")
    }
  }

  const name = iosBluetoothDeviceLabel(deviceName, DeviceTypes.LIVE)

  const steps: OnboardingStep[] = [
    {
      type: "image",
      source: require("@assets/onboarding/live/forget-ios-pairing.png"),
      name: "Forget iOS Pairing",
      transition: false,
      title: translate("onboarding:forgetIosPairingTitle"),
      subtitle: translate("onboarding:forgetIosPairingSubtitle"),
      numberedBullets: [
        translate("onboarding:forgetIosPairingStep1"),
        translate("onboarding:forgetIosPairingStep2", {name}),
        translate("onboarding:forgetIosPairingStep3"),
      ],
    },
  ]

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header
        leftIcon="chevron-left"
        onLeftPress={() => returnToScanList()}
        RightActionComponent={<MentraLogoStandalone />}
      />
      <OnboardingGuide
        steps={steps}
        autoStart={true}
        showCloseButton={false}
        showHeader={false}
        endButtonText={translate("pairing:openSettings")}
        endButtonFn={handleOpenSettings}
        showSkipButton={false}
      />
    </Screen>
  )
}
