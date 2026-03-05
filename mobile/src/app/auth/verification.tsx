import {useLocalSearchParams} from "expo-router"
import {useState} from "react"
import {ActivityIndicator, TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {spacing, ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"

export default function VerificationScreen() {
  const {email} = useLocalSearchParams<{email?: string}>()
  const [isResending, setIsResending] = useState(false)
  const {replace, goBack} = useNavigationHistory()
  const {theme, themed} = useAppTheme()

  const handleContinue = () => {
    replace("/")
  }

  const handleResendEmail = async () => {
    if (!email) return

    setIsResending(true)

    const res = await mentraAuth.resendSignupEmail(email)

    if (res.is_error()) {
      console.error("Error resending verification email:", res.error)
      showAlert(translate("common:error"), translate("login:errors.genericError"), [{text: translate("common:ok")}])
    } else {
      showAlert(translate("login:success"), translate("login:verification.resentSuccess"), [
        {text: translate("common:ok")},
      ])
    }

    setIsResending(false)
  }

  const handleBack = () => {
    goBack()
  }

  return (
    <Screen preset="fixed" style={themed($container)}>
      <Header title={translate("login:verification.title")} leftIcon="chevron-left" onLeftPress={handleBack} />
      <View style={themed($content)}>
        <Text preset="heading" style={themed($heading)}>
          {translate("login:verification.heading")}
        </Text>

        <Text style={themed($subtitle)}>{translate("login:verification.subtitle")}</Text>

        <Spacer height={spacing.s6} />

        <Button
          tx="login:verification.continue"
          style={themed($continueButton)}
          pressedStyle={themed($continueButtonPressed)}
          textStyle={themed($continueButtonText)}
          onPress={handleContinue}
        />

        <Spacer height={spacing.s4} />

        <TouchableOpacity onPress={handleResendEmail} disabled={isResending}>
          {isResending ? (
            <View style={themed($resendContainer)}>
              <ActivityIndicator size="small" color={theme.colors.foreground} />
              <Text style={themed($resendingText)}>{translate("login:verification.resending")}</Text>
            </View>
          ) : (
            <Text style={themed($resendLink)}>{translate("login:verification.resendEmail")}</Text>
          )}
        </TouchableOpacity>
      </View>
    </Screen>
  )
}

// Themed Styles
const $container: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $content: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.s4,
})

const $heading: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 24,
  fontWeight: "bold",
  color: colors.text,
  marginBottom: spacing.s3,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
  lineHeight: 24,
})

const $continueButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.text,
})

const $continueButtonPressed: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.text,
  opacity: 0.8,
})

const $continueButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.background,
  fontSize: 16,
  fontWeight: "500",
})

const $resendContainer: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
})

const $resendingText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.tint,
})

const $resendLink: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.tint,
  textAlign: "center",
})
