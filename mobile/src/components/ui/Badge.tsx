import {View, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface BadgeProps {
  text: string
  style?: ViewStyle
}

export function Badge({text, style}: BadgeProps) {
  const {themed} = useAppTheme()

  return (
    <View style={[themed($container), style]}>
      <Text style={themed($text)}>{text}</Text>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  paddingHorizontal: spacing.s2,
  paddingVertical: 2,
  backgroundColor: colors.background,
  borderRadius: spacing.s6,
  alignSelf: "flex-start",
  borderWidth: 1,
  borderColor: colors.border,
})

const $text: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: spacing.s3,
  color: colors.secondary_foreground,
  fontWeight: "500",
})
