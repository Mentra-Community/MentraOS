import {FontAwesome} from "@expo/vector-icons"
import * as WebBrowser from "expo-web-browser"
import {useState} from "react"
import {ActivityIndicator, Keyboard, Modal, Platform, ScrollView, TextInput, TouchableOpacity, View} from "react-native"

import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {spacing} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {mapAuthError} from "@/utils/auth/authErrors"

import AppleIcon from "assets/icons/component/AppleIcon"
import GoogleIcon from "assets/icons/component/GoogleIcon"

export default function EmailLoginScreen() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(false)

  const {goBack, replace, push} = useNavigationHistory()
  const {theme} = useAppTheme()
  const [isChina] = useSetting(SETTINGS.china_deployment.key)

  const validateInputs = (): boolean => {
    if (!email.trim()) {
      showAlert(translate("common:error"), translate("login:errors.emailRequired"), [{text: translate("common:ok")}])
      return false
    }
    if (!email.includes("@") || !email.includes(".")) {
      showAlert(translate("common:error"), translate("login:invalidEmail"), [{text: translate("common:ok")}])
      return false
    }
    if (!password) {
      showAlert(translate("common:error"), translate("login:errors.passwordRequired"), [{text: translate("common:ok")}])
      return false
    }
    return true
  }

  const handleEmailSignIn = async () => {
    Keyboard.dismiss()

    if (!validateInputs()) {
      return
    }

    setIsLoading(true)

    const res = await mentraAuth.signInWithPassword({email, password})
    if (res.is_error()) {
      console.error("Error during sign-in:", res.error)
      showAlert(translate("common:error"), mapAuthError(res.error), [{text: translate("common:ok")}])
      setIsLoading(false)
      return
    }

    setIsLoading(false)
    replace("/")
  }

  const handleGoogleSignIn = async () => {
    setIsAuthLoading(true)

    setTimeout(() => {
      setIsAuthLoading(false)
    }, 5000)

    const res = await mentraAuth.googleSignIn()

    if (res.is_error()) {
      setIsAuthLoading(false)
      return
    }
    const url = res.value

    console.log("Opening browser with:", url)
    await WebBrowser.openBrowserAsync(url)

    setIsAuthLoading(false)
  }

  const handleAppleSignIn = async () => {
    setIsAuthLoading(true)

    const res = await mentraAuth.appleSignIn()
    if (res.is_error()) {
      console.error("Apple sign in failed:", res.error)
      setIsAuthLoading(false)
      return
    }
    const url = res.value

    console.log("Opening browser with:", url)
    await WebBrowser.openBrowserAsync(url)

    setIsAuthLoading(false)
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("login:login")} leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView
        contentContainerClassName="flex-grow"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <View className="flex-1 p-4">
          <Text preset="heading" className="text-2xl font-bold text-foreground mb-4">
            {translate("login:loginToMentra")}
          </Text>

          <View className="w-full">
            {/* Email Input */}
            <View className="mb-3">
              <Text tx="login:email" className="text-sm font-medium text-foreground mb-2" />
              <View className="flex-row items-center h-12 border border-border rounded-lg px-3 bg-background">
                <TextInput
                  hitSlop={{top: 16, bottom: 16}}
                  className="flex-1 text-base text-foreground"
                  placeholder={translate("login:emailPlaceholder")}
                  value={email}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  onChangeText={setEmail}
                  placeholderTextColor={theme.colors.textDim}
                  autoFocus={true}
                />
              </View>
            </View>

            {/* Password Input */}
            <View className="mb-3">
              <Text tx="login:password" className="text-sm font-medium text-foreground mb-2" />
              <View className="flex-row items-center h-12 border border-border rounded-lg px-3 bg-background dark:bg-transparent dark:shadow-sm">
                <TextInput
                  hitSlop={{top: 16, bottom: 16}}
                  className="flex-1 text-base text-foreground"
                  placeholder={translate("login:passwordPlaceholder")}
                  value={password}
                  autoCapitalize="none"
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  placeholderTextColor={theme.colors.textDim}
                  onSubmitEditing={handleEmailSignIn}
                  returnKeyType="go"
                />
                <TouchableOpacity
                  hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
                  onPress={() => setShowPassword(!showPassword)}>
                  <FontAwesome name={showPassword ? "eye" : "eye-slash"} size={18} color={theme.colors.textDim} />
                </TouchableOpacity>
              </View>
            </View>

            <Spacer height={spacing.s2} />

            <Button
              tx="login:logIn"
              onPress={handleEmailSignIn}
              disabled={isLoading}
              LeftAccessory={() => <Icon name="mail" size={20} color={theme.colors.background} />}
            />

            <Text className="text-xs text-muted-foreground text-center mt-3">{translate("login:termsTextSignIn")}</Text>

            <TouchableOpacity onPress={() => push("/auth/forgot-password")} className="self-center mt-4">
              <Text tx="login:forgotPassword" className="text-sm text-primary" />
            </TouchableOpacity>

            {/* Divider */}
            <View className="flex-row items-center my-6">
              <View className="flex-1 h-px bg-border" />
              <Text className="mx-3 text-sm text-muted-foreground">OR</Text>
              <View className="flex-1 h-px bg-border" />
            </View>

            <View className="gap-4">
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
        </View>
      </ScrollView>

      {/* Loading Modal */}
      <Modal visible={isLoading || isAuthLoading} transparent={true} animationType="fade">
        <View className="flex-1 bg-black/70 justify-center items-center">
          <View className="bg-background p-8 rounded-2xl items-center min-w-[200px]">
            <ActivityIndicator size="large" color={theme.colors.foreground} className="mb-4" />
            <Text preset="bold" className="text-foreground">
              {translate("login:connectingToServer")}
            </Text>
          </View>
        </View>
      </Modal>
    </Screen>
  )
}
