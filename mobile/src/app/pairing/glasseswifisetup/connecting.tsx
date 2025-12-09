import CoreModule from "core"
import {useLocalSearchParams} from "expo-router"
import {useEffect, useRef, useState, useCallback} from "react"
import {ActivityIndicator, TextStyle, View, ViewStyle} from "react-native"

import {WifiIcon} from "@/components/icons/WifiIcon"
import {Button, Header, Icon, Screen} from "@/components/ignite"
import {Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"
import {$styles, ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"
import WifiCredentialsService from "@/utils/wifi/WifiCredentialsService"

export default function WifiConnectingScreen() {
  const params = useLocalSearchParams()
  const _deviceModel = (params.deviceModel as string) || "Glasses"
  const ssid = params.ssid as string
  const password = (params.password as string) || ""
  const rememberPassword = (params.rememberPassword as string) === "true"
  const returnTo = params.returnTo as string | undefined
  const nextRoute = params.nextRoute as string | undefined

  const {theme, themed} = useAppTheme()

  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "success" | "failed">("connecting")
  const [errorMessage, setErrorMessage] = useState("")
  const connectionTimeoutRef = useRef<number | null>(null)
  const failureGracePeriodRef = useRef<number | null>(null)
  const {goBack, navigate, replace} = useNavigationHistory()
  const wifiConnected = useGlassesStore(state => state.wifiConnected)
  const wifiSsid = useGlassesStore(state => state.wifiSsid)
  const glassesConnected = useGlassesStore(state => state.connected)

  // Navigate away if glasses disconnect (but not on initial mount)
  const prevGlassesConnectedRef = useRef(glassesConnected)
  useEffect(() => {
    if (prevGlassesConnectedRef.current && !glassesConnected) {
      console.log("[WifiConnectingScreen] Glasses disconnected - navigating away")
      showAlert("Glasses Disconnected", "Please reconnect your glasses to set up WiFi.", [{text: "OK"}])
      if (returnTo && typeof returnTo === "string") {
        replace(decodeURIComponent(returnTo))
      } else {
        replace("/")
      }
    }
    prevGlassesConnectedRef.current = glassesConnected
  }, [glassesConnected, returnTo])

  useEffect(() => {
    // Start connection attempt
    attemptConnection()

    return () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current)
        connectionTimeoutRef.current = null
      }
      if (failureGracePeriodRef.current) {
        clearTimeout(failureGracePeriodRef.current)
        failureGracePeriodRef.current = null
      }
    }
  }, [ssid])

  useEffect(() => {
    console.log("WiFi connection status changed:", wifiConnected, wifiSsid)

    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current)
      connectionTimeoutRef.current = null
    }

    if (wifiConnected && wifiSsid === ssid) {
      // Clear any failure grace period if it exists
      if (failureGracePeriodRef.current) {
        clearTimeout(failureGracePeriodRef.current)
        failureGracePeriodRef.current = null
      }

      // Save credentials ONLY on successful connection if checkbox was checked
      // This ensures we never save wrong passwords
      if (password && rememberPassword) {
        WifiCredentialsService.saveCredentials(ssid, password, true)
        WifiCredentialsService.updateLastConnected(ssid)
      }

      setConnectionStatus("success")
      // Don't show banner anymore since we have a dedicated success screen
      // User will manually dismiss with Done button
    } else if (!wifiConnected && connectionStatus === "connecting") {
      // Set up 5-second grace period before showing failure
      failureGracePeriodRef.current = setTimeout(() => {
        console.log("#$%^& Failed to connect to the network. Please check your password and try again.")
        setConnectionStatus("failed")
        setErrorMessage("Failed to connect to the network. Please check your password and try again.")
        failureGracePeriodRef.current = null
      }, 10000)
    }
  }, [wifiConnected, wifiSsid])

  const attemptConnection = async () => {
    try {
      console.log("Attempting to send wifi credentials to Core", ssid, password)
      await CoreModule.sendWifiCredentials(ssid, password)

      // Set timeout for connection attempt (20 seconds)
      connectionTimeoutRef.current = setTimeout(() => {
        if (connectionStatus === "connecting") {
          setConnectionStatus("failed")
          setErrorMessage("Connection timed out. Please try again.")
        }
      }, 20000)
    } catch (error) {
      console.error("Error sending WiFi credentials:", error)
      setConnectionStatus("failed")
      setErrorMessage("Failed to send credentials to glasses. Please try again.")
    }
  }

  const handleTryAgain = () => {
    setConnectionStatus("connecting")
    setErrorMessage("")
    attemptConnection()
  }

  const handleSuccess = useCallback(() => {
    if (nextRoute && typeof nextRoute === "string") {
      replace(decodeURIComponent(nextRoute))
    } else if (returnTo && typeof returnTo === "string") {
      replace(decodeURIComponent(returnTo))
    } else {
      navigate("/")
    }
  }, [nextRoute, returnTo, navigate])

  const handleCancel = useCallback(() => {
    if (returnTo && typeof returnTo === "string") {
      replace(decodeURIComponent(returnTo))
    } else {
      goBack()
    }
  }, [returnTo, goBack])

  const handleHeaderBack = useCallback(() => {
    if (returnTo && typeof returnTo === "string") {
      replace(decodeURIComponent(returnTo))
    } else {
      goBack()
    }
  }, [returnTo, goBack])

  const renderContent = () => {
    switch (connectionStatus) {
      case "connecting":
        return (
          <>
            <ActivityIndicator size="large" color={theme.colors.text} />
            <Text style={themed($statusText)}>Connecting to {ssid}...</Text>
            <Text style={themed($subText)}>This may take up to 20 seconds</Text>
          </>
        )

      case "success":
        return (
          <View style={themed($successContainer)}>
            <View style={themed($successContent)}>
              <View style={themed($successIconContainer)}>
                <WifiIcon size={48} color={theme.colors.palette.success500} />
              </View>

              <Text style={themed($successTitle)}>Network added</Text>

              <Text style={themed($successDescription)}>
                Connected devices will perform automatic updates and media imports while charging through the Mentra
                app. Automatic updates can be disabled in Device settings at any time.
              </Text>
            </View>

            <View style={themed($successButtonContainer)}>
              <Button text="Continue" onPress={handleSuccess} />
            </View>
          </View>
        )

      case "failed":
        return (
          <View style={themed($failureContainer)}>
            <View style={themed($failureContent)}>
              <View style={themed($failureIconContainer)}>
                <Icon name="x-circle" size={80} color={theme.colors.destructive} />
              </View>

              <Text style={themed($failureTitle)}>Connection Failed</Text>

              <Text style={themed($failureDescription)}>{errorMessage}</Text>

              <View style={themed($failureTipsList)}>
                <View style={themed($failureTipItem)}>
                  <Icon
                    name="lock"
                    size={20}
                    color={theme.colors.textDim}
                    containerStyle={{marginRight: theme.spacing.s3}}
                  />
                  <Text style={themed($failureTipText)}>Make sure the password was entered correctly</Text>
                </View>

                <View style={themed($failureTipItem)}>
                  <Icon
                    name="wifi"
                    size={20}
                    color={theme.colors.textDim}
                    containerStyle={{marginRight: theme.spacing.s3}}
                  />
                  <Text style={themed($failureTipText)}>
                    Mentra Live Beta can only connect to pure 2.4GHz WiFi networks (not 5GHz or dual-band 2.4/5GHz)
                  </Text>
                </View>
              </View>
            </View>

            <View style={themed($failureButtonsContainer)}>
              <Button onPress={handleTryAgain}>
                <Text>Try Again</Text>
              </Button>
              <Button onPress={handleCancel} preset="alternate" style={{marginTop: theme.spacing.s3}}>
                <Text>Cancel</Text>
              </Button>
            </View>
          </View>
        )
    }
  }

  return (
    <Screen
      preset="fixed"
      contentContainerStyle={connectionStatus === "connecting" ? themed($styles.screen) : undefined}>
      {connectionStatus === "connecting" && (
        <Header title="Connecting" leftIcon="chevron-left" onLeftPress={handleHeaderBack} />
      )}
      <View style={themed(connectionStatus === "connecting" ? $content : $contentNoPadding)}>{renderContent()}</View>
    </Screen>
  )
}

