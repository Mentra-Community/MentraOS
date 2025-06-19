import * as React from "react"
import {View, ViewStyle, TextStyle} from "react-native"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import {translate, TxKeyPath} from "@/i18n"
import {Text} from "@/components/ignite"

interface EmptyAppsViewProps {
  statusMessageKey: TxKeyPath
  activeAppsMessageKey: TxKeyPath
}

const EmptyAppsView = ({statusMessageKey, activeAppsMessageKey}: EmptyAppsViewProps) => {
  const {themed} = useAppTheme()

  return (
    <View style={themed($emptyApps)}>
      <Text tx={statusMessageKey} style={themed($statusMessage)} numberOfLines={1} />
      <Text tx={activeAppsMessageKey} style={themed($activeAppsMessage)} numberOfLines={1} />
    </View>
  )
}

const $emptyApps: ThemedStyle<ViewStyle> = () => ({
  alignSelf: "stretch",
  borderRadius: 15,
  width: "100%",
  alignItems: "center",
  justifyContent: "center",
  paddingHorizontal: 12,
  height: 68,
  gap: 4,
})

const $statusMessage: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 17,
  letterSpacing: 1.7,
  textTransform: "capitalize",
  color: colors.text, // Use semantic color for better theme support
  overflow: "hidden",
  textAlign: "left",
})

const $activeAppsMessage: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 13,
  letterSpacing: 0.4,
  lineHeight: 18,
  color: colors.textDim, // Use semantic color for dimmed text
  overflow: "hidden",
  textAlign: "left",
})

export default EmptyAppsView
