import {useState} from "react"
import {TextInput, View, ViewStyle, TextStyle, TouchableOpacity} from "react-native"

import {Button, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@mentra/engine"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"

interface SavedUrl {
  label: string
  url: string
}

export default function OtaVersionUrl() {
  const {theme, themed} = useAppTheme()
  const [customUrlInput, setCustomUrlInput] = useState("")
  const [isSavingUrl, setIsSavingUrl] = useState(false)
  const [otaVersionUrl, setOtaVersionUrl] = useSetting(SETTINGS.ota_version_url.key)
  const [savedUrls, setSavedUrls] = useSetting(SETTINGS.saved_ota_version_urls.key)

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

  const validateUrl = (url: string): boolean => {
    if (!url) {
      showAlert("Empty URL", "Please enter a URL or reset to default.", [{text: "OK"}])
      return false
    }

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      showAlert("Invalid URL", "Please enter a valid URL starting with http:// or https://", [{text: "OK"}])
      return false
    }

    return true
  }

  const handleBookmark = () => {
    const urlToSave = customUrlInput.trim()

    if (!validateUrl(urlToSave)) {
      return
    }

    // Check for duplicates
    if (bookmarks.some((b) => b.url === urlToSave)) {
      showAlert("Already Bookmarked", "This URL is already in your saved list.", [{text: "OK"}])
      return
    }

    const label = generateLabel(urlToSave)
    setSavedUrls([...bookmarks, {label, url: urlToSave}])
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
          setSavedUrls(bookmarks.filter((_, i) => i !== index))
        },
      },
    ])
  }

  const handleSaveUrl = async () => {
    const urlToTest = customUrlInput.trim()

    if (!validateUrl(urlToTest)) {
      return
    }

    setIsSavingUrl(true)

    try {
      // Test the URL by fetching the manifest itself
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)

      try {
        const response = await fetch(urlToTest, {
          method: "GET",
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          showAlert(
            "Verification Failed",
            `The server responded, but with status ${response.status}. Please check the URL and server status.`,
            [{text: "OK"}],
          )
          return
        }

        const data = await response.json()
        if (!data || typeof data !== "object") {
          showAlert("Verification Failed", "The URL did not return a JSON manifest.", [{text: "OK"}])
          return
        }

        await setOtaVersionUrl(urlToTest)
        showAlert("Success", "Custom OTA manifest URL saved. Future OTA checks and installs will use it.", [
          {text: "OK"},
        ])
      } catch (fetchError: unknown) {
        clearTimeout(timeoutId)
        throw fetchError
      }
    } catch (error: unknown) {
      console.error("OTA URL test failed:", error instanceof Error ? error.message : "Unknown error")

      let errorMessage = "Could not load the OTA manifest. Please check the URL and your network connection."
      if (error instanceof Error && error.name === "AbortError") {
        errorMessage = "Connection timed out. Please check the URL and server status."
      }

      showAlert("Verification Failed", errorMessage, [{text: "OK"}])
    } finally {
      setIsSavingUrl(false)
    }
  }

  const handleResetUrl = async () => {
    await setOtaVersionUrl(null)
    setCustomUrlInput("")
    showAlert("Success", "Reset OTA manifest URL to default.", [{text: "OK"}])
  }

  return (
    <GlassView className="bg-primary-foreground rounded-2xl" style={themed($container)}>
      <View style={themed($textContainer)}>
        <Text style={themed($label)}>Custom OTA Manifest URL</Text>
        <Text style={themed($subtitle)}>
          Override the OTA manifest URL this app drives (default: this build's pinned manifest). Leave blank to use
          default.
          {otaVersionUrl && `\nCurrently using: ${otaVersionUrl}`}
        </Text>
        <TextInput
          style={themed($urlInput)}
          placeholder="e.g., http://192.168.1.100:8000/live_version.json"
          placeholderTextColor={theme.colors.textDim}
          value={customUrlInput}
          onChangeText={setCustomUrlInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!isSavingUrl}
        />
        <View style={themed($buttonRow)}>
          <Button
            text={isSavingUrl ? "Testing..." : "Save & Test URL"}
            onPress={handleSaveUrl}
            disabled={isSavingUrl}
            preset="alternate"
            flexContainer={false}
          />
          <Button
            tx="common:reset"
            onPress={handleResetUrl}
            disabled={isSavingUrl}
            preset="alternate"
            flexContainer={false}
          />
          <Button
            text="☆ Bookmark"
            onPress={handleBookmark}
            disabled={isSavingUrl}
            preset="alternate"
            flexContainer={false}
          />
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
      </View>
    </GlassView>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
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
