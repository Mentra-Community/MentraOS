// eslint-disable-next-line import/no-unresolved
import LogoSvg from "@assets/logo/logo.svg"
import {useLocalSearchParams} from "expo-router"
import * as WebBrowser from "expo-web-browser"
import {useEffect, useRef, useState} from "react"
import {ActivityIndicator, Animated, AppState, BackHandler, Modal, Platform, TouchableOpacity, View} from "react-native"

import {Button, Icon, Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {mapAuthError} from "@/utils/auth/authErrors"
import {useSafeAreaInsetsStyle} from "@/utils/useSafeAreaInsetsStyle"
import AppleIcon from "assets/icons/component/AppleIcon"
import GoogleIcon from "assets/icons/component/GoogleIcon"

export default function LoginScreen() {
  const [isAuthLoading, setIsAuthLoading] = useState(false)
  const [backPressCount, setBackPressCount] = useState(0)
  const {push} = useNavigationHistory()
  const [isChina] = useSetting(SETTINGS.china_deployment.key)
  const {authError} = useLocalSearchParams<{authError?: string}>()
  const {theme} = useAppTheme()
  const $bottomContainerInsets = useSafeAreaInsetsStyle(["bottom"])
  const authOverlayOpacity = useRef(new Animated.Value(0)).current

  // Handle auth errors passed via URL params (e.g., from expired reset links)
  useEffect(() => {
    if (authError) {
      const errorMessage = mapAuthError(authError)
      showAlert(translate("common:error"), errorMessage, [{text: translate("common:ok")}])
    }
  }, [authError])

  // Add a listener for app state changes to detect when the app comes back from background
  useEffect(() => {
    const handleAppStateChange = (nextAppState: any) => {
      console.log("App state changed to:", nextAppState)
      if (nextAppState === "active" && isAuthLoading) {
        console.log("App became active, hiding auth overlay")
        setIsAuthLoading(false)
        authOverlayOpacity.setValue(0)
      }
    }

    const appStateSubscription = AppState.addEventListener("change", handleAppStateChange)

    return () => {
      appStateSubscription.remove()
    }
  }, [])

  const handleGoogleSignIn = async () => {
    setIsAuthLoading(true)
    Animated.timing(authOverlayOpacity, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start()

    setTimeout(() => {
      console.log("Auth flow failsafe timeout - hiding loading overlay")
      setIsAuthLoading(false)
      authOverlayOpacity.setValue(0)
    }, 5000)

    const res = await mentraAuth.googleSignIn()

    if (res.is_error()) {
      setIsAuthLoading(false)
      authOverlayOpacity.setValue(0)
      return
    }

    const url = res.value
    console.log("Opening browser with:", url)
    await WebBrowser.openBrowserAsync(url)
    setIsAuthLoading(false)
    authOverlayOpacity.setValue(0)
  }

  const handleAppleSignIn = async () => {
    setIsAuthLoading(true)
    Animated.timing(authOverlayOpacity, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start()

    const res = await mentraAuth.appleSignIn()

    if (res.is_error()) {
      console.error("Apple sign in failed:", res.error)
      setIsAuthLoading(false)
      authOverlayOpacity.setValue(0)
      return
    }

    const url = res.value
    console.log("Opening browser with:", url)
    await WebBrowser.openBrowserAsync(url)
    setIsAuthLoading(false)
    authOverlayOpacity.setValue(0)
  }

  useEffect(() => {
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (backPressCount === 0) {
        setBackPressCount(1)
        setTimeout(() => setBackPressCount(0), 2000)
        return true
      } else {
        BackHandler.exitApp()
        return true
      }
    })

    return () => backHandler.remove()
  }, [backPressCount])

  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} contentContainerStyle={$bottomContainerInsets}>
      <View className="flex-1">
        {/* Auth Loading Overlay */}
        {isAuthLoading && (
          <Animated.View
            className="absolute inset-0 bg-background/90 z-10 justify-center items-center"
            style={{opacity: authOverlayOpacity}}>
            <View className="items-center p-4">
              <View className="items-center justify-center mb-6">
                <LogoSvg width={80} height={80} />
              </View>
              <ActivityIndicator className="mb-3" size="large" color={theme.colors.tint} />
              <Text className="text-primary-foreground text-center">{translate("login:connectingToServer")}</Text>
            </View>
          </Animated.View>
        )}

        <View className="flex-1 justify-center p-4">
          <View className="items-center justify-center mb-4">
            <LogoSvg width={100} height={100} />
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
                onPress={() => push("/auth/signup")}
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
