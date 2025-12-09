import {useFocusEffect} from "@react-navigation/native"
import CoreModule from "core"
import {useCallback, useEffect, useState} from "react"
import {ActivityIndicator, BackHandler, Platform, ScrollView, View} from "react-native"

import {Header, Screen, Text} from "@/components/ignite"
import ModelSelector from "@/components/settings/ModelSelector"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import STTModelManager from "@/services/STTModelManager"
import {useStopAllApplets} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"
import {$styles} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"

export default function TranscriptionSettingsScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationHistory()

  const [selectedModelId, setSelectedModelId] = useState(STTModelManager.getCurrentModelId())
  const [modelInfo, setModelInfo] = useState<any>(null)
  const [allModels, setAllModels] = useState<any[]>([])
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [extractionProgress, setExtractionProgress] = useState(0)
  const [isCheckingModel, setIsCheckingModel] = useState(true)
  const [bypassVadForDebugging, setBypassVadForDebugging] = useSetting(SETTINGS.bypass_vad_for_debugging.key)
  const [offlineMode, setOfflineMode] = useSetting(SETTINGS.offline_mode.key)
  const [_offlineCaptionsAppRunning, setOfflineCaptionsAppRunning] = useSetting(SETTINGS.offline_captions_running.key)
  const [enforceLocalTranscription, setEnforceLocalTranscription] = useSetting(SETTINGS.enforce_local_transcription.key)
  const RESTART_TRANSCRIPTION_DEBOUNCE_MS = 8000 // 8 seconds
  const [lastRestartTime, setLastRestartTime] = useState(0)

  const stopAllApps = useStopAllApplets()

  const handleToggleOfflineMode = () => {
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
              // If enabling offline mode, stop all running apps
              await stopAllApps()
            } else {
              // If disabling offline mode, turn off offline captions
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

  // Cancel download function
  const handleCancelDownload = async () => {
    try {
      await STTModelManager.cancelDownload()
      setIsDownloading(false)
      setDownloadProgress(0)
      setExtractionProgress(0)
    } catch (error) {
      console.error("Error canceling download:", error)
    }
  }

  // Handle back navigation blocking during downloads
  const handleBackPress = useCallback(() => {
    if (isDownloading) {
      showAlert(
        "Download in Progress",
        "A model is currently downloading. Are you sure you want to cancel and go back?",
        [
          {text: "Stay", style: "cancel"},
          {
            text: "Cancel Download",
            style: "destructive",
            onPress: async () => {
              try {
                await handleCancelDownload()
                goBack()
              } catch (error) {
                console.error("Error canceling download:", error)
                goBack() // Go back anyway if cancel fails
              }
            },
          },
        ],
      )
      return true // Prevent default back action
    }
    return false // Allow default back action
  }, [isDownloading, goBack, handleCancelDownload])

  // Block hardware back button on Android during downloads
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === "android") {
        const backHandler = BackHandler.addEventListener("hardwareBackPress", handleBackPress)
        return () => backHandler.remove()
      }
    }, [handleBackPress]),
  )

  // Custom goBack function that respects download state
  const handleGoBack = () => {
    const shouldBlock = handleBackPress()
    if (!shouldBlock) {
      goBack()
    }
  }

  const enableEnforceLocalTranscription = async () => {
    await setEnforceLocalTranscription(true)
  }

  const timeRemainingTillRestart = () => {
    const now = Date.now()
    const timeRemaining = RESTART_TRANSCRIPTION_DEBOUNCE_MS - (now - lastRestartTime)
    return timeRemaining
  }

  const activateModelandRestartTranscription = async (modelId: string): Promise<void> => {
    const now = Date.now()
    setLastRestartTime(now)
    await STTModelManager.activateModel(modelId)
    await CoreModule.restartTranscriber()
  }

  const handleModelChange = async (modelId: string) => {
    const timeRemaining = timeRemainingTillRestart()

    if (isDownloading) {
      // Also add cancel download button
      showAlert(
        "Download in Progress",
        "A model is currently downloading. Please wait before switching to another model",
        [
          {text: "Cancel Download", style: "destructive", onPress: handleCancelDownload},
          {text: "OK", style: "cancel"},
        ],
      )
      return
    }

    if (timeRemaining > 0) {
      showAlert(
        "Restart already in progress",
        "A model change is in progress. Please wait " +
          Math.ceil(timeRemaining / 1000) +
          " seconds before switching to another model",
        [{text: "OK"}],
      )
      return
    }
    const info = await STTModelManager.getModelInfo(modelId)
    setSelectedModelId(modelId)
    STTModelManager.setCurrentModelId(modelId)
    setModelInfo(info)

    if (info.downloaded) {
      try {
        await activateModelandRestartTranscription(modelId)
        showAlert("Restarted Transcription", "Switched to new model", [{text: "OK"}])
      } catch (error: any) {
        showAlert("Error", error.message || "Failed to activate model", [{text: "OK"}])
      }
    }
  }

  const handleDownloadModel = async (modelId?: string) => {
    const targetModelId = modelId || selectedModelId
    try {
      setIsDownloading(true)
      setDownloadProgress(0)
      setExtractionProgress(0)

      await STTModelManager.downloadModel(
        targetModelId,
        progress => {
          setDownloadProgress(progress.percentage)
        },
        progress => {
          setExtractionProgress(progress.percentage)
        },
      )

      // Re-check model status after download
      await checkModelStatus()

      await activateModelandRestartTranscription(targetModelId)

      await enableEnforceLocalTranscription()

      showAlert("Success", "Speech recognition model downloaded successfully!", [{text: "OK"}])
    } catch (error: any) {
      showAlert("Download Failed", error.message || "Failed to download the model. Please try again.", [{text: "OK"}])
    } finally {
      setIsDownloading(false)
      setDownloadProgress(0)
      setExtractionProgress(0)
    }
  }

  const handleDeleteModel = async (modelId?: string) => {
    const targetModelId = modelId || selectedModelId
    showAlert(
      "Delete Model",
      "Are you sure you want to delete the speech recognition model? You'll need to download it again to use local transcription.",
      [
        {text: "Cancel", style: "cancel"},
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await STTModelManager.deleteModel(targetModelId)
              await checkModelStatus()

              // If local transcription is enabled, disable it
              if (enforceLocalTranscription) {
                await setEnforceLocalTranscription(false)
              }
            } catch (error: any) {
              showAlert("Error", error.message || "Failed to delete model", [{text: "OK"}])
            }
          },
        },
      ],
    )
  }

  const initSelectedModel = async () => {
    const modelId = await STTModelManager.getCurrentModelIdFromPreferences()
    if (modelId) {
      setSelectedModelId(modelId)
    }
    checkModelStatus(modelId)
  }

  const checkModelStatus = async (modelId?: string) => {
    setIsCheckingModel(true)
    try {
      const info = await STTModelManager.getModelInfo(modelId || selectedModelId)
      setModelInfo(info)
      const models = await STTModelManager.getAllModelsInfo()
      setAllModels(models)
    } catch (error) {
      console.error("Error checking model status:", error)
    } finally {
      setIsCheckingModel(false)
    }
  }

  useEffect(() => {
    initSelectedModel()
  }, [])

  useEffect(() => {
    const subscription = CoreModule.addListener("CoreMessageEvent", (_event: any) => {
      // console.log("CoreMessageEvent:", event)
      // let _type = event.body.type
      // if (type === "") {
      // }
    })
    return () => subscription.remove()
  }, [])

  return (
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Header
        title={translate("settings:transcriptionSettings")}
        leftIcon="chevron-left"
        onLeftPress={handleGoBack}
        titleMode="flex"
        titleStyle={{textAlign: "left", paddingLeft: theme.spacing.s3}}
      />

      <ScrollView>
        <Spacer height={theme.spacing.s4} />

        <ToggleSetting
          label={translate("settings:bypassVAD")}
          subtitle={translate("settings:bypassVADSubtitle")}
          value={bypassVadForDebugging}
          onValueChange={setBypassVadForDebugging}
        />

        <Spacer height={theme.spacing.s4} />

        <ToggleSetting
          label={"Offline Mode"}
          subtitle={"Toggle Offline mode. Offline Apps don't need internet to run."}
          value={offlineMode}
          onValueChange={handleToggleOfflineMode}
        />

        {
          <>
            <Spacer height={theme.spacing.s4} />

            {isCheckingModel ? (
              <View style={{alignItems: "center", padding: theme.spacing.s6}}>
                <ActivityIndicator size="large" color={theme.colors.text} />
                <Spacer height={theme.spacing.s3} />
                <Text>Checking model status...</Text>
              </View>
            ) : (
              <>
                {/* Integrated Model Selector */}
                <ModelSelector
                  selectedModelId={selectedModelId}
                  models={allModels}
                  onModelChange={handleModelChange}
                  onDownload={() => handleDownloadModel()}
                  onDelete={() => handleDeleteModel()}
                  isDownloading={isDownloading}
                  downloadProgress={downloadProgress}
                  extractionProgress={extractionProgress}
                  currentModelInfo={modelInfo}
                />
              </>
            )}
          </>
        }
      </ScrollView>
    </Screen>
  )
}
