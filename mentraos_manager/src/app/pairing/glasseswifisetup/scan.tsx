import React, {useState, useEffect} from "react"
import {View, Text, FlatList, TouchableOpacity, ActivityIndicator, BackHandler} from "react-native"
import {useLocalSearchParams, router, useFocusEffect} from "expo-router"
import {Screen, Header} from "@/components/ignite"
import coreCommunicator from "@/bridge/CoreCommunicator"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import {ViewStyle, TextStyle} from "react-native"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import {useCallback} from "react"
import ActionButton from "@/components/ui/ActionButton"

export default function WifiScanScreen() {
  const {deviceModel = "Glasses"} = useLocalSearchParams()
  const {theme, themed} = useAppTheme()
  const {status} = useStatus()

  const [networks, setNetworks] = useState<string[]>([])
  const [isScanning, setIsScanning] = useState(true)

  // Get current WiFi status
  const currentWifi = status.glasses_info?.glasses_wifi_ssid
  const isWifiConnected = status.glasses_info?.glasses_wifi_connected

  const handleGoBack = useCallback(() => {
    // Go back to main WiFi setup screen (not to previous screen in stack)
    router.back()
    return true // Prevent default back behavior
  }, [])

  // Handle Android back button
  useFocusEffect(
    useCallback(() => {
      const backHandler = BackHandler.addEventListener("hardwareBackPress", handleGoBack)
      return () => backHandler.remove()
    }, [handleGoBack]),
  )

  useEffect(() => {
    // Start scanning immediately when screen loads
    startScan()

    const handleWifiScanResults = (data: {networks: string[]}) => {
      console.log("WiFi scan results received:", data.networks)
      setNetworks(data.networks)
      setIsScanning(false)
    }

    GlobalEventEmitter.on("WIFI_SCAN_RESULTS", handleWifiScanResults)

    return () => {
      GlobalEventEmitter.removeListener("WIFI_SCAN_RESULTS", handleWifiScanResults)
    }
  }, [])

  const startScan = async () => {
    setIsScanning(true)
    setNetworks([])

    try {
      await coreCommunicator.requestWifiScan()
    } catch (error) {
      console.error("Error scanning for WiFi networks:", error)
      setIsScanning(false)
      GlobalEventEmitter.emit("SHOW_BANNER", {
        message: "Failed to scan for WiFi networks",
        type: "error",
      })
    }
  }

  const handleNetworkSelect = (selectedNetwork: string) => {
    // Check if this is the currently connected network
    if (isWifiConnected && currentWifi === selectedNetwork) {
      GlobalEventEmitter.emit("SHOW_BANNER", {
        message: `Already connected to ${selectedNetwork}`,
        type: "info",
      })
      return
    }

    router.push({
      pathname: "/pairing/glasseswifisetup/password",
      params: {
        deviceModel,
        ssid: selectedNetwork,
      },
    })
  }

  return (
    <Screen preset="fixed" contentContainerStyle={themed($container)}>
      <Header title="Select Glasses WiFi Network" leftIcon="caretLeft" onLeftPress={handleGoBack} />
      <View style={themed($content)}>
        {isScanning ? (
          <View style={themed($loadingContainer)}>
            <ActivityIndicator size="large" color={theme.colors.text} />
            <Text style={themed($loadingText)}>Scanning for networks...</Text>
          </View>
        ) : networks.length > 0 ? (
          <>
            <FlatList
              data={networks}
              keyExtractor={(item, index) => `network-${index}`}
              renderItem={({item}) => {
                const isConnected = isWifiConnected && currentWifi === item
                return (
                  <TouchableOpacity
                    style={themed(isConnected ? $connectedNetworkItem : $networkItem)}
                    onPress={() => handleNetworkSelect(item)}>
                    <View style={themed($networkContent)}>
                      <Text style={themed(isConnected ? $connectedNetworkText : $networkText)}>{item}</Text>
                      {isConnected && (
                        <View style={themed($connectedBadge)}>
                          <Text style={themed($connectedBadgeText)}>Connected</Text>
                        </View>
                      )}
                    </View>
                    <Text style={themed(isConnected ? $connectedChevron : $chevron)}>{isConnected ? "✓" : "›"}</Text>
                  </TouchableOpacity>
                )
              }}
              style={themed($networksList)}
              contentContainerStyle={themed($listContent)}
            />
            <ActionButton label="Scan Again" onPress={startScan} variant="secondary" />
          </>
        ) : (
          <View style={themed($emptyContainer)}>
            <Text style={themed($emptyText)}>No networks found</Text>
            <ActionButton label="Try Again" onPress={startScan} />
          </View>
        )}
      </View>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $content: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.lg,
})

const $loadingContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: spacing.xxl,
})

const $loadingText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  marginTop: spacing.md,
  fontSize: 16,
  color: colors.textDim,
})

const $networksList: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  width: "100%",
})

const $listContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingBottom: spacing.md,
})

const $networkItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  backgroundColor: colors.background,
  padding: spacing.md,
  marginBottom: spacing.xs,
  borderRadius: spacing.xs,
  borderWidth: 1,
  borderColor: colors.border,
})

const $connectedNetworkItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  backgroundColor: colors.backgroundDim,
  padding: spacing.md,
  marginBottom: spacing.xs,
  borderRadius: spacing.xs,
  borderWidth: 1,
  borderColor: colors.border,
  opacity: 0.7,
})

const $networkContent: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
})

const $networkText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
  flex: 1,
})

const $connectedNetworkText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.textDim,
  flex: 1,
})

const $connectedBadge: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.tint,
  paddingHorizontal: spacing.xs,
  paddingVertical: 2,
  borderRadius: spacing.xs,
  marginLeft: spacing.sm,
})

const $connectedBadgeText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 10,
  fontWeight: "500",
  color: colors.background,
  textTransform: "uppercase",
})

const $chevron: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 24,
  color: colors.textDim,
  marginLeft: 8,
})

const $connectedChevron: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 20,
  color: colors.tint,
  marginLeft: 8,
  fontWeight: "bold",
})

const $emptyContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: spacing.xxl,
})

const $emptyText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  color: colors.textDim,
  marginBottom: spacing.lg,
  textAlign: "center",
})
