import {ActivityIndicator, Pressable, TextStyle, View, ViewStyle} from "react-native"

import {Icon, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {Group} from "@/components/ui/Group"
import {useAppTheme} from "@/contexts/ThemeContext"
import {STTModelManager} from "@mentra/engine/internal"
import {ThemedStyle} from "@/theme"

export type LanguageRow = {
  code: string
  displayName: string
  size: number
  downloaded: boolean
}

type LanguageSelectorProps = {
  title: string
  languages: LanguageRow[]
  currentLanguage: string
  downloadingLanguage?: string
  downloadPercent?: number
  extractionPercent?: number
  onPickLanguage: (code: string) => void
  formatBytes?: (bytes: number) => string
}

export default function LanguageSelector({
  title,
  languages,
  currentLanguage,
  downloadingLanguage,
  downloadPercent,
  extractionPercent,
  onPickLanguage,
  formatBytes = STTModelManager.formatBytes,
}: LanguageSelectorProps) {
  const {theme, themed} = useAppTheme()

  return (
    <Group title={title}>
      {languages.map((lang) => {
        const isActive = lang.code === currentLanguage && lang.downloaded
        const isDownloading = lang.code === downloadingLanguage

        let subtitle: string
        if (isDownloading) {
          if (extractionPercent !== undefined && extractionPercent > 0) {
            subtitle = extractionPercent >= 100 ? "Finishing up…" : `Extracting… ${extractionPercent}%`
          } else if (downloadPercent !== undefined && downloadPercent > 0) {
            subtitle = `Downloading… ${downloadPercent}%`
          } else {
            subtitle = "Preparing download…"
          }
        } else if (lang.downloaded) {
          subtitle = isActive ? `${formatBytes(lang.size)} · In use` : `${formatBytes(lang.size)} · Tap to use`
        } else {
          subtitle = `${formatBytes(lang.size)} · Tap to download`
        }

        return (
          <GlassView key={lang.code} className="bg-primary-foreground">
            <Pressable disabled={isDownloading} style={themed($row)} onPress={() => onPickLanguage(lang.code)}>
              <View style={themed($rowText)}>
                <Text text={lang.displayName} style={themed($rowTitle)} />
                <Text text={subtitle} style={themed($rowSubtitle)} />
              </View>
              <View style={themed($rowIcon)}>
                {isDownloading ? (
                  <ActivityIndicator size="small" color={theme.colors.foreground} />
                ) : isActive ? (
                  <Icon name="check" size={22} color={theme.colors.foreground} />
                ) : lang.downloaded ? null : (
                  <Icon name="world-download" size={20} color={theme.colors.textDim} />
                )}
              </View>
            </Pressable>
          </GlassView>
        )
      })}
    </Group>
  )
}

const $row: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
})

const $rowText: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $rowIcon: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginLeft: spacing.s3,
  alignItems: "center",
  justifyContent: "center",
  minWidth: 24,
})

const $rowTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.text,
})

const $rowSubtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 13,
  marginTop: 2,
  color: colors.textDim,
})
