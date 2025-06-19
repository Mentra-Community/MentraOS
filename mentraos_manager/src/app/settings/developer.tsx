import React, {useState, useEffect} from "react"
import {View, Text, StyleSheet, Switch, TouchableOpacity, Platform, ScrollView, TextInput} from "react-native"
import Icon from "react-native-vector-icons/MaterialCommunityIcons"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import coreCommunicator from "@/bridge/CoreCommunicator"
import {saveSetting, loadSetting} from "@/utils/SettingsHelper"
import {SETTINGS_KEYS} from "@/consts"
import axios from "axios"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"
import {Header, Screen, PillButton} from "@/components/ignite"
import {router} from "expo-router"
import {Spacer} from "@/components/misc/Spacer"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {translate} from "@/i18n"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {spacing} from "@/theme"

export default function DeveloperSettingsScreen() {
  const {status} = useStatus()
  const [isBypassVADForDebuggingEnabled, setIsBypassVADForDebuggingEnabled] = useState(
    status.core_info.bypass_vad_for_debugging,
  )
  const [isBypassAudioEncodingForDebuggingEnabled, setIsBypassAudioEncodingForDebuggingEnabled] = useState(
    status.core_info.bypass_audio_encoding_for_debugging,
  )
  const [isTestFlightOrDev, setIsTestFlightOrDev] = useState<boolean>(false)

  const {theme} = useAppTheme()
  const {goBack, push} = useNavigationHistory()
  // State for custom URL management
  const [customUrlInput, setCustomUrlInput] = useState("")
  const [savedCustomUrl, setSavedCustomUrl] = useState<string | null>(null)
  const [isSavingUrl, setIsSavingUrl] = useState(false) // Add loading state
  const [reconnectOnAppForeground, setReconnectOnAppForeground] = useState(true)

  // Load saved URL on mount
  useEffect(() => {
    const loadSettings = async () => {
      const url = await loadSetting(SETTINGS_KEYS.CUSTOM_BACKEND_URL, null)
      setSavedCustomUrl(url)
      setCustomUrlInput(url || "")

      const reconnectOnAppForeground = await loadSetting(SETTINGS_KEYS.RECONNECT_ON_APP_FOREGROUND, true)
      setReconnectOnAppForeground(reconnectOnAppForeground)
    }
    loadSettings()
  }, [])

  useEffect(() => {
    setIsBypassVADForDebuggingEnabled(status.core_info.bypass_vad_for_debugging)
  }, [status.core_info.bypass_vad_for_debugging])

  const toggleBypassVadForDebugging = async () => {
    const newSetting = !isBypassVADForDebuggingEnabled
    await coreCommunicator.sendToggleBypassVadForDebugging(newSetting)
    setIsBypassVADForDebuggingEnabled(newSetting)
  }

  const toggleReconnectOnAppForeground = async () => {
    const newSetting = !reconnectOnAppForeground
    await saveSetting(SETTINGS_KEYS.RECONNECT_ON_APP_FOREGROUND, newSetting)
    setReconnectOnAppForeground(newSetting)
  }

  const toggleBypassAudioEncodingForDebugging = async () => {
    const newSetting = !isBypassAudioEncodingForDebuggingEnabled
    await coreCommunicator.sendToggleBypassAudioEncodingForDebugging(newSetting)
    setIsBypassAudioEncodingForDebuggingEnabled(newSetting)
  }

  // Modified handler for Custom URL
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

    setIsSavingUrl(true) // Start loading indicator

    try {
      // Test the URL by fetching the version endpoint
      const testUrl = `${urlToTest}/apps/version`
      console.log(`Testing URL: ${testUrl}`)
      const response = await axios.get(testUrl, {timeout: 5000})

      // Check if the request was successful (status 200-299)
      if (response.status >= 200 && response.status < 300) {
        console.log("URL Test Successful:", response.data)
        // Save the URL if the test passes
        await saveSetting(SETTINGS_KEYS.CUSTOM_BACKEND_URL, urlToTest)
        await coreCommunicator.setServerUrl(urlToTest)
        setSavedCustomUrl(urlToTest)
        showAlert(
          "Success",
          "Custom backend URL saved and verified. It will be used on the next connection attempt or app restart.",
          [{text: "OK"}],
        )
      } else {
        // Handle non-2xx responses as errors
        console.error(`URL Test Failed: Status ${response.status}`)
        showAlert(
          "Verification Failed",
          `The server responded, but with status ${response.status}. Please check the URL and server status.`,
          [{text: "OK"}],
        )
      }
    } catch (error: unknown) {
      // Handle network errors or timeouts
      console.error("URL Test Failed:", error instanceof Error ? error.message : "Unknown error")
      let errorMessage = "Could not connect to the specified URL. Please check the URL and your network connection."

      // Type guard for axios error with code property
      if (error && typeof error === "object" && "code" in error && error.code === "ECONNABORTED") {
        errorMessage = "Connection timed out. Please check the URL and server status."
      }
      // Type guard for axios error with response property
      else if (
        error &&
        typeof error === "object" &&
        "response" in error &&
        error.response &&
        typeof error.response === "object" &&
        "status" in error.response
      ) {
        // Server responded with an error status code (4xx, 5xx)
        errorMessage = `Server responded with error ${error.response.status}. Please check the URL and server status.`
      }

      showAlert("Verification Failed", errorMessage, [{text: "OK"}])
    } finally {
      setIsSavingUrl(false) // Stop loading indicator
    }
  }

  const handleResetUrl = async () => {
    await saveSetting(SETTINGS_KEYS.CUSTOM_BACKEND_URL, null)
    setSavedCustomUrl(null)
    setCustomUrlInput("")
    showAlert("Success", "Backend URL reset to default.", [{text: "OK"}])
  }

  const switchColors = {
    trackColor: {
      false: theme.colors.switchTrackOff,
      true: theme.colors.switchTrackOn,
    },
    thumbColor: Platform.OS === "ios" ? undefined : theme.colors.switchThumb,
    ios_backgroundColor: theme.colors.switchTrackOff,
  }

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.md}}>
      <Header title="Developer Settings" leftIcon="caretLeft" onLeftPress={() => goBack()} />

      <View style={[styles.warningContainer, {backgroundColor: theme.colors.warningBackgroundDestructive}]}>
        <View style={styles.warningContent}>
          <Icon name="alert" size={16} color={theme.colors.text} />
          <Text style={[styles.warningTitle, {color: theme.colors.text}]}>Warning</Text>
        </View>
        <Text style={[styles.warningSubtitle, {color: theme.colors.text}]}>
          These may break the app. Use at your own risk.
        </Text>
      </View>

      <Spacer height={theme.spacing.md} />

      <ScrollView>
        <ToggleSetting
          label={translate("settings:bypassVAD")}
          subtitle={translate("settings:bypassVADSubtitle")}
          value={isBypassVADForDebuggingEnabled}
          onValueChange={toggleBypassVadForDebugging}
        />

        <Spacer height={theme.spacing.md} />

        <ToggleSetting
          label={translate("settings:reconnectOnAppForeground")}
          subtitle={translate("settings:reconnectOnAppForegroundSubtitle")}
          value={reconnectOnAppForeground}
          onValueChange={toggleReconnectOnAppForeground}
        />

        <Spacer height={theme.spacing.md} />

        <View style={[styles.settingContainer, {backgroundColor: theme.colors.background}]}>
          <View style={styles.settingTextContainer}>
            <Text style={[styles.label, {color: theme.colors.text}]}>Custom Backend URL</Text>
            <Text style={[styles.value, {color: theme.colors.textDim}]}>
              Override the default backend server URL. Leave blank to use default.
              {savedCustomUrl && `\nCurrently using: ${savedCustomUrl}`}
            </Text>
            <TextInput
              style={[
                styles.urlInput,
                {
                  backgroundColor: theme.colors.background,
                  borderColor: theme.colors.inputBorderHighlight,
                  color: theme.colors.text,
                },
              ]}
              placeholder="e.g., http://192.168.1.100:7002"
              placeholderTextColor={theme.colors.textDim}
              value={customUrlInput}
              onChangeText={setCustomUrlInput}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!isSavingUrl}
            />
            <View style={styles.buttonRow}>
              <PillButton
                text={isSavingUrl ? "Testing..." : "Save & Test URL"}
                variant="primary"
                onPress={handleSaveUrl}
                disabled={isSavingUrl}
                buttonStyle={styles.saveButton}
              />
              <PillButton
                text="Reset"
                variant="secondary"
                onPress={handleResetUrl}
                disabled={isSavingUrl}
                buttonStyle={styles.resetButton}
              />
            </View>
            <View style={styles.buttonColumn}>
              <PillButton
                text="Production"
                variant="secondary"
                onPress={() => setCustomUrlInput("https://prod.mentra.glass:443")}
                buttonStyle={styles.button}
              />
              <PillButton
                text="Debug"
                variant="secondary"
                onPress={() => setCustomUrlInput("https://debug.mentra.glass:443")}
                buttonStyle={styles.button}
              />
              <PillButton
                text="Global"
                variant="secondary"
                onPress={() => setCustomUrlInput("https://global.mentra.glass:443")}
                buttonStyle={styles.button}
              />
            </View>
            <View style={styles.buttonColumnCentered}>
              <PillButton
                text="Dev Nicolo"
                variant="secondary"
                onPress={() => setCustomUrlInput("https://dev.mentra.glass:443")}
                buttonStyle={styles.button}
              />
              <PillButton
                text="Dev Cloud"
                variant="secondary"
                onPress={() => setCustomUrlInput("https://dev.mentra.glass:443")}
                buttonStyle={styles.button}
              />
            </View>
          </View>
        </View>

        {isTestFlightOrDev && <Spacer height={theme.spacing.md} />}

        {/* Bypass Audio Encoding for Debugging Toggle
        <View style={styles.settingItem}>
          <View style={styles.settingTextContainer}>
            <Text
              style={[
                styles.label,
                isDarkTheme ? styles.lightText : styles.darkText
              ]}>
              Bypass Audio Encoding for Debugging
            </Text>
            <Text
              style={[
                styles.value,
                isDarkTheme ? styles.lightSubtext : styles.darkSubtext
              ]}>
              Bypass audio encoding processing for debugging purposes.
            </Text>
          </View>
          <Switch
            value={isBypassAudioEncodingForDebuggingEnabled}
            onValueChange={toggleBypassAudioEncodingForDebugging}
            trackColor={switchColors.trackColor}
            thumbColor={switchColors.thumbColor}
            ios_backgroundColor={switchColors.ios_backgroundColor}
          />
        </View> */}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  warningContainer: {
    borderRadius: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  warningContent: {
    alignItems: "center",
    flexDirection: "row",
    marginBottom: 4,
  },
  warningTitle: {
    fontSize: 16,
    fontWeight: "bold",
    marginLeft: 6,
  },
  warningSubtitle: {
    fontSize: 14,
    marginLeft: 22,
  },
  settingContainer: {
    borderRadius: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  button: {
    flexShrink: 1,
  },
  buttonColumn: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    marginTop: 12,
  },
  buttonColumnCentered: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "center",
    marginTop: 12,
  },
  settingTextContainer: {
    flex: 1,
  },
  label: {
    flexWrap: "wrap",
    fontSize: 16,
  },
  value: {
    flexWrap: "wrap",
    fontSize: 12,
    marginTop: 5,
  },
  // New styles for custom URL section
  urlInput: {
    borderWidth: 1,
    borderRadius: 12, // Consistent border radius
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginTop: 10,
    marginBottom: 10,
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },
  saveButton: {
    flex: 1,
    marginRight: 10,
  },
  resetButton: {
    flex: 1,
  },
})
