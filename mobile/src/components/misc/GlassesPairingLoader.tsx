import {useEffect, useRef, useState} from "react"
import {View, Animated, Easing, ViewStyle, TextStyle, Image, ImageStyle} from "react-native"

import {Button, Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {getGlassesImage, getEvenRealitiesG1Image} from "@/utils/getGlassesImage"
import {useAppTheme} from "@/utils/useAppTheme"

import {getModelSpecificTips} from "./GlassesTroubleshootingModal"

interface GlassesPairingLoaderProps {
  glassesModelName: string
  deviceName?: string
  onCancel?: () => void
}

const GlassesPairingLoader: React.FC<GlassesPairingLoaderProps> = ({glassesModelName, deviceName, onCancel}) => {
  const {theme, themed} = useAppTheme()

  // Animation values
  const progressAnim = useRef(new Animated.Value(0)).current

  const [currentTipIndex, setCurrentTipIndex] = useState(0)
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const tips = getModelSpecificTips(glassesModelName)

  // Set up animations
  useEffect(() => {
    // Progress bar animation
    Animated.timing(progressAnim, {
      toValue: 85,
      duration: 75000,
      useNativeDriver: false,
      easing: Easing.out(Easing.exp),
    }).start()

    // Set up fact rotator
    const rotateTips = () => {
      tipTimerRef.current = setTimeout(() => {
        setCurrentTipIndex(prevIndex => (prevIndex + 1) % tips.length)
        rotateTips()
      }, 8000) // Change tip every 8 seconds
    }

    rotateTips()

    return () => {
      if (tipTimerRef.current) {
        clearTimeout(tipTimerRef.current)
      }
    }
  }, [])

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ["0%", "100%"],
  })

  // Use dynamic image for Even Realities G1 based on style and color
  let glassesImage = getGlassesImage(glassesModelName)
  if (
    glassesModelName &&
    (glassesModelName === "Even Realities G1" || glassesModelName === "evenrealities_g1" || glassesModelName === "g1")
  ) {
    // For pairing, we don't have style/color info yet, so use defaults
    // If battery level is available in props or context, pass it; otherwise, pass undefined
    glassesImage = getEvenRealitiesG1Image("Round", "Grey", "folded", "l", theme.isDark, undefined)
  }

  return (
    <View style={themed($outerContainer)}>
      <View style={themed($container)}>
        {/* Title */}
        <Text style={themed($title)}>
          {glassesModelName}
          {deviceName && deviceName !== "NOTREQUIREDSKIP" ? ` - ${deviceName}` : ""}
        </Text>

        {/* Glasses image */}
        <View style={themed($imageContainer)}>
          <Image source={glassesImage} style={themed($glassesImageNew)} resizeMode="contain" />
        </View>

        {/* Progress bar */}
        <View style={themed($progressBarContainer)}>
          <Animated.View style={[themed($progressBar), {width: progressWidth}]} />
        </View>

        {/* Instruction text */}
        <Text style={themed($instructionText)}>{tips[currentTipIndex].body}</Text>

        {/* Cancel button */}
        {onCancel && (
          <View style={themed($buttonContainer)}>
            <Button preset="alternate" compact tx="common:cancel" onPress={onCancel} style={themed($cancelButton)} />
          </View>
        )}
      </View>
    </View>
  )
}

const $outerContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  gap: spacing.s4,
})

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s6,
  borderWidth: 1,
  borderColor: colors.border,
  padding: spacing.s6,
  gap: spacing.s4,
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 20,
  fontWeight: "600",
  color: colors.text,
  textAlign: "center",
  lineHeight: 28,
})

const $imageContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  justifyContent: "center",
  paddingVertical: spacing.s4,
  minHeight: 150,
})

const $glassesImageNew: ThemedStyle<ImageStyle> = () => ({
  width: "100%",
  height: 140,
  resizeMode: "contain",
})

const $progressBarContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  width: "100%",
  height: 12,
  borderRadius: 6,
  backgroundColor: colors.separator,
  overflow: "hidden",
})

const $progressBar: ThemedStyle<ViewStyle> = () => ({
  height: "100%",
  borderRadius: 6,
  backgroundColor: "#10b981", // Green color for progress
})

const $instructionText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  fontWeight: "400",
  color: colors.textDim,
  textAlign: "center",
  paddingHorizontal: spacing.s4,
  lineHeight: 20,
})

const $buttonContainer: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "flex-end",
})

const $cancelButton: ThemedStyle<ViewStyle> = () => ({
  minWidth: 100,
})

export default GlassesPairingLoader
