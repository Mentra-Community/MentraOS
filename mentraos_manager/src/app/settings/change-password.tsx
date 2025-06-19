import React, {useState} from "react"
import {View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView, ViewStyle, TextStyle} from "react-native"
import {supabase} from "@/supabase/supabaseClient"
import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle, spacing} from "@/theme"
import {translate} from "@/i18n"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import showAlert from "@/utils/AlertUtils"
import {FontAwesome} from "@expo/vector-icons"
import {Spacer} from "@/components/misc/Spacer"
import Toast from "react-native-toast-message"

export default function ChangePasswordScreen() {
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const {goBack} = useNavigationHistory()
  const {theme, themed} = useAppTheme()

  const passwordsMatch = newPassword === confirmPassword && newPassword.length > 0
  const isFormValid = passwordsMatch && newPassword.length >= 6

  const handleUpdatePassword = async () => {
    // Validation checks with specific error messages
    if (newPassword.length < 6) {
      showAlert(translate("common:error"), translate("profileSettings:passwordTooShort"))
      return
    }

    if (newPassword !== confirmPassword) {
      showAlert(translate("common:error"), translate("profileSettings:passwordsDoNotMatch"))
      return
    }

    setIsLoading(true)

    try {
      const {error} = await supabase.auth.updateUser({
        password: newPassword,
      })

      if (error) {
        showAlert(translate("common:error"), error.message)
      } else {
        Toast.show({
          type: "success",
          text1: translate("profileSettings:passwordUpdatedSuccess"),
          position: "bottom",
        })
        goBack()
      }
    } catch (err) {
      console.error("Error updating password:", err)
      showAlert(translate("common:error"), err.toString())
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.md}}>
      <Header title={translate("profileSettings:changePassword")} leftIcon="caretLeft" onLeftPress={goBack} />
      <ScrollView contentContainerStyle={themed($scrollContent)} showsVerticalScrollIndicator={false}>
        <View style={themed($card)}>
          <Text tx="profileSettings:changePasswordSubtitle" style={themed($subtitle)} />

          <View style={themed($form)}>
            <View style={themed($inputGroup)}>
              <Text tx="profileSettings:newPassword" style={themed($inputLabel)} />
              <View style={themed($enhancedInputContainer)}>
                <FontAwesome name="lock" size={16} color={theme.colors.text} />
                <Spacer width={spacing.xxs} />
                <TextInput
                  hitSlop={{top: 16, bottom: 16}}
                  style={themed($enhancedInput)}
                  placeholder={translate("profileSettings:enterNewPassword")}
                  value={newPassword}
                  autoCapitalize="none"
                  onChangeText={setNewPassword}
                  secureTextEntry={!showNewPassword}
                  placeholderTextColor={theme.colors.textDim}
                />
                <TouchableOpacity
                  hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
                  onPress={() => setShowNewPassword(!showNewPassword)}>
                  <FontAwesome name={showNewPassword ? "eye" : "eye-slash"} size={18} color={theme.colors.text} />
                </TouchableOpacity>
              </View>
            </View>

            <View style={themed($inputGroup)}>
              <Text tx="profileSettings:confirmPassword" style={themed($inputLabel)} />
              <View style={themed($enhancedInputContainer)}>
                <FontAwesome name="lock" size={16} color={theme.colors.text} />
                <Spacer width={spacing.xxs} />
                <TextInput
                  hitSlop={{top: 16, bottom: 16}}
                  style={themed($enhancedInput)}
                  placeholder={translate("profileSettings:confirmNewPassword")}
                  value={confirmPassword}
                  autoCapitalize="none"
                  onChangeText={setConfirmPassword}
                  secureTextEntry={!showConfirmPassword}
                  placeholderTextColor={theme.colors.textDim}
                />
                <TouchableOpacity
                  hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
                  onPress={() => setShowConfirmPassword(!showConfirmPassword)}>
                  <FontAwesome name={showConfirmPassword ? "eye" : "eye-slash"} size={18} color={theme.colors.text} />
                </TouchableOpacity>
              </View>
            </View>

            {newPassword.length > 0 && confirmPassword.length > 0 && !passwordsMatch && (
              <Text tx="profileSettings:passwordsDoNotMatch" style={themed($errorText)} />
            )}

            <Spacer height={spacing.lg} />

            <Button
              tx="profileSettings:updatePassword"
              style={themed($primaryButton)}
              pressedStyle={themed($pressedButton)}
              textStyle={themed($buttonText)}
              onPress={handleUpdatePassword}
              disabled={!isFormValid || isLoading}
              LeftAccessory={() =>
                isLoading && <ActivityIndicator size="small" color={theme.colors.icon} style={{marginRight: 8}} />
              }
            />
          </View>
        </View>
      </ScrollView>
    </Screen>
  )
}

// Themed Styles - matching login screen styling
const $scrollContent: ThemedStyle<ViewStyle> = () => ({
  flexGrow: 1,
})

const $card: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.lg,
})

const $subtitle: ThemedStyle<TextStyle> = ({spacing, colors}) => ({
  fontSize: 16,
  color: colors.text,
  textAlign: "left",
  marginBottom: spacing.lg,
})

const $form: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})

const $inputGroup: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.sm,
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
  paddingHorizontal: spacing.sm,
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

const $errorText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.error,
  marginTop: spacing.xs,
})

const $primaryButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  // Using default Button styles from Ignite theme
})

const $pressedButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.buttonPressed,
  opacity: 0.9,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  fontWeight: "bold",
})
