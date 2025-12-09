import * as Clipboard from "expo-clipboard"
import {useEffect, useState} from "react"
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Share,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native"

import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {Divider} from "@/components/ui/Divider"
import {Group} from "@/components/ui/Group"
import {Spacer} from "@/components/ui/Spacer"
import {useAuth} from "@/contexts/AuthContext"
import {useCoreStatus} from "@/contexts/CoreStatusProvider"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {useApplets} from "@/stores/applets"
import {ThemedStyle} from "@/theme"
import {showAlert} from "@/utils/AlertUtils"
import {DataExportService, UserDataExport} from "@/utils/DataExportService"
import {useAppTheme} from "@/utils/useAppTheme"

export default function DataExportPage() {
  const [exportData, setExportData] = useState<UserDataExport | null>(null)
  const [jsonString, setJsonString] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [copying, setCopying] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [previewExpanded, setPreviewExpanded] = useState(false)

  const {user, session} = useAuth()
  const {status} = useCoreStatus()
  const appStatus = useApplets()
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
      showAlert(translate("common:error"), "Failed to collect export data. Please try again.", [
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
      Clipboard.setStringAsync(jsonString)
      showAlert("Copied!", "Your data has been copied to the clipboard.", [{text: translate("common:ok")}])
    } catch (error) {
      console.error("DataExport: Error copying to clipboard:", error)
      showAlert(translate("common:error"), "Failed to copy to clipboard.", [{text: translate("common:ok")}])
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
        message: Platform.OS === "ios" ? `AugmentOS Data Export - ${filename}\n\n${jsonString}` : jsonString,
        title: `AugmentOS Data Export - ${filename}`,
      })

      if (result.action === Share.sharedAction) {
        console.log("DataExport: Data shared successfully")
      }
    } catch (error) {
      console.error("DataExport: Error sharing:", error)
      showAlert(translate("common:error"), "Failed to share data.", [{text: translate("common:ok")}])
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
        leftIcon="chevron-left"
        onLeftPress={goBack}
        titleMode="flex"
        titleStyle={{textAlign: "left", paddingLeft: theme.spacing.s3}}
      />

      {loading ? (
        <View style={themed($loadingContainer)}>
          <ActivityIndicator size="large" color={theme.colors.palette.primary500} />
          <Spacer height={theme.spacing.s4} />
          <Text text="Collecting your data..." style={themed($loadingText)} />
        </View>
      ) : (
        <ScrollView style={themed($contentContainer)} showsVerticalScrollIndicator={false}>
          <Spacer height={theme.spacing.s4} />

          {/* Data Summary */}
          <Group title="Export Summary">
            {exportData && (
              <View style={themed($summaryContent)}>
                <View style={themed($summaryRow)}>
                  <Text text="Generated" style={themed($summaryLabel)} />
                  <Text
                    text={new Date(exportData.metadata.exportDate).toLocaleString()}
                    style={themed($summaryValue)}
                  />
                </View>
                <View style={themed($summaryRow)}>
                  <Text text="Size" style={themed($summaryLabel)} />
                  <Text text={formatDataSize(jsonString)} style={themed($summaryValue)} />
                </View>
                <View style={themed($summaryRow)}>
                  <Text text="Apps" style={themed($summaryLabel)} />
                  <Text text={String(exportData.installedApps.length)} style={themed($summaryValue)} />
                </View>
                <View style={themed($summaryRow)}>
                  <Text text="Settings" style={themed($summaryLabel)} />
                  <Text text={String(Object.keys(exportData.userSettings).length)} style={themed($summaryValue)} />
                </View>
              </View>
            )}
          </Group>

          <Spacer height={theme.spacing.s6} />

          {/* Action Buttons */}
          <View style={themed($buttonContainer)}>
            <Button
              flex
              preset="alternate"
              disabled={copying || !jsonString}
              onPress={handleCopy}
              LeftAccessory={() => <Icon name="copy" size={20} color={theme.colors.foreground} />}>
              <Text text={copying ? "Copying..." : "Copy"} style={themed($buttonText)} />
            </Button>
            <Button
              flex
              preset="primary"
              disabled={sharing || !jsonString}
              onPress={handleShare}
              LeftAccessory={() => <Icon name="share-2" size={20} color={theme.colors.primary_foreground} />}>
              <Text text={sharing ? "Sharing..." : "Share"} style={themed($buttonTextPrimary)} />
            </Button>
          </View>

          <Spacer height={theme.spacing.s6} />

          {/* Collapsible JSON Preview */}
          <View style={themed($previewContainer)}>
            <TouchableOpacity
              style={themed($previewHeader)}
              onPress={() => setPreviewExpanded(!previewExpanded)}
              activeOpacity={0.7}>
              <Text text="Data Preview" style={themed($previewTitle)} />
              <Icon name={previewExpanded ? "chevron-up" : "chevron-down"} size={24} color={theme.colors.foreground} />
            </TouchableOpacity>

            {previewExpanded && (
              <>
                <Divider />
                <View style={themed($jsonPreviewContainer)}>
                  <ScrollView
                    style={themed($jsonScrollView)}
                    showsVerticalScrollIndicator={true}
                    nestedScrollEnabled={true}>
                    <Text text={jsonString} style={themed($jsonText)} />
                  </ScrollView>
                </View>
              </>
            )}
          </View>

          <Spacer height={theme.spacing.s6} />
        </ScrollView>
      )}
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  flex: 1,
  paddingHorizontal: spacing.s6,
})

const $contentContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $loadingContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
})

const $loadingText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  textAlign: "center",
})

const $summaryContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  gap: spacing.s3,
  paddingVertical: spacing.s2,
})

const $summaryRow: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
})

const $summaryLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  fontWeight: "500",
  color: colors.textDim,
})

const $summaryValue: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  fontWeight: "600",
  color: colors.text,
})

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.s3,
  paddingHorizontal: spacing.s6,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.foreground,
  fontSize: 14,
  fontWeight: "500",
})

const $buttonTextPrimary: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.primary_foreground,
  fontSize: 14,
  fontWeight: "500",
})

const $previewContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  overflow: "hidden",
})

const $previewHeader: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s6,
  minHeight: 56,
})

const $previewTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.text,
})

const $jsonPreviewContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  height: 400,
  backgroundColor: colors.background,
  margin: spacing.s4,
  borderRadius: spacing.s3,
  borderWidth: 1,
  borderColor: colors.border,
  overflow: "hidden",
})

const $jsonScrollView: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $jsonText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  fontSize: 11,
  color: colors.text,
  padding: spacing.s4,
  lineHeight: 16,
})
