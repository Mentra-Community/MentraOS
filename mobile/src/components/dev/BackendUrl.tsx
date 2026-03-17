import {useState} from "react"
import {TextInput, View, ViewStyle, TextStyle, TouchableOpacity} from "react-native"

import {Button, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mantle from "@/services/MantleManager"

interface SavedUrl {
  label: string
  url: string
}

export default function BackendUrl() {
  const {theme, themed} = useAppTheme()
  const {replaceAll} = useNavigationHistory()
  const [customUrlInput, setCustomUrlInput] = useState("")
  const [isSavingUrl, setIsSavingUrl] = useState(false)
  const [backendUrl, setBackendUrl] = useSetting(SETTINGS.backend_url.key)
  const [savedUrls, setSavedUrls] = useSetting(SETTINGS.saved_backend_urls.key)

  // Triple-tap detection for Asia East button
  const [asiaButtonTapCount, setAsiaButtonTapCount] = useState(0)
  const [asiaButtonLastTapTime, setAsiaButtonLastTapTime] = useState(0)

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

    setIsSavingUrl(true)

    try {
      // Test the URL by fetching the version endpoint
      const testUrl = `${urlToTest}/apps/version`
      console.log(`Testing URL: ${testUrl}`)

      // Create an AbortController for timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)

      try {
        const response = await fetch(testUrl, {
          method: "GET",
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (response.ok) {
          const data = await response.json()
          console.log("URL Test Successful:", data)

          await setBackendUrl(urlToTest)

          await showAlert(
            "Success",
            "Custom backend URL saved and verified. It will be used on the next connection attempt or app restart.",
            [
              {
                text: translate("common:ok"),
                onPress: async () => {
                  await mantle.cleanup()
                  replaceAll("/")
                },
              },
            ],
          )
        } else {
          console.error(`URL Test Failed: Status ${response.status}`)
          showAlert(
            "Verification Failed",
            `The server responded, but with status ${response.status}. Please check the URL and server status.`,
            [{text: "OK"}],
          )
        }
      } catch (fetchError: unknown) {
        clearTimeout(timeoutId)
        throw fetchError
      }
    } catch (error: unknown) {
      console.error("URL Test Failed:", error instanceof Error ? error.message : "Unknown error")

      let errorMessage = "Could not connect to the specified URL. Please check the URL and your network connection."

      if (error instanceof Error && error.name === "AbortError") {
        errorMessage = "Connection timed out. Please check the URL and server status."
      } else if (error instanceof TypeError && error.message.includes("fetch")) {
        errorMessage = "Network error occurred. Please check your internet connection and the URL."
      }

      showAlert("Verification Failed", errorMessage, [{text: "OK"}])
    } finally {
      setIsSavingUrl(false)
    }
  }

  const handleResetUrl = async () => {
    setBackendUrl(null)
    setCustomUrlInput("")
    showAlert("Success", "Reset backend URL to default.", [
      {
        text: "OK",
        onPress: () => {
          replaceAll("/")
        },
      },
    ])
  }

  const handleAsiaButtonPress = () => {
    const currentTime = Date.now()
    const timeDiff = currentTime - asiaButtonLastTapTime

    if (timeDiff > 2000) {
      setAsiaButtonTapCount(1)
    } else {
      setAsiaButtonTapCount((prev) => prev + 1)
    }

    setAsiaButtonLastTapTime(currentTime)

    if (asiaButtonTapCount + 1 >= 3) {
      setCustomUrlInput("https://devold.augmentos.org:443")
    } else {
      setCustomUrlInput("https://asiaeastapi.mentra.glass:443")
    }
  }

  return (
    <View style={themed($container)}>
      <View style={themed($textContainer)}>
        <Text style={themed($label)}>Custom Backend URL</Text>
        <Text style={themed($subtitle)}>
          Override the default backend server URL. Leave blank to use default.
          {backendUrl && `\nCurrently using: ${backendUrl}`}
        </Text>
        <TextInput
          style={themed($urlInput)}
          placeholder="e.g., http://192.168.1.100:7002"
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

        {/* Environment presets */}
        <View style={themed($buttonColumn)}>
          <Button
            tx="developer:global"
            onPress={() => setCustomUrlInput("https://api.mentra.glass:443")}
            compact
            flex
            flexContainer={false}
          />
          <Button
            tx="developer:dev"
            onPress={() => setCustomUrlInput("https://devapi.mentra.glass:443")}
            compact
            flexContainer={false}
            flex
          />
        </View>
        <View style={themed($buttonColumn)}>
          <Button
            compact
            tx="developer:debug"
            onPress={() => setCustomUrlInput("https://debug.augmentos.cloud:443")}
            flexContainer={false}
            flex
          />
          <Button
            compact
            tx="developer:usCentral"
            onPress={() => setCustomUrlInput("https://uscentralapi.mentra.glass:443")}
            flexContainer={false}
            flex
          />
        </View>
        <View style={themed($buttonColumn)}>
          <Button
            compact
            tx="developer:france"
            onPress={() => setCustomUrlInput("https://franceapi.mentra.glass:443")}
            flexContainer={false}
            flex
          />
          <Button compact tx="developer:asiaEast" onPress={handleAsiaButtonPress} flexContainer={false} flex />
        </View>
        <View style={themed($buttonColumn)}>
          <Button
            compact
            tx="developer:staging"
            onPress={() => setCustomUrlInput("https://stagingapi.mentraglass.com:443")}
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
