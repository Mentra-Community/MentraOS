import CoreModule from "core"
import {useFocusEffect} from "expo-router"
import {useCallback, useEffect, useRef, useState} from "react"
import {ActivityIndicator, ScrollView, TouchableOpacity, View} from "react-native"
import Toast from "react-native-toast-message"

import {WifiIcon} from "@/components/icons/WifiIcon"
import {WifiLockedIcon} from "@/components/icons/WifiLockedIcon"
import {WifiUnlockedIcon} from "@/components/icons/WifiUnlockedIcon"
import {Button, Header, Screen, Text} from "@/components/ignite"
import {Badge} from "@/components/ui/Badge"
import {Group} from "@/components/ui"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useGlassesStore} from "@/stores/glasses"
import showAlert from "@/utils/AlertUtils"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import WifiCredentialsService from "@/utils/wifi/WifiCredentialsService"
import {translate} from "@/i18n"
import {ConnectionOverlay} from "@/components/glasses/ConnectionOverlay"
import { BackgroundTimer } from "@/utils/timers"

interface NetworkInfo {
  ssid: string
  requiresPassword: boolean
  signalStrength?: number
}

export default function WifiScanScreen() {
  const {theme} = useAppTheme()

  const [networks, setNetworks] = useState<NetworkInfo[]>([])
  const [savedNetworks, setSavedNetworks] = useState<string[]>([])
  const [isScanning, setIsScanning] = useState(true)
  const scanTimeoutRef = useRef<number | null>(null)
  const currentScanSessionRef = useRef<number>(Date.now())
  const receivedResultsForSessionRef = useRef<boolean>(false)
  const wifiSsid = useGlassesStore((state) => state.wifiSsid)
  const wifiConnected = useGlassesStore((state) => state.wifiConnected)
  const {push, goBack, pushPrevious, getPreviousRoute, incPreventBack, decPreventBack, setAndroidBackFn} =
    useNavigationHistory()

  // if the previous route is in this list, or the second to last route is in this list
  // show / allow the back button:
  const backableRoutes = ["/settings/glasses", "/home"]

  const secondLastRoute = getPreviousRoute(1)
  const showBack = backableRoutes.includes(getPreviousRoute() || "") || backableRoutes.includes(secondLastRoute || "")
  const showSkip = !showBack

  const handleBack = () => {
    if (showBack) {
      goBack()
    } else {
      pushPrevious(2)
    }
  }

  // only prevent back if the showBack flag is false:
  useFocusEffect(
    useCallback(() => {
      if (!showBack) {
        incPreventBack()
      }
      setAndroidBackFn(() => {
        if (showBack) {
          goBack()
        }
      })

      return () => {
        decPreventBack()
      }
    }, [incPreventBack, decPreventBack, showBack]),
  )

  useEffect(() => {
    const loadSavedNetworks = () => {
      const savedCredentials = WifiCredentialsService.getAllCredentials()
      setSavedNetworks(savedCredentials.map((cred) => cred.ssid))
    }

    loadSavedNetworks()
    startScan()

    const handleWifiScanResults = (data: {networks: string[]; networksEnhanced?: any[]}) => {
      // console.log("WIFI_SCAN: ========= SCAN.TSX RECEIVED WIFI RESULTS =========")
      // console.log("WIFI_SCAN: Data received:", data)

      let processedNetworks: NetworkInfo[]
      if (data.networks && data.networks.length > 0) {
        // console.log("WIFI_SCAN: Processing enhanced networks:", data.networks)
        processedNetworks = data.networks.map((network: any) => ({
          ssid: network.ssid || "",
          requiresPassword: network.requiresPassword !== false,
          signalStrength: network.signalStrength || -100,
        }))
        // console.log("WIFI_SCAN: Enhanced networks count:", processedNetworks.length)
      }

      if (scanTimeoutRef.current) {
        // console.log("WIFI_SCAN: Clearing scan timeout - results received")
        BackgroundTimer.clearTimeout(scanTimeoutRef.current)
        scanTimeoutRef.current = null
      }

      setNetworks((prevNetworks) => {
        // console.log("WIFI_SCAN: Current scan session ID:", currentScanSessionRef.current)
        // console.log("WIFI_SCAN: Previous networks count:", prevNetworks.length)
        // console.log("WIFI_SCAN: Is first result of this scan session?", !receivedResultsForSessionRef.current)

        let baseNetworks: NetworkInfo[]
        if (receivedResultsForSessionRef.current) {
          // console.log("WIFI_SCAN: APPENDING: Adding to existing networks from current scan session")
          baseNetworks = prevNetworks
        } else {
          console.log("WIFI_SCAN: REPLACING: Starting fresh with new scan session results")
          baseNetworks = []
        }

        const existingMap = new Map<string, NetworkInfo>()
        baseNetworks.forEach((network) => existingMap.set(network.ssid, network))
        processedNetworks.forEach((network) => {
          if (network.ssid) {
            existingMap.set(network.ssid, network)
          }
        })
        const newNetworks = Array.from(existingMap.values())
        // console.log("WIFI_SCAN: Final networks count:", newNetworks.length)
        return newNetworks
      })

      receivedResultsForSessionRef.current = true
      setIsScanning(false)
      // console.log("WIFI_SCAN: ========= END SCAN.TSX WIFI RESULTS =========")
    }

    GlobalEventEmitter.on("wifi_scan_results", handleWifiScanResults)

    return () => {
      GlobalEventEmitter.removeListener("wifi_scan_results", handleWifiScanResults)
      if (scanTimeoutRef.current) {
        BackgroundTimer.clearTimeout(scanTimeoutRef.current)
        scanTimeoutRef.current = null
      }
    }
  }, [])

  const startScan = async () => {
    // console.log("WIFI_SCAN: ========= STARTING NEW WIFI SCAN =========")
    setIsScanning(true)
    currentScanSessionRef.current = Date.now()
    receivedResultsForSessionRef.current = false
    setNetworks([])

    if (scanTimeoutRef.current) {
      BackgroundTimer.clearTimeout(scanTimeoutRef.current)
    }

    scanTimeoutRef.current = BackgroundTimer.setTimeout(() => {
      console.log("WIFI_SCAN: SCAN TIMEOUT - RETRYING...")
      scanTimeoutRef.current = null
    }, 15000)

    try {
      await CoreModule.requestWifiScan()
      // console.log("WIFI_SCAN: WiFi scan request sent successfully")
    } catch (error) {
      console.error("WIFI_SCAN: Error scanning for WiFi networks:", error)
      if (scanTimeoutRef.current) {
        BackgroundTimer.clearTimeout(scanTimeoutRef.current)
        scanTimeoutRef.current = null
      }
      setIsScanning(false)
      Toast.show({
        type: "error",
        text1: "Failed to scan for WiFi networks",
      })
    }
  }

  const handleNetworkSelect = (selectedNetwork: NetworkInfo) => {
    if (wifiConnected && wifiSsid === selectedNetwork.ssid) {
      showAlert(
        "Forget Network",
        `Would you like to forget "${selectedNetwork.ssid}"? You will need to re-enter the password to connect again.`,
        [
          {
            text: "Cancel",
            style: "cancel",
          },
          {
            text: "Forget",
            style: "destructive",
            onPress: async () => {
              try {
                console.log(`WIFI_SCAN: Forgetting network: ${selectedNetwork.ssid}`)
                await CoreModule.forgetWifiNetwork(selectedNetwork.ssid)
                // Also remove from local saved credentials
                WifiCredentialsService.removeCredentials(selectedNetwork.ssid)
                Toast.show({
                  type: "success",
                  text1: `Forgot "${selectedNetwork.ssid}"`,
                })
              } catch (error) {
                console.error("WIFI_SCAN: Error forgetting network:", error)
                Toast.show({
                  type: "error",
                  text1: "Failed to forget network",
                })
              }
            },
          },
        ],
      )
      return
    }

    if (!selectedNetwork.requiresPassword) {
      console.log(`WIFI_SCAN: Open network selected: ${selectedNetwork.ssid} - connecting directly`)
      push("/wifi/connecting", {
        ssid: selectedNetwork.ssid,
        password: "",
      })
    } else {
      console.log(`WIFI_SCAN: Secured network selected: ${selectedNetwork.ssid} - going to password screen`)
      push("/wifi/password", {
        ssid: selectedNetwork.ssid,
        requiresPassword: selectedNetwork.requiresPassword.toString(),
      })
    }
  }

  const handleManualEntry = () => {
    push("/wifi/password", {
      ssid: "",
    })
  }

  const renderNetworkItem = (item: NetworkInfo) => {
    const isConnected = wifiConnected && wifiSsid === item.ssid
    const isSaved = savedNetworks.includes(item.ssid)

    return (
      <TouchableOpacity
        key={item.ssid}
        className={`flex-row justify-between items-center bg-primary-foreground py-4 px-4 rounded-xl ${isConnected ? "opacity-70" : ""}`}
        onPress={() => handleNetworkSelect(item)}>
        <View className="flex-1 flex-row items-center justify-between">
          <View className="flex-row items-center flex-1">
            {item.requiresPassword ? (
              <WifiLockedIcon size={20} color={theme.colors.text} />
            ) : (
              <WifiUnlockedIcon size={20} color={theme.colors.text} />
            )}
            <Text
              className={`text-base ml-2 flex-1 ${
                isConnected ? "text-text-dim" : isSaved ? "text-text font-medium" : "text-text"
              }`}>
              {item.ssid}
            </Text>
          </View>
          <View className="flex-row items-center ml-2">
            {isConnected && <Badge text={translate("common:connected")} />}
            {isSaved && !isConnected && <Badge text={translate("common:saved")} />}
          </View>
        </View>
        {!isConnected && (
          <Text className={`text-2xl ml-2 ${isSaved ? "text-tint text-lg" : "text-text-dim"}`}>
            {isSaved ? "🔑" : "›"}
          </Text>
        )}
      </TouchableOpacity>
    )
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      {showBack ? (
        <Header
          title="Wi-Fi"
          leftIcon="chevron-left"
          onLeftPress={handleBack}
          rightIcon="repeat"
          onRightPress={startScan}
        />
      ) : (
        <Header title="Wi-Fi" rightIcon="repeat" onRightPress={startScan} />
      )}

      <ConnectionOverlay />

      <View className="flex-1">
        {/* Header */}
        <View className="pt-4 pb-6 items-center">
          <View className="mb-4">
            <WifiIcon size={48} color={theme.colors.primary} />
          </View>
          <Text className="text-2xl font-semibold text-text text-center mb-2" tx="wifi:addNetwork" />
          <Text className="text-sm text-text-dim text-center px-4 leading-5" tx="wifi:addNetworkDescription" />
        </View>

        {/* Content - flex-1 makes it take remaining space, flex-shrink allows it to shrink */}
        <View className="flex-1 flex-shrink min-h-0 pb-4">
          {isScanning ? (
            <View className="flex-1 justify-center items-center py-12">
              <ActivityIndicator size="large" color={theme.colors.text} />
              <Text className="mt-4 text-base text-text-dim" tx="wifi:scanningForNetworks" />
            </View>
          ) : networks.length > 0 ? (
            <>
              {/* <Text className="text-sm font-semibold text-text mb-2" tx="wifi:networks" /> */}
              <ScrollView className="flex-1 px-5 -mx-5" contentContainerClassName="pb-4">
                <Group>{networks.map(renderNetworkItem)}</Group>
              </ScrollView>
            </>
          ) : (
            <View className="flex-1 justify-center items-center py-12">
              <Text className="text-base text-text-dim mb-6 text-center" tx="wifi:noNetworksFound" />
              <Button tx="common:tryAgain" onPress={startScan} />
            </View>
          )}
        </View>

        <Button
          tx="wifi:enterNetworkManually"
          preset={showSkip ? "primary" : "secondary"}
          onPress={handleManualEntry}
        />
        {showSkip && <Button tx="common:skip" preset="secondary" onPress={handleBack} className="mt-3" />}
      </View>
    </Screen>
  )
}
