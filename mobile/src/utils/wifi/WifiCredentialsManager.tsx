import {useState, useEffect} from "react"
import {View, FlatList, TouchableOpacity, Alert} from "react-native"
import {ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import ActionButton from "@/components/ui/ActionButton"
import {Spacer} from "@/components/ui/Spacer"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import WifiCredentialsService from "@/utils/wifi/WifiCredentialsService"

interface WifiCredentialsManagerProps {
  onNetworkSelect?: (ssid: string) => void
}

export default function WifiCredentialsManager({onNetworkSelect}: WifiCredentialsManagerProps) {
  const {themed, theme} = useAppTheme()
  const [savedNetworks, setSavedNetworks] = useState<Array<{ssid: string; lastConnected?: number}>>([])

  useEffect(() => {
    loadSavedNetworks()
  }, [])

  const loadSavedNetworks = () => {
    const credentials = WifiCredentialsService.getAllCredentials()
    setSavedNetworks(credentials.map(cred => ({ssid: cred.ssid, lastConnected: cred.lastConnected})))
  }

  const handleRemoveNetwork = (ssid: string) => {
    Alert.alert("Remove Saved Network", `Are you sure you want to remove "${ssid}" from saved networks?`, [
      {text: "Cancel", style: "cancel"},
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          WifiCredentialsService.removeCredentials(ssid)
          loadSavedNetworks()
        },
      },
    ])
  }

  const handleClearAll = () => {
    Alert.alert("Clear All Saved Networks", "Are you sure you want to remove all saved WiFi networks?", [
      {text: "Cancel", style: "cancel"},
      {
        text: "Clear All",
        style: "destructive",
        onPress: () => {
          WifiCredentialsService.clearAllCredentials()
          loadSavedNetworks()
        },
      },
    ])
  }

  const formatLastConnected = (timestamp?: number) => {
    if (!timestamp) return "Unknown"
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) return "Today"
    if (diffDays === 1) return "Yesterday"
    if (diffDays < 7) return `${diffDays} days ago`
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
    return date.toLocaleDateString()
  }

  if (savedNetworks.length === 0) {
    return (
      <View style={themed($emptyContainer)}>
        <Text style={themed($emptyText)}>No saved WiFi networks</Text>
        <Text style={themed($emptySubtext)}>Networks you connect to will be saved here</Text>
      </View>
    )
  }

  return (
    <View style={themed($container)}>
      <View style={themed($header)}>
        <Text style={themed($headerText)}>Saved Networks ({savedNetworks.length})</Text>
        <ActionButton label="Clear All" variant="secondary" onPress={handleClearAll} />
      </View>

      <FlatList
        data={savedNetworks}
        keyExtractor={item => item.ssid}
        renderItem={({item}) => (
          <View style={themed($networkItem)}>
            <View style={themed($networkInfo)}>
              <Text style={themed($networkName)}>{item.ssid}</Text>
              <Text style={themed($networkDate)}>Last connected: {formatLastConnected(item.lastConnected)}</Text>
            </View>
            <View style={themed($networkActions)}>
              {onNetworkSelect && (
                <TouchableOpacity style={themed($selectButton)} onPress={() => onNetworkSelect(item.ssid)}>
                  <Text style={themed($selectButtonText)}>Select</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={themed($removeButton)} onPress={() => handleRemoveNetwork(item.ssid)}>
                <Text style={themed($removeButtonText)}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        ItemSeparatorComponent={() => <Spacer height={theme.spacing.s2} />}
      />
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $header: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: spacing.s4,
})

const $headerText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  fontWeight: "600",
  color: colors.text,
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
  marginBottom: spacing.s2,
  textAlign: "center",
})

const $emptySubtext: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.textDim,
  textAlign: "center",
})

const $networkItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  backgroundColor: colors.background,
  padding: spacing.s4,
  borderRadius: spacing.s2,
  borderWidth: 1,
  borderColor: colors.border,
})

const $networkInfo: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $networkName: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "500",
  color: colors.text,
  marginBottom: 2,
})

const $networkDate: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.textDim,
})

const $networkActions: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.s2,
})

const $selectButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.tint,
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s2,
  borderRadius: spacing.s2,
})

const $selectButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  fontWeight: "500",
  color: colors.background,
})

const $removeButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.error,
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s2,
  borderRadius: spacing.s2,
})

const $removeButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  fontWeight: "500",
  color: colors.background,
})
