/**
 * speech facade — `engine.speech.{stt,tts}`: on-device STT/TTS model management,
 * wrapping the in-engine model managers. Thin passthrough (args forwarded with
 * exact types via Parameters<>), so the facade never drifts from the managers.
 * STT additionally exposes the auto-download status stream (the TTS path has none).
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import sttModelManager from "../services/STTModelManager"
import ttsModelManager from "../services/TTSModelManager"
import offlineSpeechModelService from "../services/OfflineSpeechModelService"

export const speech = {
  /** Restart the glasses' on-device transcriber (e.g. after switching STT language). */
  restartTranscriber: (): Promise<void> => BluetoothSdk.restartTranscriber(),
  stt: {
    currentLanguage: () => sttModelManager.getCurrentLanguage(),
    languages: () => sttModelManager.getAvailableLanguages(),
    languageInfo: () => sttModelManager.getAllLanguageInfo(),
    download: (...args: Parameters<typeof sttModelManager.downloadModel>) => sttModelManager.downloadModel(...args),
    activate: (code: string) => sttModelManager.setCurrentLanguage(code),
    cancelDownload: () => sttModelManager.cancelDownload(),
    deleteModel: (...args: Parameters<typeof sttModelManager.deleteModel>) => sttModelManager.deleteModel(...args),
    /** Current auto-download status of the offline STT model. */
    status: () => offlineSpeechModelService.getStatus(),
    /** Subscribe to auto-download status changes; returns an unsubscribe. */
    onStatusChanged: (...args: Parameters<typeof offlineSpeechModelService.subscribe>) =>
      offlineSpeechModelService.subscribe(...args),
  },
  tts: {
    currentLanguage: () => ttsModelManager.getCurrentLanguage(),
    languages: () => ttsModelManager.getAvailableLanguages(),
    languageInfo: () => ttsModelManager.getAllLanguageInfo(),
    download: (...args: Parameters<typeof ttsModelManager.downloadModel>) => ttsModelManager.downloadModel(...args),
    activate: (code: string) => ttsModelManager.setCurrentLanguage(code),
    cancelDownload: () => ttsModelManager.cancelDownload(),
    deleteModel: (...args: Parameters<typeof ttsModelManager.deleteModel>) => ttsModelManager.deleteModel(...args),
  },
}
