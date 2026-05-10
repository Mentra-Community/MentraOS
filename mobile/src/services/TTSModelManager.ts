import CoreModule from "@mentra/bluetooth-sdk"
import * as RNFS from "@dr.pogodin/react-native-fs"

export interface TTSLanguageInfo {
  code: string
  displayName: string
  size: number
  language: string
  downloaded: boolean
  path?: string
  type: "vits"
}

export interface TTSDownloadProgress {
  jobId: number
  bytesWritten: number
  contentLength: number
  percentage: number
}

export interface TTSExtractionProgress {
  percentage: number
  currentFile?: string
}

export interface TTSLanguageConfig {
  code: string
  displayName: string
  fileName: string
  downloadUrl?: string
  modelFileName: string
  size: number
  type: "vits"
  requiredFiles: string[]
  languageCode: string
}

export interface TTSGenerateOptions {
  languageCode?: string
  speakerId?: number
  speed?: number
}

export interface TTSGenerateResult {
  audioUrl: string
  filePath: string
  cleanup: () => Promise<void>
}

const DEFAULT_LANGUAGE = "en"

class TTSModelManager {
  private static instance: TTSModelManager
  private downloadJobId?: number
  private currentLanguage = DEFAULT_LANGUAGE
  private modelBaseUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"

  private languages: Record<string, TTSLanguageConfig> = {
    en: {
      code: "en",
      displayName: "English",
      fileName: "vits-piper-en_US-lessac-low-int8",
      modelFileName: "en_US-lessac-low.onnx",
      size: 21070568,
      type: "vits",
      requiredFiles: ["en_US-lessac-low.onnx", "tokens.txt", "espeak-ng-data"],
      languageCode: "en-US",
    },
    fr: {
      code: "fr",
      displayName: "Français",
      fileName: "vits-piper-fr_FR-siwis-low-int8",
      modelFileName: "fr_FR-siwis-low.onnx",
      size: 13317962,
      type: "vits",
      requiredFiles: ["fr_FR-siwis-low.onnx", "tokens.txt", "espeak-ng-data"],
      languageCode: "fr-FR",
    },
    de: {
      code: "de",
      displayName: "Deutsch",
      fileName: "vits-piper-de_DE-thorsten-low-int8",
      modelFileName: "de_DE-thorsten-low.onnx",
      size: 21292232,
      type: "vits",
      requiredFiles: ["de_DE-thorsten-low.onnx", "tokens.txt", "espeak-ng-data"],
      languageCode: "de-DE",
    },
    es: {
      code: "es",
      displayName: "Español",
      fileName: "vits-piper-es_ES-davefx-medium-int8",
      modelFileName: "es_ES-davefx-medium.onnx",
      size: 21171632,
      type: "vits",
      requiredFiles: ["es_ES-davefx-medium.onnx", "tokens.txt", "espeak-ng-data"],
      languageCode: "es-ES",
    },
  }

  private constructor() {}

  static getInstance(): TTSModelManager {
    if (!TTSModelManager.instance) {
      TTSModelManager.instance = new TTSModelManager()
    }
    return TTSModelManager.instance
  }

  async getCurrentLanguageFromPreferences(): Promise<string> {
    try {
      const path = await CoreModule.getTtsModelPath()
      const code = path && path.length > 0 ? this.getLanguageFromPath(path) : ""
      if (code && this.languages[code]) {
        this.currentLanguage = code
        return code
      }
      return ""
    } catch (error) {
      console.error("Error getting current TTS language from preferences:", error)
      return ""
    }
  }

  getCurrentLanguage(): string {
    return this.currentLanguage
  }

  setCurrentLanguage(code: string): void {
    if (this.languages[code]) {
      this.currentLanguage = code
    }
  }

  getAvailableLanguages(): TTSLanguageConfig[] {
    return Object.values(this.languages)
  }

  getBcp47ForLanguage(code?: string): string {
    const id = code || this.currentLanguage
    return this.languages[id]?.languageCode ?? "en-US"
  }

  getModelDirectory(): string {
    return `${RNFS.DocumentDirectoryPath}/tts_models`
  }

  getModelPath(code?: string): string {
    const id = code || this.currentLanguage
    return `${this.getModelDirectory()}/${id}`
  }

  /** Last path segment is the language code (the on-disk folder name). */
  getLanguageFromPath(path: string): string {
    return path.split("/").pop() || ""
  }

  async isModelAvailable(code?: string): Promise<boolean> {
    try {
      const id = code || this.currentLanguage
      const language = this.languages[id]
      if (!language) return false

      const modelPath = this.getModelPath(id)
      for (const file of language.requiredFiles) {
        const exists = await RNFS.exists(`${modelPath}/${file}`)
        if (!exists) {
          console.log(`Missing required TTS file: ${file} at ${modelPath}`)
          return false
        }
      }

      return await CoreModule.validateTtsModel(modelPath)
    } catch (error) {
      console.error("Error checking TTS model availability:", error)
      return false
    }
  }

  async getLanguageInfo(code?: string): Promise<TTSLanguageInfo> {
    const id = code || this.currentLanguage
    const language = this.languages[id]
    if (!language) {
      throw new Error(`TTS language ${id} not found`)
    }

    const downloaded = await this.isModelAvailable(id)
    const path = downloaded ? this.getModelPath(id) : undefined

    return {
      code: id,
      displayName: language.displayName,
      size: language.size,
      language: language.languageCode,
      downloaded,
      path,
      type: language.type,
    }
  }

