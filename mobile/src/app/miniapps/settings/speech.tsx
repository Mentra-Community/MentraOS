import {useFocusEffect} from "@react-navigation/native"
import {useCallback, useEffect, useRef, useState} from "react"
import {ActivityIndicator, BackHandler, Platform, ScrollView, View} from "react-native"

import {Header, Screen, Text} from "@/components/ignite"
import LanguageSelector, {LanguageRow} from "@/components/settings/LanguageSelector"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {useStopAll, SETTINGS, useSetting} from "@mentra/engine"
import {
  offlineSpeechModelService,
  sttModelManager as STTModelManager,
  ttsModelManager as TTSModelManager,
  wakeWordModelManager as WakeWordModelManager,
  type OfflineModelDownloadStatus as DownloadStatus,
} from "@mentra/engine-host-internal"
import showAlert from "@/utils/AlertUtils"

export default function SpeechSettingsScreen() {
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

  const [wakeWordRows, setWakeWordRows] = useState<LanguageRow[]>([])

  // Download status from the Speech-page download system, per model kind: the
  // startup download, a miniapp that needed a missing model, or a tap here.
  // Falls back to per-screen state below when the user kicks a download manually via tap.
  const [autoStatuses, setAutoStatuses] = useState<Partial<Record<DownloadStatus["kind"], DownloadStatus>>>(() => {
    const status = offlineSpeechModelService.getStatus()
    return status ? {[status.kind]: status} : {}
  })

  const [isLoading, setIsLoading] = useState(true)
  const [_enforceLocalTranscription, setEnforceLocalTranscription] = useSetting(
    SETTINGS.enforce_local_transcription.key,
  )
  const [offlineMode, setOfflineMode] = useSetting(SETTINGS.offline_mode.key)

  // Tracks the most-recently requested language per kind. The background
  // activation runs serialized via the chain ref; when the user taps another
  // language mid-flight, the new tap is queued behind the in-flight one and
  // only the final tap's selection sticks.
  const sttDesiredRef = useRef<string | null>(null)
  const ttsDesiredRef = useRef<string | null>(null)
  const sttChainRef = useRef<Promise<void>>(Promise.resolve())
  const ttsChainRef = useRef<Promise<void>>(Promise.resolve())

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
    const [sttInfos, ttsInfos, wakeWordInfo] = await Promise.all([
      STTModelManager.getAllLanguageInfo(),
      TTSModelManager.getAllLanguageInfo(),
      WakeWordModelManager.getInfo(),
    ])
    setWakeWordRows([wakeWordInfo])
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
      console.error("Error initializing speech settings:", error)
    } finally {
      setIsLoading(false)
    }
  }, [refreshLists])

  useEffect(() => {
    initSelected()
  }, [initSelected])

  useEffect(() => {
    return offlineSpeechModelService.subscribe((status) => {
      if (status) setAutoStatuses((current) => ({...current, [status.kind]: status}))
    })
  }, [])

  // When a background download completes, refresh the rows so the
  // downloaded flag/icon updates without needing to leave + re-enter the screen.
  const sttStatus = autoStatuses.stt
  const ttsStatus = autoStatuses.tts
  const wakeWordStatus = autoStatuses.wakeword
  useEffect(() => {
    if (sttStatus?.stage === "complete" || sttStatus?.stage === "failed") {
      void refreshLists()
      setSttCurrent(STTModelManager.getCurrentLanguage())
    }
  }, [sttStatus?.stage, sttStatus?.languageCode, refreshLists])
  useEffect(() => {
    if (ttsStatus?.stage === "complete" || ttsStatus?.stage === "failed") {
      void refreshLists()
      setTtsCurrent(TTSModelManager.getCurrentLanguage())
    }
  }, [ttsStatus?.stage, ttsStatus?.languageCode, refreshLists])
  useEffect(() => {
    if (wakeWordStatus?.stage === "complete" || wakeWordStatus?.stage === "failed") void refreshLists()
  }, [wakeWordStatus?.stage, refreshLists])

  const inProgress = (status?: DownloadStatus) =>
    status?.stage === "downloading" || status?.stage === "extracting" ? status : undefined
  const progressFor = (status: DownloadStatus | undefined, stage: DownloadStatus["stage"]) =>
    status?.stage === stage ? status.percent : 0

  // Merge download status with the manually-driven per-screen state. Manual
  // tap state wins when set (user is in control); otherwise surface the
  // download system's progress on the matching row.
  const sttAuto = inProgress(sttStatus)
  const ttsAuto = inProgress(ttsStatus)
  const wakeWordAuto = inProgress(wakeWordStatus)
  const sttRowDownloading = sttDownloading ?? sttAuto?.languageCode
  const sttRowDownloadPercent = sttDownloading ? sttDownloadPercent : progressFor(sttAuto, "downloading")
  const sttRowExtractPercent = sttDownloading ? sttExtractPercent : progressFor(sttAuto, "extracting")
  const ttsRowDownloading = ttsDownloading ?? ttsAuto?.languageCode
  const ttsRowDownloadPercent = ttsDownloading ? ttsDownloadPercent : progressFor(ttsAuto, "downloading")
  const ttsRowExtractPercent = ttsDownloading ? ttsExtractPercent : progressFor(ttsAuto, "extracting")

  const handleCancelDownload = async () => {
    try {
      if (sttDownloading) {
        await STTModelManager.cancelDownload(sttDownloading)
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

  const handlePickStt = async (code: string) => {
    if (sttDownloading || sttAuto) {
      showAlert("Download in Progress", "Please wait for the current download to finish.", [
        {text: "OK", style: "cancel"},
      ])
      return
    }

    const info = await STTModelManager.getLanguageInfo(code)

    if (info.downloaded) {
      // Optimistic: commit the UI selection immediately, then activate in the
      // background; on-device transcription that is running reloads the new
      // model itself. Subsequent taps queue behind the in-flight call so the
      // last tap wins.
      setSttCurrent(code)
      sttDesiredRef.current = code

      sttChainRef.current = sttChainRef.current
        .catch(() => undefined)
        .then(async () => {
          const target = sttDesiredRef.current
          if (target == null) return
          try {
            await STTModelManager.activateLanguage(target)
          } catch (error: any) {
            const actual = await STTModelManager.getCurrentLanguageFromPreferences()
            setSttCurrent(actual || STTModelManager.getCurrentLanguage())
            console.error("STT activation failed:", error)
            showAlert("Error", error?.message ?? "Failed to switch language", [{text: "OK"}])
          }
        })
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
      await STTModelManager.activateLanguage(code)
      setSttCurrent(code)
      sttDesiredRef.current = code
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
    if (ttsDownloading || ttsAuto) {
      showAlert("Download in Progress", "Please wait for the current download to finish.", [
        {text: "OK", style: "cancel"},
      ])
      return
    }

    const info = await TTSModelManager.getLanguageInfo(code)

    if (info.downloaded) {
      // Optimistic: same pattern as STT.
      setTtsCurrent(code)
      TTSModelManager.setCurrentLanguage(code)
      ttsDesiredRef.current = code

      ttsChainRef.current = ttsChainRef.current
        .catch(() => undefined)
        .then(async () => {
          const target = ttsDesiredRef.current
          if (target == null) return
          try {
            await TTSModelManager.activateLanguage(target)
          } catch (error: any) {
            console.error("TTS activation failed:", error)
            showAlert("Error", error?.message ?? "Failed to switch voice language", [{text: "OK"}])
          }
        })
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
      setTtsCurrent(code)
      TTSModelManager.setCurrentLanguage(code)
      ttsDesiredRef.current = code
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

  const handlePickWakeWord = async () => {
    if (wakeWordAuto) return
    const info = await WakeWordModelManager.getInfo()
    if (!info.downloaded) {
      try {
        await offlineSpeechModelService.downloadWakeWordModel()
      } catch (error: any) {
        showAlert(
          translate("settings:speechModelDownloadFailed"),
          error?.message ?? translate("settings:wakeWordModelDownloadFailedMessage"),
          [{text: translate("common:ok")}],
        )
      } finally {
        void refreshLists()
      }
      return
    }
    showAlert(translate("settings:wakeWordModelDeleteTitle"), translate("settings:wakeWordModelDeleteMessage"), [
      {text: translate("common:cancel"), style: "cancel"},
      {
        text: translate("common:delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await WakeWordModelManager.deleteModel()
          } finally {
            void refreshLists()
          }
        },
      },
    ])
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("settings:speechSettings")}
        leftIcon="chevron-left"
        onLeftPress={handleGoBack}
        titleMode="flex"
        titleStyle={{textAlign: "left", paddingLeft: theme.spacing.s3}}
      />

      <ScrollView className="pt-6 px-6 -mx-6">
        {isLoading ? (
          <View style={{alignItems: "center", padding: theme.spacing.s6}}>
            <ActivityIndicator size="large" color={theme.colors.foreground} />
            <Spacer height={theme.spacing.s3} />
            <Text>Checking languages…</Text>
          </View>
        ) : (
          <>
            <LanguageSelector
              title={translate("settings:speechToTextLanguage")}
              languages={sttLanguages}
              currentLanguage={sttCurrent}
              downloadingLanguage={sttRowDownloading}
              downloadPercent={sttRowDownloadPercent}
              extractionPercent={sttRowExtractPercent}
              onPickLanguage={handlePickStt}
              formatBytes={(b) => STTModelManager.formatBytes(b)}
            />

            <Spacer height={theme.spacing.s6} />

            <LanguageSelector
              title="Voice Language (Text-to-Speech)"
              languages={ttsLanguages}
              currentLanguage={ttsCurrent}
              downloadingLanguage={ttsRowDownloading}
              downloadPercent={ttsRowDownloadPercent}
              extractionPercent={ttsRowExtractPercent}
              onPickLanguage={handlePickTts}
              formatBytes={(b) => TTSModelManager.formatBytes(b)}
            />

            <Spacer height={theme.spacing.s6} />

            <LanguageSelector
              title={translate("settings:wakeWordModel")}
              languages={wakeWordRows}
              currentLanguage=""
              downloadingLanguage={wakeWordAuto?.languageCode}
              downloadPercent={progressFor(wakeWordAuto, "downloading")}
              extractionPercent={progressFor(wakeWordAuto, "extracting")}
              onPickLanguage={handlePickWakeWord}
              formatBytes={(b) => STTModelManager.formatBytes(b)}
              downloadedHint={translate("settings:wakeWordModelDownloadedHint")}
            />

            <Spacer height={theme.spacing.s10} />
          </>
        )}
      </ScrollView>
    </Screen>
  )
}
