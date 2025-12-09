import {View, ActivityIndicator, SafeAreaView, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

const LoadingComponent = ({message = "Loading..."}: {message?: string}) => {
  const {themed} = useAppTheme()

  return (
    <SafeAreaView style={themed($safeArea)}>
      <View style={themed($loadingContainer)}>
        <ActivityIndicator size="large" color="#999999" />
        <Text text={message} style={themed($text)} />
      </View>
    </SafeAreaView>
  )
}

const $safeArea: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  backgroundColor: colors.background,
})

const $loadingContainer: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  flex: 1,
  justifyContent: "center",
  marginHorizontal: 20,
})

const $text: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  marginBottom: 20,
  textAlign: "center",
  color: colors.text,
})

export default LoadingComponent
