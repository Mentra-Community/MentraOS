import * as Application from "expo-application"
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
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {useApps} from "@mentra/engine"
import {engine} from "@mentra/engine"
import {ThemedStyle} from "@/theme"
import {showAlert} from "@/utils/AlertUtils"
import type {MentraAuthSession, MentraAuthUser} from "@/utils/auth/authProvider.types"

/**
 * The account profile as the current auth providers report it
 * (`MentraAuthUser`). Optional fields a provider does not supply are null;
 * nothing is inferred beyond what the provider returned.
 */
export interface ExportedAuthUser {
  id: string
  email: string | null
  name: string
  avatarUrl: string | null
  createdAt: string | null
  provider: string | null
}

/**
 * Non-secret facts about the current `MentraAuthSession`. The token itself is
 * never exported, and its presence does not mean the server still accepts it.
 */
export interface ExportedSessionInfo {
  hasAccessToken: boolean
}

export interface UserDataExport {
  metadata: {
    exportDate: string
    exportVersion: string
    /** Installed native Mentra App version, or null when the platform cannot report it. */
    appVersion: string | null
  }
  authentication: {
    /** The signed-in account's profile, or null when the app has no account user. */
    user: ExportedAuthUser | null
    sessionInfo: ExportedSessionInfo
  }
  augmentosStatus: any // Full status from AugmentOSStatusProvider
  installedApps: any[] // Full app list from AppStatusProvider
  userSettings: {
    [key: string]: any
  }
}

class DataExportService {
  // 2.0.0: authentication follows the current MentraAuthUser/MentraAuthSession
  // types. The 1.0.0 user/sessionInfo fields read a former provider's shape
  // that current sessions no longer carry, so they exported as empty objects.
  private static readonly EXPORT_VERSION = "2.0.0"

  /**
   * Collect all user data from various sources
   */
  public static async collectUserData(
    user: MentraAuthUser | null,
    session: MentraAuthSession | null,
    status: any,
    appStatus: any[],
  ): Promise<UserDataExport> {
    console.log("DataExportService: Starting user data collection...")

    const exportData: UserDataExport = {
      metadata: {
        exportDate: new Date().toISOString(),
        exportVersion: this.EXPORT_VERSION,
        appVersion: this.installedAppVersion(),
      },
      authentication: this.collectAuthData(user, session),
      augmentosStatus: this.sanitizeStatusData(status),
      installedApps: this.sanitizeAppData(appStatus),
      userSettings: await this.collectSettingsData(),
    }

    console.log("DataExportService: Data collection completed")
    return exportData
  }

  /**
   * The installed binary's marketing version (iOS CFBundleShortVersionString,
   * Android versionName). Build labels and package versions are not substitutes.
   */
  private static installedAppVersion(): string | null {
    return Application.nativeApplicationVersion?.trim() || null
  }

  /**
   * Project the auth context into its exportable, non-secret form. Fields are
   * picked explicitly so a credential added to the auth types is never exported
   * by accident.
   */
  private static collectAuthData(
    user: MentraAuthUser | null,
    session: MentraAuthSession | null,
  ): UserDataExport["authentication"] {
    console.log("DataExportService: Collecting auth data...")

    return {
      user: user
        ? {
            id: user.id,
            email: user.email ?? null,
            name: user.name,
            // Authing reports a missing photo as "".
            avatarUrl: user.avatarUrl || null,
            createdAt: user.createdAt ?? null,
            provider: user.provider ?? null,
          }
        : null,
      sessionInfo: {hasAccessToken: Boolean(session?.token)},
    }
  }

  /**
   * Copy `value`, replacing every non-empty value whose key the settings
   * registry marks as a credential with "[REDACTED]", at any depth. The source
   * is never modified.
   *
   * The same rule covers settings and status: native Bluetooth status mirrors
   * the settings synced to it, and iOS returns its whole "bluetooth" store,
   * including `core_token`, at the status root.
   */
  private static redactCredentials(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.redactCredentials(entry))
    if (!value || typeof value !== "object") return value
    return this.redactCredentialEntries(value)
  }

  /** `redactCredentials` for one object's own entries. */
  private static redactCredentialEntries(record: object): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]: [string, unknown]) => [
        key,
        engine.settings.descriptor(key)?.credential && entry ? "[REDACTED]" : this.redactCredentials(entry),
      ]),
    )
  }

  private static sanitizeStatusData(status: any): any {
    if (!status) return null
    return this.redactCredentials(status)
  }

  /**
   * Sanitize app data - remove sensitive keys and tokens
   */
  private static sanitizeAppData(appStatus: any[]): any[] {
    if (!appStatus || !Array.isArray(appStatus)) return []

    return appStatus.map((app) => {
      const sanitized = {...app}

      // Remove sensitive app data
      if (sanitized.hashedApiKey) {
        sanitized.hashedApiKey = "[REDACTED]"
      }
      if (sanitized.hashedEndpointSecret) {
        sanitized.hashedEndpointSecret = "[REDACTED]"
      }

      return sanitized
    })
  }

  /**
   * Collect the user's settings with credentials (such as the Cloud bearer in
   * `core_token`) redacted.
   */
  private static async collectSettingsData(): Promise<{[key: string]: any}> {
    console.log("DataExportService: Collecting settings data...")
    const settings = this.redactCredentialEntries(engine.settings.getAll())
    console.log(`DataExportService: Collected ${Object.keys(settings).length} settings`)
    return settings
  }

  /**
   * Format the export data as pretty JSON string
   */
  public static formatAsJson(data: UserDataExport): string {
    return JSON.stringify(data, null, 2)
  }

  /**
   * Generate a filename for the export
   */
  public static generateFilename(): string {
    const date = new Date().toISOString().split("T")[0] // YYYY-MM-DD
    return `mentraos-data-export-${date}.json`
  }
}