const $content: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.s6,
  justifyContent: "center",
  alignItems: "center",
})

const $contentNoPadding: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $statusText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 20,
  fontWeight: "500",
  color: colors.text,
  marginTop: spacing.s6,
  textAlign: "center",
})

const $subText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.textDim,
  marginTop: spacing.s2,
  textAlign: "center",
})

const $successContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  width: "100%",
  justifyContent: "space-between",
})

const $successContent: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
})

const $successIconContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  marginBottom: spacing.s6,
})

const $successTitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 24,
  fontWeight: "600",
  color: colors.text,
  textAlign: "center",
  marginBottom: spacing.s6,
})

const $successDescription: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.textDim,
  textAlign: "center",
  paddingHorizontal: spacing.s6,
  lineHeight: 20,
})

const $successButtonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s6,
  paddingHorizontal: spacing.s4,
})

const $failureContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  width: "100%",
  justifyContent: "space-between",
})

const $failureContent: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
})

const $failureIconContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  marginTop: spacing.s12,
  marginBottom: spacing.s6,
})

const $failureTitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 24,
  fontWeight: "600",
  color: colors.destructive,
  textAlign: "center",
  marginBottom: spacing.s6,
})

const $failureDescription: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  color: colors.textDim,
  textAlign: "center",
  marginBottom: spacing.s8,
  paddingHorizontal: spacing.s8,
})

const $failureButtonsContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s6,
  paddingHorizontal: spacing.s6,
})

const $failureTipsList: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s8,
  marginTop: spacing.s4,
})

const $failureTipItem: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "flex-start",
  marginBottom: spacing.s4,
})

const $failureTipText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.textDim,
  flex: 1,
})
