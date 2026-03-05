import {router as _router} from "expo-router"
import {View, TouchableOpacity, TextStyle, ViewStyle} from "react-native"

import {Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle} from "@/theme"

interface StatusCardProps {
  label: string
  text?: string
  style?: ViewStyle
  textStyle?: TextStyle
  iconStart?: React.ReactNode
  iconEnd?: React.ReactNode
  subtitle?: string
  onPress?: () => void
}

export function StatusCard({label, style, iconStart, iconEnd, textStyle, subtitle, onPress}: StatusCardProps) {
  const {theme, themed} = useAppTheme()

  // Extract flex from style to apply to TouchableOpacity wrapper
  const {flex, ...restStyle} = (style || {}) as ViewStyle & {flex?: number}

  const content = (
    <View style={[themed($settingsGroup), themed($statusCardContainer), restStyle]}>
      <View style={{flexDirection: "row", alignItems: "center", gap: theme.spacing.s4}}>
        {iconStart && <View className="justify-center items-center">{iconStart}</View>}
        <View
          style={{
            gap: theme.spacing.s1,
          }}>
          <Text style={[themed($label), textStyle]} className="font-semibold" text={label} />
          {subtitle && <Text style={themed($subtitle)} text={subtitle} />}
        </View>
      </View>
      {iconEnd && iconEnd}
    </View>
  )

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} style={flex !== undefined ? {flex} : undefined}>
        {content}
      </TouchableOpacity>
    )
  }

  if (flex !== undefined) {
    return <View style={{flex}}>{content}</View>
  }

  return content
}

const $statusCardContainer: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  // paddingVertical: 16,
  height: 48,
  alignItems: "center",
})

interface RouteButtonProps {
  label: string
  subtitle?: string
  onPress?: () => void
  position?: "top" | "bottom" | "middle"
  text?: string
  style?: ViewStyle
  icon?: React.ReactNode
  preset?: "default" | "destructive"
  disabled?: boolean
}

export function RouteButton({
  label,
  subtitle,
  onPress,
  style,
  text,
  icon,
  preset = "default",
  disabled = false,
}: RouteButtonProps) {
  const {theme, themed} = useAppTheme()

  const isDestructive = preset === "destructive"
  const labelColor = disabled
    ? theme.colors.textDim
    : isDestructive
    ? theme.colors.destructive
    : theme.colors.secondary_foreground

  return (
    <View style={[themed($settingsGroup), {paddingVertical: 0}, disabled && {opacity: 0.5}, style]}>
      <TouchableOpacity onPress={onPress} disabled={disabled || !onPress}>
        <View style={{flexDirection: "row", paddingVertical: 8, alignItems: "center"}}>
          <View
            style={{
              flexDirection: "column",
              paddingVertical: 8,
              flex: 1,
              gap: theme.spacing.s1,
            }}>
            <View className="flex-row items-center gap-4">
              {icon && <View className="justify-center items-center">{icon}</View>}
              <Text style={[themed($label), {color: labelColor}]}>{label}</Text>
            </View>
            {subtitle && <Text style={themed($subtitle)}>{subtitle}</Text>}
          </View>
          {onPress && (
            <View style={[themed($iconContainer), {flexShrink: 0}]} className="ml-3">
              <Icon name="arrow-right" size={24} color={disabled ? theme.colors.textDim : theme.colors.text} />
            </View>
          )}
          {text && (
            <Text style={[themed($text), {flexShrink: 0}]} className="font-light ml-3">
              {text}
              {/* {"testthisisalongtestemailaddress@example.com"} */}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    </View>
  )
}

const $settingsGroup: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  paddingVertical: spacing.s3,
  paddingHorizontal: spacing.s4,
  borderRadius: spacing.s4,
})

const $text: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 16,
  maxWidth: "70%",
  textOverflow: "ellipsis",
})

const $iconContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  padding: spacing.s3,
  width: spacing.s12,
  height: spacing.s12,
  borderRadius: spacing.s12,
  alignItems: "center",
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.secondary_foreground,
  fontSize: 14,
  lineHeight: 16,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.muted_foreground,
  fontSize: 12,
  lineHeight: 14,
})
