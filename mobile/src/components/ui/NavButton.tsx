import {TouchableOpacity, ViewStyle, TextStyle} from "react-native"

import {Icon, IconTypes, Text} from "@/components/ignite"
import {spacing, ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface NavButtonProps {
  icon: IconTypes
  title: string
  onPress: () => void
  containerStyle?: ViewStyle
  textStyle?: TextStyle
  iconSize?: number
  iconColor?: string
}

const NavButton: React.FC<NavButtonProps> = ({
  icon,
  title,
  onPress,
  containerStyle,
  textStyle,
  iconSize = 20,
  iconColor,
}) => {
  const {theme, themed} = useAppTheme()

  return (
    <TouchableOpacity style={[themed($navButton), containerStyle]} onPress={onPress} activeOpacity={0.7}>
      <Icon icon={icon} size={iconSize} color={iconColor || theme.colors.text} />
      <Text style={[themed($navButtonText), textStyle]}>{title}</Text>
    </TouchableOpacity>
  )
}

const $navButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  paddingVertical: 8,
  paddingHorizontal: 12,
  backgroundColor: colors.primary,
  borderRadius: 8,
  marginTop: 8,
})

const $navButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.palette.neutral100,
  fontSize: 16,
  fontWeight: "600",
  marginLeft: spacing.s2,
})

export default NavButton
