import {ControllerTypes, DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import {Platform} from "react-native"
import {useRoute} from "@react-navigation/native"

import {Screen} from "@/components/ignite"
import {focusEffectPreventBack, usePushUnder} from "@/contexts/NavigationHistoryContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useNavigationStore} from "@/stores/navigation"
import {getAr99ImageSource, getGlassesImage} from "@/utils/getGlassesImage"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {translate} from "@/i18n"
import {useCallback, useEffect, useRef, useState} from "react"
import {toolkit} from "@mentra/island"

export default function PairingSuccessScreen() {
  const {clearHistoryAndGoHome, push} = useNavigationStore.getState()
  const pushUnder = usePushUnder()
  const route = useRoute()
  const {deviceModel: routeDeviceModel, ar99ProjectName} = (route.params as {deviceModel?: string; ar99ProjectName?: string}) || {}
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [buttonText, setButtonText] = useState<string>(translate("common:continue"))
  const [isStackReady, setIsStackReady] = useState(false)
  const stackPromiseRef = useRef<Promise<string[]> | null>(null)

  focusEffectPreventBack()

  // Use route params first (immediately available), fall back to settings store
  const deviceModel = routeDeviceModel || defaultWearable
  if (!routeDeviceModel) {
    console.warn("PAIR_SUCCESS: No deviceModel in route params, falling back to defaultWearable:", defaultWearable)
  } else {
    console.log("PAIR_SUCCESS: Using deviceModel from route params:", routeDeviceModel)
  }

  const glassesImage = deviceModel === DeviceTypes.AR99 ? getAr99ImageSource(ar99ProjectName) : getGlassesImage(deviceModel)

  const buildLiveStack = useCallback(async (): Promise<string[]> => {
    const features = getModelCapabilities(deviceModel as DeviceTypes)
    if (!features.hasOta) {
      return []
    }
    // OTA check runs on the phone; WiFi is only required after an update is confirmed (see check-for-updates).
    let bluetoothClassicConnected = await toolkit.pairing.waitForBluetoothClassic({timeoutMs: 1000})
    // Android pairs Bluetooth Classic at the native stack level, so that screen is never needed there.
    if (Platform.OS === "android") {
      bluetoothClassicConnected = true
    }
    const order = ["/pairing/btclassic", "/wifi/scan", "/ota/check-for-updates", "/onboarding/live", "/onboarding/os"]
    const newStack: string[] = []
    if (!bluetoothClassicConnected) {
      newStack.push("/pairing/btclassic")
    }
    newStack.push("/ota/check-for-updates")
    newStack.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    return newStack
  }, [deviceModel])

  useEffect(() => {
    stackPromiseRef.current = buildLiveStack().then((routes) => {
      setIsStackReady(true)
      return routes
    })
  }, [buildLiveStack])

  const handleContinue = async () => {
    const routes = await (stackPromiseRef.current ?? buildLiveStack())
    console.log("PAIR_SUCCESS: stack", routes)
    clearHistoryAndGoHome()
    if (routes.length === 0) {
      return
    }
    let stackCopy = routes.slice()
    const first = stackCopy.shift()
    push(first!)
    for (let i = stackCopy.length - 1; i >= 0; i--) {
      pushUnder(stackCopy[i])
    }
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
    case DeviceTypes.G2:
      steps = [
        {
          name: "Start Onboarding",
          type: "image",
          source: glassesImage,
          containerClassName: "px-12",
          transition: false,
          title: translate("common:success"),
          subtitle: translate("onboarding:g2Connected"),
        },
      ]
      break
    case DeviceTypes.NIMO:
      steps = [
        {
          name: "Start Onboarding",
          type: "image",
          source: glassesImage,
          containerClassName: "px-12",
          transition: false,
          title: translate("common:success"),
          subtitle: translate("onboarding:nimoConnected"),
        },
      ]
      break
    case DeviceTypes.AR99:
      steps = [
        {
          name: "Start Onboarding",
          type: "image",
          source: glassesImage,
          containerClassName: "px-12",
          transition: false,
          title: translate("common:success"),
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
    case ControllerTypes.R1:
      steps = [
        {
          name: "Start Onboarding",
          type: "image",
          source: glassesImage,
          transition: false,
          title: translate("common:success"),
          subtitle: translate("onboarding:r1Connected"),
        },
      ]
      break
  }

  useEffect(() => {
    if (isStackReady) {
      setButtonText(translate("onboarding:continueSetup"))
    }
  }, [isStackReady])

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
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

