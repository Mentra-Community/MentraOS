import React, {useState, useRef, useEffect} from "react"
import {
  View,
  TouchableOpacity,
  TextInput,
  Animated,
  SafeAreaView,
  BackHandler,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  ScrollView,
  AppState,
  ViewStyle,
  TextStyle,
  Keyboard,
  Modal,
} from "react-native"
import LinearGradient from "react-native-linear-gradient"
import {supabase} from "@/supabase/supabaseClient"
import {Linking} from "react-native"
import {Screen, Text, Button, Icon} from "@/components/ignite"
import {translate, TxKeyPath} from "@/i18n"
import {spacing, ThemedStyle} from "@/theme"
import {useSafeAreaInsetsStyle} from "@/utils/useSafeAreaInsetsStyle"
import {useAppTheme} from "@/utils/useAppTheme"
import {FontAwesome} from "@expo/vector-icons"
import GoogleIcon from "assets/icons/component/GoogleIcon"
import AppleIcon from "assets/icons/component/AppleIcon"
import {router} from "expo-router"
import showAlert from "@/utils/AlertUtils"
import {Pressable} from "react-native-gesture-handler"
import {Spacer} from "@/components/misc/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import * as WebBrowser from "expo-web-browser"
import Toast from "react-native-toast-message"

export default function LoginScreen() {
  const [isSigningUp, setIsSigningUp] = useState(false)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [isFormLoading, setIsFormLoading] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(false)
  const [formAction, setFormAction] = useState<"signin" | "signup" | null>(null)
  const [backPressCount, setBackPressCount] = useState(0)
  const {goBack, push, replace} = useNavigationHistory()

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
  }, [isAuthLoading, authOverlayOpacity])

  useEffect(() => {
    const handleDeepLink = async (event: any) => {
      const authParams = parseAuthParams(event.url)

      if (authParams && authParams.access_token && authParams.refresh_token) {
        try {
          // Update the Supabase session manually
          const {data, error} = await supabase.auth.setSession({
            access_token: authParams.access_token,
            refresh_token: authParams.refresh_token,
          })
          if (error) {
            console.error("Error setting session:", error)
          } else {
            console.log("Session updated:", data.session)
          console.log("[LOGIN DEBUG] Session set successfully, data.session exists:", !!data.session)
            // Dismiss the WebView after successful authentication (non-blocking)
            console.log("[LOGIN DEBUG] About to dismiss browser, platform:", Platform.OS)
            try {
              const dismissResult = WebBrowser.dismissBrowser()
              console.log("[LOGIN DEBUG] dismissBrowser returned:", dismissResult, "type:", typeof dismissResult)
              if (dismissResult && typeof dismissResult.catch === 'function') {
                dismissResult.catch(() => {
                  // Ignore errors - browser might not be open
                })
              }
            } catch (dismissError) {
              console.log("[LOGIN DEBUG] Error calling dismissBrowser:", dismissError)
              // Ignore - browser might not be open or function might not exist
            }

            // Small delay to ensure auth state propagates
            console.log("[LOGIN DEBUG] About to set timeout for navigation")
            setTimeout(() => {
              console.log("[LOGIN DEBUG] Inside setTimeout, about to call router.replace('/')")
              try {
                router.replace("/")
                console.log("[LOGIN DEBUG] router.replace called successfully")
              } catch (navError) {
                console.error("[LOGIN DEBUG] Error calling router.replace:", navError)
              }
            }, 100)
            console.log("[LOGIN DEBUG] setTimeout scheduled")
            return // Don't do the navigation below
          }
        } catch (err) {
          console.error("Exception during setSession:", err)
          console.error("[LOGIN DEBUG] setSession error details:", {
            name: err.name,
            message: err.message,
            stack: err.stack
          })
        }
      }

      // Always hide the loading overlay when we get any deep link callback
      // This ensures it gets hidden even if auth was not completed
      setIsAuthLoading(false)
      authOverlayOpacity.setValue(0)

      // Check if this is an auth callback without tokens
      if (event.url.includes("auth/callback") && !authParams) {
        // Try checking if user is already authenticated
        const {
          data: {session},
        } = await supabase.auth.getSession()
        if (session) {
          router.replace("/")
        }
      } else if (event.url.includes("auth/callback") && authParams) {
        // Navigation already handled above after setSession
      }
    }

    const linkingSubscription = Linking.addEventListener("url", (event) => {
      handleDeepLink(event).catch(error => {
        console.error("Error handling deep link:", error)
      })
    })
    // Handle deep links that opened the app
    Linking.getInitialURL().then(url => {
      if (url) {
        handleDeepLink({url}).catch(error => {
          console.error("Error handling initial URL:", error)
        })
      }
    }).catch(error => {
      console.error("Error getting initial URL:", error)
    })

    // Add this to see if linking is working at all
    Linking.canOpenURL("com.mentra://auth/callback").then(supported => {
      console.log("Can open URL:", supported)
    }).catch(error => {
      console.error("Error checking URL support:", error)
    })

    return () => {
      linkingSubscription.remove()
    }
  }, [authOverlayOpacity])

  const parseAuthParams = (url: string) => {
    const parts = url.split("#")
    if (parts.length < 2) return null
    const paramsString = parts[1]
    const params = new URLSearchParams(paramsString)
    return {
      access_token: params.get("access_token"),
      refresh_token: params.get("refresh_token"),
      token_type: params.get("token_type"),
      expires_in: params.get("expires_in"),
      // Add any other parameters you might need
    }
  }

  const handleGoogleSignIn = async () => {
    try {
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

      const {data, error} = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          // Must match the deep link scheme/host/path in your AndroidManifest.xml
          redirectTo: "com.mentra://auth/callback",
          skipBrowserRedirect: true,
          queryParams: {
            prompt: "select_account",
          },
        },
      })

      // 2) If there's an error, handle it
      if (error) {
        console.error("Supabase Google sign-in error:", error)
        // showAlert(translate('loginScreen.errors.authError'), error.message);
        setIsAuthLoading(false)
        authOverlayOpacity.setValue(0)
        return
      }

      // 3) If we get a `url` back, we must open it ourselves in RN
      if (data?.url) {
        console.log("Opening browser with:", data.url)
        // await Linking.openURL(data.url)

        await WebBrowser.openBrowserAsync(data.url)

        // Directly hide the loading overlay when we leave the app
        // This ensures it won't be shown when user returns without completing auth
        setIsAuthLoading(false)
        authOverlayOpacity.setValue(0)
      }
    } catch (err) {
      console.error("Google sign in failed:", err)
      // showAlert(
      //   translate('loginScreen.errors.authError'),
      //   translate('loginScreen.errors.googleSignInFailed'),
      // );
      setIsAuthLoading(false)
      authOverlayOpacity.setValue(0)
    }

    console.log("signInWithOAuth call finished")
  }

  const showToastMessage = (txPath: TxKeyPath) => {
    Toast.show({
      type: "error",
      text1: translate(txPath),
      position: "bottom",
    })
  }
  const handleAppleSignIn = async () => {
    try {
      setIsAuthLoading(true)

      // Show the auth loading overlay
      Animated.timing(authOverlayOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start()

      const {data, error} = await supabase.auth.signInWithOAuth({
        provider: "apple",
        options: {
          // Match the deep link scheme/host/path in your AndroidManifest.xml
          redirectTo: "com.mentra://auth/callback",
        },
      })

      // If there's an error, handle it
      if (error) {
        console.error("Supabase Apple sign-in error:", error)
        // showAlert(translate('loginScreen.errors.authError'), error.message);
        setIsAuthLoading(false)
        authOverlayOpacity.setValue(0)
        return
      }

      // If we get a `url` back, we must open it ourselves in React Native
      if (data?.url) {
        console.log("Opening browser with:", data.url)
        await WebBrowser.openBrowserAsync(data.url)

        // Directly hide the loading overlay when we leave the app
        // This ensures it won't be shown when user returns without completing auth
        setIsAuthLoading(false)
        authOverlayOpacity.setValue(0)
      }

      // Note: The actual navigation to SplashScreen will be handled by
      // the onAuthStateChange listener you already have in place
    } catch (err) {
      console.error("Apple sign in failed:", err)
      // showAlert(
      //   translate('loginScreen.errors.authError'),
      //   translate('loginScreen.errors.appleSignInFailed'),
      // );
      setIsAuthLoading(false)
      authOverlayOpacity.setValue(0)
    }

    console.log("signInWithOAuth for Apple finished")
  }

  const handleEmailSignUp = async (email: string, password: string) => {
    Keyboard.dismiss()
    setIsFormLoading(true)
    setFormAction("signup")

    try {
      const redirectUrl = "https://mentra.glass/verify-email" // No encoding needed

      const {data, error} = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: "com.mentra://auth/callback",
        },
      })

      if (error) {
        console.log("Sign-up error:", error)

        // Check for common Supabase error messages when email already exists
        const errorMessage = error.message.toLowerCase()

        if (
          errorMessage.includes("already registered") ||
          errorMessage.includes("user already registered") ||
          errorMessage.includes("email already exists") ||
          errorMessage.includes("identity already linked")
        ) {
          // Try to detect if it's a Google or Apple account
          // Note: Supabase doesn't always tell us which provider, so we show a generic message
          showAlert(translate("login:emailAlreadyRegistered"), translate("login:useGoogleSignIn"))
        } else {
          showAlert(translate("common:error"), error.message)
        }
      } else if (!data.session) {
        // Ensure translations are resolved before passing to showAlert
        const successTitle = translate("login:success")
        const verificationMessage = translate("login:checkEmailVerification")
        showAlert(successTitle, verificationMessage)
      } else {
        console.log("Sign-up successful:", data)
        replace("/")
      }
    } catch (err) {
      console.error("Error during sign-up:", err)
      showAlert(translate("common:error"), err.toString())
    } finally {
      setIsFormLoading(false)
      setFormAction(null)
    }
  }

  const handleEmailSignIn = async (email: string, password: string) => {
    Keyboard.dismiss()
    setIsFormLoading(true)
    setFormAction("signin")
    const {data, error} = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      showAlert(translate("common:error"), error.message)
      // Handle sign-in error
    } else {
      console.log("Sign-in successful:", data)
      replace("/")
    }
    setIsFormLoading(false)
  }

  useEffect(() => {
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
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
  }, [backPressCount])

  useEffect(() => {
    // Subscribe to auth state changes:
    // const {
    //   data: { subscription },
    // } = supabase.auth.onAuthStateChange((event, session) => {
    //   console.log('onAuthStateChange event:', event, session);
    //   if (session) {
    //     // If session is present, user is authenticated
    //     // Hide the auth loading overlay after a short delay
    //     setTimeout(() => {
    //       Animated.timing(authOverlayOpacity, {
    //         toValue: 0,
    //         duration: 300,
    //         useNativeDriver: true,
    //       }).start(() => {
    //         setIsAuthLoading(false);
    //         navigation.replace('SplashScreen');
    //       });
    //     }, 500); // Give a slight delay to ensure the animation is seen
    //   }
    // });
    // // Also add a focus listener to hide the loading overlay when returning to this screen
    // const unsubscribe = navigation.addListener('focus', () => {
    //   // If we're coming back to this screen and the auth overlay is still showing, hide it
    //   if (isAuthLoading) {
    //     console.log('Screen focused, hiding auth overlay if showing');
    //     Animated.timing(authOverlayOpacity, {
    //       toValue: 0,
    //       duration: 300,
    //       useNativeDriver: true,
    //     }).start(() => {
    //       setIsAuthLoading(false);
    //     });
    //   }
    // });
    // // Cleanup subscriptions on unmount
    // return () => {
    //   subscription.unsubscribe();
    //   unsubscribe();
    // };
  }, [authOverlayOpacity, isAuthLoading])

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
                <View style={themed($authLoadingLogoPlaceholder)} />
                <ActivityIndicator size="large" color={theme.colors.tint} style={themed($authLoadingIndicator)} />
                <Text tx="login:connectingToMentraOS" style={themed($authLoadingText)} />
              </View>
            </Animated.View>
          )}
          <Animated.View style={{opacity, transform: [{translateY}]}}>
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
                      color={theme.colors.text}
                      // style={themed($inputIcon)}
                    />
                    <Spacer width={spacing.xxs} />
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
                      color={theme.colors.text}
                      // style={themed($inputIcon)}
                    />
                    <Spacer width={spacing.xxs} />
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
                      <FontAwesome name={showPassword ? "eye" : "eye-slash"} size={18} color={theme.colors.text} />
                    </TouchableOpacity>
                  </View>
                </View>

                <Spacer height={spacing.sm} />

                <Button
                  tx="login:login"
                  style={themed($primaryButton)}
                  pressedStyle={themed($pressedButton)}
                  textStyle={themed($buttonText)}
                  onPress={() => handleEmailSignIn(email, password)}
                  disabled={isFormLoading}
                />
                <Spacer height={spacing.sm} />
                <Button
                  tx="login:createAccount"
                  style={themed($secondaryButton)}
                  pressedStyle={themed($pressedButton)}
                  textStyle={themed($buttonText)}
                  onPress={() => handleEmailSignUp(email, password)}
                  disabled={isFormLoading}
                />

                <Spacer height={spacing.sm} />

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
                <TouchableOpacity style={[themed($socialButton), themed($googleButton)]} onPress={handleGoogleSignIn}>
                  <View style={[themed($socialIconContainer), {position: "absolute", left: 12}]}>
                    <GoogleIcon />
                  </View>
                  <Text style={themed($socialButtonText)} tx="login:continueWithGoogle" />
                </TouchableOpacity>

                {Platform.OS === "ios" && (
                  <TouchableOpacity style={[themed($socialButton), themed($appleButton)]} onPress={handleAppleSignIn}>
                    <View style={[themed($socialIconContainer), {position: "absolute", left: 12}]}>
                      <AppleIcon color={theme.colors.text} />
                    </View>
                    <Text style={[themed($socialButtonText), themed($appleButtonText)]} tx="login:continueWithApple" />
                  </TouchableOpacity>
                )}

                <View style={themed($dividerContainer)}>
                  <View style={themed($divider)} />
                  <Text style={themed($dividerText)} tx="common:or" />
                  <View style={themed($divider)} />
                </View>

                <Button
                  tx="login:continueWithEmail"
                  style={themed($primaryButton)}
                  pressedStyle={themed($pressedButton)}
                  textStyle={themed($emailButtonText)}
                  onPress={() => setIsSigningUp(true)}
                  LeftAccessory={() => (
                    <FontAwesome
                      name="envelope"
                      size={16}
                      color={theme.colors.text}
                      // style={themed($emailIcon)}
                    />
                  )}
                />
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
              padding: theme.spacing.xl,
              borderRadius: theme.spacing.md,
              alignItems: "center",
              minWidth: 200,
            }}>
            <ActivityIndicator size="large" color={theme.colors.tint} style={{marginBottom: theme.spacing.md}} />
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

