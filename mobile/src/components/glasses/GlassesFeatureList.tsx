import {DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import {View, ViewStyle, TextStyle, ImageStyle} from "react-native"

import {Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle} from "@/theme"

interface GlassesFeatureListProps {
  glassesModel: string
}

export type GlassesFeature = "camera" | "microphone" | "speakers" | "display"

const featureLabels: Record<GlassesFeature, string> = {
  camera: "Camera",
  microphone: "Microphone",
  speakers: "Speakers",
  display: "Display",
}

export function GlassesFeatureList({glassesModel}: GlassesFeatureListProps) {
  const {theme, themed} = useAppTheme()
  const capabilities = getModelCapabilities(glassesModel as DeviceTypes)

  if (!capabilities) {
    console.warn(`No capabilities defined for glasses model: ${glassesModel}`)
    return null
  }

  const featureOrder: GlassesFeature[] = ["camera", "microphone", "speakers", "display"]

  const getFeatureValue = (feature: GlassesFeature): boolean => {
    switch (feature) {
      case "camera":
        return capabilities.hasCamera
      case "microphone":
        return capabilities.hasMicrophone
      case "speakers":
        return capabilities.hasSpeaker
      case "display":
        return capabilities.hasDisplay
      default:
        return false
    }
  }

  return (
    <View className="my-4 w-70 self-center">
      <View className="flex-row mb-2">
        {featureOrder.slice(0, 2).map((feature) => (
          <View key={feature} className="gap-2 flex-row items-center w-1/2">
            <Icon name={getFeatureValue(feature) ? "check" : "x"} size={24} color={theme.colors.secondary_foreground} />
            <Text text={featureLabels[feature]} className="text-sm font-medium" />
          </View>
        ))}
      </View>
      <View className="flex-row">
        {featureOrder.slice(2, 4).map((feature) => (
          <View key={feature} className="gap-2 flex-row items-center w-1/2">
            <Icon name={getFeatureValue(feature) ? "check" : "x"} size={24} color={theme.colors.secondary_foreground} />
            <Text text={featureLabels[feature]} className="text-sm font-medium" />
          </View>
        ))}
      </View>
    </View>
  )
}