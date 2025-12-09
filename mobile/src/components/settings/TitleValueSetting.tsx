import {View, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type TitleValueSettingProps = {
  label: string
  value: string
  isFirst?: boolean
  isLast?: boolean
}

const TitleValueSetting = ({label, value, isFirst, isLast}: TitleValueSettingProps) => {
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

  return (
    <View style={[themed($container), groupedStyle]}>
      <Text text={label} style={themed($label)} />
      <Text text={value} style={themed($value)} />
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: "100%",
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  fontWeight: "600",
  color: colors.text,
})

const $value: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.textDim,
})

export default TitleValueSetting
