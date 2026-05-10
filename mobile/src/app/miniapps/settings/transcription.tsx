import {useFocusEffect} from "@react-navigation/native"
import CoreModule from "@mentra/bluetooth-sdk"
import {useCallback, useEffect, useState} from "react"
import {ActivityIndicator, BackHandler, Platform, ScrollView, View} from "react-native"

import {Header, Screen, Text} from "@/components/ignite"
import LanguageSelector, {LanguageRow} from "@/components/settings/LanguageSelector"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import STTModelManager from "@/services/STTModelManager"
import TTSModelManager from "@/services/TTSModelManager"
import {useStopAll} from "@mentra/island"
import {SETTINGS, useSetting} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"

const RESTART_TRANSCRIPTION_DEBOUNCE_MS = 8000

export default function TranscriptionSettingsScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationStore.getState()

  const [sttCurrent, setSttCurrent] = useState(STTModelManager.getCurrentLanguage())
  const [sttLanguages, setSttLanguages] = useState<LanguageRow[]>([])
  const [sttDownloading, setSttDownloading] = useState<string | undefined>(undefined)
  const [sttDownloadPercent, setSttDownloadPercent] = useState(0)
  const [sttExtractPercent, setSttExtractPercent] = useState(0)

  const [ttsCurrent, setTtsCurrent] = useState(TTSModelManager.getCurrentLanguage())
  const [ttsLanguages, setTtsLanguages] = useState<LanguageRow[]>([])
  const [ttsDownloading, setTtsDownloading] = useState<string | undefined>(undefined)
  const [ttsDownloadPercent, setTtsDownloadPercent] = useState(0)
  const [ttsExtractPercent, setTtsExtractPercent] = useState(0)

  const [isLoading, setIsLoading] = useState(true)
  const [bypassVadForDebugging, setBypassVadForDebugging] = useSetting(SETTINGS.bypass_vad_for_debugging.key)
  const [_offlineCaptionsAppRunning, setOfflineCaptionsAppRunning] = useSetting(SETTINGS.offline_captions_running.key)
  const [enforceLocalTranscription, setEnforceLocalTranscription] = useSetting(SETTINGS.enforce_local_transcription.key)
  const [offlineMode, setOfflineMode] = useSetting(SETTINGS.offline_mode.key)
  const [lastRestartTime, setLastRestartTime] = useState(0)

  const stopAllApps = useStopAll()

  const _handleToggleOfflineMode = () => {
    const title = offlineMode ? "Disable Offline Mode?" : "Enable Offline Mode?"
    const message = offlineMode
      ? "Switching to online mode will close all offline-only apps and allow you to use all online apps."
      : "Enabling offline mode will close all running online apps. You'll only be able to use apps that work without an internet connection, and all other apps will be shut down."
    const confirmText = offlineMode ? "Go Online" : "Go Offline"

    showAlert(
      title,
      message,
      [
        {text: "Cancel", style: "cancel"},
        {
          text: confirmText,
          onPress: async () => {
            if (!offlineMode) {
              await stopAllApps()
            } else {
              setOfflineCaptionsAppRunning(false)
            }
            setOfflineMode(!offlineMode)
          },
        },
      ],
      {
        iconName: offlineMode ? "wifi" : "wifi-off",
        iconColor: theme.colors.icon,
      },
    )
  }

  const refreshLists = useCallback(async () => {
    const [sttInfos, ttsInfos] = await Promise.all([
      STTModelManager.getAllLanguageInfo(),
      TTSModelManager.getAllLanguageInfo(),
    ])
    setSttLanguages(
      sttInfos.map((i) => ({
        code: i.code,
        displayName: i.displayName,
        size: i.size,
        downloaded: i.downloaded,
      })),
    )
    setTtsLanguages(
      ttsInfos.map((i) => ({
        code: i.code,
        displayName: i.displayName,
        size: i.size,
        downloaded: i.downloaded,
      })),
    )
  }, [])

  const initSelected = useCallback(async () => {
    setIsLoading(true)
    try {
      const sttPref = await STTModelManager.getCurrentLanguageFromPreferences()
      if (sttPref) setSttCurrent(sttPref)
      const ttsPref = await TTSModelManager.getCurrentLanguageFromPreferences()
      if (ttsPref) setTtsCurrent(ttsPref)
      await refreshLists()
    } catch (error) {
      console.error("Error initializing transcription settings:", error)
    } finally {
      setIsLoading(false)
    }
  }, [refreshLists])

  useEffect(() => {
    initSelected()
  }, [initSelected])

  const handleCancelDownload = async () => {
    try {
      if (sttDownloading) {
        await STTModelManager.cancelDownload()
        setSttDownloading(undefined)
        setSttDownloadPercent(0)
        setSttExtractPercent(0)
      }
      if (ttsDownloading) {
        await TTSModelManager.cancelDownload()
        setTtsDownloading(undefined)
        setTtsDownloadPercent(0)
        setTtsExtractPercent(0)
      }
    } catch (error) {
      console.error("Error canceling download:", error)
    }
  }

  const handleBackPress = useCallback(() => {
    if (sttDownloading || ttsDownloading) {
      showAlert(
        "Download in Progress",
        "A language is currently downloading. Are you sure you want to cancel and go back?",
        [
          {text: "Stay", style: "cancel"},
          {
            text: "Cancel Download",
            style: "destructive",
            onPress: async () => {
              try {
                await handleCancelDownload()
              } finally {
                goBack()
              }
            },
          },
        ],
      )
      return true
    }
    return false
  }, [sttDownloading, ttsDownloading, goBack])

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === "android") {
        const handler = BackHandler.addEventListener("hardwareBackPress", handleBackPress)
        return () => handler.remove()
      }
      return undefined
    }, [handleBackPress]),
  )

  const handleGoBack = () => {
    if (!handleBackPress()) goBack()
  }

  const timeRemainingTillRestart = () => {
    const now = Date.now()
    return RESTART_TRANSCRIPTION_DEBOUNCE_MS - (now - lastRestartTime)
  }

  const activateAndRestartStt = async (code: string) => {
    setLastRestartTime(Date.now())
    await STTModelManager.activateLanguage(code)
    await CoreModule.restartTranscriber()
  }

  const handlePickStt = async (code: string) => {
    if (sttDownloading) {
      showAlert("Download in Progress", "Please wait for the current download to finish.", [
        {text: "Cancel Download", style: "destructive", onPress: handleCancelDownload},
        {text: "OK", style: "cancel"},
      ])
      return
    }

    const remaining = timeRemainingTillRestart()
    if (remaining > 0 && code !== sttCurrent) {
      showAlert(
        "Restart in progress",
        `A language change is in progress. Please wait ${Math.ceil(remaining / 1000)} seconds.`,
        [{text: "OK"}],
      )
      return
    }

    const info = await STTModelManager.getLanguageInfo(code)

    if (info.downloaded) {
      try {
        await activateAndRestartStt(code)
        // Only commit the selection once the language is actually active.
        setSttCurrent(code)
        STTModelManager.setCurrentLanguage(code)
      } catch (error: any) {
        showAlert("Error", error?.message ?? "Failed to switch language", [{text: "OK"}])
      }
      return
    }

    try {
      setSttDownloading(code)
      setSttDownloadPercent(0)
      setSttExtractPercent(0)
      await STTModelManager.downloadModel(
        code,
        (p) => setSttDownloadPercent(p.percentage),
        (p) => setSttExtractPercent(p.percentage),
      )
      await refreshLists()
      await activateAndRestartStt(code)
      // Only commit the selection once the model is on disk and active.
      setSttCurrent(code)
      STTModelManager.setCurrentLanguage(code)
      await setEnforceLocalTranscription(true)
    } catch (error: any) {
      showAlert("Download Failed", error?.message ?? "Failed to download language. Please try again.", [{text: "OK"}])
    } finally {
      setSttDownloading(undefined)
      setSttDownloadPercent(0)
      setSttExtractPercent(0)
    }
  }

  const handlePickTts = async (code: string) => {
    if (ttsDownloading) {
      showAlert("Download in Progress", "Please wait for the current download to finish.", [
        {text: "Cancel Download", style: "destructive", onPress: handleCancelDownload},
        {text: "OK", style: "cancel"},
      ])
      return
    }

    const info = await TTSModelManager.getLanguageInfo(code)

    if (info.downloaded) {
      try {
        await TTSModelManager.activateLanguage(code)
        // Only commit the selection once the language is actually active.
        setTtsCurrent(code)
        TTSModelManager.setCurrentLanguage(code)
      } catch (error: any) {
        showAlert("Error", error?.message ?? "Failed to switch voice language", [{text: "OK"}])
      }
      return
    }

    try {
      setTtsDownloading(code)
      setTtsDownloadPercent(0)
      setTtsExtractPercent(0)
      await TTSModelManager.downloadModel(
        code,
        (p) => setTtsDownloadPercent(p.percentage),
        (p) => setTtsExtractPercent(p.percentage),
      )
      await refreshLists()
      await TTSModelManager.activateLanguage(code)
      // Only commit the selection once the model is on disk and active.
      setTtsCurrent(code)
      TTSModelManager.setCurrentLanguage(code)
    } catch (error: any) {
      showAlert("Download Failed", error?.message ?? "Failed to download voice language. Please try again.", [
        {text: "OK"},
      ])
    } finally {
      setTtsDownloading(undefined)
      setTtsDownloadPercent(0)
      setTtsExtractPercent(0)
    }
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("settings:transcriptionSettings")}
        leftIcon="chevron-left"
        onLeftPress={handleGoBack}
        titleMode="flex"
        titleStyle={{textAlign: "left", paddingLeft: theme.spacing.s3}}
      />

      <ScrollView className="pt-6 px-6 -mx-6">
        <ToggleSetting
          label={translate("settings:bypassVAD")}
          subtitle={translate("settings:bypassVADSubtitle")}
          value={bypassVadForDebugging}
          onValueChange={setBypassVadForDebugging}
        />

        <Spacer height={theme.spacing.s6} />

        {isLoading ? (
          <View style={{alignItems: "center", padding: theme.spacing.s6}}>
            <ActivityIndicator size="large" color={theme.colors.foreground} />
            <Spacer height={theme.spacing.s3} />
            <Text>Checking languages…</Text>
          </View>
        ) : (
          <>
            <LanguageSelector
              title="Captions Language"
              languages={sttLanguages}
              currentLanguage={sttCurrent}
              downloadingLanguage={sttDownloading}
              downloadPercent={sttDownloadPercent}
              extractionPercent={sttExtractPercent}
              onPickLanguage={handlePickStt}
              formatBytes={(b) => STTModelManager.formatBytes(b)}
            />

            <Spacer height={theme.spacing.s6} />

            <LanguageSelector
              title="Voice Language (Text-to-Speech)"
              languages={ttsLanguages}
              currentLanguage={ttsCurrent}
              downloadingLanguage={ttsDownloading}
              downloadPercent={ttsDownloadPercent}
              extractionPercent={ttsExtractPercent}
              onPickLanguage={handlePickTts}
              formatBytes={(b) => TTSModelManager.formatBytes(b)}
            />

            <Spacer height={theme.spacing.s10} />

            <Text
              text={
                enforceLocalTranscription
                  ? "Captions are running locally on this device."
                  : "Captions will run on this device when the language model is downloaded."
              }
              style={{color: theme.colors.textDim, fontSize: 13}}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  )
}
