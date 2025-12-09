// GlassesPairingGuides.tsx

import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {MaterialCommunityIcons} from "@expo/vector-icons"
import {useEffect, useState} from "react"
import {View, Image, TouchableOpacity, Linking, ImageStyle, ViewStyle, TextStyle} from "react-native"
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated"

import {GlassesFeatureList} from "@/components/glasses/GlassesFeatureList"
import {Button, Text} from "@/components/ignite"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import GlassesTroubleshootingModal from "@/components/misc/GlassesTroubleshootingModal"
import {Spacer} from "@/components/ui/Spacer"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"
import {showAlert} from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"

export function MentraNextGlassesPairingGuide() {
  const {theme, themed} = useAppTheme()

  // Animation values
  const glassesOpacity = useSharedValue(1)
  const glassesTranslateY = useSharedValue(0)
  const glassesScale = useSharedValue(1)
  const caseOpacity = useSharedValue(1)
  const arrowOpacity = useSharedValue(0)
  const finalImageOpacity = useSharedValue(0)

  useEffect(() => {
    const resetValues = () => {
      glassesOpacity.value = 1
      glassesTranslateY.value = 0
      glassesScale.value = 1
      caseOpacity.value = 1
      arrowOpacity.value = 0
      finalImageOpacity.value = 0
    }

    const startAnimation = () => {
      resetValues()
      glassesTranslateY.value = withDelay(
        500,
        withTiming(160, {
          duration: 1800,
          easing: Easing.out(Easing.cubic),
        }),
      )

      glassesScale.value = withDelay(
        500,
        withTiming(0.7, {
          duration: 1200,
          easing: Easing.out(Easing.cubic),
        }),
      )

      glassesOpacity.value = withDelay(1000, withTiming(0, {duration: 400}))

      finalImageOpacity.value = withDelay(
        1000,
        withTiming(1, {duration: 600}, finished => {
          if (finished) {
            finalImageOpacity.value = withDelay(
              1000,
              withTiming(0, {duration: 400}, finished => {
                if (finished) {
                  runOnJS(startAnimation)()
                }
              }),
            )
            glassesTranslateY.value = 0
            glassesScale.value = 1
            glassesOpacity.value = withDelay(1000, withTiming(1, {duration: 400}))
          }
        }),
      )
    }

    const timer = setTimeout(startAnimation, 300)
    return () => clearTimeout(timer)
  }, [])

  const animatedGlassesStyle = useAnimatedStyle(() => ({
    opacity: glassesOpacity.value,
    transform: [{translateY: glassesTranslateY.value}, {scale: glassesScale.value}],
  }))

  const animatedCaseStyle = useAnimatedStyle(() => ({
    opacity: caseOpacity.value,
  }))

  const animatedArrowStyle = useAnimatedStyle(() => ({
    opacity: arrowOpacity.value,
  }))

  const animatedFinalImageStyle = useAnimatedStyle(() => ({
    opacity: finalImageOpacity.value,
  }))

  return (
    <View style={themed($guideContainer)}>
      <Text
        text="1. Disconnect your MentraNex from within the MentraNex app, or uninstall the MentraNex app"
        style={themed($guideStep)}
      />
      <Text text="2. Place your MentraNex in the charging case with the lid open." style={themed($guideStep)} />

      <View style={themed($animationContainer)}>
        {/* Glasses Image - Animated */}
        <Animated.View style={[themed($glassesContainer), animatedGlassesStyle]}>
          <Image source={require("../../../assets/glasses/g1.png")} style={themed($glassesImage)} />
        </Animated.View>

        {/* Case Image - Fades in */}
        <Animated.View style={[themed($caseContainer), animatedCaseStyle]}>
          <Image source={require("../../../assets/guide/image_g1_case_closed.png")} style={themed($caseImage)} />
        </Animated.View>

        {/* Arrow - Appears and disappears */}
        <Animated.View style={[themed($arrowContainer), animatedArrowStyle]}>
          <MaterialCommunityIcons name="arrow-down" size={36} color={theme.colors.text} />
        </Animated.View>

        {/* Final paired image - Fades in at the end */}
        <Animated.View style={[themed($caseContainer), animatedFinalImageStyle]}>
          <Image source={require("../../../assets/guide/image_g1_pair.png")} style={themed($caseImage)} />
        </Animated.View>
      </View>
    </View>
  )
}

