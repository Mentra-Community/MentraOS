import type {OtaProgress, OtaProgressStatus} from "@mentra/bluetooth-sdk-internal"
import {View, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle, type Theme} from "@/theme"

interface OtaProgressSectionProps {
  otaProgress: OtaProgress | null
}

export default function OtaProgressSection({otaProgress}: OtaProgressSectionProps) {
  const {theme, themed} = useAppTheme()

  if (!otaProgress) {
    return null
  }

  const progress = otaProgress.progress
  const stageTitle = otaProgress.stage === "install" ? "Installation" : "Download"
  const showByteCount = otaProgress.stage === "download" && otaProgress.totalBytes > 0

  return (
    <View style={themed($container)}>
      <Text style={[themed($subtitle), {marginBottom: theme.spacing.s2}]}>Mentra Live Software Update</Text>

      <View style={themed($progressItem)}>
        <View style={themed($progressHeader)}>
          <Text style={themed($progressTitle)}>{stageTitle}</Text>
          <Text style={[themed($progressStatus), {color: getStatusColor(otaProgress.status, theme)}]}>
            {getStatusText(otaProgress.status)}
          </Text>
        </View>

        {otaProgress.status === "FAILED" && otaProgress.errorMessage ? (
          <Text style={[themed($progressText), {color: theme.colors.error}]}>Error: {otaProgress.errorMessage}</Text>
        ) : (
          <>
            <View style={themed($progressBarContainer)}>
              <View style={[themed($progressBar), {width: `${progress}%`}]} />
            </View>
            <View style={themed($progressDetails)}>
              <Text style={themed($progressText)}>
                {showByteCount
                  ? `${progress}% (${formatBytes(otaProgress.bytesDownloaded)} / ${formatBytes(otaProgress.totalBytes)})`
                  : `${progress}%`}
              </Text>
            </View>
          </>
        )}
      </View>
    </View>
  )
}

function getStatusText(status: OtaProgressStatus) {
  switch (status) {
    case "STARTED":
      return "Started"
    case "PROGRESS":
      return "In Progress"
    case "FINISHED":
      return "Completed"
    case "FAILED":
      return "Failed"
  }
}

function getStatusColor(status: OtaProgressStatus, {colors}: Theme) {
  switch (status) {
    case "STARTED":
    case "PROGRESS":
    case "FINISHED":
      return colors.palette.success100
    case "FAILED":
      return colors.palette.angry100
  }
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B"

  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderRadius: spacing.s4,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: spacing.s3,
  fontWeight: "600",
})

const $progressItem: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s3,
})

const $progressHeader: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: spacing.s2,
})

const $progressTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
  fontWeight: "500",
})

const $progressStatus: ThemedStyle<TextStyle> = () => ({
  fontSize: 12,
  fontWeight: "600",
})

const $progressBarContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  height: 8,
  borderRadius: 4,
  backgroundColor: colors.palette.neutral300,
  marginBottom: spacing.s2,
  overflow: "hidden",
})

const $progressBar: ThemedStyle<ViewStyle> = ({colors}) => ({
  height: "100%",
  backgroundColor: colors.palette.success100,
})

const $progressDetails: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s2,
})

const $progressText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 12,
})
