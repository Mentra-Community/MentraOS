import {View, TextStyle, ViewStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export function NotConnectedInfo() {
  const {themed} = useAppTheme()

  return (
    <View style={themed($container)}>
      <Text tx="deviceSettings:notConnectedInfo" style={themed($text)} />
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.s3,
  marginBottom: spacing.s3,
  marginTop: spacing.s3,
})

const $text: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
  textAlign: "center",
})
