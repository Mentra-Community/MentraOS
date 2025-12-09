import {View, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type GroupTitleProps = {
  title: string
}

const GroupTitle = ({title}: GroupTitleProps) => {
  const {themed} = useAppTheme()
  return (
    <View style={themed($container)}>
      <Text text={title} style={themed($title)} />
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: "100%",
  marginTop: spacing.s4,
  marginBottom: spacing.s2,
  paddingHorizontal: spacing.s4,
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "normal",
  color: colors.textDim,
})

export default GroupTitle
