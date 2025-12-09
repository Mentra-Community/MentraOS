import {View} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {OtaProgress} from "@/utils/CoreStatusParser"
import {useAppTheme} from "@/utils/useAppTheme"

interface OtaProgressSectionProps {
  otaProgress?: OtaProgress
}

export default function OtaProgressSection({otaProgress}: OtaProgressSectionProps) {
  const {theme, themed} = useAppTheme()

  // Show the component if there's OTA progress data
  if (!otaProgress) {
    return null
  }

  const {download, installation} = otaProgress

  const getStatusText = (status: string) => {
    switch (status) {
      case "STARTED":
        return "Started"
      case "PROGRESS":
        return "In Progress"
      case "FINISHED":
        return "Completed"
      case "FAILED":
        return "Failed"
      default:
        return status
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "STARTED":
      case "PROGRESS":
        return theme.colors.palette.success100
      case "FINISHED":
        return theme.colors.palette.success100
      case "FAILED":
        return theme.colors.palette.angry100
      default:
        return theme.colors.text
    }
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B"
    const k = 1024
    const sizes = ["B", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
  }

  // Determine which progress to show
  // Priority: Installation > Download
  const showInstallation = installation && (installation.status !== "FINISHED" || download?.status === "FINISHED")
  const showDownload = download && !showInstallation

  console.log("installation", installation)
  console.log("download", download)
  console.log("showInstallation", showInstallation)
  console.log("showDownload", showDownload)

  return (
    <View style={themed($container)}>
      <Text style={[themed($subtitle), {marginBottom: theme.spacing.s2}]}>Mentra Live Software Update</Text>

      {/* Show Installation Progress (if active) */}
      {showInstallation && (
        <View style={themed($progressItem)}>
          <View style={themed($progressHeader)}>
            <Text style={themed($progressTitle)}>Installation</Text>
            <Text style={[themed($progressStatus), {color: getStatusColor(installation.status)}]}>
              {getStatusText(installation.status)}
            </Text>
          </View>

          {installation.status === "STARTED" && <Text style={themed($progressText)}>Installing update...</Text>}

          {installation.status === "FINISHED" && (
            <Text style={themed($progressText)}>Installation completed successfully</Text>
          )}

          {installation.status === "FAILED" && installation.error_message && (
            <Text style={[themed($progressText), {color: theme.colors.error}]}>
              Error: {installation.error_message}
            </Text>
          )}
        </View>
      )}

      {/* Show Download Progress (if no active installation) */}
      {showDownload && (
        <View style={themed($progressItem)}>
          <View style={themed($progressHeader)}>
            <Text style={themed($progressTitle)}>Download</Text>
            <Text style={[themed($progressStatus), {color: getStatusColor(download.status)}]}>
              {getStatusText(download.status)}
            </Text>
          </View>

          {download.status === "STARTED" && (
            <>
              <View style={themed($progressBarContainer)}>
                <View style={[themed($progressBar), {width: "0%"}]} />
              </View>
              <View style={themed($progressDetails)}>
                <Text style={themed($progressText)}>0% (0 B / {formatBytes(download.total_bytes)})</Text>
              </View>
            </>
          )}

          {download.status === "PROGRESS" && (
            <>
              <View style={themed($progressBarContainer)}>
                <View style={[themed($progressBar), {width: `${download.progress}%`}]} />
              </View>
              <View style={themed($progressDetails)}>
                <Text style={themed($progressText)}>
                  {download.progress}% ({formatBytes(download.bytes_downloaded)} / {formatBytes(download.total_bytes)})
                </Text>
              </View>
            </>
          )}

          {download.status === "FINISHED" && <Text style={themed($progressText)}>Download completed successfully</Text>}

          {download.status === "FAILED" && download.error_message && (
            <Text style={[themed($progressText), {color: theme.colors.error}]}>Error: {download.error_message}</Text>
          )}
        </View>
      )}
    </View>
  )
}

const $container: ThemedStyle<any> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderRadius: spacing.s4,
  // borderWidth: 2,
  // borderColor: colors.border,
})

const $subtitle: ThemedStyle<any> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: spacing.s3,
  fontWeight: "600",
})

const $progressItem: ThemedStyle<any> = ({spacing}) => ({
  marginBottom: spacing.s3,
})

const $progressHeader: ThemedStyle<any> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: spacing.s2,
})

const $progressTitle: ThemedStyle<any> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
  fontWeight: "500",
})

const $progressStatus: ThemedStyle<any> = () => ({
  fontSize: 12,
  fontWeight: "600",
})

const $progressBarContainer: ThemedStyle<any> = ({colors, spacing}) => ({
  height: 8,
  borderRadius: 4,
  backgroundColor: colors.palette.neutral300,
  marginBottom: spacing.s2,
  overflow: "hidden",
})

const $progressBar: ThemedStyle<any> = ({colors}) => ({
  height: "100%",
  backgroundColor: colors.palette.success100,
})

const $progressDetails: ThemedStyle<any> = ({spacing}) => ({
  marginBottom: spacing.s2,
})

const $progressText: ThemedStyle<any> = ({colors}) => ({
  color: colors.text,
  fontSize: 12,
})