export function G1PairingGuide() {
  const {theme, themed} = useAppTheme()

  return (
    <View style={themed($guideContainer)}>
      <View style={themed($animationContainer)}>
        <Image source={require("../../../assets/glasses/g1.png")} style={themed($glassesImage)} />
        <MaterialCommunityIcons name="arrow-down" size={36} color={theme.colors.text} />
        <Image source={require("../../../assets/guide/image_g1_pair.png")} style={themed($caseImage)} />
      </View>

      <Spacer height={theme.spacing.s6} />

      <View style={{justifyContent: "flex-start", flexDirection: "column"}}>
        <Text tx="pairing:instructions" style={themed($guideTitle)} />
        <Text
          text="1. Disconnect your G1 from within the Even Realities app, or uninstall the Even Realities app"
          style={themed($guideStep)}
        />
        <Text text="2. Place your G1 in the charging case with the lid open." style={themed($guideStep)} />
      </View>
    </View>
  )
}

const $guideContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginTop: spacing.s6,
  width: "100%",
  alignSelf: "center",
  flex: 1,
  justifyContent: "space-between",
})

const $guideTitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 24,
  fontWeight: "bold",
  marginBottom: spacing.s3 + 2,
  color: colors.text,
})

const $guideStep: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  marginBottom: spacing.s3,
  color: colors.text,
})

const $guideDescription: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  lineHeight: 20,
  marginBottom: spacing.s6,
  marginTop: spacing.s6,
  color: colors.text,
})

const $guideImage: ThemedStyle<ImageStyle> = ({spacing}) => ({
  height: 180,
  marginVertical: spacing.s4,
  resizeMode: "contain",
  width: "100%",
})

const $buySection: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginTop: spacing.s4,
})

const $preorderButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  alignItems: "center",
  borderRadius: 30,
  justifyContent: "center",
  minHeight: 44,
  paddingHorizontal: 12,
  paddingVertical: 12,
  width: "100%",
  backgroundColor: colors.tint,
})

const $buyButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.background,
})

const $shippingText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  marginTop: 4,
  color: colors.background,
  opacity: 0.8,
})

// const $noteSection: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
//   width: "100%",
//   borderRadius: spacing.s4,
//   marginTop: spacing.s4,
//   alignItems: "center",
//   backgroundColor: colors.primary_foreground,
//   padding: spacing.s6,
// })

const $animationContainer: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  // height: 400,
  // marginVertical: spacing.s6,
  position: "relative",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
})

const $glassesContainer: ThemedStyle<ViewStyle> = () => ({
  position: "absolute",
  top: 0,
  zIndex: 3,
  alignItems: "center",
  width: "100%",
})

const $glassesImage: ThemedStyle<ImageStyle> = () => ({
  width: 200,
  height: 100,
  resizeMode: "contain",
})

const $caseContainer: ThemedStyle<ViewStyle> = () => ({
  position: "absolute",
  bottom: 50,
  zIndex: 1,
  alignItems: "center",
  width: "100%",
})

const $caseImage: ThemedStyle<ImageStyle> = () => ({
  width: 250,
  height: 150,
  resizeMode: "contain",
})

const $arrowContainer: ThemedStyle<ViewStyle> = () => ({
  position: "absolute",
  top: "45%",
  zIndex: 2,
  alignItems: "center",
  width: "100%",
})

