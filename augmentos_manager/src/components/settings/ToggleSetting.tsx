import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import React from "react"
import {View, StyleSheet, Platform, ViewStyle, TextStyle} from "react-native"
import {Switch, Text} from "@/components/ignite"

type ToggleSettingProps = {
  label: string
  subtitle?: string
  value: boolean
  onValueChange: (newValue: boolean) => void
  containerStyle?: ViewStyle
}

const ToggleSetting: React.FC<ToggleSettingProps> = ({label, subtitle, value, onValueChange, containerStyle}) => {
  const {theme, themed} = useAppTheme()

  return (
    <View style={[themed($container), containerStyle]}>
      <View style={themed($textContainer)}>
        <Text text={label} style={themed($label)} />
        {subtitle && <Text text={subtitle} style={themed($subtitle)} />}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
      />
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  width: "100%",
  backgroundColor: colors.background,
  paddingVertical: spacing.md,
  paddingHorizontal: spacing.lg,
  borderRadius: spacing.sm,
})

const $textContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "flex-start",
  gap: 4,
  flex: 1,
  marginRight: 16, // Add spacing between text and toggle
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  color: colors.text,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.textDim,
})

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
  },
  label: {
    fontSize: 16,
  },
})

const SettingsSwitch = () => {
  const {themed} = useAppTheme()
  return (
    <View style={themed($switchContainer)}>
      <Text>Settings</Text>
      <Switch value={true} onValueChange={() => {}} />
    </View>
  )
}

const $switchContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
  padding: 10,
  backgroundColor: colors.palette.neutral100,
  borderRadius: 12,
})

export default ToggleSetting
