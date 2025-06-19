import React, {useState, useEffect} from "react"
import {
  View,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Share,
  Platform,
  ViewStyle,
  TextStyle,
  Clipboard,
} from "react-native"
import {Screen, Header, Text} from "@/components/ignite"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAuth} from "@/contexts/AuthContext"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import {useAppStatus} from "@/contexts/AppStatusProvider"
import {DataExportService, UserDataExport} from "@/utils/DataExportService"
import {translate} from "@/i18n"
import ActionButton from "@/components/ui/ActionButton"
import {Spacer} from "@/components/misc/Spacer"

export default function DataExportPage() {
  const [exportData, setExportData] = useState<UserDataExport | null>(null)
  const [jsonString, setJsonString] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [copying, setCopying] = useState(false)
  const [sharing, setSharing] = useState(false)

  const {user, session} = useAuth()
  const {status} = useStatus()
  const {appStatus} = useAppStatus()
  const {goBack} = useNavigationHistory()
  const {theme, themed} = useAppTheme()

  useEffect(() => {
    collectData()
  }, [])

  const collectData = async () => {
    console.log("DataExport: Starting data collection...")
    setLoading(true)

    try {
      const data = await DataExportService.collectUserData(user, session, status, appStatus)
      const formatted = DataExportService.formatAsJson(data)

      setExportData(data)
      setJsonString(formatted)
      console.log("DataExport: Data collection completed")
    } catch (error) {
      console.error("DataExport: Error collecting data:", error)
      Alert.alert(translate("common:error"), "Failed to collect export data. Please try again.", [
        {text: translate("common:ok")},
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async () => {
    if (!jsonString) return

    setCopying(true)
    try {
      Clipboard.setString(jsonString)
      Alert.alert("Copied!", "Your data has been copied to the clipboard.", [{text: translate("common:ok")}])
    } catch (error) {
      console.error("DataExport: Error copying to clipboard:", error)
      Alert.alert(translate("common:error"), "Failed to copy to clipboard.", [{text: translate("common:ok")}])
    } finally {
      setCopying(false)
    }
  }

  const handleShare = async () => {
    if (!jsonString) return

    setSharing(true)
    try {
      const filename = DataExportService.generateFilename()

      const result = await Share.share({
        message: Platform.OS === "ios" ? `MentraOS Data Export - ${filename}\n\n${jsonString}` : jsonString,
        title: `MentraOS Data Export - ${filename}`,
      })

      if (result.action === Share.sharedAction) {
        console.log("DataExport: Data shared successfully")
      }
    } catch (error) {
      console.error("DataExport: Error sharing:", error)
      Alert.alert(translate("common:error"), "Failed to share data.", [{text: translate("common:ok")}])
    } finally {
      setSharing(false)
    }
  }

  const formatDataSize = (str: string): string => {
    const bytes = new Blob([str]).size
    if (bytes < 1024) return `${bytes} bytes`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <Screen preset="fixed" style={themed($container)}>
      <Header
        title="Data Export"
        leftIcon="caretLeft"
        onLeftPress={goBack}
        rightIcon={!loading ? "more" : undefined}
        rightIconColor={theme.colors.text}
        onRightPress={
          !loading
            ? () => {
                Alert.alert("Export Options", "Choose an action for your data:", [
                  {text: "Copy to Clipboard", onPress: handleCopy},
                  {text: "Share", onPress: handleShare},
                  {text: translate("common:cancel"), style: "cancel"},
                ])
              }
            : undefined
        }
      />

      {loading ? (
        <View style={themed($loadingContainer)}>
          <ActivityIndicator size="large" color={theme.colors.palette.primary500} />
          <Spacer height={theme.spacing.md} />
          <Text text="Collecting your data..." style={themed($loadingText)} />
        </View>
      ) : (
        <View style={themed($contentContainer)}>
          {/* Data Summary */}
          <View style={themed($summaryContainer)}>
            <Text text="Export Summary" style={themed($summaryTitle)} />
            {exportData && (
              <>
                <Text
                  text={`Generated: ${new Date(exportData.metadata.exportDate).toLocaleString()}`}
                  style={themed($summaryText)}
                />
                <Text text={`Size: ${formatDataSize(jsonString)}`} style={themed($summaryText)} />
                <Text text={`Apps: ${exportData.installedApps.length}`} style={themed($summaryText)} />
                <Text text={`Settings: ${Object.keys(exportData.userSettings).length}`} style={themed($summaryText)} />
              </>
            )}
          </View>

          <Spacer height={theme.spacing.md} />

          {/* Action Buttons */}
          <View style={themed($buttonContainer)}>
            <ActionButton
              label={copying ? "Copying..." : "Copy to Clipboard"}
              variant="default"
              onPress={handleCopy}
              disabled={copying || !jsonString}
              containerStyle={themed($button)}
            />
            <ActionButton
              label={sharing ? "Sharing..." : "Share"}
              variant="default"
              onPress={handleShare}
              disabled={sharing || !jsonString}
              containerStyle={themed($button)}
            />
          </View>

          <Spacer height={theme.spacing.md} />

          {/* JSON Preview */}
          <View style={themed($jsonContainer)}>
            <Text text="Data Preview" style={themed($jsonTitle)} />
            <ScrollView style={themed($jsonScrollView)} showsVerticalScrollIndicator={true} nestedScrollEnabled={true}>
              <Text text={jsonString} style={themed($jsonText)} />
            </ScrollView>
          </View>
        </View>
      )}
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  flex: 1,
})

const $contentContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  paddingHorizontal: spacing.md,
})

const $loadingContainer: ThemedStyle<ViewStyle> = ({}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
})

const $loadingText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  textAlign: "center",
})

const $summaryContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.palette.neutral100,
  borderRadius: 8,
  padding: spacing.md,
  borderWidth: 1,
  borderColor: colors.border,
})

const $summaryTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  fontWeight: "bold",
  color: colors.text,
  marginBottom: 8,
})

const $summaryText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.textDim,
  marginBottom: 4,
})

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.sm,
})

const $button: ThemedStyle<ViewStyle> = ({}) => ({
  flex: 1,
})

const $jsonContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flex: 1,
  backgroundColor: colors.palette.neutral100,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: colors.border,
  overflow: "hidden",
})

const $jsonTitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.text,
  padding: spacing.md,
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
})

const $jsonScrollView: ThemedStyle<ViewStyle> = ({}) => ({
  flex: 1,
})

const $jsonText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  fontSize: 12,
  color: colors.text,
  padding: spacing.md,
  lineHeight: 16,
})
