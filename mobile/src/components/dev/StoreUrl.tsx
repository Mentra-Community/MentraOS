import {useState} from "react"
import {TextInput, View, ViewStyle, TextStyle} from "react-native"

import {Button, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"

export default function StoreUrl() {
  const {theme, themed} = useAppTheme()
  const {replace} = useNavigationHistory()
  const [customUrlInput, setCustomUrlInput] = useState("")
  const [storeUrl, setStoreUrl] = useSetting(SETTINGS.store_url.key)

  const handleSaveUrl = async () => {
    const urlToTest = customUrlInput.trim().replace(/\/+$/, "")

    // Basic validation
    if (!urlToTest) {
      showAlert("Empty URL", "Please enter a URL or reset to default.", [{text: "OK"}])
      return
    }

    if (!urlToTest.startsWith("http://") && !urlToTest.startsWith("https://")) {
      showAlert("Invalid URL", "Please enter a valid URL starting with http:// or https://", [{text: "OK"}])
      return
    }

    await setStoreUrl(urlToTest)

    await showAlert(
      "Success",
      "Custom store URL saved and verified. It will be used on the next connection attempt or app restart.",
      [
        {
          text: translate("common:ok"),
          onPress: () => {
            replace("/")
          },
        },
      ],
    )
  }

  const handleResetUrl = async () => {
    setStoreUrl(null)
    setCustomUrlInput("")
    showAlert("Success", "Reset store URL to default.", [
      {
        text: "OK",
        onPress: () => {
          replace("/")
        },
      },
    ])
  }

  return (
    <View style={themed($container)}>
      <View style={themed($textContainer)}>
        <Text style={themed($label)}>Custom Store URL</Text>
        <Text style={themed($subtitle)}>
          Override the default store server URL. Leave blank to use default.
          {storeUrl && `\nCurrently using: ${storeUrl}`}
        </Text>
        <TextInput
          style={themed($urlInput)}
          placeholder="e.g., https://apps.mentra.glass"
          placeholderTextColor={theme.colors.textDim}
          value={customUrlInput}
          onChangeText={setCustomUrlInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <View style={themed($buttonRow)}>
          <Button
            // compact
            text="Save URL"
            onPress={handleSaveUrl}
            preset="alternate"
            flexContainer={false}
          />
          <Button
            // compact
            tx="common:reset"
            onPress={handleResetUrl}
            preset="alternate"
            flexContainer={false}
          />
        </View>
        <View style={themed($buttonColumn)}>
          <Button
            tx="developer:global"
            onPress={() => setCustomUrlInput("https://apps.mentra.glass")}
            compact
            flex
            flexContainer={false}
          />
          <Button
            tx="developer:dev"
            onPress={() => setCustomUrlInput("https://appsbeta.mentraglass.com")}
            compact
            flexContainer={false}
            flex
          />
        </View>
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.backgroundAlt,
  borderRadius: spacing.s4,
  paddingHorizontal: spacing.s6,
  paddingVertical: spacing.s4,
})

const $textContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  flexWrap: "wrap",
  fontSize: 16,
  color: colors.text,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  flexWrap: "wrap",
  fontSize: 12,
  marginTop: 5,
  color: colors.textDim,
})

const $urlInput: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  borderColor: colors.primary,
  borderRadius: spacing.s3,
  paddingHorizontal: 12,
  paddingVertical: 10,
  fontSize: 14,
  marginTop: 10,
  marginBottom: 10,
  color: colors.text,
})

const $buttonRow: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  marginTop: 10,
})

const $buttonColumn: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  gap: 12,
  justifyContent: "space-between",
  marginTop: 12,
})
