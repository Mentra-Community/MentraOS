import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {View, ViewStyle, Image, ImageStyle, TextStyle} from "react-native"

import {EvenRealitiesLogo} from "@/components/brands/EvenRealitiesLogo"
import {MentraLogo} from "@/components/brands/MentraLogo"
import {VuzixLogo} from "@/components/brands/VuzixLogo"
import {Screen, Text, Button} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import {waitForGlassesState} from "@/stores/glasses"
import {getGlassesImage} from "@/utils/getGlassesImage"

export default function PairingSuccessScreen() {
  const {theme, themed} = useAppTheme()
  const {clearHistoryAndGoHome, pushUnder} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const {push} = useNavigationHistory()
  const [onboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)
  
  focusEffectPreventBack()

  // Get manufacturer logo component
  const getManufacturerLogo = (modelName: string) => {
    switch (modelName) {
      case DeviceTypes.G1:
        return <EvenRealitiesLogo color={theme.colors.text} />
      case DeviceTypes.LIVE:
      case DeviceTypes.MACH1:
        return <MentraLogo color={theme.colors.text} />
      case DeviceTypes.Z100:
        return <VuzixLogo color={theme.colors.text} />
      default:
        return null
    }
  }

  const glassesImage = getGlassesImage(defaultWearable)

  const handleContinue = async () => {
    if (defaultWearable === DeviceTypes.LIVE) {
      const stack = []
      const order = ["/pairing/btclassic", "/wifi/scan", "/ota/check-for-updates", "/onboarding/live", "/onboarding/os"]

      let btcConnected = await waitForGlassesState("btcConnected", (value) => value === true, 1000)
      console.log("PAIR_SUCCESS: btcConnected", btcConnected)
      
      if (!btcConnected) {
        stack.push("/pairing/btclassic")
      }
      // check if the glasses are already connected:
      // wait for the glasses to be connected to wifi for up to 1 second:
      let wifiConnected = await waitForGlassesState("wifiConnected", (value) => value === true, 1000)
      if (!wifiConnected) {
        stack.push("/wifi/scan")
      }
      stack.push("/ota/check-for-updates")
      if (!onboardingOsCompleted) {
        stack.push("/onboarding/os")
      }
      stack.push("/onboarding/live")

      // sort the stack by the order:
      stack.sort((a, b) => order.indexOf(a) - order.indexOf(b))

      console.log("PAIR_SUCCESS: stack", stack)

      // clear the history and go home so that we don't navigate back here:
      clearHistoryAndGoHome()
      // push the first element in the stack (removing it from the list):
      const first = stack.shift()
      push(first!)
      // go bottom to top and pushUnder the rest (in reverse order):
      for (let i = stack.length - 1; i >= 0; i--) {
        pushUnder(stack[i])
      }

      return
    }

    if (defaultWearable === DeviceTypes.G1) {
      if (!onboardingOsCompleted) {
        clearHistoryAndGoHome()
        push("/onboarding/os")
        return
      }
    }

    clearHistoryAndGoHome()
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <View style={{flex: 1}} />

      {/* Glasses Image with Logo on top */}
      <View style={themed($imageContainer)}>
        {/* Manufacturer Logo */}
        <View style={themed($logoContainer)}>{getManufacturerLogo(defaultWearable)}</View>

        <Spacer height={theme.spacing.s4} />

        <Image source={glassesImage} style={themed($glassesImage)} resizeMode="contain" />
      </View>

      <Spacer height={theme.spacing.s6} />

      {/* Success Message */}
      <View style={themed($messageContainer)}>
        <Text style={themed($successTitle)} tx="pairing:success" />
        <Text style={themed($successMessage)} tx="pairing:glassesConnected" />
      </View>

      <View style={{flex: 1}} />

      {/* Continue Button */}
      <Button preset="primary" tx="common:continue" onPress={handleContinue} style={themed($continueButton)} />
    </Screen>
  )
}

const $logoContainer: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  justifyContent: "center",
  minHeight: 32,
})

const $imageContainer: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  justifyContent: "center",
})

const $glassesImage: ThemedStyle<ImageStyle> = () => ({
  width: "80%",
  height: 200,
  resizeMode: "contain",
})

const $messageContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  gap: spacing.s3,
})

const $successTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 28,
  fontWeight: "600",
  lineHeight: 36,
  color: colors.text,
  textAlign: "center",
})

const $successMessage: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  color: colors.textDim,
  textAlign: "center",
})

const $continueButton: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})
