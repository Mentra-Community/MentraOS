// loading screen with a spinner

import {View, ViewStyle} from "react-native"

import {Screen} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export default function LoadingScreen() {
  const {themed} = useAppTheme()

  return (
    <Screen preset="fixed" contentContainerStyle={themed($container)}>
      <View style={themed($mainContainer)}>
        <View style={themed($infoContainer)}>
          {/* <View style={themed($iconContainer)}>
            <Icon name="check-circle" size={80} color={theme.colors.palette.primary500} />
          </View> */}

          {/* <Text style={themed($title)}>{getStatusTitle()}</Text> */}
        </View>
      </View>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $mainContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  flexDirection: "column",
  justifyContent: "space-between",
  padding: spacing.s6,
})

const $infoContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingTop: spacing.s8,
})