export function MentraMach1PairingGuide() {
  const {themed} = useAppTheme()

  return (
    <View style={themed($guideContainer)}>
      <Text text="Mentra Mach1" style={themed($guideTitle)} weight="bold" />
      <Text text="1. Make sure your Mach1 is fully charged and turned on." style={themed($guideStep)} />
      <Text
        text="2. Make sure your device is running the latest firmware by using the Vuzix Connect app."
        style={themed($guideStep)}
      />
      <Text
        text="3. Put your Mentra Mach1 in pairing mode: hold the power button until you see the Bluetooth icon, then release."
        style={themed($guideStep)}
      />
    </View>
  )
}

export function MentraLivePairingGuide() {
  const {themed} = useAppTheme()

  return (
    <View style={themed($guideContainer)}>
      <View style={{justifyContent: "flex-start", flexDirection: "column"}}>
        <Text text="Mentra Live" style={themed($guideTitle)} />

        {/* Product image would go here */}
        <Image
          source={require("../../../assets/glasses/mentra_live/mentra_live.png")}
          style={themed($guideImage)}
          onError={() => console.log("Image failed to load")}
        />

        {/* Feature list */}
        <GlassesFeatureList glassesModel="Mentra Live" />

        {/* Marketing description */}
        <Text
          text="Mentra Live brings the power of computer vision to your everyday life. With a camera that sees what you see, you can build and run AI apps that recognize objects, translate text, remember faces, and more. Perfect for developers creating the next generation of augmented reality experiences."
          style={themed($guideDescription)}
        />

        <View style={themed($buySection)}>
          <TouchableOpacity
            style={themed($preorderButton)}
            onPress={() => {
              showAlert("Open External Website", "This will open mentra.glass in your web browser. Continue?", [
                {
                  text: "Cancel",
                  style: "cancel",
                },
                {
                  text: "Continue",
                  onPress: () => Linking.openURL("https://mentra.glass"),
                },
              ])
            }}>
            <Text text={`${translate("pairing:preorderNow")}`} style={themed($buyButtonText)} weight="bold" />
            <Text tx="pairing:preorderNowShipMessage" style={themed($shippingText)} />
          </TouchableOpacity>
          <Spacer height={16} />
        </View>
      </View>
    </View>
  )
}

export function AudioWearablePairingGuide() {
  const {themed} = useAppTheme()

  return (
    <View style={themed($guideContainer)}>
      <Text text="Audio Wearable" style={themed($guideTitle)} />
      <Text text="1. Make sure your Audio Wearable is fully charged and turned on." style={themed($guideStep)} />
      <Text text="2. Enable Bluetooth pairing mode on your Audio Wearable." style={themed($guideStep)} />
      <Text
        text="3. Note: Audio Wearables don't have displays. All visual information will be converted to speech."
        style={themed($guideStep)}
      />
      <Text
        text="Audio Wearables are smart glasses without displays. They use text-to-speech to provide information that would normally be shown visually. This makes them ideal for audio-only applications or for users who prefer auditory feedback."
        style={themed($guideDescription)}
      />
    </View>
  )
}

export function VuzixZ100PairingGuide() {
  const {themed} = useAppTheme()

  return (
    <View style={themed($guideContainer)}>
      <Text text="Vuzix Z100" style={themed($guideTitle)} />
      <Text text="1. Make sure your Vuzix Z100 is fully charged and turned on." style={themed($guideStep)} />
      <Text
        text="2. Make sure your device is running the latest firmware by using the Vuzix Connect app."
        style={themed($guideStep)}
      />
      <Text
        text="3. Put your Vuzix Z100 in pairing mode: hold the power button until you see the Bluetooth icon, then release."
        style={themed($guideStep)}
      />
    </View>
  )
}

