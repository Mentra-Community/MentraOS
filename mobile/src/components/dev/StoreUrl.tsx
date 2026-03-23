import {useState} from "react"
import {TextInput, View, ViewStyle, TextStyle, TouchableOpacity} from "react-native"

import {Button, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"

interface SavedUrl {
  label: string
  url: string
}

export default function StoreUrl() {
  const {theme, themed} = useAppTheme()
  const {replace} = useNavigationHistory()
  const [customUrlInput, setCustomUrlInput] = useState("")
  const [storeUrl, setStoreUrl] = useSetting(SETTINGS.store_url.key)
  const [savedUrls, setSavedUrls] = useSetting(SETTINGS.saved_store_urls.key)

  // Ensure savedUrls is always an array
  const bookmarks: SavedUrl[] = Array.isArray(savedUrls) ? savedUrls : []

  const generateLabel = (url: string): string => {
    try {
      const parsed = new URL(url)
      return parsed.host
    } catch {
      return url
    }
  }

  const handleBookmark = () => {
    const urlToSave = customUrlInput.trim().replace(/\/+$/, "")

    if (!urlToSave) {
      showAlert("No URL", "Enter a URL in the text field first.", [{text: "OK"}])
      return
    }

    if (!urlToSave.startsWith("http://") && !urlToSave.startsWith("https://")) {
      showAlert("Invalid URL", "Please enter a valid URL starting with http:// or https://", [{text: "OK"}])
      return
    }

    // Check for duplicates
    if (bookmarks.some((b) => b.url === urlToSave)) {
      showAlert("Already Bookmarked", "This URL is already in your saved list.", [{text: "OK"}])
      return
    }

    const label = generateLabel(urlToSave)
    const updated = [...bookmarks, {label, url: urlToSave}]
    setSavedUrls(updated)
    showAlert("Bookmarked", `Saved "${label}" to your URLs.`, [{text: "OK"}])
  }

  const handleDeleteBookmark = (index: number) => {
    const bookmark = bookmarks[index]
    showAlert("Remove Bookmark", `Remove "${bookmark.label}" from your saved URLs?`, [
      {text: "Cancel", style: "cancel"},
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          const updated = bookmarks.filter((_, i) => i !== index)
          setSavedUrls(updated)
        },
      },
    ])
  }

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
          <Button text="Save URL" onPress={handleSaveUrl} preset="alternate" flexContainer={false} />
          <Button tx="common:reset" onPress={handleResetUrl} preset="alternate" flexContainer={false} />
          <Button text="☆ Bookmark" onPress={handleBookmark} preset="alternate" flexContainer={false} />
        </View>

        {/* Saved URL bookmarks */}
        {bookmarks.length > 0 && (
          <View style={themed($savedSection)}>
            <Text style={themed($sectionLabel)}>My URLs</Text>
            <View style={themed($chipContainer)}>
              {bookmarks.map((bookmark, index) => (
                <TouchableOpacity
                  key={`${bookmark.url}-${index}`}
                  style={themed($chip)}
                  onPress={() => setCustomUrlInput(bookmark.url)}
                  onLongPress={() => handleDeleteBookmark(index)}
                  activeOpacity={0.7}>
                  <Text style={themed($chipText)}>{bookmark.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={themed($chipHint)}>Tap to fill · Long-press to remove</Text>
          </View>
        )}

        {/* Environment presets */}
        <View style={themed($buttonColumn)}>
          <Button
            tx="developer:global"
            onPress={() => setCustomUrlInput("https://apps.mentra.glass")}
            compact
            flex
            flexContainer={false}
          />
          <Button
            tx="developer:beta"
            onPress={() => setCustomUrlInput("https://appsbeta.mentraglass.com")}
            compact
            flexContainer={false}
            flex
          />
          <Button
            tx="developer:dev"
            onPress={() => setCustomUrlInput("https://appsdev.mentraglass.com")}
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
  backgroundColor: colors.primary_foreground,
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

const $savedSection: ThemedStyle<ViewStyle> = () => ({
  marginTop: 14,
  marginBottom: 4,
})

const $sectionLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 13,
  fontWeight: "600",
  color: colors.textDim,
  marginBottom: 8,
})

const $chipContainer: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  flexWrap: "wrap",
  gap: 8,
})

const $chip: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  borderWidth: 1,
  borderColor: colors.primary,
  borderRadius: spacing.s3,
  paddingHorizontal: 12,
  paddingVertical: 6,
})

const $chipText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.text,
})

const $chipHint: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 10,
  color: colors.textDim,
  marginTop: 6,
  fontStyle: "italic",
})
