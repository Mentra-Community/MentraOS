import LogoSvg from "@assets/logo/logo.svg"
import {FontAwesome} from "@expo/vector-icons"
import AppleIcon from "assets/icons/component/AppleIcon"
import GoogleIcon from "assets/icons/component/GoogleIcon"
import * as WebBrowser from "expo-web-browser"
import {useEffect, useRef, useState} from "react"
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  TextInput,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native"
import {Pressable} from "react-native-gesture-handler"

import {Button, Screen, Text} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {spacing, ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {useAppTheme} from "@/utils/useAppTheme"
import {useSafeAreaInsetsStyle} from "@/utils/useSafeAreaInsetsStyle"

export default function LoginScreen() {
  const [isSigningUp, setIsSigningUp] = useState(false)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [isFormLoading, setIsFormLoading] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(false)
  const [formAction, setFormAction] = useState<"signin" | "signup" | null>(null)
  const [backPressCount, setBackPressCount] = useState(0)
  const {push, replace} = useNavigationHistory()
  const [isChina] = useSetting(SETTINGS.china_deployment.key)

  // Get theme and safe area insets
  const {theme, themed} = useAppTheme()
  const $bottomContainerInsets = useSafeAreaInsetsStyle(["bottom"])

  // Animation values
  const opacity = useRef(new Animated.Value(0)).current
  const translateY = useRef(new Animated.Value(20)).current
  const formScale = useRef(new Animated.Value(0)).current
  const authOverlayOpacity = useRef(new Animated.Value(0)).current

  // Password visibility
  const [showPassword, setShowPassword] = useState(false)
  const togglePasswordVisibility = () => {
    setShowPassword(!showPassword)
  }

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start()
  }, [opacity, translateY])

  useEffect(() => {
    if (isSigningUp) {
      Animated.spring(formScale, {
        toValue: 1,
        tension: 50,
        friction: 7,
        useNativeDriver: true,
      }).start()
    } else {
      formScale.setValue(0)
    }
  }, [formScale, isSigningUp])

  // Add a listener for app state changes to detect when the app comes back from background
  useEffect(() => {
    const handleAppStateChange = (nextAppState: any) => {
      console.log("App state changed to:", nextAppState)
      // If app comes back to foreground, hide the loading overlay
      if (nextAppState === "active" && isAuthLoading) {
        console.log("App became active, hiding auth overlay")
        setIsAuthLoading(false)
        authOverlayOpacity.setValue(0)
      }
    }

    // Subscribe to app state changes
    const appStateSubscription = AppState.addEventListener("change", handleAppStateChange)

    return () => {
      appStateSubscription.remove()
    }
  }, [])

  const handleGoogleSignIn = async () => {
    // Start auth flow
    setIsAuthLoading(true)

    // Show the auth loading overlay
    Animated.timing(authOverlayOpacity, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start()

    // Automatically hide the overlay after 5 seconds regardless of what happens
    // This is a failsafe in case the auth flow is interrupted
    setTimeout(() => {
      console.log("Auth flow failsafe timeout - hiding loading overlay")
      setIsAuthLoading(false)
      authOverlayOpacity.setValue(0)
    }, 5000)

    const res = await mentraAuth.googleSignIn()

    // 2) If there's an error, handle it
    if (res.is_error()) {
      // showAlert(translate('loginScreen.errors.authError'), error.message);
      setIsAuthLoading(false)
      authOverlayOpacity.setValue(0)
      return
    }
    const url = res.value

    // 3) If we get a `url` back, we must open it ourselves in RN
    console.log("Opening browser with:", url)
    // await Linking.openURL(data.url)

    await WebBrowser.openBrowserAsync(url)

    // Directly hide the loading overlay when we leave the app
    // This ensures it won't be shown when user returns without completing auth
    setIsAuthLoading(false)
    authOverlayOpacity.setValue(0)
  }

  const handleAppleSignIn = async () => {
    setIsAuthLoading(true)

    // Show the auth loading overlay
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

    // If we get a `url` back, we must open it ourselves in React Native
    console.log("Opening browser with:", url)
    await WebBrowser.openBrowserAsync(url)

    // Directly hide the loading overlay when we leave the app
    // This ensures it won't be shown when user returns without completing auth
    setIsAuthLoading(false)
    authOverlayOpacity.setValue(0)
  }

  const handleEmailSignUp = async (email: string, password: string) => {
    Keyboard.dismiss()
    setIsFormLoading(true)
    setFormAction("signup")

    const res = await mentraAuth.signUp({email, password})

    if (res.is_error()) {
      console.error("Error during sign-up:", res.error)
      showAlert(translate("common:error"), res.error.toString(), [{text: translate("common:ok")}])
      setIsFormLoading(false)
      setFormAction(null)
      return
    }

    setIsFormLoading(false)
    setFormAction(null)
    replace("/")
  }

  const handleEmailSignIn = async (email: string, password: string) => {
    Keyboard.dismiss()
    setIsFormLoading(true)
    setFormAction("signin")
    
    const res = await mentraAuth.signInWithPassword({email, password})
    if (res.is_error()) {
      console.error("Error during sign-in:", res.error)
      showAlert(translate("common:error"), res.error.toString(), [{text: translate("common:ok")}])
      setIsFormLoading(false)
      return
    }

    setIsFormLoading(false)
    replace("/")
  }

  useEffect(() => {
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      // If email form is shown, close it instead of exiting
      if (isSigningUp) {
        setIsSigningUp(false)
        return true
      }

      // Otherwise, use the double-press to exit behavior
      if (backPressCount === 0) {
        setBackPressCount(1)
        setTimeout(() => setBackPressCount(0), 2000)
        // showAlert(translate('loginScreen.leavingAlready'), translate('loginScreen.pressBackToExit'));
        return true
      } else {
        BackHandler.exitApp()
        return true
      }
    })

    return () => backHandler.remove()
  }, [backPressCount, isSigningUp])

  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} contentContainerStyle={themed($container)}>
      <ScrollView
        contentContainerStyle={themed($scrollContent)}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <View style={themed($card)}>
          {/* Auth Loading Overlay */}
          {isAuthLoading && (
            <Animated.View style={[themed($authLoadingOverlay), {opacity: authOverlayOpacity}]}>
              <View style={themed($authLoadingContent)}>
                <View style={themed($authLoadingLogoContainer)}>
                  <LogoSvg width={108} height={58} />
                </View>
                <ActivityIndicator size="large" color={theme.colors.tint} style={themed($authLoadingIndicator)} />
                <Text tx="login:connectingToServer" style={themed($authLoadingText)} />
              </View>
            </Animated.View>
          )}
          <Animated.View style={{opacity, transform: [{translateY}]}}>
            <View style={themed($logoContainer)}>
              <LogoSvg width={108} height={58} />
            </View>
            <Text preset="heading" tx="login:title" style={themed($title)} />
            <Text preset="subheading" tx="login:subtitle" style={themed($subtitle)} />
          </Animated.View>

          <Animated.View style={[themed($content), {opacity, transform: [{translateY}]}]}>
            {isSigningUp ? (
              <Animated.View style={[themed($form), {transform: [{scale: formScale}]}]}>
                <View style={themed($inputGroup)}>
                  <Text tx="login:email" style={themed($inputLabel)} />
                  <View style={themed($enhancedInputContainer)}>
                    <FontAwesome
                      name="envelope"
                      size={16}
                      color={theme.colors.textDim}
                      // style={themed($inputIcon)}
                    />
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
                    />
                  </View>
                </View>

                <View style={themed($inputGroup)}>
                  <Text tx="login:password" style={themed($inputLabel)} />
                  <View style={themed($enhancedInputContainer)}>
                    <FontAwesome
                      name="lock"
                      size={16}
                      color={theme.colors.textDim}
                      // style={themed($inputIcon)}
                    />
                    <Spacer width={spacing.s3} />
                    <TextInput
                      hitSlop={{top: 16, bottom: 16}}
                      style={themed($enhancedInput)}
                      placeholder={translate("login:passwordPlaceholder")}
                      value={password}
                      autoCapitalize="none"
                      onChangeText={setPassword}
                      secureTextEntry={!showPassword}
                      placeholderTextColor={theme.colors.textDim}
                    />
                    <TouchableOpacity
                      hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
                      onPress={togglePasswordVisibility}>
                      <FontAwesome name={showPassword ? "eye" : "eye-slash"} size={18} color={theme.colors.textDim} />
                    </TouchableOpacity>
                  </View>
                </View>

                <TouchableOpacity
                  onPress={() => push("/auth/forgot-password")}
                  style={themed($forgotPasswordContainer)}>
                  <Text tx="login:forgotPassword" style={themed($forgotPasswordText)} />
                </TouchableOpacity>

                <Spacer height={spacing.s3} />

                <Button
                  tx="login:login"
                  style={themed($primaryButton)}
                  pressedStyle={themed($pressedButton)}
                  textStyle={themed($buttonText)}
                  onPress={() => handleEmailSignIn(email, password)}
                  disabled={isFormLoading}
                />
                <Spacer height={spacing.s3} />
                <Button
                  tx="login:createAccount"
                  style={themed($secondaryButton)}
                  pressedStyle={themed($pressedButton)}
                  textStyle={themed($buttonText)}
                  onPress={() => handleEmailSignUp(email, password)}
                  disabled={isFormLoading}
                />

                <Spacer height={spacing.s3} />

                <Pressable onPress={() => setIsSigningUp(false)}>
                  <View style={{flexDirection: "row", justifyContent: "center", alignItems: "center"}}>
                    <FontAwesome
                      name="arrow-left"
                      size={16}
                      color={theme.colors.textDim}
                      // style={themed($backIcon)}
                    />
                    <Text style={{marginLeft: 8, color: theme.colors.textDim}}>Back</Text>
                  </View>
                </Pressable>
              </Animated.View>
            ) : (
              <View style={themed($signInOptions)}>
                <Button
                  flexContainer
                  tx="login:continueWithEmail"
                  style={themed($primaryButton)}
                  pressedStyle={themed($pressedButton)}
                  textStyle={themed($emailButtonText)}
                  onPress={() => setIsSigningUp(true)}
                  LeftAccessory={() => (
                    <FontAwesome
                      name="envelope"
                      size={16}
                      color={theme.colors.textAlt}
                      // style={themed($emailIcon)}
                    />
                  )}
                />
                {!isChina && (
                  <TouchableOpacity style={[themed($socialButton), themed($googleButton)]} onPress={handleGoogleSignIn}>
                    <View style={[themed($socialIconContainer), {position: "absolute", left: 12}]}>
                      <GoogleIcon />
                    </View>
                    <Text style={themed($socialButtonText)} tx="login:continueWithGoogle" />
                  </TouchableOpacity>
                )}

                {Platform.OS === "ios" && !isChina && (
                  <TouchableOpacity style={[themed($socialButton), themed($appleButton)]} onPress={handleAppleSignIn}>
                    <View style={[themed($socialIconContainer), {position: "absolute", left: 12}]}>
                      <AppleIcon color={theme.colors.text} />
                    </View>
                    <Text style={[themed($socialButtonText), themed($appleButtonText)]} tx="login:continueWithApple" />
                  </TouchableOpacity>
                )}
              </View>
            )}
          </Animated.View>

          <Animated.View style={[{opacity}, $bottomContainerInsets]}>
            <Text tx="login:termsText" size="xs" style={themed($termsText)} />
          </Animated.View>
        </View>
      </ScrollView>

      {/* Loading Modal */}
      <Modal visible={isFormLoading} transparent={true} animationType="fade">
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(0, 0, 0, 0.7)",
            justifyContent: "center",
            alignItems: "center",
          }}>
          <View
            style={{
              backgroundColor: theme.colors.background,
              padding: theme.spacing.s8,
              borderRadius: theme.spacing.s4,
              alignItems: "center",
              minWidth: 200,
            }}>
            <ActivityIndicator size="large" color={theme.colors.tint} style={{marginBottom: theme.spacing.s4}} />
            <Text preset="bold" style={{color: theme.colors.text}}>
              {formAction === "signup" ? "Creating your account..." : "Signing in..."}
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
  justifyContent: "center",
})

