import React from "react"
import {View, Text, ViewStyle, TextStyle} from "react-native"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface InfoRowProps {
  label: string
  value: string
  showDivider?: boolean
}

export function InfoRow({label, value, showDivider = true}: InfoRowProps) {
  const {theme, themed} = useAppTheme()

  // Add zero-width spaces after periods to help with text wrapping
  const formattedValue = value.replace(/\./g, ".\u200B")

  return (
    <>
      <View style={themed($row)}>
        <Text style={themed($label)}>{label}</Text>
        <Text style={themed($value)}>{formattedValue}</Text>
      </View>
      {showDivider && <View style={themed($divider)} />}
    </>
  )
}

const $row: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  paddingVertical: spacing.sm,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  color: colors.textDim,
  flex: 1,
})

const $value: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  color: colors.text,
  textAlign: "right",
  maxWidth: "60%",
  // @ts-ignore - textBreakStrategy is Android only but doesn't hurt iOS
  textBreakStrategy: "highQuality",
})

const $divider: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  height: 1,
  backgroundColor: colors.separator,
  marginVertical: spacing.xxs,
})
