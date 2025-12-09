import CoreModule from "core"
import {useFocusEffect, useLocalSearchParams} from "expo-router"
import {useCallback, useEffect, useRef, useState} from "react"
import {ActivityIndicator, BackHandler, FlatList, TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"
import Toast from "react-native-toast-message"

import {WifiIcon} from "@/components/icons/WifiIcon"
import {WifiLockedIcon} from "@/components/icons/WifiLockedIcon"
import {WifiUnlockedIcon} from "@/components/icons/WifiUnlockedIcon"
import {Button, Header, Screen, Text} from "@/components/ignite"
import {Badge} from "@/components/ui/Badge"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"
import {$styles, ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {useAppTheme} from "@/utils/useAppTheme"
import WifiCredentialsService from "@/utils/wifi/WifiCredentialsService"

// Enhanced network info type
interface NetworkInfo {
  ssid: string
  requiresPassword: boolean
  signalStrength?: number
}

export default function WifiScanScreen() {
  const {deviceModel = "Glasses", returnTo, nextRoute} = useLocalSearchParams()
  const {theme, themed} = useAppTheme()

  const [networks, setNetworks] = useState<NetworkInfo[]>([])
  const [savedNetworks, setSavedNetworks] = useState<string[]>([])
  const [isScanning, setIsScanning] = useState(true)
  const scanTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const currentScanSessionRef = useRef<number>(Date.now())
  const receivedResultsForSessionRef = useRef<boolean>(false)
  const wifiSsid = useGlassesStore(state => state.wifiSsid)
  const wifiConnected = useGlassesStore(state => state.wifiConnected)
  const glassesConnected = useGlassesStore(state => state.connected)
  const {push, goBack, replace} = useNavigationHistory()

  // Navigate away if glasses disconnect (but not on initial mount)
  const prevGlassesConnectedRef = useRef(glassesConnected)
  useEffect(() => {
    if (prevGlassesConnectedRef.current && !glassesConnected) {
      console.log("[WifiScanScreen] Glasses disconnected - navigating away")
      showAlert("Glasses Disconnected", "Please reconnect your glasses to set up WiFi.", [{text: "OK"}])
      if (returnTo && typeof returnTo === "string") {
        replace(decodeURIComponent(returnTo))
      } else {
        replace("/")
      }
    }
    prevGlassesConnectedRef.current = glassesConnected
  }, [glassesConnected, returnTo])

  const handleGoBack = useCallback(() => {
    if (returnTo && typeof returnTo === "string") {
      replace(decodeURIComponent(returnTo))
    } else {
      goBack()
    }
    return true // Prevent default back behavior
  }, [returnTo])

  // Handle Android back button
  useFocusEffect(
    useCallback(() => {
      const backHandler = BackHandler.addEventListener("hardwareBackPress", handleGoBack)
      return () => backHandler.remove()
    }, [handleGoBack]),
  )

  useEffect(() => {
    // Load saved networks
    const loadSavedNetworks = () => {
      const savedCredentials = WifiCredentialsService.getAllCredentials()
      setSavedNetworks(savedCredentials.map(cred => cred.ssid))
    }

    loadSavedNetworks()
    // Start scanning immediately when screen loads
    startScan()

    const handleWifiScanResults = (data: {networks: string[]; networksEnhanced?: any[]}) => {
      console.log("🎯 ========= SCAN.TSX RECEIVED WIFI RESULTS =========")
      console.log("🎯 Data received:", data)

      // Process enhanced format if available, otherwise use legacy format
      let processedNetworks: NetworkInfo[]
      if (data.networks && data.networks.length > 0) {
        console.log("🎯 Processing enhanced networks:", data.networks)
        processedNetworks = data.networks.map((network: any) => ({
          ssid: network.ssid || "",
          requiresPassword: network.requiresPassword !== false, // Default to secure
          signalStrength: network.signalStrength || -100,
        }))
        console.log("🎯 Enhanced networks count:", processedNetworks.length)
      }

      // Clear the timeout since we got results
      if (scanTimeoutRef.current) {
        console.log("🎯 Clearing scan timeout - results received")
        clearTimeout(scanTimeoutRef.current)
        scanTimeoutRef.current = null
      }

      // Handle network results - replace on first result of new session, append on subsequent
      setNetworks(prevNetworks => {
        console.log("🎯 Current scan session ID:", currentScanSessionRef.current)
        console.log(
          "🎯 Previous networks count:",
          prevNetworks.length,
          "SSIDs:",
          prevNetworks.map(n => n.ssid),
        )
        console.log("🎯 Is first result of this scan session?", !receivedResultsForSessionRef.current)

        let baseNetworks: NetworkInfo[]
        if (receivedResultsForSessionRef.current) {
          // This is additional results from the same scan session - append
          console.log("🎯 APPENDING: Adding to existing networks from current scan session")
          baseNetworks = prevNetworks
        } else {
          // This is the first result of a new scan session - replace
          console.log("🎯 REPLACING: Starting fresh with new scan session results")
          baseNetworks = []
        }

        // Create a Map to avoid duplicates by SSID when adding new networks
        const existingMap = new Map<string, NetworkInfo>()
        baseNetworks.forEach(network => existingMap.set(network.ssid, network))
        processedNetworks.forEach(network => {
          if (network.ssid) {
            existingMap.set(network.ssid, network)
          }
        })
        const newNetworks = Array.from(existingMap.values())
        console.log(
          "🎯 Final networks count:",
          newNetworks.length,
          "SSIDs:",
          newNetworks.map(n => `${n.ssid} (${n.requiresPassword ? "secured" : "open"})`),
        )
        return newNetworks
      })

      // Mark that we've received results for the current session
      receivedResultsForSessionRef.current = true
      setIsScanning(false)
      console.log("🎯 Marked receivedResultsForSessionRef as true for this session")
      console.log("🎯 ========= END SCAN.TSX WIFI RESULTS =========")
    }

    GlobalEventEmitter.on("WIFI_SCAN_RESULTS", handleWifiScanResults)

    return () => {
      GlobalEventEmitter.removeListener("WIFI_SCAN_RESULTS", handleWifiScanResults)
      // Clean up timeout on unmount
      if (scanTimeoutRef.current) {
        clearTimeout(scanTimeoutRef.current)
        scanTimeoutRef.current = null
      }
    }
  }, [])

  const startScan = async () => {
    console.log("🔄 ========= STARTING NEW WIFI SCAN =========")
    console.log("🔄 Resetting scan session state...")

    setIsScanning(true)
    // Start a new scan session - results from this session will replace previous networks
    currentScanSessionRef.current = Date.now()
    receivedResultsForSessionRef.current = false

    console.log("🔄 New scan session ID:", currentScanSessionRef.current)
    console.log("🔄 receivedResultsForSessionRef reset to:", receivedResultsForSessionRef.current)
    console.log("🔄 ========= END START SCAN SETUP =========")

    // Clear the networks list immediately when starting a new scan
    // This ensures users see fresh results, not old ones
    setNetworks([])

    // Clear any existing timeout
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current)
    }

    // Set a timeout for scan results
    scanTimeoutRef.current = setTimeout(() => {
      console.log("⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️")
      console.log("⏱️ WIFI SCAN TIMEOUT - NO RESULTS AFTER 15 SECONDS ⏱️")
      console.log("⏱️ RETRYING SCAN AUTOMATICALLY...")
      console.log("⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️⏱️")

      // Don't stop scanning, just retry silently
      CoreModule.requestWifiScan().catch(error => {
        console.error("⏱️ RETRY FAILED:", error)
      })

      scanTimeoutRef.current = null
    }, 15000) // 15 second timeout

    try {
      await CoreModule.requestWifiScan()
      console.log("🔄 WiFi scan request sent successfully")
    } catch (error) {
      console.error("Error scanning for WiFi networks:", error)
      if (scanTimeoutRef.current) {
        clearTimeout(scanTimeoutRef.current)
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
    // Check if this is the currently connected network
    if (wifiConnected && wifiSsid === selectedNetwork.ssid) {
      Toast.show({
        type: "info",
        text1: `Already connected to ${selectedNetwork.ssid}`,
      })
      return
    }

    // Skip password screen for open networks and connect directly
    if (!selectedNetwork.requiresPassword) {
      console.log(`🔓 Open network selected: ${selectedNetwork.ssid} - connecting directly`)
      push("/pairing/glasseswifisetup/connecting", {
        deviceModel,
        ssid: selectedNetwork.ssid,
        password: "", // Empty password for open networks
        returnTo,
        nextRoute,
      })
    } else {
      console.log(`🔒 Secured network selected: ${selectedNetwork.ssid} - going to password screen`)
      push("/pairing/glasseswifisetup/password", {
        deviceModel,
        ssid: selectedNetwork.ssid,
        requiresPassword: selectedNetwork.requiresPassword.toString(),
        returnTo,
        nextRoute,
      })
    }
  }

  const handleManualEntry = () => {
    push("/pairing/glasseswifisetup/password", {
      deviceModel,
      ssid: "",
      returnTo,
      nextRoute,
    })
  }

  const handleSkip = () => {
    if (nextRoute && typeof nextRoute === "string") {
      replace(decodeURIComponent(nextRoute))
    }
  }

  return (
    <Screen preset="fixed" contentContainerStyle={themed($styles.screen)}>
      <Header
        title="Wi-Fi"
        leftIcon="chevron-left"
        onLeftPress={handleGoBack}
        rightIcon="repeat"
        onRightPress={startScan}
      />

      <View style={themed($header)}>
        <View style={themed($iconContainer)}>
          <WifiIcon size={48} color={theme.colors.palette.success500} />
        </View>
        <Text style={themed($title)}>Add your Wi-Fi network</Text>
        <Text style={themed($subtitle)}>
          Add a network to import media and install device updates automatically while your device is charging.
        </Text>
      </View>

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
              keyExtractor={item => `network-${item.ssid}`}
              renderItem={({item}) => {
                const isConnected = wifiConnected && wifiSsid === item.ssid
                const isSaved = savedNetworks.includes(item.ssid)
                return (
                  <TouchableOpacity
                    style={themed(isConnected ? $connectedNetworkItem : isSaved ? $savedNetworkItem : $networkItem)}
                    onPress={() => handleNetworkSelect(item)}>
                    <View style={themed($networkContent)}>
                      <View style={themed($networkNameRow)}>
                        {item.requiresPassword ? (
                          <WifiLockedIcon size={20} color={theme.colors.text} />
                        ) : (
                          <WifiUnlockedIcon size={20} color={theme.colors.text} />
                        )}
                        <Text
                          style={themed(
                            isConnected ? $connectedNetworkText : isSaved ? $savedNetworkText : $networkText,
                          )}>
                          {item.ssid}
                        </Text>
                      </View>
                      <View style={themed($badgeContainer)}>
                        {isConnected && <Badge text="Connected" />}
                        {isSaved && !isConnected && <Badge text="Saved" />}
                      </View>
                    </View>
                    {!isConnected && (
                      <Text style={themed(isSaved ? $savedChevron : $chevron)}>{isSaved ? "🔑" : "›"}</Text>
                    )}
                  </TouchableOpacity>
                )
              }}
              style={themed($networksList)}
              contentContainerStyle={themed($listContent)}
            />
          </>
        ) : (
          <View style={themed($emptyContainer)}>
            <Text style={themed($emptyText)}>No networks found</Text>
            <Button text="Try Again" onPress={startScan} style={themed($tryAgainButton)} />
          </View>
        )}
      </View>

      {/* Bottom buttons */}
      <View style={themed($bottomButtons)}>
        <Button preset="alternate" onPress={handleManualEntry}>
          <Text>Enter network manually</Text>
        </Button>
        {nextRoute && (
          <Button preset="alternate" onPress={handleSkip} style={{marginTop: theme.spacing.s3}}>
            <Text>Skip</Text>
          </Button>
        )}
      </View>
    </Screen>
  )
}

