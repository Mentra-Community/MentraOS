import {FontAwesome} from "@expo/vector-icons"
import {useState} from "react"
import {View, TextInput, ActivityIndicator, ScrollView, ViewStyle, TextStyle} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {ThemedStyle, spacing} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {mapAuthError} from "@/utils/auth/authErrors"
import {useAppTheme} from "@/contexts/ThemeContext"

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const {goBack} = useNavigationHistory()
  const {theme, themed} = useAppTheme()

  const isEmailValid = email.includes("@") && email.includes(".")

  const handleSendResetEmail = async () => {
    if (!isEmailValid) {
      showAlert(translate("common:error"), translate("login:invalidEmail"))
      return
    }

    setIsLoading(true)

    const res = await mentraAuth.resetPasswordForEmail(email)
    if (res.is_error()) {
      console.error("Error sending reset email:", res.error)
      showAlert(translate("common:error"), mapAuthError(res.error), [{text: translate("common:ok")}])
      setIsLoading(false)
      return
    }

    setIsLoading(false)

    // Show success alert and navigate back after dismissal
    showAlert(translate("login:resetEmailSent"), translate("login:checkEmailForReset"), [
      {text: translate("common:ok"), onPress: () => goBack()},
    ])
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("login:forgotPasswordTitle")} leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView
        contentContainerStyle={themed($scrollContent)}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <View style={themed($card)}>
          <Text tx="login:forgotPasswordSubtitle" style={themed($subtitle)} />

          <View style={themed($form)}>
            <View style={themed($inputGroup)}>
              <Text tx="login:email" style={themed($inputLabel)} />
              <View style={themed($enhancedInputContainer)}>
                <FontAwesome name="envelope" size={16} color={theme.colors.textDim} />
                <Spacer width={spacing.s3} />
                <TextInput
                  hitSlop={{top: 16, bottom: 16}}
                  style={themed($enhancedInput)}
                  placeholder={translate("login:emailPlaceholder")}
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholderTextColor={theme.colors.textDim}
                  autoFocus={true}
                />
              </View>
            </View>

            <Spacer height={spacing.s6} />

            <Button
              tx="login:sendResetEmail"
              style={themed($primaryButton)}
              pressedStyle={themed($pressedButton)}
              textStyle={themed($buttonText)}
              onPress={handleSendResetEmail}
              disabled={!isEmailValid || isLoading}
              {...(isLoading && {
                LeftAccessory: () => (
                  <ActivityIndicator size="small" color={theme.colors.textAlt} style={{marginRight: 8}} />
                ),
              })}
            />

            <Spacer height={spacing.s4} />

            <Text tx="login:rememberPassword" style={themed($helperText)} />
            <Button
              tx="login:backToLogin"
              style={themed($secondaryButton)}
              textStyle={themed($secondaryButtonText)}
              onPress={goBack}
            />
          </View>
        </View>
      </ScrollView>
    </Screen>
  )
}

// Themed Styles - matching login and change-password screens
const $scrollContent: ThemedStyle<ViewStyle> = () => ({
  flexGrow: 1,
})

const $card: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.s4,
})

const $subtitle: ThemedStyle<TextStyle> = ({spacing, colors}) => ({
  fontSize: 16,
  color: colors.text,
  textAlign: "left",
  marginBottom: spacing.s6,
  lineHeight: 22,
})

const $form: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})

const $inputGroup: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s3,
})

const $inputLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  fontWeight: "500",
  color: colors.text,
  marginBottom: 8,
})

const $enhancedInputContainer: ThemedStyle<ViewStyle> = ({colors, spacing, isDark}) => ({
  flexDirection: "row",
  alignItems: "center",
  height: 48,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 8,
  paddingHorizontal: spacing.s3,
  backgroundColor: isDark ? colors.transparent : colors.background,
  ...(isDark
    ? {
        shadowOffset: {
          width: 0,
          height: 1,
        },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 2,
      }
    : {}),
})

const $enhancedInput: ThemedStyle<TextStyle> = ({colors}) => ({
  flex: 1,
  fontSize: 16,
  color: colors.text,
})

const $primaryButton: ThemedStyle<ViewStyle> = () => ({})

const $pressedButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.buttonPressed,
  opacity: 0.9,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textAlt,
  fontSize: 16,
  fontWeight: "bold",
})

const $secondaryButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.transparent,
  borderWidth: 0,
})

const $secondaryButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.tint,
  fontSize: 14,
  textDecorationLine: "underline",
})

const $helperText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.textDim,
  textAlign: "center",
  marginBottom: spacing.s2,
})
