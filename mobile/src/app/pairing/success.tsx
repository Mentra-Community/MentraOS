import {useLocalSearchParams} from "expo-router"
import {View, ViewStyle, Image, ImageStyle, TextStyle} from "react-native"

import {EvenRealitiesLogo} from "@/components/brands/EvenRealitiesLogo"
import {MentraLogo} from "@/components/brands/MentraLogo"
import {VuzixLogo} from "@/components/brands/VuzixLogo"
import {Screen, Text} from "@/components/ignite"
import {Button} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {$styles, ThemedStyle} from "@/theme"
import {getGlassesImage} from "@/utils/getGlassesImage"
import {useAppTheme} from "@/utils/useAppTheme"

import {DeviceTypes} from "@/../../cloud/packages/types/src"

export default function PairingSuccessScreen() {
  const {theme, themed} = useAppTheme()
  const {clearHistoryAndGoHome} = useNavigationHistory()
  const {glassesModelName} = useLocalSearchParams<{glassesModelName: string}>()

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

  const glassesImage = getGlassesImage(glassesModelName)

  return (
    <Screen preset="fixed" style={themed($styles.screen)} safeAreaEdges={["bottom"]}>
      <View style={{flex: 1}} />

      {/* Glasses Image with Logo on top */}
      <View style={themed($imageContainer)}>
        {/* Manufacturer Logo */}
        <View style={themed($logoContainer)}>{getManufacturerLogo(glassesModelName)}</View>

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
      <Button preset="primary" text="Go to home" onPress={clearHistoryAndGoHome} style={themed($continueButton)} />
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
