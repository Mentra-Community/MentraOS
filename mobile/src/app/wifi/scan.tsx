import {engine, type WifiSearchResult} from "@mentra/engine"
import {useFocusEffect, useLocalSearchParams} from "expo-router"
import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {ActivityIndicator, ScrollView, TouchableOpacity, View} from "react-native"
import Toast from "react-native-toast-message"

import {WifiIcon} from "@/components/icons/WifiIcon"
import {WifiLockedIcon} from "@/components/icons/WifiLockedIcon"
import {WifiUnlockedIcon} from "@/components/icons/WifiUnlockedIcon"
import {Button, Header, Screen, Text} from "@/components/ignite"
import {Badge} from "@/components/ui/Badge"
import {Group} from "@/components/ui"
import {usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"
import WifiCredentialsService from "@/utils/wifi/WifiCredentialsService"
import {mergeWifiScanResults} from "@/utils/wifi/WifiScanUtils"
import {translate} from "@/i18n"

export default function WifiScanScreen() {
  const params = useLocalSearchParams()
  const returnToMiniapp = params.returnToMiniapp as string | undefined
  const {theme} = useAppTheme()

  const [networks, setNetworks] = useState<WifiSearchResult[]>([])
  const networksRef = useRef(networks)
  networksRef.current = networks
  const [savedNetworks, setSavedNetworks] = useState<string[]>([])
  const [isScanning, setIsScanning] = useState(true)
  const wifiStatus = useEngineSnapshot(engine.glasses.wifi.status, (onChange) => engine.glasses.wifi.onStatus(onChange))
  const connectedWifi = wifiStatus.state === "connected" ? wifiStatus : null
  const connectedWifiSsid = connectedWifi?.ssid
  const {push, goBack, getPreviousRoute, incPreventBack, decPreventBack, setAndroidBackFn, clearHistoryAndGoHome} =
    useNavigationStore.getState()
  const pushPrevious = usePushPrevious()

  const refreshSavedNetworks = useCallback(() => {
    const savedCredentials = WifiCredentialsService.getAllCredentials()
    setSavedNetworks(savedCredentials.map((cred) => cred.ssid))
  }, [])

  // if the previous route is in this list, or the second to last route is in this list
  // show / allow the back button:
  const backableRoutes = ["/miniapps/settings/main", "/home"]

  const secondLastRoute = getPreviousRoute(1)
  const showBack =
    !!returnToMiniapp ||
    backableRoutes.includes(getPreviousRoute() || "") ||
    backableRoutes.includes(secondLastRoute || "")
  const showSkip = connectedWifi !== null

  const handleBack = useCallback(async () => {
    if (returnToMiniapp) {
      clearHistoryAndGoHome({transition: "fade"})
      await engine.miniapps.setForeground(returnToMiniapp)
      return
    }
    if (showBack) {
      goBack()
    } else {
      pushPrevious(1)
    }
  }, [clearHistoryAndGoHome, goBack, pushPrevious, returnToMiniapp, showBack])

  // only prevent back if the showBack flag is false:
  useFocusEffect(
    useCallback(() => {
      refreshSavedNetworks()
      if (!showBack) {
        incPreventBack()
      }
      setAndroidBackFn(() => {
        if (showBack) {
          void handleBack()
        }
      })

      return () => {
        decPreventBack()
      }
    }, [incPreventBack, decPreventBack, showBack, refreshSavedNetworks, handleBack, setAndroidBackFn]),
  )

  useEffect(() => {
    refreshSavedNetworks()

    // The glasses stream networks one by one while the scan runs; show them as
    // they arrive instead of waiting for the final requestWifiScan() result.
    // Each correlated event is one chunk, so merge it into the visible list.
    const unsubscribe = engine.glasses.wifi.onScanResult((scanned) => {
      if (scanned.length > 0) {
        setNetworks((current) => mergeWifiScanResults(current, mapNetworks(scanned)))
      }
    })
    startScan()
    return unsubscribe
  }, [refreshSavedNetworks])

  const mapNetworks = (scanResults: WifiSearchResult[]): WifiSearchResult[] =>
    scanResults.map((network) => ({
      ssid: network.ssid || "",
      requiresPassword: network.requiresPassword !== false,
      signalStrength: network.signalStrength || -100,
      frequency: network.frequency,
    }))

  const startScan = async () => {
    console.log("WIFI_SCAN: ========= STARTING NEW WIFI SCAN =========")
    setIsScanning(true)
    setNetworks([])

    try {
      const scanResults = await engine.glasses.wifi.scan()
      console.log(`WIFI_SCAN: Received ${scanResults.length} WiFi scan results`)
      setNetworks(mapNetworks(scanResults))
      setIsScanning(false)
    } catch (error) {
      console.error("WIFI_SCAN: Error scanning for WiFi networks:", error)
      setIsScanning(false)
      // Networks that streamed in before the failure are still shown; only
      // surface the error when the user would otherwise see an empty list.
      if (networksRef.current.length === 0) {
        Toast.show({
          type: "error",
          text1: "Failed to scan for WiFi networks",
        })
      }
    }
  }

  const handleNetworkSelect = (selectedNetwork: WifiSearchResult) => {
    if (connectedWifiSsid === selectedNetwork.ssid) {
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
                await engine.glasses.wifi.forget(selectedNetwork.ssid)
                // Also remove from local saved credentials
                WifiCredentialsService.removeCredentials(selectedNetwork.ssid)
                setSavedNetworks((prev) => prev.filter((ssid) => ssid !== selectedNetwork.ssid))
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
        returnToMiniapp,
      })
    } else {
      console.log(`WIFI_SCAN: Secured network selected: ${selectedNetwork.ssid} - going to password screen`)
      push("/wifi/password", {
        ssid: selectedNetwork.ssid,
        requiresPassword: selectedNetwork.requiresPassword.toString(),
        returnToMiniapp,
      })
    }
  }

  const handleManualEntry = () => {
    push("/wifi/password", {
      ssid: "",
      returnToMiniapp,
    })
  }

  const renderNetworkItem = (item: WifiSearchResult) => {
    const isConnected = connectedWifiSsid === item.ssid
    const isSaved = savedNetworks.includes(item.ssid)

    return (
      <TouchableOpacity
        key={item.ssid}
        className={`flex-row justify-between items-center bg-primary-foreground py-4 px-4 rounded-xl ${
          isConnected ? "opacity-70" : ""
        }`}
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

  // sort networks so that connected networks are at the top:
  const sortedNetworks = useMemo(
    () =>
      networks.sort((a, b) => {
        if (connectedWifiSsid === a.ssid) {
          return -1
        }
        if (connectedWifiSsid === b.ssid) {
          return 1
        }
        return 0
      }),
    [connectedWifiSsid, networks],
  )

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} KeyboardAvoidingViewProps={{enabled: false}}>
      {showBack ? (
        <Header
          title="Wi-Fi"
          leftIcon="chevron-left"
          onLeftPress={() => void handleBack()}
          rightIcon="repeat"
          onRightPress={startScan}
        />
      ) : (
        <Header title="Wi-Fi" rightIcon="repeat" onRightPress={startScan} />
      )}

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
          {networks.length > 0 ? (
            <>
              {/* <Text className="text-sm font-semibold text-text mb-2" tx="wifi:networks" /> */}
              <ScrollView className="flex-1 px-5 -mx-5" contentContainerClassName="pb-4">
                <Group>{sortedNetworks.map(renderNetworkItem)}</Group>
                {isScanning && (
                  <View className="flex-row justify-center items-center py-4">
                    <ActivityIndicator size="small" color={theme.colors.foreground} />
                  </View>
                )}
              </ScrollView>
            </>
          ) : isScanning ? (
            <View className="flex-1 justify-center items-center py-12">
              <ActivityIndicator size="large" color={theme.colors.foreground} />
              <Text className="mt-4 text-base text-text-dim" tx="wifi:scanningForNetworks" />
            </View>
          ) : (
            <View className="flex-1 justify-center items-center py-12">
              <Text className="text-base text-text-dim mb-6 text-center" tx="wifi:noNetworksFound" />
              <Button tx="common:tryAgain" onPress={startScan} />
            </View>
          )}
        </View>

        <Button tx="wifi:enterNetworkManually" preset="primary" onPress={handleManualEntry} />
        {/* show skip button if we are already connected to a network */}
        {showSkip && <Button tx="common:skip" preset="secondary" onPress={() => void handleBack()} className="mt-3" />}
      </View>
    </Screen>
  )
}
