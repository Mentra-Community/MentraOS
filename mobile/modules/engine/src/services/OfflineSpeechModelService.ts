// import NetInfo from "@react-native-community/netinfo"

import STTModelManager from "./STTModelManager"
import TTSModelManager from "./TTSModelManager"

export type DownloadStage = "idle" | "downloading" | "extracting" | "complete" | "failed"

export interface DownloadStatus {
  kind: "stt" | "tts"
  languageCode: string
  stage: DownloadStage
  /** 0–100, only meaningful while stage is "downloading" or "extracting". */
  percent: number
}

type StatusListener = (status: DownloadStatus | null) => void

class OfflineSpeechModelService {
  private static instance: OfflineSpeechModelService
  private started = false
  private sttPromise: Promise<void> | null = null
  private ttsPromise: Promise<void> | null = null

  private currentStatus: DownloadStatus | null = null
  private listeners = new Set<StatusListener>()

  private constructor() {}

  static getInstance(): OfflineSpeechModelService {
    if (!OfflineSpeechModelService.instance) {
      OfflineSpeechModelService.instance = new OfflineSpeechModelService()
    }
    return OfflineSpeechModelService.instance
  }

  startBackgroundDownloads(): void {
    if (this.started) return
    this.started = true

    // Wi-Fi gate (currently disabled — uncomment to skip background downloads on cellular):
    // NetInfo.fetch().then((state) => {
    //   if (state.type !== "wifi") {
    //     console.log("OFFLINE_MODELS: skipping background download — not on Wi-Fi")
    //     return
    //   }
    //   void this.ensureDefaultModels().catch((error) => {
    //     console.warn("OFFLINE_MODELS: background model setup failed:", error)
    //   })
    // })

    void this.ensureDefaultModels().catch((error) => {
      console.warn("OFFLINE_MODELS: background model setup failed:", error)
    })
  }

  /** Subscribe to background-download status changes. Fires immediately with current status. */
  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    listener(this.currentStatus)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getStatus(): DownloadStatus | null {
    return this.currentStatus
  }

  private setStatus(status: DownloadStatus | null): void {
    this.currentStatus = status
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch (e) {
        console.warn("OFFLINE_MODELS: status listener threw:", e)
      }
    }
  }

  async ensureDefaultModels(): Promise<void> {
    // Sequence STT then TTS so the home-screen banner shows one coherent
    // progress at a time. STT first because it's the primary use case.
    try {
      await this.ensureSttModel()
    } catch (error) {
      console.warn("OFFLINE_MODELS: STT model setup failed:", error)
    }
    try {
      await this.ensureTtsModel()
    } catch (error) {
      console.warn("OFFLINE_MODELS: TTS model setup failed:", error)
    }
  }

  async ensureSttModel(): Promise<void> {
    if (this.sttPromise) return this.sttPromise
    this.sttPromise = this.ensureSttModelInner().finally(() => {
      this.sttPromise = null
    })
    return this.sttPromise
  }

  async ensureTtsModel(): Promise<void> {
    if (this.ttsPromise) return this.ttsPromise
    this.ttsPromise = this.ensureTtsModelInner().finally(() => {
      this.ttsPromise = null
    })
    return this.ttsPromise
  }

  private async ensureSttModelInner(): Promise<void> {
    const preferred = await STTModelManager.getCurrentLanguageFromPreferences()
    const code = preferred || STTModelManager.getCurrentLanguage()

    if (await STTModelManager.isModelAvailable(code)) {
      await STTModelManager.activateLanguage(code)
      console.log(`OFFLINE_MODELS: STT model ready: ${code}`)
      return
    }

    console.log(`OFFLINE_MODELS: downloading STT model in background: ${code}`)
    this.setStatus({kind: "stt", languageCode: code, stage: "downloading", percent: 0})
    try {
      await STTModelManager.downloadModel(
        code,
        (p) => this.setStatus({kind: "stt", languageCode: code, stage: "downloading", percent: p.percentage}),
        (p) => this.setStatus({kind: "stt", languageCode: code, stage: "extracting", percent: p.percentage}),
      )
      await STTModelManager.activateLanguage(code)
      this.setStatus({kind: "stt", languageCode: code, stage: "complete", percent: 100})
      console.log(`OFFLINE_MODELS: STT model downloaded: ${code}`)
    } catch (error) {
      this.setStatus({kind: "stt", languageCode: code, stage: "failed", percent: 0})
      throw error
    }
  }

  private async ensureTtsModelInner(): Promise<void> {
    const preferred = await TTSModelManager.getCurrentLanguageFromPreferences()
    const code = preferred || TTSModelManager.getCurrentLanguage()

    if (await TTSModelManager.isModelAvailable(code)) {
      await TTSModelManager.activateLanguage(code)
      console.log(`OFFLINE_MODELS: TTS model ready: ${code}`)
      return
    }

    console.log(`OFFLINE_MODELS: downloading TTS model in background: ${code}`)
    this.setStatus({kind: "tts", languageCode: code, stage: "downloading", percent: 0})
    try {
      await TTSModelManager.downloadModel(
        code,
        (p) => this.setStatus({kind: "tts", languageCode: code, stage: "downloading", percent: p.percentage}),
        (p) => this.setStatus({kind: "tts", languageCode: code, stage: "extracting", percent: p.percentage}),
      )
      await TTSModelManager.activateLanguage(code)
      this.setStatus({kind: "tts", languageCode: code, stage: "complete", percent: 100})
      console.log(`OFFLINE_MODELS: TTS model downloaded: ${code}`)
    } catch (error) {
      this.setStatus({kind: "tts", languageCode: code, stage: "failed", percent: 0})
      throw error
    }
  }
}

const offlineSpeechModelService = OfflineSpeechModelService.getInstance()
export {OfflineSpeechModelService}
export default offlineSpeechModelService
