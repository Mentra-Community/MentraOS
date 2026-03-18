import {router as _router} from "expo-router"
import {View, TouchableOpacity, TextStyle, ViewStyle} from "react-native"

import {Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle} from "@/theme"
import GlassView from "@/components/ui/GlassView"

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
    <GlassView className="bg-primary-foreground px-4 py-3 flex-row justify-between items-center rounded-2xl" style={[restStyle]}>
      <View className="flex-row items-center gap-4">
        {iconStart && <View className="justify-center items-center">{iconStart}</View>}
        <View className="gap-1">
          <Text className="text-sm text-secondary-foreground" style={textStyle} text={label} />
          {subtitle && <Text className="text-muted-foreground text-xs" text={subtitle} />}
        </View>
      </View>
      {iconEnd && iconEnd}
    </GlassView>
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
  const {theme} = useAppTheme()

  const isDestructive = preset === "destructive"
  const labelColor = disabled
    ? theme.colors.muted_foreground
    : isDestructive
    ? theme.colors.destructive
    : theme.colors.secondary_foreground

  return (
    <GlassView className="bg-primary-foreground px-4 rounded-2xl" style={[disabled && {opacity: 0.5}, style]}>
      <TouchableOpacity onPress={onPress} disabled={disabled || !onPress}>
        <View className="items-center py-2 flex-row">
          <View
            style={{
              flexDirection: "column",
              paddingVertical: 8,
              flex: 1,
              gap: theme.spacing.s1,
            }}>
            <View className="flex-row items-center gap-4">
              {icon && <View className="justify-center items-center">{icon}</View>}
              <Text style={{color: labelColor}} className="text-sm text-secondary-foreground" text={label} />
            </View>
            {subtitle && <Text className="text-muted-foreground text-xs" text={subtitle} />}
          </View>
          {onPress && (
            <View className="bg-background rounded-full p-3 w-12 h-12 ml-3 flex-shrink-0">
              <Icon
                name="arrow-right"
                size={24}
                color={disabled ? theme.colors.muted_foreground : theme.colors.foreground}
              />
            </View>
          )}
          {text && (
            <Text
              className="text-text text-base flex-shrink-0 font-light ml-3 text-ellipsis max-w-[70%] align-center justify-center"
              text={text}
            />
          )}
        </View>
      </TouchableOpacity>
    </GlassView>
  )
}