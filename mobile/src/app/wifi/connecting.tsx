import CoreModule from "core"
import {useLocalSearchParams} from "expo-router"
import {useEffect, useRef, useState, useCallback} from "react"
import {ActivityIndicator, View} from "react-native"
import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useGlassesStore} from "@/stores/glasses"
import WifiCredentialsService from "@/utils/wifi/WifiCredentialsService"
import {ConnectionOverlay} from "@/components/glasses/ConnectionOverlay"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {translate} from "@/i18n"

export default function WifiConnectingScreen() {
  const params = useLocalSearchParams()
  const _deviceModel = (params.deviceModel as string) || "Glasses"
  const ssid = params.ssid as string
  const password = (params.password as string) || ""
  const rememberPassword = (params.rememberPassword as string) === "true"
  const returnTo = params.returnTo as string | undefined
  const nextRoute = params.nextRoute as string | undefined

  const {theme} = useAppTheme()
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "success" | "failed">("connecting")
  const [errorMessage, setErrorMessage] = useState("")
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const failureGracePeriodRef = useRef<NodeJS.Timeout | null>(null)

  const {goBack, navigate, pushPrevious} = useNavigationHistory()
  const wifiConnected = useGlassesStore((state) => state.wifiConnected)
  const wifiSsid = useGlassesStore((state) => state.wifiSsid)

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
    pushPrevious(2) // pop the entire stack
  }, [nextRoute, returnTo, navigate])

  const handleHeaderBack = useCallback(() => {
    goBack()
  }, [returnTo, goBack])

  const renderContent = () => {
    switch (connectionStatus) {
      case "connecting":
        return (
          <View className="flex-1 justify-center">
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text
              className="text-xl font-medium text-foreground mt-6 text-center"
              text={translate("wifi:connectingToNetwork", {network: ssid})}
            />
            <Text className="text-sm text-muted-foreground mt-2 text-center" tx="wifi:connectingDescription" />
          </View>
        )
      case "success":
        return (
          <View className="flex-1 w-full justify-between">
            <View className="flex-1 justify-center">
              <View className="items-center mb-6">
                <Icon name="wifi" size={64} color={theme.colors.primary} />
              </View>
              <Text tx="wifi:networkAdded" className="text-2xl font-semibold text-foreground text-center mb-6" />
              <Text
                className="text-sm text-muted-foreground text-center px-6 leading-5"
                tx="wifi:networkAddedDescription"
              />
            </View>
            <Button tx="common:continue" onPress={handleSuccess} />
          </View>
        )

      case "failed":
        return (
          <View className="flex-1 w-full justify-between">
            <View className="flex-1 justify-center">
              <View className="items-center mt-12 mb-6">
                <Icon name="wifi-off" size={64} color={theme.colors.destructive} />
              </View>
              <Text className="text-2xl font-semibold text-text text-center mb-6">{errorMessage}</Text>
              <Text className="text-base text-muted-foreground text-center mb-8 px-8" tx="wifi:failedDescription" />
            </View>
            <Button text="Try Again" onPress={handleTryAgain} />
          </View>
        )
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      {connectionStatus === "connecting" ? (
        <Header
          leftIcon="chevron-left"
          onLeftPress={handleHeaderBack}
          RightActionComponent={<MentraLogoStandalone />}
        />
      ) : (
        <Header />
      )}
      <ConnectionOverlay />
      {renderContent()}
    </Screen>
  )
}
