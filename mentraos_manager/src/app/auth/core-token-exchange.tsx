import React, {useEffect, useState, useRef} from "react"
import {View, Text, ActivityIndicator, StyleSheet, Platform, TouchableOpacity, Animated, TextStyle} from "react-native"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import {useNavigation} from "@react-navigation/native"
import {useAuth} from "@/contexts/AuthContext"
import coreCommunicator from "@/bridge/CoreCommunicator"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import Config from "react-native-config"
import Icon from "react-native-vector-icons/MaterialCommunityIcons"
import Button from "@/components/misc/Button"
import {loadSetting} from "@/utils/SettingsHelper"
import {SETTINGS_KEYS} from "@/consts"
import {router} from "expo-router"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import {Screen} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n/translate"

export default function CoreTokenExchange() {
  const {status} = useStatus()
  const {user, session, loading: authLoading} = useAuth()
  const [connectionError, setConnectionError] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState(
    "Connection to MentraOS failed. Please check your connection and try again.",
  )
  const hasAttemptedConnection = useRef(false)
  const loadingOverlayOpacity = useRef(new Animated.Value(1)).current
  const {theme, themed} = useAppTheme()
  const {goBack, push, replace} = useNavigationHistory()

  const handleTokenExchange = async () => {
    if (isLoading) return

    setIsLoading(true)

    try {
      const supabaseToken = session?.access_token
      if (!supabaseToken) {
        setErrorMessage("Unable to authenticate. Please sign in again.")
        setIsLoading(false)
        return
      }

      // Exchange token with backend
      const backend = BackendServerComms.getInstance()
      const coreToken = await backend.exchangeToken(supabaseToken).catch(err => {
        // Hide console.error output
        // Log only if needed for debugging
        // console.error('Token exchange failed:', err);
        throw err
      })

      const uid = user.email || user.id
      coreCommunicator.setAuthenticationSecretKey(uid, coreToken)
      BackendServerComms.getInstance().setCoreToken(coreToken)

      // Navigate
      // Check if the user has completed onboarding
      const onboardingCompleted = await loadSetting(SETTINGS_KEYS.ONBOARDING_COMPLETED, false)
      if (onboardingCompleted) {
        // If onboarding is completed, go directly to Home
        replace("/(tabs)/home")
      } else {
        // If onboarding is not completed, go to WelcomePage
        replace("/onboarding/welcome")
      }
    } catch (err) {
      // Don't log the error to console
      setErrorMessage("Connection to MentraOS failed. Please check your connection and try again.")
      setConnectionError(true)
      setIsLoading(false)
    }
  }

  useEffect(() => {
    // Don't show the error UI for initial load attempts and avoid repeating failed attempts
    if (connectionError || hasAttemptedConnection.current) return

    // We only proceed once the core is connected, the user is loaded, etc.
    if (/*TODO2.0: status.core_info.puck_connected && */ !authLoading && user) {
      // Track that we've attempted a connection
      hasAttemptedConnection.current = true

      // 1) Get the Supabase token from your AuthContext
      const supabaseToken = session?.access_token
      if (!supabaseToken) {
        console.log("No Supabase token found")
        setErrorMessage("Unable to authenticate. Please sign in again.")
        setConnectionError(true)
        return
      }

      // 2) Check if we need to do the exchange
      if (!status.auth.core_token_owner || status.auth.core_token_owner !== user.email) {
        console.log("OWNER IS NULL CALLING VERIFY (TOKEN EXCHANGE)")

        // Don't try automatic retry if we're already loading or had an error
        if (!isLoading) {
          handleTokenExchange().catch(error => {
            console.error("Error in automatic token exchange:", error)
          })
        }
      } else {
        // If we already have a token, go straight to Home
        BackendServerComms.getInstance().setCoreToken(status.core_info.core_token)
        replace("/(tabs)/home")
      }
    }
  }, [status.core_info.puck_connected, authLoading, user])

  // Loading screen
  if (!connectionError) {
    return (
      <Screen preset="fixed" safeAreaEdges={["bottom"]}>
        <View style={{flex: 1, justifyContent: "center", alignItems: "center"}}>
          <View style={styles.authLoadingLogoPlaceholder} />
          <ActivityIndicator size="large" color={theme.colors.loadingIndicator} style={styles.authLoadingIndicator} />
          <Text style={themed($authLoadingText)}>{translate("login:connectingToMentraOS")}</Text>
        </View>
      </Screen>
    )
  }

  // Error screen (similar to VersionUpdateScreen)
  return (
    <Screen preset="fixed" style={{flex: 1, justifyContent: "center", alignItems: "center"}} safeAreaEdges={["bottom"]}>
      <View style={styles.mainContainer}>
        <View style={styles.infoContainer}>
          <View style={styles.iconContainer}>
            <Icon name="wifi-off" size={80} color={theme.colors.error} />
          </View>

          <Text style={[styles.title, {color: theme.colors.text}]}>Connection Error</Text>

          <Text style={[styles.description, {color: theme.colors.textDim}]}>{errorMessage}</Text>
        </View>

        <View style={styles.setupContainer}>
          <Button onPress={handleTokenExchange} isDarkTheme={theme.isDark} disabled={isLoading} iconName="reload">
            {isLoading ? "Connecting..." : "Retry Connection"}
          </Button>
        </View>
      </View>
    </Screen>
  )
}

const $authLoadingText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontFamily: "Montserrat-Medium",
  color: colors.text,
  textAlign: "center",
})

const styles = StyleSheet.create({
  authLoadingIndicator: {
    marginBottom: 16,
  },
  authLoadingLogoPlaceholder: {
    height: 100,
    marginBottom: 20,
    width: 100,
  },
  authLoadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // backgroundColor: "rgba(255, 255, 255, 0.9)",
    zIndex: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  authLoadingText: {
    fontSize: 16,
    fontFamily: "Montserrat-Medium",
    // color moved to themed style
    textAlign: "center",
  },
  container: {
    flex: 1,
  },
  description: {
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 32,
    paddingHorizontal: 24,
    textAlign: "center",
  },
  iconContainer: {
    marginBottom: 32,
  },
  infoContainer: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingTop: 60,
  },
  loadingContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    fontSize: 16,
    marginTop: 16,
  },
  mainContainer: {
    flex: 1,
    flexDirection: "column",
    justifyContent: "space-between",
    padding: 24,
  },
  setupContainer: {
    alignItems: "center",
    paddingBottom: 40,
    width: "100%",
  },
  title: {
    fontFamily: "Montserrat-Bold",
    fontSize: 28,
    fontWeight: "bold",
    marginBottom: 28,
    textAlign: "center",
  },
  // Removed hardcoded color styles - now using theme dynamic colors
})
