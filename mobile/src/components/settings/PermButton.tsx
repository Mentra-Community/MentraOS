import {TouchableOpacity, View, ViewStyle, TextStyle} from "react-native"

import {Icon, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle} from "@/theme"

type ToggleSettingProps = {
  label: string
  subtitle?: string
  value: boolean
  onPress: () => void
  containerStyle?: ViewStyle
}

const PermissionButton: React.FC<ToggleSettingProps> = ({label, subtitle, value: _value, onPress, containerStyle}) => {
  const {theme, themed} = useAppTheme()

  return (
    <GlassView
      androidShadowSize="sm"
      className="bg-primary-foreground rounded-2xl"
      style={[themed($container), containerStyle]}>
      <TouchableOpacity
        style={{flexDirection: "row", justifyContent: "space-between", alignItems: "center"}}
        onPress={onPress}
        activeOpacity={0.7}>
        <View style={themed($textContainer)}>
          <Text text={label} style={themed($label)} />
          {subtitle && <Text text={subtitle} style={themed($subtitle)} />}
        </View>
        <View style={themed($iconContainer)}>
          <Icon name="arrow-right" size={24} color={theme.colors.foreground} />
        </View>
      </TouchableOpacity>
    </GlassView>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: "100%",
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
  borderRadius: spacing.s4,
})

const $textContainer: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "flex-start",
  gap: 4,
  flex: 1,
  marginRight: 16,
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
  fontSize: 15,
  color: colors.text,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.textDim,
})

export default PermissionButton