const $gradientContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $keyboardAvoidingView: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $scrollContent: ThemedStyle<ViewStyle> = () => ({
  flexGrow: 1,
  justifyContent: "center",
})

const $card: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  padding: spacing.lg,
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
  padding: spacing.md,
})

const $authLoadingLogoPlaceholder: ThemedStyle<ViewStyle> = () => ({
  width: 100,
  height: 100,
  marginBottom: 20,
})

const $authLoadingIndicator: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.sm,
})

const $authLoadingText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  textAlign: "center",
})

const $title: ThemedStyle<TextStyle> = ({spacing, colors}) => ({
  fontSize: 46,
  color: colors.text,
  textAlign: "center",
  marginBottom: spacing.xs,
  paddingTop: spacing.xl,
  paddingBottom: spacing.md,
})

const $subtitle: ThemedStyle<TextStyle> = ({spacing, colors}) => ({
  fontSize: 16,
  color: colors.text,
  textAlign: "center",
  marginBottom: spacing.md,
})

const $content: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.md,
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

const $inputIcon: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginRight: spacing.xs,
})

const $enhancedInput: ThemedStyle<TextStyle> = ({colors}) => ({
  flex: 1,
  fontSize: 16,
  color: colors.text,
})

const $signInOptions: ThemedStyle<ViewStyle> = ({spacing}) => ({
  gap: spacing.xs,
})

