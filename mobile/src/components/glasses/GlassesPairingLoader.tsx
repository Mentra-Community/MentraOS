import {useEffect, useRef, useState} from "react"
import {View, Animated, Easing, Image} from "react-native"

import {Button, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {getGlassesImage, getEvenRealitiesG1Image} from "@/utils/getGlassesImage"

import {getModelSpecificTips} from "@/components/glasses/GlassesTroubleshootingModal"

interface GlassesPairingLoaderProps {
  deviceModel: string
  deviceName?: string
  onCancel?: () => void
  isBooting?: boolean
}

const GlassesPairingLoader: React.FC<GlassesPairingLoaderProps> = ({deviceModel, deviceName, onCancel, isBooting}) => {
  const {theme} = useAppTheme()
  const progressAnim = useRef(new Animated.Value(0)).current
  const [currentTipIndex, setCurrentTipIndex] = useState(0)
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const tips = getModelSpecificTips(deviceModel)

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
        setCurrentTipIndex((prevIndex) => (prevIndex + 1) % tips.length)
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
  let glassesImage = getGlassesImage(deviceModel)
  if (
    deviceModel &&
    (deviceModel === "Even Realities G1" || deviceModel === "evenrealities_g1" || deviceModel === "g1")
  ) {
    // For pairing, we don't have style/color info yet, so use defaults
    // If battery level is available in props or context, pass it; otherwise, pass undefined
    glassesImage = getEvenRealitiesG1Image("Round", "Grey", "folded", "l", theme.isDark, undefined)
  }

  return (
    <View className="flex-1 justify-center">
      <View className="bg-primary-foreground rounded-lg p-6 gap-4">
        {/* Title */}
        <Text tx="pairing:pairing" className="text-xl font-semibold text-center" />
        <Text className="text-xl text-center">
          {deviceModel}
          {deviceName && deviceName !== "NOTREQUIREDSKIP" ? ` - ${deviceName}` : ""}
        </Text>

        {/* Glasses image */}
        <View className="items-center justify-center py-4 h-[150px]">
          <Image source={glassesImage} className="w-full h-[150px]" resizeMode="contain" />
        </View>

        {/* Progress bar */}
        <View className="bg-border rounded-md h-3 w-full overflow-hidden">
          <Animated.View className="bg-primary h-full rounded-md" style={{width: progressWidth}} />
          <Animated.View
            style={{
              width: progressWidth,
              backgroundColor: theme.colors.primary,
              borderRadius: theme.spacing.s2,
              height: "100%",
            }}
          />
        </View>

        {isBooting && (
          <View className="bg-background rounded-lg py-2 px-4">
            <Text className="text-sm font-medium text-primary text-center" tx="pairing:glassesBooting" />
          </View>
        )}

        {/* Instruction text */}
        <Text className="text-sm text-muted-foreground text-center px-4">{tips[currentTipIndex].body}</Text>

        {/* Cancel button */}
        {onCancel && (
          <View className="flex-row justify-end">
            <Button preset="alternate" compact tx="common:cancel" onPress={onCancel} className="min-w-24" />
          </View>
        )}
      </View>
    </View>
  )
}

export default GlassesPairingLoader
