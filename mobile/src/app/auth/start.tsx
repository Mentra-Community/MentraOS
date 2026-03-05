import {useLocalSearchParams} from "expo-router"
import {useEffect} from "react"
import {Platform, TouchableOpacity, View} from "react-native"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"

import {Button, Icon, Text, Screen} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {mapAuthError} from "@/utils/auth/authErrors"
import AppleIcon from "assets/icons/component/AppleIcon"
import GoogleIcon from "assets/icons/component/GoogleIcon"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"

export default function LoginScreen() {
  const {push, replace} = useNavigationHistory()
  const [isChina] = useSetting(SETTINGS.china_deployment.key)
  const {authError} = useLocalSearchParams<{authError?: string}>()
  const {theme} = useAppTheme()
  const {setAnimation} = useNavigationHistory()

  focusEffectPreventBack()

  // Handle auth errors passed via URL params (e.g., from expired reset links)
  useEffect(() => {
    if (authError) {
      const errorMessage = mapAuthError(authError)
      showAlert(translate("common:error"), errorMessage, [{text: translate("common:ok")}])
    }
  }, [authError])

  const handleWebLogin = async (url: string) => {
    console.log("Opening browser with:", url)
    setAnimation("fade")
    await new Promise((resolve) => setTimeout(resolve, 1))
    push("/auth/web-splash", {url})
    // await new Promise((resolve) => setTimeout(resolve, 1000))
    // await WebBrowser.openBrowserAsync(url)
  }

  const handleGoogleSignIn = async () => {
    const res = await mentraAuth.googleSignIn()
    if (res.is_error()) {
      return
    }
    const url = res.value
    handleWebLogin(url)
  }

  const handleAppleSignIn = async () => {
    const res = await mentraAuth.appleSignIn()
    if (res.is_error()) {
      console.error("Apple sign in failed:", res.error)
      return
    }
    const url = res.value
    handleWebLogin(url)
  }

  const handleSignup = async () => {
    setAnimation("simple_push")
    await new Promise((resolve) => setTimeout(resolve, 1))
    push("/auth/signup")
  }

  return (
    <Screen preset="fixed">
      <View className="flex-1">
        <View className="flex-1 justify-center p-4">
          <View className="items-center justify-center mb-4">
            <MentraLogoStandalone width={100} height={48} />
          </View>

          <Text
            text="Mentra"
            className="text-[46px] text-primary-foreground text-secondary-foreground text-center mb-2 pt-8 pb-4"
          />

          <Text tx="login:subtitle" className="text-base text-secondary-foreground text-center text-xl mb-4">
            {translate("login:subtitle")}
          </Text>

          <View className="mb-4">
            <View className="gap-4">
              <Button
                preset="primary"
                text={translate("login:signUpWithEmail")}
                onPress={handleSignup}
                LeftAccessory={() => <Icon name="mail" size={20} color={theme.colors.background} />}
              />

              {!isChina && (
                <Button
                  preset="secondary"
                  text={translate("login:continueWithGoogle")}
                  onPress={handleGoogleSignIn}
                  LeftAccessory={() => <GoogleIcon />}
                />
              )}

              {Platform.OS === "ios" && !isChina && (
                <Button
                  preset="secondary"
                  text={translate("login:continueWithApple")}
                  onPress={handleAppleSignIn}
                  LeftAccessory={() => <AppleIcon color={theme.colors.foreground} />}
                />
              )}
            </View>
          </View>

          {/* Already have an account? Log in */}
          <View className="flex-row justify-center items-center gap-1 mt-2">
            <Text className="text-sm text-muted-foreground">{translate("login:alreadyHaveAccount")}</Text>
            <TouchableOpacity onPress={() => push("/auth/email-login")}>
              <Text className="text-sm text-secondary-foreground font-semibold">{translate("login:logIn")}</Text>
            </TouchableOpacity>
          </View>

          <Text className="text-[11px] text-muted-foreground text-center mt-2">{translate("login:termsText")}</Text>
        </View>
      </View>
    </Screen>
  )
}
