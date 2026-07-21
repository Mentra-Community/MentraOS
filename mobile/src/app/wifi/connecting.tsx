import {engine} from "@mentra/engine"
import {useLocalSearchParams} from "expo-router"
import {useEffect, useState, useCallback} from "react"
import {ActivityIndicator, View} from "react-native"
import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import WifiCredentialsService from "@/utils/wifi/WifiCredentialsService"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {translate, type TxKeyPath} from "@/i18n"

type WifiConnectionErrorCopy = {
  titleTx: TxKeyPath
  descriptionTx: TxKeyPath
}

function wifiConnectionErrorCopy(error: unknown): WifiConnectionErrorCopy {
  const code = typeof (error as {code?: unknown})?.code === "string" ? (error as {code: string}).code : undefined
  const message = error instanceof Error ? error.message : String(error)

  if (code === "bluetooth_powered_off") {
    return {
      titleTx: "wifi:errors.bluetoothPoweredOffTitle",
      descriptionTx: "wifi:errors.bluetoothPoweredOffDescription",
    }
  }
  if (code === "bluetooth_permission_denied") {
    return {
      titleTx: "wifi:errors.bluetoothPermissionTitle",
      descriptionTx: "wifi:errors.bluetoothPermissionDescription",
    }
  }
  if (code === "bluetooth_unsupported") {
    return {
      titleTx: "wifi:errors.bluetoothUnsupportedTitle",
      descriptionTx: "wifi:errors.bluetoothUnsupportedDescription",
    }
  }
  if (code === "request_in_flight") {
    return {
      titleTx: "wifi:errors.connectionInProgressTitle",
      descriptionTx: "wifi:errors.connectionInProgressDescription",
    }
  }
  if (code === "request_timeout" || message.includes("timed out")) {
    return {
      titleTx: "wifi:errors.glassesNoResponseTitle",
      descriptionTx: "wifi:errors.glassesNoResponseDescription",
    }
  }

  return {
    titleTx: "wifi:errors.connectionFailedTitle",
    descriptionTx: "wifi:errors.connectionFailedDescription",
  }
}

export default function WifiConnectingScreen() {
  const params = useLocalSearchParams()
  const _deviceModel = (params.deviceModel as string) || "Glasses"
  const ssid = params.ssid as string
  const password = (params.password as string) || ""
  const rememberPassword = (params.rememberPassword as string) === "true"
  const returnTo = params.returnTo as string | undefined
  const returnToMiniapp = params.returnToMiniapp as string | undefined
  const _nextRoute = params.nextRoute as string | undefined

  const {theme} = useAppTheme()
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "success" | "failed">("connecting")
  const [errorMessage, setErrorMessage] = useState("")
  const [errorDescription, setErrorDescription] = useState("")

  const {goBack, push, clearHistoryAndGoHome} = useNavigationStore.getState()
  const pushPrevious = usePushPrevious()

  useEffect(() => {
    // Start connection attempt
    attemptConnection()
  }, [ssid])

  const attemptConnection = async () => {
    try {
      console.log("Attempting to send wifi credentials to Core", ssid, password)
      await engine.glasses.wifi.connect(ssid, password)

      // Save credentials ONLY on successful connection if checkbox was checked.
      // This ensures we never save wrong passwords.
      if (password && rememberPassword) {
        WifiCredentialsService.saveCredentials(ssid, password, true)
        WifiCredentialsService.updateLastConnected(ssid)
      }

      setConnectionStatus("success")
    } catch (error) {
      console.error("Error connecting WiFi:", error)
      const copy = wifiConnectionErrorCopy(error)
      setConnectionStatus("failed")
      setErrorMessage(translate(copy.titleTx))
      setErrorDescription(translate(copy.descriptionTx))
    }
  }

  const handleTryAgain = () => {
    setConnectionStatus("connecting")
    setErrorMessage("")
    setErrorDescription("")
    attemptConnection()
  }

  const handleSuccess = useCallback(async () => {
    if (returnToMiniapp) {
      clearHistoryAndGoHome({transition: "fade"})
      await engine.miniapps.setForeground(returnToMiniapp)
      return
    }

    const history = useNavigationStore.getState().history
    // Check if OTA check-for-updates is already in the stack (initial pairing flow)
    const otaIndex = history.indexOf("/ota/check-for-updates")

    if (otaIndex !== -1) {
      // OTA is in the stack - calculate how many screens to pop to get there
      // pushPrevious(n) removes (n+2) screens from top and goes to that position
      const currentIndex = history.length - 1
      const screensToSkip = currentIndex - otaIndex - 1
      console.log(
        `WiFi success: OTA found at index ${otaIndex}, current at ${currentIndex}, skipping ${screensToSkip} screens`,
      )
      pushPrevious(screensToSkip)
    } else {
      // OTA not in stack (home OTA alert flow) - push it
      console.log("WiFi success: OTA not in stack, pushing /ota/check-for-updates")
      push("/ota/check-for-updates")
    }
  }, [clearHistoryAndGoHome, pushPrevious, push, returnToMiniapp])

  const handleHeaderBack = useCallback(() => {
    goBack()
  }, [returnTo, goBack])

  const renderContent = () => {
    switch (connectionStatus) {
      case "connecting":
        return (
          <View className="flex-1 justify-center">
            <ActivityIndicator size="large" color={theme.colors.foreground} />
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
              <Text className="text-base text-muted-foreground text-center mb-8 px-8" text={errorDescription} />
            </View>
            <Button tx="common:tryAgain" onPress={handleTryAgain} />
          </View>
        )
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      {connectionStatus === "success" ? (
        <Header />
      ) : (
        <Header
          leftIcon="chevron-left"
          onLeftPress={handleHeaderBack}
          RightActionComponent={<MentraLogoStandalone />}
        />
      )}
      {renderContent()}
    </Screen>
  )
}
