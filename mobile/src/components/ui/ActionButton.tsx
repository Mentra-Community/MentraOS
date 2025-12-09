import {TouchableOpacity, View} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export type ActionButtonVariant = "default" | "warning" | "destructive" | "secondary"

interface ActionButtonProps {
  /**
   * The text to display in the button
   */
  label: string

  /**
   * Optional subtitle text to display below the label
   */
  subtitle?: string

  /**
   * The button variant - default (blue), warning (orange), or destructive (red)
   */
  variant?: ActionButtonVariant

  /**
   * Callback when the button is pressed
   */
  onPress: () => void

  /**
   * Whether the button is disabled
   */
  disabled?: boolean

  /**
   * Optional style overrides for the container
   */
  containerStyle?: ViewStyle
}

/**
 * A reusable action button component for settings screens.
 * Similar to RouteButton but for actions like delete, disconnect, etc.
 */
export default function ActionButton({
  label,
  subtitle,
  variant = "default",
  onPress,
  disabled = false,
  containerStyle,
}: ActionButtonProps) {
  const {theme, themed} = useAppTheme()

  const getTextColor = () => {
    switch (variant) {
      case "warning":
        return theme.colors.warning
      case "destructive":
        return theme.colors.error
      case "secondary":
        return theme.colors.textDim
      default:
        return theme.colors.palette.primary500
    }
  }

  return (
    <View style={[themed($container), {paddingVertical: 0}]}>
      <TouchableOpacity
        style={[disabled && {opacity: 0.4}, containerStyle]}
        onPress={onPress}
        disabled={disabled}
        activeOpacity={0.7}>
        <View style={themed($innerRow)}>
          <View style={themed($textContainer)}>
            <Text style={[themed($text), {color: getTextColor()}]}>{label}</Text>
            {subtitle && <Text style={themed($subtitle)}>{subtitle}</Text>}
          </View>
          {/* Invisible spacer to match RouteButton's chevron */}
          <View style={themed($invisibleIcon)} />
        </View>
      </TouchableOpacity>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.backgroundAlt,
  paddingVertical: spacing.s3,
  paddingHorizontal: spacing.s4,
  borderRadius: spacing.s4,
  borderWidth: spacing.s0_5,
  borderColor: colors.border,
})

const $innerRow: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  paddingVertical: 8,
  alignItems: "center",
})

const $textContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "column",
  justifyContent: "center",
  maxWidth: "90%",
  gap: spacing.s1,
  flex: 1,
})

const $invisibleIcon: ThemedStyle<ViewStyle> = () => ({
  width: 24,
  height: 24,
  opacity: 0,
})

const $text: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: spacing.s4,
  fontWeight: "500",
  color: colors.text,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.textDim,
})