export default function DataExportPage() {
  const [exportData, setExportData] = useState<UserDataExport | null>(null)
  const [jsonString, setJsonString] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [copying, setCopying] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [previewExpanded, setPreviewExpanded] = useState(false)

  const {user, session} = useAuth()
  const appStatus = useApps()
  const {goBack} = useNavigationStore.getState()
  const {theme, themed} = useAppTheme()

  useEffect(() => {
    collectData()
  }, [])

  const collectData = async () => {
    console.log("DataExport: Starting data collection...")
    setLoading(true)

    try {
      const data = await DataExportService.collectUserData(user, session, engine.dev.bluetoothStatus(), appStatus)
      const formatted = DataExportService.formatAsJson(data)

      setExportData(data)
      setJsonString(formatted)
      console.log("DataExport: Data collection completed")
    } catch (error) {
      console.error("DataExport: Error collecting data:", error)
      showAlert(translate("common:error"), translate("profileSettings:dataExportCollectError"), [
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
      showAlert(translate("profileSettings:dataExportCopied"), translate("profileSettings:dataExportCopiedMessage"), [
        {text: translate("common:ok")},
      ])
    } catch (error) {
      console.error("DataExport: Error copying to clipboard:", error)
      showAlert(translate("common:error"), translate("profileSettings:dataExportCopyError"), [
        {text: translate("common:ok")},
      ])
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
      showAlert(translate("common:error"), translate("profileSettings:dataExportShareError"), [
        {text: translate("common:ok")},
      ])
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
        title={translate("profileSettings:dataExportHeader")}
        leftIcon="chevron-left"
        onLeftPress={goBack}
        titleMode="flex"
        titleStyle={{textAlign: "left", paddingLeft: theme.spacing.s3}}
      />

      {loading ? (
        <View style={themed($loadingContainer)}>
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          <Spacer height={theme.spacing.s4} />
          <Text text={translate("profileSettings:dataExportCollecting")} style={themed($loadingText)} />
        </View>
      ) : (
        <ScrollView style={themed($contentContainer)} showsVerticalScrollIndicator={false}>
          <Spacer height={theme.spacing.s4} />

          {/* Data Summary */}
          <Group title={translate("profileSettings:dataExportSummary")}>
            {exportData && (
              <View style={themed($summaryContent)}>
                <View style={themed($summaryRow)}>
                  <Text text={translate("profileSettings:dataExportGenerated")} style={themed($summaryLabel)} />
                  <Text
                    text={new Date(exportData.metadata.exportDate).toLocaleString()}
                    style={themed($summaryValue)}
                  />
                </View>
                <View style={themed($summaryRow)}>
                  <Text text={translate("profileSettings:dataExportSize")} style={themed($summaryLabel)} />
                  <Text text={formatDataSize(jsonString)} style={themed($summaryValue)} />
                </View>
                <View style={themed($summaryRow)}>
                  <Text text={translate("profileSettings:dataExportApps")} style={themed($summaryLabel)} />
                  <Text text={String(exportData.installedApps.length)} style={themed($summaryValue)} />
                </View>
                <View style={themed($summaryRow)}>
                  <Text text={translate("profileSettings:dataExportSettings")} style={themed($summaryLabel)} />
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
              text={translate(copying ? "profileSettings:dataExportCopying" : "profileSettings:dataExportCopy")}
              LeftAccessory={() => <Icon name="copy" size={20} color={theme.colors.foreground} />}
            />
            <Button
              flex
              preset="primary"
              disabled={sharing || !jsonString}
              onPress={handleShare}
              text={translate(sharing ? "profileSettings:dataExportSharing" : "profileSettings:dataExportShare")}
              LeftAccessory={() => <Icon name="share-2" size={20} color={theme.colors.primary_foreground} />}
            />
          </View>

          <Spacer height={theme.spacing.s6} />

          {/* Collapsible JSON Preview */}
          <View style={themed($previewContainer)}>
            <TouchableOpacity
              style={themed($previewHeader)}
              onPress={() => setPreviewExpanded(!previewExpanded)}
              activeOpacity={0.7}>
              <Text text={translate("profileSettings:dataExportPreview")} style={themed($previewTitle)} />
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

const $container: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  flex: 1,
})

const $contentContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  paddingHorizontal: spacing.s4,
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