const $header: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingTop: spacing.s4,
  paddingBottom: spacing.s6,
  alignItems: "center",
})

const $iconContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s4,
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 24,
  fontWeight: "600",
  color: colors.text,
  textAlign: "center",
  marginBottom: 8,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.textDim,
  textAlign: "center",
  paddingHorizontal: spacing.s4,
  lineHeight: 20,
})

const $content: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flex: 1,
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s6,
  borderWidth: 1,
  borderColor: colors.border,
})

const $loadingContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: spacing.s12,
})

const $loadingText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  marginTop: spacing.s4,
  fontSize: 16,
  color: colors.textDim,
})

const $networksList: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  width: "100%",
})

const $listContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingBottom: spacing.s4,
})

const $networkItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  backgroundColor: colors.backgroundAlt,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
  marginBottom: spacing.s2,
  borderRadius: spacing.s4,
})

const $connectedNetworkItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  backgroundColor: colors.backgroundAlt,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
  marginBottom: spacing.s2,
  borderRadius: spacing.s4,
  opacity: 0.7,
})

const $savedNetworkItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  backgroundColor: colors.backgroundAlt,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
  marginBottom: spacing.s2,
  borderRadius: spacing.s4,
})

const $networkContent: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
})

const $networkText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  color: colors.text,
  flex: 1,
  marginLeft: spacing.s2,
})

const $connectedNetworkText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  color: colors.textDim,
  flex: 1,
  marginLeft: spacing.s2,
})

const $savedNetworkText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  color: colors.text,
  flex: 1,
  fontWeight: "500",
  marginLeft: spacing.s2,
})

const $badgeContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  marginLeft: spacing.s2,
})

const $chevron: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 24,
  color: colors.textDim,
  marginLeft: 8,
  textAlignVertical: "center",
})

const $savedChevron: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  color: colors.tint,
  marginLeft: 8,
  textAlignVertical: "center",
})

const $emptyContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: spacing.s12,
})

const $emptyText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  color: colors.textDim,
  marginBottom: spacing.s6,
  textAlign: "center",
})

const $tryAgainButton: ThemedStyle<ViewStyle> = () => ({})

const $networkNameRow: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
  flex: 1,
})

const $bottomButtons: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingBottom: spacing.s6,
})
