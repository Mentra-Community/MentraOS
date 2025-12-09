import {View, ViewStyle, TextStyle} from "react-native"

import {Switch, Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type ToggleSettingProps = {
  label: string
  subtitle?: string
  value: boolean
  onValueChange: (newValue: boolean) => void
  disabled?: boolean
  style?: ViewStyle
  icon?: React.ReactNode
  compact?: boolean
  isFirst?: boolean
  isLast?: boolean
}

const ToggleSetting: React.FC<ToggleSettingProps> = ({
  label,
  subtitle,
  value,
  onValueChange,
  disabled = false,
  style,
  icon,
  compact = false,
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

  return (
    <View
      style={[
        themed($container),
        groupedStyle,
        style,
        disabled && {opacity: 0.5},
        compact && {paddingVertical: theme.spacing.s3},
      ]}>
      <View style={themed($textContainer)}>
        <View style={{flexDirection: "row", alignItems: "center", gap: theme.spacing.s4, justifyContent: "center"}}>
          {icon && icon}
          <Text text={label} weight="semiBold" style={[themed($label), compact && {fontSize: 12}]} />
        </View>
        {subtitle && <Text text={subtitle} style={themed($subtitle)} />}
      </View>
      <Switch value={value} onValueChange={onValueChange} disabled={disabled} />
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  width: "100%",
  backgroundColor: colors.primary_foreground,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
  borderRadius: spacing.s4,
  // borderWidth: spacing.s0_5,
  // borderColor: colors.border,
})

const $textContainer: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "flex-start",
  gap: 4,
  flex: 1,
  marginRight: 16, // Add spacing between text and toggle
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.text,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.textDim,
})

export default ToggleSetting
