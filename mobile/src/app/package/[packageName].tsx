// loading screen with a spinner

import {View, ViewStyle} from "react-native"

import {Screen} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle} from "@/theme"

export default function LoadingScreen() {
  const {themed} = useAppTheme()

  return (
    <Screen preset="fixed" contentContainerStyle={themed($container)}>
      <View style={themed($mainContainer)}>
        <View style={themed($infoContainer)}>
          {/* <View style={themed($iconContainer)}>
            <Icon name="check-circle" size={80} color={theme.colors.secondary_foreground} />
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
