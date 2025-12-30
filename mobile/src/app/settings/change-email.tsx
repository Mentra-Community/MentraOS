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

export default function ChangeEmailScreen() {
  const [newEmail, setNewEmail] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const {goBack} = useNavigationHistory()
  const {theme, themed} = useAppTheme()

  const isValidEmail = newEmail.includes("@") && newEmail.includes(".")

  const handleChangeEmail = async () => {
    // Validate email format
    if (!newEmail.trim()) {
      showAlert(translate("common:error"), translate("login:errors.emailRequired"), [{text: translate("common:ok")}])
      return
    }
    if (!isValidEmail) {
      showAlert(translate("common:error"), translate("login:invalidEmail"), [{text: translate("common:ok")}])
      return
    }

    setIsLoading(true)

    const res = await mentraAuth.updateUserEmail(newEmail)
    if (res.is_error()) {
      console.error("Error updating email:", res.error)
      showAlert(translate("common:error"), mapAuthError(res.error), [{text: translate("common:ok")}])
      setIsLoading(false)
      return
    }

    setIsLoading(false)
    showAlert(
      translate("profileSettings:emailChangeRequested"),
      translate("profileSettings:checkNewEmailForVerification"),
      [{text: translate("common:ok"), onPress: () => goBack()}],
    )
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("profileSettings:changeEmail")} leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView contentContainerStyle={themed($scrollContent)} showsVerticalScrollIndicator={false}>
        <View style={themed($card)}>
          <Text style={themed($subtitle)}>{translate("profileSettings:changeEmailSubtitle")}</Text>

          <View style={themed($form)}>
            <View style={themed($inputGroup)}>
              <Text style={themed($inputLabel)}>{translate("profileSettings:newEmailPlaceholder")}</Text>
              <View style={themed($enhancedInputContainer)}>
                <TextInput
                  hitSlop={{top: 16, bottom: 16}}
                  style={themed($enhancedInput)}
                  placeholder={translate("profileSettings:newEmailPlaceholder")}
                  value={newEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  onChangeText={setNewEmail}
                  placeholderTextColor={theme.colors.textDim}
                  autoFocus={true}
                />
              </View>
            </View>

            <Spacer height={spacing.s6} />

            <Button
              text={translate("profileSettings:sendVerificationEmail")}
              style={themed($primaryButton)}
              pressedStyle={themed($pressedButton)}
              textStyle={themed($buttonText)}
              onPress={handleChangeEmail}
              disabled={!newEmail.trim() || isLoading}
              {...(isLoading && {
                LeftAccessory: () => (
                  <ActivityIndicator size="small" color={theme.colors.textAlt} style={{marginRight: 8}} />
                ),
              })}
            />
          </View>
        </View>
      </ScrollView>
    </Screen>
  )
}

// Themed Styles - matching change-password screen styling
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

const $primaryButton: ThemedStyle<ViewStyle> = () => ({})

const $pressedButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.primary_foreground,
  opacity: 0.9,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textAlt,
  fontSize: 16,
  fontWeight: "bold",
})
