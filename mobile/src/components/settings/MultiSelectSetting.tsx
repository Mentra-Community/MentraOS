import {View, ViewStyle, TextStyle, TouchableOpacity} from "react-native"

import {Text} from "@/components/ignite"
import CheckBox from "@/components/misc/CheckBox"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type Option = {
  label: string
  value: string
}

type MultiSelectSettingProps = {
  label: string
  values: string[]
  options: Option[]
  onValueChange: (selectedValues: string[]) => void
  isFirst?: boolean
  isLast?: boolean
}

const MultiSelectSetting: React.FC<MultiSelectSettingProps> = ({
  label,
  values = [],
  options,
  onValueChange,
  isFirst,
  isLast,
}) => {
  const {theme, themed} = useAppTheme()

  const groupedStyle: ViewStyle | undefined =
    isFirst !== undefined || isLast !== undefined
      ? {
          borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
          borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
          borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
          borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
          marginBottom: isLast ? 0 : theme.spacing.s2,
        }
      : undefined

  const toggleValue = (value: string) => {
    if (values.includes(value)) {
      onValueChange(values.filter(v => v !== value))
    } else {
      onValueChange([...values, value])
    }
  }

  return (
    <View style={[themed($container), groupedStyle]}>
      <Text style={themed($label)}>{label}</Text>
      {options.map(opt => (
        <TouchableOpacity key={opt.value} style={themed($option)} onPress={() => toggleValue(opt.value)}>
          <CheckBox checked={values.includes(opt.value)} onChange={() => toggleValue(opt.value)} />
          <Text style={themed($optionLabel)}>{opt.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: "100%",
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
})

const $label: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  fontWeight: "600",
  color: colors.text,
  marginBottom: spacing.s2,
})

const $option: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  marginVertical: spacing.s1,
})

const $optionLabel: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.text,
  marginLeft: spacing.s2,
})

export default MultiSelectSetting
