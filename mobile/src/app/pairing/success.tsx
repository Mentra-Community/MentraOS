import {engine, SETTINGS, useSetting} from "@mentra/engine"
import {useRoute} from "@react-navigation/native"
import {useCallback, useEffect, useRef, useState} from "react"
import {Platform} from "react-native"

import {ControllerTypes, DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import {Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {focusEffectPreventBack, usePushUnder} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {getGlassesImage} from "@/utils/getGlassesImage"

export default function PairingSuccessScreen() {
  const {clearHistoryAndGoHome, push} = useNavigationStore.getState()
  const pushUnder = usePushUnder()
  const route = useRoute()
  const {deviceModel: routeDeviceModel} = (route.params as {deviceModel?: string}) || {}
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [onboardingEvenRealitiesCompleted] = useSetting<boolean>(SETTINGS.onboarding_even_realities_completed.key)
  const [onboardingOsCompleted] = useSetting<boolean>(SETTINGS.onboarding_os_completed.key)
  const [hasSetupRoutes, setHasSetupRoutes] = useState(false)
  const stackPromiseRef = useRef<Promise<string[]> | null>(null)
  const buttonText = translate(hasSetupRoutes ? "onboarding:continueSetup" : "common:continue")

  focusEffectPreventBack()

  // Use route params first (immediately available), fall back to settings store
  const deviceModel = routeDeviceModel || defaultWearable
  if (!routeDeviceModel) {
    console.warn("PAIR_SUCCESS: No deviceModel in route params, falling back to defaultWearable:", defaultWearable)
  } else {
    console.log("PAIR_SUCCESS: Using deviceModel from route params:", routeDeviceModel)
  }

  const glassesImage = getGlassesImage(deviceModel)

  const buildSetupStack = useCallback(async (): Promise<string[]> => {
    const features = getModelCapabilities(deviceModel as DeviceTypes)
    if (!features.hasOta) {
      const routes: string[] = []
      if (!onboardingEvenRealitiesCompleted && (deviceModel === DeviceTypes.G1 || deviceModel === DeviceTypes.G2)) {
        routes.push("/onboarding/even-realities")
      }
      if (!onboardingOsCompleted) {
        routes.push("/onboarding/os")
      }
      return routes
    }
    // OTA check runs on the phone; WiFi is only required after an update is confirmed (see check-for-updates).
    let bluetoothClassicConnected = await engine.pairing.waitForBluetoothClassic({timeoutMs: 1000})
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
  }, [deviceModel, onboardingEvenRealitiesCompleted, onboardingOsCompleted])

  useEffect(() => {
    stackPromiseRef.current = buildSetupStack().then((routes) => {
      setHasSetupRoutes(routes.length > 0)
      return routes
    })
  }, [buildSetupStack])

  const handleContinue = async () => {
    const routes = await (stackPromiseRef.current ?? buildSetupStack())
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
