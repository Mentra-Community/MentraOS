import {View, TouchableOpacity, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export interface RadioOption {
  value: string
  label: string
}

export interface RadioGroupProps {
  options: RadioOption[]
  value: string
  onValueChange: (value: string) => void
  style?: ViewStyle
}

export function RadioGroup({options, value, onValueChange, style}: RadioGroupProps) {
  const {themed} = useAppTheme()

  return (
    <View style={[themed($container), style]}>
      {options.map(option => (
        <TouchableOpacity
          key={option.value}
          style={themed($option(value === option.value))}
          onPress={() => onValueChange(option.value)}
          activeOpacity={0.7}>
          <View style={themed($radioOuter(value === option.value))}>
            {value === option.value && <View style={themed($radioInner)} />}
          </View>
          <Text style={themed($label)}>{option.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  gap: spacing.s3,
})

const $option: (selected: boolean) => ThemedStyle<ViewStyle> =
  selected =>
  ({colors, spacing}) => ({
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.s4,
    borderRadius: spacing.s3,
    borderWidth: 1.5,
    borderColor: selected ? colors.primary : colors.border,
    backgroundColor: selected ? `${colors.primary}10` : colors.background,
    gap: spacing.s3,
  })

const $radioOuter: (selected: boolean) => ThemedStyle<ViewStyle> =
  selected =>
  ({colors}) => ({
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: selected ? colors.primary : colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
  })

const $radioInner: ThemedStyle<ViewStyle> = ({colors}) => ({
  width: 10,
  height: 10,
  borderRadius: 5,
  backgroundColor: colors.primary,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
})
