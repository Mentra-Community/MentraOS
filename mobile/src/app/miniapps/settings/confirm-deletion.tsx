import {useState} from "react"
import {View, TextInput, ActivityIndicator, ScrollView, ViewStyle, TextStyle} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useCapsuleStore} from "@/stores/capsule"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {ThemedStyle, spacing} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {mapAuthError} from "@/utils/auth/authErrors"
import {LogoutUtils} from "@/utils/LogoutUtils"
import {settleFrame} from "@/utils/settleFrame"

/**
 * Final step of account deletion (issue 019): the backend emailed a one-time
 * code; entering it here destroys the account. Reached only through the
 * triple-warning flow in profile.tsx.
 */
export default function ConfirmDeletionScreen() {
  const [code, setCode] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const {goBack, replaceAll} = useNavigationStore.getState()
  const {theme, themed} = useAppTheme()

  const handleConfirm = async () => {
    if (!code.trim()) return
    setIsLoading(true)
    const res = await mentraAuth.confirmAccountDeletion(code.trim())
    if (res.is_error()) {
      console.error("Error confirming account deletion:", res.error)
      showAlert(translate("common:error"), mapAuthError(res.error), [{text: translate("common:ok")}])
      setIsLoading(false)
      return
    }
    // Leave the miniapp surface before the teardown destroys it, exactly as the
    // sign-out path does (OS-1834). This screen renders inside the Settings
    // miniapp and performCompleteLogout() calls localMiniappRuntime.cleanup(),
    // so tearing down first leaves this component mounted in a container that no
    // longer exists — Fabric fails to reparent a view that still has a parent
    // and React Native destroys the ReactHost, leaving a white screen that only
    // a force-quit clears.
    //
    // The window here was worse than on the sign-out path: navigation used to
    // happen only when the user tapped OK on the success alert, so the screen
    // could sit in a destroyed runtime indefinitely.
    //
    // Unlike sign-out, we cannot leave *before* the auth event: the confirm call
    // above needs a live session and emits SIGNED_OUT itself on success, so by
    // the time we get here AuthContext has already been handed that event and
    // has a state update in flight while this screen is still mounted. Let that
    // commit first, then move surfaces — otherwise the teardown below races a
    // re-render that is already under way.
    await settleFrame()

    await useCapsuleStore.getState().active?.handleRightPress(true)
    await settleFrame()

    replaceAll("/auth/start")
    await settleFrame()

    // Account is gone server-side; clear everything device-side too.
    try {
      await LogoutUtils.performCompleteLogout()
    } catch (error) {
      console.error("ConfirmDeletion: logout cleanup failed:", error)
    }
    setIsLoading(false)
    // Already on the login screen, so OK just dismisses.
    showAlert(
      translate("profileSettings:deleteAccountSuccessTitle"),
      translate("profileSettings:deleteAccountSuccessMessage"),
      [{text: translate("common:ok")}],
      {cancelable: false},
    )
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("profileSettings:deleteAccountTitle")} leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView contentContainerStyle={themed($scrollContent)} showsVerticalScrollIndicator={false}>
        <View style={themed($card)}>
          <Text style={themed($subtitle)}>{translate("profileSettings:deleteAccountCodeSubtitle")}</Text>

          <View style={themed($inputGroup)}>
            <Text style={themed($inputLabel)}>{translate("profileSettings:deleteAccountCodePlaceholder")}</Text>
            <View style={themed($enhancedInputContainer)}>
              <TextInput
                hitSlop={{top: 16, bottom: 16}}
                style={themed($enhancedInput)}
                placeholder={translate("profileSettings:deleteAccountCodePlaceholder")}
                value={code}
                autoCapitalize="none"
                keyboardType="number-pad"
                onChangeText={setCode}
                placeholderTextColor={theme.colors.textDim}
                autoFocus={true}
              />
            </View>
          </View>

          <Spacer height={spacing.s6} />

          <Button
            text={translate("profileSettings:deleteAccountConfirmButton")}
            style={themed($primaryButton)}
            pressedStyle={themed($pressedButton)}
            textStyle={themed($buttonText)}
            onPress={handleConfirm}
            disabled={!code.trim() || isLoading}
            {...(isLoading
              ? {
                  LeftAccessory: () => (
                    <ActivityIndicator size="small" color={theme.colors.foreground} style={{marginRight: 8}} />
                  ),
                }
              : {})}
          />
        </View>
      </ScrollView>
    </Screen>
  )
}

// Themed styles - matching the change-email screen
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
})

const $enhancedInput: ThemedStyle<TextStyle> = ({colors}) => ({
  flex: 1,
  fontSize: 16,
  color: colors.text,
})

const $primaryButton: ThemedStyle<ViewStyle> = () => ({})

const $pressedButton: ThemedStyle<ViewStyle> = () => ({
  opacity: 0.9,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textAlt,
  fontSize: 16,
  fontWeight: "bold",
})
