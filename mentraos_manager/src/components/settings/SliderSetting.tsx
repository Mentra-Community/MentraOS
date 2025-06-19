import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import React from "react"
import {View, StyleSheet, ViewStyle, TextStyle} from "react-native"
import {Slider} from "react-native-elements"
import {Text} from "@/components/ignite"

type Theme = {
  backgroundColor: string
  textColor: string
}

type SliderSettingProps = {
  label: string
  subtitle?: string
  value: number | undefined // Allow undefined if value might not always be set
  min: number
  max: number
  onValueChange: (value: number) => void // For immediate feedback, e.g., UI updates
  onValueSet: (value: number) => void // For BLE requests or final actions
  containerStyle?: ViewStyle
}

const SliderSetting: React.FC<SliderSettingProps> = ({
  label,
  subtitle,
  value = 0, // Default value if not provided
  min,
  max,
  onValueChange,
  onValueSet,
  containerStyle,
}) => {
  const handleValueChange = (val: number) => {
    const roundedValue = Math.round(val)
    onValueChange(roundedValue) // Emit only integer values
  }

  const handleValueSet = (val: number) => {
    const roundedValue = Math.round(val)
    onValueSet(roundedValue) // Emit only integer values
  }

  const {theme, themed} = useAppTheme()

  return (
    <View style={[themed($container), containerStyle]}>
      <View style={themed($textContainer)}>
        <View style={themed($labelRow)}>
          <Text text={label} style={themed($label)} />
          <Text text={String(value || 0)} style={themed($valueText)} />
        </View>
        {subtitle && <Text text={subtitle} style={themed($subtitle)} />}
      </View>
      <View style={themed($sliderRow)}>
        <Text text={String(min)} style={themed($minMaxText)} />
        <View style={themed($sliderContainer)}>
          <Slider
            style={themed($slider)}
            value={value || 0} // Fallback to 0 if undefined
            onValueChange={handleValueChange} // Wrap the callback to round values
            onSlidingComplete={handleValueSet} // Wrap the callback to round values
            minimumValue={min}
            maximumValue={max}
            minimumTrackTintColor={theme.colors.palette.primary300}
            maximumTrackTintColor={theme.colors.palette.neutral300}
            thumbStyle={{
              width: 24,
              height: 24,
              backgroundColor: theme.colors.sliderThumb,
            }}
          />
        </View>
        <Text text={String(max)} style={themed($minMaxText)} />
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "column",
  justifyContent: "flex-start",
  alignItems: "flex-start",
  width: "100%",
  backgroundColor: colors.background,
  paddingVertical: spacing.md,
  paddingHorizontal: spacing.lg,
  borderRadius: spacing.sm,
})

const $textContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "flex-start",
  gap: 4,
  width: "100%",
  marginBottom: 8,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  color: colors.text,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.textDim,
})

const $sliderRow: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.xs,
  width: "100%",
})

const $sliderContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
})

const $slider: ThemedStyle<ViewStyle> = ({colors}) => ({
  width: "100%",
  height: 40,
})

const $labelRow: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  width: "100%",
})

const $valueText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  color: colors.textDim,
  fontWeight: "500",
})

const $minMaxText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.textDim,
  minWidth: 25,
  textAlign: "center",
})

export default SliderSetting
