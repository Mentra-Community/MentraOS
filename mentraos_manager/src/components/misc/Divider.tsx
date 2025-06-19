import * as React from "react"
import {View, ViewStyle} from "react-native"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import {StyleSheet} from "react-native"

interface DividerProps {
  variant?: "full" | "inset"
  color?: string
  thickness?: number
}

const Divider = ({variant = "full", color, thickness = 1}: DividerProps) => {
  const {themed} = useAppTheme()

  const style = variant === "full" ? $dividerFull : $dividerInset

  // @ts-ignore
  if (thickness === 1) {
    thickness = StyleSheet.hairlineWidth
  }
  return <View style={[themed(style), color && {backgroundColor: color}, {height: thickness}]} />
}

const $dividerFull: ThemedStyle<ViewStyle> = ({colors}) => ({
  height: 1,
  backgroundColor: colors.separator,
  width: "100%",
})

const $dividerInset: ThemedStyle<ViewStyle> = ({colors}) => ({
  height: 1,
  backgroundColor: colors.separator,
  width: "90%",
  alignSelf: "center",
})

export default Divider
