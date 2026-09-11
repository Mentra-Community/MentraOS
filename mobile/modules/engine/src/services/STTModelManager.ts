import BluetoothSdk from "@mentra/bluetooth-sdk"
import {Platform} from "react-native"
import * as RNFS from "@dr.pogodin/react-native-fs"

export interface LanguageInfo {
  code: string
  displayName: string
  size: number
  language: string
  downloaded: boolean
  path?: string
  type: "transducer" | "ctc"
}

export interface DownloadProgress {
  jobId: number
  bytesWritten: number
  contentLength: number
  percentage: number
}

export interface ExtractionProgress {
  percentage: number
  currentFile?: string
}

export interface LanguageConfig {
  code: string
  displayName: string
  fileName: string
  downloadUrl?: string
  size: number
  type: "transducer" | "ctc"
  requiredFiles: string[]
  languageCode: string
}

const DEFAULT_LANGUAGE = "en"

class STTModelManager {
  private static instance: STTModelManager
  private downloadJobId?: number
  private currentLanguage = DEFAULT_LANGUAGE
  private modelBaseUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"

  private languages: Record<string, LanguageConfig> = {
    en: {
      code: "en",
      displayName: "English",
      fileName: "sherpa-onnx-streaming-zipformer-en-2023-06-21-mobile",
      size: 349 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "en-US",
    },
    fr: {
      code: "fr",
      displayName: "Français",
      fileName: "sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06",
      size: 57 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "fr-FR",
    },
    de: {
      code: "de",
      displayName: "Deutsch",
      fileName: "sherpa-onnx-streaming-zipformer-de-kroko-2025-08-06",
      size: 58 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "de-DE",
    },
    es: {
      code: "es",
      displayName: "Español",
      fileName: "sherpa-onnx-streaming-zipformer-es-kroko-2025-08-06",
      size: 124 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "es-ES",
    },
    zh: {
      code: "zh",
      displayName: "中文",
      fileName: "sherpa-onnx-streaming-zipformer-zh-2025-06-30",
      size: 150 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "zh-CN",
    },
    ko: {
      code: "ko",
      displayName: "한국어",
      fileName: "sherpa-onnx-streaming-zipformer-korean-2024-06-16",
      size: 200 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "ko-KR",
    },
  }

  private constructor() {}

  static getInstance(): STTModelManager {
    if (!STTModelManager.instance) {
      STTModelManager.instance = new STTModelManager()
    }
    return STTModelManager.instance
  }

  async getCurrentLanguageFromPreferences(): Promise<string> {
    try {
      const path = await BluetoothSdk.getSttModelPath()
      const code = path && path.length > 0 ? this.getLanguageFromPath(path) : ""
      if (code && this.languages[code]) {
        this.currentLanguage = code
        return code
      }
      return ""
    } catch (error) {
      console.error("Error getting current STT language from preferences:", error)
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

  getBcp47ForLanguage(code?: string): string {
    const id = code || this.currentLanguage
    return this.languages[id]?.languageCode ?? "en-US"
  }

  getAvailableLanguages(): LanguageConfig[] {
    return Object.values(this.languages)
  }

  getModelDirectory(): string {
    const baseDir = Platform.OS === "ios" ? RNFS.DocumentDirectoryPath : RNFS.DocumentDirectoryPath
    return `${baseDir}/stt_models`
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
        const filePath = `${modelPath}/${file}`
        const exists = await RNFS.exists(filePath)
        if (!exists) {
          console.log(`Missing required STT file: ${file} at ${filePath}`)
          return false
        }
      }

      return await BluetoothSdk.validateSttModel(modelPath)
    } catch (error) {
      console.error("Error checking STT model availability:", error)
      return false
    }
  }

  async getLanguageInfo(code?: string): Promise<LanguageInfo> {
    const id = code || this.currentLanguage
    const language = this.languages[id]
    if (!language) {
      throw new Error(`Language ${id} not found`)
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

  async getAllLanguageInfo(): Promise<LanguageInfo[]> {
    const infos: LanguageInfo[] = []
    for (const code of Object.keys(this.languages)) {
      infos.push(await this.getLanguageInfo(code))
    }
    return infos
  }

  async downloadModel(
    code?: string,
    onProgress?: (progress: DownloadProgress) => void,
    onExtractionProgress?: (progress: ExtractionProgress) => void,
  ): Promise<void> {
    const id = code || this.currentLanguage
    const language = this.languages[id]
    if (!language) {
      throw new Error(`Language ${id} not found`)
    }

    const modelUrl = language.downloadUrl ?? `${this.modelBaseUrl}${language.fileName}.tar.bz2`
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${language.fileName}.tar.bz2`
    const modelDir = this.getModelDirectory()
    const finalPath = this.getModelPath(id)

    try {
      await RNFS.mkdir(modelDir, {NSURLIsExcludedFromBackupKey: true})

      const downloadOptions = {
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
        begin: (res: RNFS.DownloadBeginCallbackResultT) => {
          console.log("Download started:", res)
        },
        connectionTimeout: 30000,
        readTimeout: 30000,
      }

      const result = await RNFS.downloadFile(downloadOptions)
      this.downloadJobId = result.jobId

      const downloadResult = await result.promise

      if (downloadResult.statusCode !== 200) {
        throw new Error(`Download failed with status code: ${downloadResult.statusCode}`)
      }

      onExtractionProgress?.({percentage: 0})

      const subscription = BluetoothSdk.addListener("extraction_progress", (event) => {
        onExtractionProgress?.({percentage: event.percentage})
      })

      try {
        const extractionResult = await BluetoothSdk.extractTarBz2(tempPath, finalPath)
        if (!extractionResult) {
          throw new Error("Native extraction returned failure status")
        }
      } catch (extractError) {
        console.error("Native extraction failed:", extractError)
        throw extractError
      } finally {
        subscription.remove()
      }

      onExtractionProgress?.({percentage: 100})

      await RNFS.unlink(tempPath)

      if (id === this.currentLanguage) {
        await this.setNativeModelPath(finalPath, language.languageCode)
      }
    } catch (error) {
      // Best-effort cleanup; never let it mask the original error.
      try {
        if (await RNFS.exists(tempPath)) await RNFS.unlink(tempPath)
      } catch (cleanupError) {
        console.warn("STTModelManager: temp cleanup failed:", cleanupError)
      }
      try {
        if (await RNFS.exists(finalPath)) await RNFS.unlink(finalPath)
      } catch (cleanupError) {
        console.warn("STTModelManager: final cleanup failed:", cleanupError)
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
      throw new Error(`Language ${code} not found`)
    }

    const isAvailable = await this.isModelAvailable(code)
    if (!isAvailable) {
      throw new Error(`Language ${code} model is not downloaded`)
    }

    this.currentLanguage = code
    const modelPath = this.getModelPath(code)
    await this.setNativeModelPath(modelPath, language.languageCode)
  }

  private async setNativeModelPath(path: string, languageCode: string): Promise<void> {
    BluetoothSdk.setSttModelDetails(path, languageCode)
  }

  async getStorageInfo(): Promise<{free: number; total: number}> {
    const fsInfo = await RNFS.getFSInfo()
    return {
      free: fsInfo.freeSpace,
      total: fsInfo.totalSpace,
    }
  }

  formatBytes(bytes: number): string {
    return STTModelManager.formatBytes(bytes)
  }

  static formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes"
    const k = 1024
    const sizes = ["Bytes", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  }
}

const instance = STTModelManager.getInstance()
export {STTModelManager}
export default instance