export function SimulatedPairingGuide() {
  const {themed} = useAppTheme()
  return (
    <View style={themed($guideContainer)}>
      <Text text="Preview MentraOS" style={themed($guideTitle)} />

      <GlassesDisplayMirror demoText="Simulated glasses display" />

      <Text
        text="Experience the full power of MentraOS without physical glasses. Simulated Glasses provides a virtual display that mirrors exactly what you would see on real smart glasses."
        style={themed($guideDescription)}
      />

      {/* <View style={themed($noteSection)}>
        <View style={{flex: 1, flexDirection: "row", gap: theme.spacing.s4, marginBottom: theme.spacing.s4}}>
          <Image
            source={require("@assets/glasses/mentra_live/mentra_live.png")}
            style={[themed($guideImage), {width: 80, height: 80}]}
            onError={() => console.log("Image failed to load")}
          />
          <View style={{flex: 1, flexDirection: "column", gap: theme.spacing.s4}}>
            <Text text="Mentra Live" />
            <Text tx="pairingGuide:mentraLivePreorder" />
          </View>
        </View>

        <Button
          preset="alternate"
          flexContainer
          // compact
          tx="common:learnMore"
          onPress={() => {
            showAlert("Open External Website", "This will open mentraglass.com in your web browser. Continue?", [
              {
                text: "Cancel",
                style: "cancel",
              },
              {
                text: "Continue",
                onPress: () => Linking.openURL("https://mentraglass.com/"),
              },
            ])
          }}
        />
      </View> */}
    </View>
  )
}

export function BrilliantLabsFramePairingGuide() {
  const {themed, theme} = useAppTheme()

  return (
    <View style={themed($guideContainer)}>
      <Text text="Brilliant Labs Frame" style={themed($guideTitle)} />

      {/* Placeholder image - will be replaced with actual image */}
      <View
        style={[
          themed($guideImage),
          {backgroundColor: theme.colors.border, justifyContent: "center", alignItems: "center"},
        ]}>
        <Text text="Frame" style={{color: theme.colors.text, fontSize: 24}} />
      </View>

      {/* Feature list */}
      <GlassesFeatureList glassesModel="Brilliant Labs Frame" />

      {/* Pairing instructions */}
      <Text text="1. Make sure your Frame is charged and powered on" style={themed($guideStep)} />
      <Text text="2. Frame will appear in the device list when scanning" style={themed($guideStep)} />
      <Text text="3. Select your Frame device to connect" style={themed($guideStep)} />

      {/* Marketing description */}
      <Text
        text="Brilliant Labs Frame brings AI-powered AR to everyday eyewear. With an integrated display, camera, and microphone, Frame enables real-time visual augmentation and AI assistance directly in your field of view."
        style={themed($guideDescription)}
      />
    </View>
  )
}

export const PairingGuide = ({model}: {model: string}) => {
  switch (model) {
    case DeviceTypes.G1:
      return <G1PairingGuide />
    case DeviceTypes.NEX:
      return <MentraNextGlassesPairingGuide />
    case DeviceTypes.Z100:
      return <VuzixZ100PairingGuide />
    case DeviceTypes.LIVE:
      return <MentraLivePairingGuide />
    case DeviceTypes.MACH1:
      return <MentraMach1PairingGuide />
    case DeviceTypes.SIMULATED:
      return <SimulatedPairingGuide />
    case DeviceTypes.FRAME:
      return <BrilliantLabsFramePairingGuide />
    default:
      return <View />
  }
}

export const PairingOptions = ({model, continueFn}: {model: string; continueFn?: () => void}) => {
  const {themed} = useAppTheme()
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  switch (model) {
    case DeviceTypes.G1:
      return (
        <>
          <View style={themed($buttonsContainer)}>
            <Button tx="pairing:g1Ready" onPress={continueFn} />
            <Button tx="pairing:g1NotReady" preset="secondary" onPress={() => setShowTroubleshootingModal(true)} />
          </View>
          <GlassesTroubleshootingModal
            isVisible={showTroubleshootingModal}
            onClose={() => setShowTroubleshootingModal(false)}
            glassesModelName={model}
          />
        </>
      )
    default:
      return (
        <View style={themed($buttonsContainer)}>
          <Button tx="common:continue" onPress={continueFn} />
        </View>
      )
  }
}

const $buttonsContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  gap: spacing.s6,
  marginBottom: spacing.s6,
})