const $socialButton: ThemedStyle<ViewStyle> = ({colors, spacing, isDark}) => ({
  flexDirection: "row",
  alignItems: "center",
  height: 44,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 8,
  paddingHorizontal: spacing.sm,
  marginBottom: spacing.xs,
  backgroundColor: isDark ? colors.transparent : colors.background,
  // Remove shadows for light theme to avoid thick border appearance
  ...(isDark
    ? {
        shadowOffset: {
          width: 0,
          height: 1,
        },
        shadowOpacity: 0.1,
        shadowRadius: 1,
        elevation: 1,
      }
    : {}),
})

const $googleButton: ThemedStyle<ViewStyle> = ({colors, isDark}) => ({
  backgroundColor: isDark ? colors.transparent : colors.background,
})

const $appleButton: ThemedStyle<ViewStyle> = ({colors, isDark}) => ({
  backgroundColor: isDark ? colors.transparent : colors.background,
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

const $primaryButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({})

const $secondaryButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({})

const $pressedButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.buttonPressed,
  opacity: 0.9,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  fontWeight: "bold",
})

const $emailButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
})

const $ghostButton: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  backgroundColor: colors.transparent,
  height: 48,
  borderRadius: 8,
  justifyContent: "center",
  alignItems: "center",
  marginTop: spacing.sm,
})

const $backIcon: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginRight: spacing.xs,
})

const $emailIcon: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginRight: spacing.xs,
})

const $ghostButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  fontSize: 15,
})

const $dividerContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  marginVertical: spacing.sm,
})

const $divider: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  height: 1,
  backgroundColor: colors.border,
})

const $dividerText: ThemedStyle<TextStyle> = ({spacing, colors}) => ({
  paddingHorizontal: spacing.sm,
  color: colors.textDim,
  fontSize: 12,
  textTransform: "uppercase",
})

const $termsText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 11,
  color: colors.textDim,
  textAlign: "center",
  marginTop: 8,
})
