import {View, TouchableOpacity, ViewStyle, TextStyle} from "react-native"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface InternetConnectionFallbackComponentProps {
  retry: () => void
  message?: string
}

export default function InternetConnectionFallbackComponent({
  retry,
  message = "Unable to connect. Please check your internet connection.",
}: InternetConnectionFallbackComponentProps) {
  const {theme, themed} = useAppTheme()

  return (
    <View style={themed($fallbackContainer)}>
      <MaterialCommunityIcons name="wifi-off" size={60} color={theme.colors.text} />
      <Text text={message} style={themed($fallbackText)} />
      <TouchableOpacity style={themed($retryButton)} onPress={retry}>
        <Text text="Retry" style={themed($retryButtonText)} />
      </TouchableOpacity>
    </View>
  )
}

const $fallbackContainer: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  flex: 1,
  justifyContent: "center",
  padding: 20,
})

const $fallbackText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  textAlign: "center",
  marginVertical: 20,
})

const $retryButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  borderRadius: 8,
  paddingHorizontal: 20,
  paddingVertical: 10,
  backgroundColor: colors.palette.primary500,
})

const $retryButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.palette.neutral100,
})
