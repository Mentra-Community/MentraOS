import {View, ViewStyle, TextStyle, ImageStyle} from "react-native"

import {Icon, Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

import {DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"

interface GlassesFeatureListProps {
  glassesModel: string
}

export type GlassesFeature = "camera" | "microphone" | "speakers" | "display"

export const featureLabels: Record<GlassesFeature, string> = {
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
    <View style={themed($container)}>
      <View style={themed($featureRow)}>
        {featureOrder.slice(0, 2).map(feature => (
          <View key={feature} style={themed($featureItem)}>
            <Icon
              name={getFeatureValue(feature) ? "check" : "close"}
              size={24}
              color={theme.colors.text}
              containerStyle={themed($icon)}
            />
            <Text text={featureLabels[feature]} style={themed($featureText)} />
          </View>
        ))}
      </View>
      <View style={themed($featureRow)}>
        {featureOrder.slice(2, 4).map(feature => (
          <View key={feature} style={themed($featureItem)}>
            <Icon
              name={getFeatureValue(feature) ? "check" : "close"}
              size={24}
              color={theme.colors.text}
              containerStyle={themed($icon)}
            />
            <Text text={featureLabels[feature]} style={themed($featureText)} />
          </View>
        ))}
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  marginVertical: 20,
})

const $featureItem: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  flexDirection: "row",
  flex: 1,
})

const $featureRow: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  marginVertical: 6,
})

const $featureText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  fontWeight: "500",
  color: colors.text,
})

const $icon: ThemedStyle<ImageStyle> = () => ({
  marginRight: 10,
})