const $card: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  padding: spacing.s6,
})

const $authLoadingOverlay: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: colors.background + "E6", // 90% opacity
  zIndex: 10,
  justifyContent: "center",
  alignItems: "center",
})

const $authLoadingContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  padding: spacing.s4,
})

const $authLoadingLogoContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  justifyContent: "center",
  marginBottom: spacing.s6,
})

const $logoContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  justifyContent: "center",
  marginBottom: spacing.s4,
})

const $authLoadingIndicator: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s3,
})

const $authLoadingText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  textAlign: "center",
})

const $title: ThemedStyle<TextStyle> = ({spacing, colors}) => ({
  fontSize: 46,
  color: colors.text,
  textAlign: "center",
  marginBottom: spacing.s2,
  paddingTop: spacing.s8,
  paddingBottom: spacing.s4,
})

const $subtitle: ThemedStyle<TextStyle> = ({spacing, colors}) => ({
  fontSize: 16,
  color: colors.text,
  textAlign: "center",
  marginBottom: spacing.s4,
})

const $content: ThemedStyle<ViewStyle> = ({spacing}) => ({
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
  // Remove shadows for light theme
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

const $signInOptions: ThemedStyle<ViewStyle> = ({spacing}) => ({
  gap: spacing.s4,
})

const $socialButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  height: 44,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: spacing.s6,
  paddingHorizontal: spacing.s3,
  backgroundColor: colors.background,
  // Remove shadows for light theme to avoid thick border appearance
  shadowOffset: {
    width: 0,
    height: 1,
  },
  shadowOpacity: 0.1,
  shadowRadius: 1,
  elevation: 1,
})

const $googleButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
})

const $appleButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  borderColor: colors.border,
})

const $socialIconContainer: ThemedStyle<ViewStyle> = () => ({
  width: 24,
  height: 24,
  justifyContent: "center",
  alignItems: "center",
})

const $socialButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  color: colors.text,
  flex: 1,
  textAlign: "center",
})

const $appleButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text, // Same as Google button text
})

const $primaryButton: ThemedStyle<ViewStyle> = () => ({})

const $secondaryButton: ThemedStyle<ViewStyle> = () => ({})

const $pressedButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  opacity: 0.9,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textAlt,
  fontSize: 16,
  fontWeight: "bold",
})

const $emailButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textAlt,
  fontSize: 16,
})

const $termsText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 11,
  color: colors.textDim,
  textAlign: "center",
  marginTop: 8,
})

const $forgotPasswordContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignSelf: "flex-end",
  marginTop: spacing.s2,
})

const $forgotPasswordText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.tint,
  textDecorationLine: "underline",
})
