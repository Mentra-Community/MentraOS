import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {Platform} from "react-native"
import {useRoute} from "@react-navigation/native"

import {Screen} from "@/components/ignite"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {waitForGlassesState} from "@/stores/glasses"
import {getGlassesImage} from "@/utils/getGlassesImage"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {translate} from "@/i18n"
import {useEffect, useState} from "react"

export default function PairingSuccessScreen() {
  const {clearHistoryAndGoHome, pushUnder} = useNavigationHistory()
  const route = useRoute()
  const {deviceModel: routeDeviceModel} = (route.params as {deviceModel?: string}) || {}
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const {push} = useNavigationHistory()
  const [onboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)
  const [buttonText, setButtonText] = useState<string>(translate("common:continue"))
  const [stack, setStack] = useState<string[]>([])

  focusEffectPreventBack()

  // Use route params first (immediately available), fall back to settings store
  const deviceModel = routeDeviceModel || defaultWearable
  if (!routeDeviceModel) {
    console.warn("PAIR_SUCCESS: No deviceModel in route params, falling back to defaultWearable:", defaultWearable)
  } else {
    console.log("PAIR_SUCCESS: Using deviceModel from route params:", routeDeviceModel)
  }

  const glassesImage = getGlassesImage(deviceModel)

  const getStack = async () => {
    const order = ["/pairing/btclassic", "/wifi/scan", "/ota/check-for-updates", "/onboarding/live", "/onboarding/os"]
    let newStack: string[] = []

    if (deviceModel === DeviceTypes.LIVE) {
      let btcConnected = await waitForGlassesState("btcConnected", (value) => value === true, 1000)
      console.log("PAIR_SUCCESS: btcConnected", btcConnected)
      if (Platform.OS === "android") {
        btcConnected = true
      }

      if (!btcConnected) {
        newStack.push("/pairing/btclassic")
      }
      // check if the glasses are already connected:
      // wait for the glasses to be connected to wifi for up to 1 second:
      let wifiConnected = await waitForGlassesState("wifiConnected", (value) => value === true, 1000)
      if (!wifiConnected) {
        newStack.push("/wifi/scan")
      }
      newStack.push("/ota/check-for-updates")
      if (!onboardingOsCompleted) {
        // newStack.push("/onboarding/os")
      }
      newStack.push("/onboarding/live")

      // sort the stack by the order:
      newStack.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    }
    if (deviceModel === DeviceTypes.G1) {
      if (!onboardingOsCompleted) {
        // newStack.push("/onboarding/os")
      }
    }
    setStack(newStack)
  }

  const handleContinue = async () => {
    console.log("PAIR_SUCCESS: stack", stack)
    // clear the history and go home so that we don't navigate back here:
    clearHistoryAndGoHome()
    // if the stack is empty, we are done:
    if (stack.length === 0) {
      return
    }
    let stackCopy = stack.slice()
    // push the first element in the stack (removing it from the list):
    const first = stackCopy.shift()
    push(first!)
    // go bottom to top and pushUnder the rest (in reverse order):
    for (let i = stackCopy.length - 1; i >= 0; i--) {
      pushUnder(stackCopy[i])
    }
    return
  }

  let steps: OnboardingStep[] = []

  switch (deviceModel) {
    case DeviceTypes.LIVE:
      steps = [
        {
          name: "Start Onboarding",
          type: "image",
          source: require("@assets/onboarding/live/thumbnails/ONB0_power.png"),
          transition: false,
          title: translate("common:success"),
          subtitle: translate("onboarding:liveConnected"),
          titleCentered: true,
          subtitleCentered: true,
        },
      ]
      break
    case DeviceTypes.Z100:
      steps = [
        {
          name: "Start Onboarding",
          type: "image",
          source: glassesImage,
          transition: false,
          title: translate("common:success"),
          // subtitle: translate("onboarding:z100Connected"),
        },
      ]
      break
    case DeviceTypes.MACH1:
      steps = [
        {
          name: "Start Onboarding",
          type: "image",
          source: glassesImage,
          transition: false,
          title: translate("common:success"),
          // subtitle: translate("onboarding:mach1Connected"),
        },
      ]
      break
    case DeviceTypes.NEX:
      steps = [
        {
          name: "Start Onboarding",
          type: "image",
          source: glassesImage,
          transition: false,
          title: translate("common:success"),
          // subtitle: translate("onboarding:nexConnected"),
        },
      ]
      break
    case DeviceTypes.G1:
    default:
      steps = [
        {
          name: "Start Onboarding",
          type: "image",
          source: glassesImage,
          containerClassName: "px-12",
          transition: false,
          title: translate("common:success"),
          subtitle: translate("onboarding:g1Connected"),
        },
      ]
      break
  }

  // initialize the stack:
  useEffect(() => {
    getStack()
  }, [])

  useEffect(() => {
    const updateButtonText = async () => {
      console.log("PAIR_SUCCESS: stack", stack)
      console.log("STACK LENGTH", stack.length)
      if (stack.length > 0) {
        setButtonText(translate("onboarding:continueSetup"))
      }
    }
    updateButtonText()
  }, [stack])

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <OnboardingGuide
        steps={steps}
        autoStart={true}
        showCloseButton={false}
        showSkipButton={false}
        startButtonText={buttonText}
        endButtonText={buttonText}
        endButtonFn={handleContinue}
      />
    </Screen>
  )
}