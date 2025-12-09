import CoreModule from "core"
import {useLocalSearchParams} from "expo-router"
import {useEffect} from "react"
import {View, ViewStyle, TextStyle} from "react-native"
import Animated, {useAnimatedStyle, useSharedValue, withTiming} from "react-native-reanimated"
import Icon from "react-native-vector-icons/FontAwesome"

import {Screen, Header, Text, Button} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {TxKeyPath} from "@/i18n"
import {translate} from "@/i18n/translate"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export default function PairingFailureScreen() {
  const {themed, theme} = useAppTheme()
  const {clearHistory, replace, clearHistoryAndGoHome} = useNavigationHistory()

  const {error, glassesModelName}: {error: string; glassesModelName?: string} = useLocalSearchParams()

  const fadeInOpacity = useSharedValue(0)
  const slideUpTranslate = useSharedValue(50)

  const animatedContainerStyle = useAnimatedStyle(() => ({
    opacity: fadeInOpacity.value,
    transform: [{translateY: slideUpTranslate.value}],
  }))

  useEffect(() => {
    fadeInOpacity.value = withTiming(1, {duration: 800})
    slideUpTranslate.value = withTiming(0, {duration: 800})
  }, [])

  const handleRetry = () => {
    CoreModule.forget()
    clearHistory()
    replace("/pairing/select-glasses-model")
  }

  const handleGoHome = () => {
    clearHistoryAndGoHome()
  }

  return (
    <Screen preset="fixed" style={themed($screen)}>
      <Header />

      <Animated.View style={[themed($container), animatedContainerStyle]}>
        <View style={themed($iconContainer)}>
          <Icon name="exclamation-circle" size={80} color={theme.colors.error} />
        </View>

        <Text tx="pairing:pairingFailed" preset="heading" style={themed($title)} />

        <Text
          text={translate(error as TxKeyPath, {glassesModel: glassesModelName || "glasses"})}
          preset="default"
          style={themed($description)}
        />

        <View style={themed($buttonContainer)}>
          <Button tx="pairing:tryAgain" preset="primary" onPress={handleRetry} style={themed($button)} />

          <Button tx="pairing:goHome" preset="alternate" onPress={handleGoHome} style={themed($button)} />
        </View>

        {/* <View style={themed($helpContainer)}>
          <Icon name="info-circle" size={16} color={theme.colors.textDim} />
          <Text
            text="Make sure your glasses are powered on and in pairing mode"
            preset="formHelper"
            style={themed($helpText)}
          />
        </View> */}
      </Animated.View>
    </Screen>
  )
}

const $screen: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s4,
})

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  paddingHorizontal: spacing.s4,
})

const $iconContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  padding: spacing.s6,
  borderRadius: 130,
  backgroundColor: colors.errorBackground || colors.palette.angry100,
  marginBottom: spacing.s8,
  width: 130,
  height: 130,
  alignItems: "center",
  justifyContent: "center",
})

const $title: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 28,
  fontWeight: "bold",
  marginBottom: spacing.s4,
  textAlign: "center",
  color: colors.text,
})

const $description: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  textAlign: "center",
  marginBottom: spacing.s12,
  lineHeight: 24,
  paddingHorizontal: spacing.s4,
  color: colors.textDim,
})

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: "100%",
  paddingHorizontal: spacing.s4,
  gap: spacing.s3,
})

const $button: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})
