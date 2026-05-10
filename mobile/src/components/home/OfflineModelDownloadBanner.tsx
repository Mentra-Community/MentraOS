import {useEffect, useState} from "react"
import {ActivityIndicator, TextStyle, View, ViewStyle} from "react-native"

import {Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import offlineSpeechModelService, {DownloadStatus} from "@/services/OfflineSpeechModelService"
import {ThemedStyle} from "@/theme"

const COMPLETE_DISMISS_MS = 2500

export default function OfflineModelDownloadBanner() {
  const {theme, themed} = useAppTheme()
  const [status, setStatus] = useState<DownloadStatus | null>(offlineSpeechModelService.getStatus())

  useEffect(() => {
    return offlineSpeechModelService.subscribe(setStatus)
  }, [])

  useEffect(() => {
    if (status?.stage === "complete") {
      const t = setTimeout(() => {
        if (offlineSpeechModelService.getStatus()?.stage === "complete") {
          setStatus(null)
        }
      }, COMPLETE_DISMISS_MS)
      return () => clearTimeout(t)
    }
    return undefined
  }, [status?.stage])

  if (!status || status.stage === "idle") return null
  if (status.stage === "failed") return null

  const labelKind = status.kind === "stt" ? "Captions" : "Voice"
  const offlineHint = status.kind === "stt" ? "keeps captions working offline" : "keeps the voice working offline"
  let title: string
  let subtitle: string
  if (status.stage === "complete") {
    title = `${labelKind} ready offline`
    subtitle = "You can now use this language without internet."
  } else if (status.stage === "extracting") {
    title = `Setting up ${labelKind.toLowerCase()}…`
    subtitle = `${status.percent}% · almost done`
  } else {
    title = `Downloading ${labelKind.toLowerCase()}…`
    subtitle = `${status.percent}% · ${offlineHint}`
  }

  return (
    <View style={themed($container)}>
      <View style={themed($iconCol)}>
        {status.stage === "complete" ? (
          <Icon name="check" size={20} color={theme.colors.foreground} />
        ) : (
          <ActivityIndicator size="small" color={theme.colors.foreground} />
        )}
      </View>
      <View style={themed($textCol)}>
        <Text text={title} style={themed($title)} />
        <Text text={subtitle} style={themed($subtitle)} />
        {status.stage !== "complete" && (
          <View style={themed($barTrack)}>
            <View style={[themed($barFill), {width: `${Math.max(2, Math.min(100, status.percent))}%`}]} />
          </View>
        )}
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  paddingVertical: spacing.s3,
  paddingHorizontal: spacing.s4,
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s3,
  marginBottom: spacing.s3,
})

const $iconCol: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: 32,
  alignItems: "center",
  justifyContent: "center",
  marginRight: spacing.s3,
})

const $textCol: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  fontWeight: "600",
  color: colors.text,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  marginTop: 2,
  color: colors.textDim,
})

const $barTrack: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  height: 4,
  marginTop: spacing.s2,
  backgroundColor: colors.border,
  borderRadius: 2,
  overflow: "hidden",
})

const $barFill: ThemedStyle<ViewStyle> = ({colors}) => ({
  height: "100%",
  backgroundColor: colors.foreground,
  borderRadius: 2,
})