  async getAllLanguageInfo(): Promise<TTSLanguageInfo[]> {
    const infos: TTSLanguageInfo[] = []
    for (const code of Object.keys(this.languages)) {
      infos.push(await this.getLanguageInfo(code))
    }
    return infos
  }

  async downloadModel(
    code?: string,
    onProgress?: (progress: TTSDownloadProgress) => void,
    onExtractionProgress?: (progress: TTSExtractionProgress) => void,
  ): Promise<void> {
    const id = code || this.currentLanguage
    const language = this.languages[id]
    if (!language) {
      throw new Error(`TTS language ${id} not found`)
    }

    const modelUrl = language.downloadUrl ?? `${this.modelBaseUrl}${language.fileName}.tar.bz2`
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${language.fileName}.tar.bz2`
    const modelDir = this.getModelDirectory()
    const finalPath = this.getModelPath(id)

    try {
      await RNFS.mkdir(modelDir, {NSURLIsExcludedFromBackupKey: true})

      const result = RNFS.downloadFile({
        fromUrl: modelUrl,
        toFile: tempPath,
        progress: (res: RNFS.DownloadProgressCallbackResultT) => {
          const percentage = Math.round((res.bytesWritten / res.contentLength) * 100)
          onProgress?.({
            jobId: res.jobId,
            bytesWritten: res.bytesWritten,
            contentLength: res.contentLength,
            percentage,
          })
        },
        progressDivider: 10,
        connectionTimeout: 30000,
        readTimeout: 30000,
      })
      this.downloadJobId = result.jobId

      const downloadResult = await result.promise
      if (downloadResult.statusCode !== 200) {
        throw new Error(`TTS model download failed with status code: ${downloadResult.statusCode}`)
      }

      const unsubscribe = CoreModule.onExtractionProgress((event) => {
        onExtractionProgress?.({percentage: event.percentage})
      })

      let extractionResult = false
      try {
        extractionResult = await CoreModule.extractTarBz2(tempPath, finalPath)
      } finally {
        unsubscribe()
      }

      if (!extractionResult) {
        throw new Error("Native TTS model extraction returned failure status")
      }
      onExtractionProgress?.({percentage: 100})

      await RNFS.unlink(tempPath)

      if (id === this.currentLanguage) {
        await this.setNativeModelPath(finalPath, language.languageCode)
      }
    } catch (error) {
      if (await RNFS.exists(tempPath)) {
        await RNFS.unlink(tempPath)
      }
      if (await RNFS.exists(finalPath)) {
        await RNFS.unlink(finalPath)
      }
      throw error
    }
  }

  async cancelDownload(): Promise<void> {
    if (this.downloadJobId !== undefined) {
      await RNFS.stopDownload(this.downloadJobId)
      this.downloadJobId = undefined
    }
  }

  async deleteModel(code?: string): Promise<void> {
    const id = code || this.currentLanguage
    const modelPath = this.getModelPath(id)
    if (await RNFS.exists(modelPath)) {
      await RNFS.unlink(modelPath)
    }
  }

  async activateLanguage(code: string): Promise<void> {
    const language = this.languages[code]
    if (!language) {
      throw new Error(`TTS language ${code} not found`)
    }

    const isAvailable = await this.isModelAvailable(code)
    if (!isAvailable) {
      throw new Error(`TTS language ${code} model is not downloaded`)
    }

    this.currentLanguage = code
    await this.setNativeModelPath(this.getModelPath(code), language.languageCode)
  }

  async synthesizeToFile(text: string, options: TTSGenerateOptions = {}): Promise<TTSGenerateResult> {
    const id = options.languageCode || this.currentLanguage
    const language = this.languages[id]
    if (!language) {
      throw new Error(`TTS language ${id} not found`)
    }

    if (!(await this.isModelAvailable(id))) {
      throw new Error(`TTS language ${id} model is not downloaded`)
    }

    const outputDir = RNFS.CachesDirectoryPath || RNFS.TemporaryDirectoryPath
    const safeId = `${Date.now()}_${Math.random().toString(36).slice(2)}`
    const outputPath = `${outputDir}/mentra_tts_${safeId}.wav`
    const ok = await CoreModule.generateTtsAudio(
      text,
      this.getModelPath(id),
      outputPath,
      options.speakerId ?? 0,
      options.speed ?? 1.0,
    )
    if (!ok) {
      throw new Error("Offline TTS synthesis failed")
    }

    return {
      audioUrl: `file://${outputPath}`,
      filePath: outputPath,
      cleanup: async () => {
        if (await RNFS.exists(outputPath)) {
          await RNFS.unlink(outputPath)
        }
      },
    }
  }

  private async setNativeModelPath(path: string, languageCode: string): Promise<void> {
    await CoreModule.setTtsModelDetails(path, languageCode)
  }

  formatBytes(bytes: number): string {
    return TTSModelManager.formatBytes(bytes)
  }

  static formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes"
    const k = 1024
    const sizes = ["Bytes", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  }
}

const instance = TTSModelManager.getInstance()
export {TTSModelManager}
export default instance
