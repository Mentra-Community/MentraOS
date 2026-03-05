import {FontAwesome} from "@expo/vector-icons"
import {useState} from "react"
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  ScrollView,
  TextInput,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {spacing, ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {isDuplicateSignupError, mapAuthError} from "@/utils/auth/authErrors"

export default function SignupScreen() {
  const [step, setStep] = useState<1 | 2>(1)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const {goBack, replace, push} = useNavigationHistory()
  const {theme, themed} = useAppTheme()

  const passwordsMatch = password === confirmPassword && password.length > 0
  const isStep2Valid = passwordsMatch && password.length >= 6

  const validateEmail = (): boolean => {
    if (!email.trim()) {
      showAlert(translate("common:error"), translate("login:errors.emailRequired"), [{text: translate("common:ok")}])
      return false
    }
    if (!email.includes("@") || !email.includes(".")) {
      showAlert(translate("common:error"), translate("login:invalidEmail"), [{text: translate("common:ok")}])
      return false
    }
    return true
  }

  const validatePasswords = (): boolean => {
    if (!password) {
      showAlert(translate("common:error"), translate("login:errors.passwordRequired"), [{text: translate("common:ok")}])
      return false
    }
    if (password.length < 6) {
      showAlert(translate("common:error"), translate("login:errors.passwordTooShort"), [{text: translate("common:ok")}])
      return false
    }
    if (password !== confirmPassword) {
      showAlert(translate("common:error"), translate("login:errors.passwordsMismatch"), [
        {text: translate("common:ok")},
      ])
      return false
    }
    return true
  }

  const handleContinue = () => {
    Keyboard.dismiss()
    if (!validateEmail()) return
    setStep(2)
  }

  const handleSignup = async () => {
    Keyboard.dismiss()
    if (!validatePasswords()) return

    setIsLoading(true)

    const res = await mentraAuth.signUp({email, password})

    if (res.is_error()) {
      console.error("Error during sign-up:", res.error)

      // Handle duplicate signup - email already registered
      if (isDuplicateSignupError(res.error)) {
        showAlert(translate("common:error"), translate("login:errors.emailAlreadyRegistered"), [
          {text: translate("common:ok")},
        ])
      } else {
        showAlert(translate("common:error"), mapAuthError(res.error), [{text: translate("common:ok")}])
      }

      setIsLoading(false)
      return
    }

    setIsLoading(false)

    // Navigate to verification page
    push("/auth/verification", {email})
  }

  const handleBack = () => {
    Keyboard.dismiss()
    if (step === 2) {
      setStep(1)
    } else {
      goBack()
    }
  }

  const handleEditEmail = () => {
    setStep(1)
  }

  return (
    <Screen preset="fixed" style={themed($container)}>
      <Header title={translate("login:signup.title")} leftIcon="chevron-left" onLeftPress={handleBack} />
      <ScrollView
        contentContainerStyle={themed($scrollContent)}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <View style={themed($card)}>
          {step === 1 ? (
            // Step 1: Email input
            <>
              <Text preset="heading" style={themed($heading)}>
                {translate("login:signup.subtitle")}
              </Text>

              <View style={themed($form)}>
                <View style={themed($inputGroup)}>
                  <Text tx="login:email" style={themed($inputLabel)} />
                  <View style={themed($enhancedInputContainer)}>
                    <TextInput
                      hitSlop={{top: 16, bottom: 16}}
                      style={themed($enhancedInput)}
                      placeholder={translate("login:emailPlaceholder")}
                      value={email}
                      autoCapitalize="none"
                      keyboardType="email-address"
                      autoComplete="email"
                      onChangeText={setEmail}
                      placeholderTextColor={theme.colors.textDim}
                      autoFocus={true}
                      onSubmitEditing={handleContinue}
                      returnKeyType="next"
                    />
                  </View>
                </View>

                <Spacer height={spacing.s4} />

                <Button
                  tx="login:signup.continue"
                  style={themed($primaryButton)}
                  pressedStyle={themed($pressedButton)}
                  textStyle={themed($buttonText)}
                  onPress={handleContinue}
                  disabled={!email.trim()}
                />

                <Spacer height={spacing.s3} />

                <Text style={themed($termsText)}>{translate("login:termsText")}</Text>
              </View>
            </>
          ) : (
            // Step 2: Password + Confirm password
            <>
              <Text preset="heading" style={themed($heading)}>
                {translate("login:signup.createPasswordSubtitle")}
              </Text>

              <View style={themed($emailRow)}>
                <Text style={themed($emailText)}>{email}</Text>
                <TouchableOpacity onPress={handleEditEmail}>
                  <Text style={themed($editLink)}>{translate("login:signup.edit")}</Text>
                </TouchableOpacity>
              </View>

              <View style={themed($form)}>
                <View style={themed($inputGroup)}>
                  <Text tx="login:password" style={themed($inputLabel)} />
                  <View style={themed($enhancedInputContainer)}>
                    <TextInput
                      hitSlop={{top: 16, bottom: 16}}
                      style={themed($enhancedInput)}
                      placeholder={translate("login:passwordPlaceholder")}
                      value={password}
                      autoCapitalize="none"
                      onChangeText={setPassword}
                      secureTextEntry={!showPassword}
                      placeholderTextColor={theme.colors.textDim}
                      autoFocus={true}
                    />
                    <TouchableOpacity
                      hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
                      onPress={() => setShowPassword(!showPassword)}>
                      <FontAwesome name={showPassword ? "eye" : "eye-slash"} size={18} color={theme.colors.textDim} />
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={themed($inputGroup)}>
                  <Text tx="login:signup.confirmPassword" style={themed($inputLabel)} />
                  <View style={themed($enhancedInputContainer)}>
                    <TextInput
                      hitSlop={{top: 16, bottom: 16}}
                      style={themed($enhancedInput)}
                      placeholder={translate("login:signup.confirmPasswordPlaceholder")}
                      value={confirmPassword}
                      autoCapitalize="none"
                      onChangeText={setConfirmPassword}
                      secureTextEntry={!showConfirmPassword}
                      placeholderTextColor={theme.colors.textDim}
                    />
                    <TouchableOpacity
                      hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
                      onPress={() => setShowConfirmPassword(!showConfirmPassword)}>
                      <FontAwesome
                        name={showConfirmPassword ? "eye" : "eye-slash"}
                        size={18}
                        color={theme.colors.textDim}
                      />
                    </TouchableOpacity>
                  </View>
                </View>

                {password.length > 0 && confirmPassword.length > 0 && !passwordsMatch && (
                  <Text style={themed($errorText)}>{translate("login:errors.passwordsMismatch")}</Text>
                )}

                {password.length > 0 && password.length < 6 && (
                  <Text style={themed($hintText)}>{translate("login:errors.passwordTooShort")}</Text>
                )}

                <Spacer height={spacing.s4} />

                <Button
                  tx="login:signup.createAccount"
                  style={themed($createAccountButton)}
                  pressedStyle={themed($createAccountButtonPressed)}
                  textStyle={themed($createAccountButtonText)}
                  onPress={handleSignup}
                  disabled={!isStep2Valid || isLoading}
                  {...(isLoading && {
                    LeftAccessory: () => (
                      <ActivityIndicator size="small" color={theme.colors.foreground} style={{marginRight: 8}} />
                    ),
                  })}
                />
              </View>
            </>
          )}
        </View>
      </ScrollView>

      {/* Loading Modal */}
      <Modal visible={isLoading} transparent={true} animationType="fade">
        <View style={themed($modalOverlay)}>
          <View style={themed($modalContent)}>
            <ActivityIndicator size="large" color={theme.colors.foreground} style={{marginBottom: theme.spacing.s4}} />
            <Text preset="bold" style={{color: theme.colors.text}}>
              {translate("login:signup.creatingAccount")}
            </Text>
          </View>
        </View>
      </Modal>
    </Screen>
  )
}

// Themed Styles
const $container: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $scrollContent: ThemedStyle<ViewStyle> = () => ({
  flexGrow: 1,
})

const $card: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.s4,
})

const $heading: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 24,
  fontWeight: "bold",
  color: colors.text,
  marginBottom: spacing.s4,
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
  backgroundColor: isDark ? colors.palette.transparent : colors.background,
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

const $emailRow: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  marginBottom: spacing.s4,
  gap: spacing.s2,
})

const $emailText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.text,
})

const $editLink: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.tint,
  fontWeight: "500",
})

const $errorText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.error,
  marginTop: spacing.s2,
})

const $hintText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.textDim,
  marginTop: spacing.s2,
})

const $primaryButton: ThemedStyle<ViewStyle> = () => ({})

const $pressedButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  opacity: 0.9,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textAlt,
  fontSize: 16,
  fontWeight: "500",
})

const $createAccountButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.text,
})

const $createAccountButtonPressed: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.text,
  opacity: 0.8,
})

const $createAccountButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.background,
  fontSize: 16,
  fontWeight: "500",
})

const $termsText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.textDim,
  textAlign: "center",
})

const $modalOverlay: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  backgroundColor: "rgba(0, 0, 0, 0.7)",
  justifyContent: "center",
  alignItems: "center",
})

const $modalContent: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  padding: spacing.s8,
  borderRadius: spacing.s4,
  alignItems: "center",
  minWidth: 200,
})
