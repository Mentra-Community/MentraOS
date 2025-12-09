import {View, ActivityIndicator, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface LoadingOverlayProps {
  message?: string
}

/**
 * A consistent loading overlay component to be used across the app
 * for loading states, especially during transitions between screens.
 */
const LoadingOverlay = ({message = "Loading..."}: LoadingOverlayProps) => {
  const {themed, theme} = useAppTheme()

  return (
    <View style={themed($container)}>
      <View style={themed($contentContainer)}>
        <ActivityIndicator size="large" color={theme.colors.tint} style={themed($spinner)} />
        <Text text={message} style={themed($message)} />
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors}) => ({
  alignItems: "center",
  bottom: 0,
  justifyContent: "center",
  left: 0,
  position: "absolute",
  right: 0,
  top: 0,
  zIndex: 1000,
  backgroundColor: colors.background,
})

const $contentContainer: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  borderRadius: 10,
  justifyContent: "center",
  padding: 20,
})

const $message: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "500",
  textAlign: "center",
  color: colors.text,
})

const $spinner: ThemedStyle<ViewStyle> = () => ({
  marginBottom: 12,
})

export default LoadingOverlay
