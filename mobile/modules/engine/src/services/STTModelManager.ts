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
  /** Stable selection ID, also the model's folder name. One model per language. */
  code: string
  displayName: string
  fileName: string
  downloadUrl?: string
  size: number
  type: "transducer" | "ctc"
  requiredFiles: string[]
  languageCode: string
}

const DEFAULT_LANGUAGE = "en-kroko"

/**
 * Models that are no longer listed but may still be saved on a phone. The
 * startup background download moves each one to its replacement
 * (OfflineSpeechModelService) and keeps using it until then.
 */
const LEGACY_LANGUAGES: Record<string, LanguageConfig & {replacement: string}> = {
  en: {
    code: "en",
    displayName: "English",
    fileName: "sherpa-onnx-streaming-zipformer-en-2023-06-21-mobile",
    size: 349 * 1024 * 1024,
    type: "transducer",
    requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
    languageCode: "en-US",
    // The listed English model.
    replacement: DEFAULT_LANGUAGE,
  },
}

/** One in-flight download, shared by every caller that asks for the same model. */
interface DownloadJob {
  promise: Promise<void>
  jobId?: number
  cancelled: boolean
  progress: Set<(progress: DownloadProgress) => void>
  extraction: Set<(progress: ExtractionProgress) => void>
  lastProgress?: DownloadProgress
  lastExtraction?: ExtractionProgress
}

class STTModelManager {
  private static instance: STTModelManager
  private downloads = new Map<string, DownloadJob>()
  private lastStartedDownload?: string
  private currentLanguage = DEFAULT_LANGUAGE
  private selectionListeners = new Set<() => void>()

  onSelectionChanged(listener: () => void): () => void {
    this.selectionListeners.add(listener)
    return () => {
      this.selectionListeners.delete(listener)
    }
  }

  private updateSelection(code: string): void {
    if (this.currentLanguage === code) return
    this.currentLanguage = code
    for (const listener of this.selectionListeners) listener()
  }
  private modelBaseUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"

  private languages: Record<string, LanguageConfig> = {
    "en-kroko": {
      code: "en-kroko",
      displayName: "English",
      fileName: "sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06",
      size: 55 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "en-US",
    },
    "fr": {
      code: "fr",
      displayName: "Français",
      fileName: "sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06",
      size: 57 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "fr-FR",
    },
    "de": {
      code: "de",
      displayName: "Deutsch",
      fileName: "sherpa-onnx-streaming-zipformer-de-kroko-2025-08-06",
      size: 58 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "de-DE",
    },
    "es": {
      code: "es",
      displayName: "Español",
      fileName: "sherpa-onnx-streaming-zipformer-es-kroko-2025-08-06",
      size: 124 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "es-ES",
    },
    "zh": {
      code: "zh",
      displayName: "中文",
      fileName: "sherpa-onnx-streaming-zipformer-zh-2025-06-30",
      size: 150 * 1024 * 1024,
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "zh-CN",
    },
    "ko": {
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
      if (code && this.config(code)) {
        this.updateSelection(code)
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
    if (this.config(code)) {
      this.updateSelection(code)
    }
  }

  getBcp47ForLanguage(code?: string): string {
    const id = code || this.currentLanguage
    return this.config(id)?.languageCode ?? "en-US"
  }

  getAvailableLanguages(): LanguageConfig[] {
    return Object.values(this.languages)
  }

  /** The listed model that replaces a saved legacy model, or undefined when `code` is current. */
  getLegacyReplacement(code: string): string | undefined {
    return LEGACY_LANGUAGES[code]?.replacement
  }

  private config(code: string): LanguageConfig | undefined {
    return this.languages[code] ?? LEGACY_LANGUAGES[code]
  }

  getModelDirectory(): string {
    const baseDir = Platform.OS === "ios" ? RNFS.DocumentDirectoryPath : RNFS.DocumentDirectoryPath
    return `${baseDir}/stt_models`
  }

  getModelPath(code?: string): string {
    const id = code || this.currentLanguage
    return `${this.getModelDirectory()}/${id}`
  }

  /** Last path segment is the selection ID (the on-disk model folder name). */
  getLanguageFromPath(path: string): string {
    return path.split("/").pop() || ""
  }

  async isModelAvailable(code?: string): Promise<boolean> {
    try {
      const id = code || this.currentLanguage
      const language = this.config(id)
      if (!language) return false
      return await this.hasModelFiles(language, this.getModelPath(id))
    } catch (error) {
      console.error("Error checking STT model availability:", error)
      return false
    }
  }

  private async hasModelFiles(language: LanguageConfig, modelPath: string): Promise<boolean> {
    for (const file of language.requiredFiles) {
      const filePath = `${modelPath}/${file}`
      const exists = await RNFS.exists(filePath)
      if (!exists) {
        console.log(`Missing required STT file: ${file} at ${filePath}`)
        return false
      }
    }
    return await BluetoothSdk.validateSttModel(modelPath)
  }

  async getLanguageInfo(code?: string): Promise<LanguageInfo> {
    const id = code || this.currentLanguage
    const language = this.config(id)
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
    for (const {code} of this.getAvailableLanguages()) {
      infos.push(await this.getLanguageInfo(code))
    }
    return infos
  }

  /**
   * Download a model if it is missing. Never changes the selected model; call
   * `activateLanguage` for that. Every caller of a model that is already
   * downloading joins that download and receives its progress.
   */
  downloadModel(
    code?: string,
    onProgress?: (progress: DownloadProgress) => void,
    onExtractionProgress?: (progress: ExtractionProgress) => void,
  ): Promise<void> {
    const id = code || this.currentLanguage
    let job = this.downloads.get(id)
    if (!job) {
      const created: DownloadJob = {
        promise: Promise.resolve(),
        cancelled: false,
        progress: new Set(),
        extraction: new Set(),
      }
      created.promise = (async () => {
        if (!(await this.isModelAvailable(id))) await this.downloadModelOnce(id, created)
      })().finally(() => {
        if (this.downloads.get(id) === created) this.downloads.delete(id)
      })
      this.downloads.set(id, created)
      this.lastStartedDownload = id
      job = created
    }
    const joined = job
    if (onProgress) {
      joined.progress.add(onProgress)
      if (joined.lastProgress) onProgress(joined.lastProgress)
    }
    if (onExtractionProgress) {
      joined.extraction.add(onExtractionProgress)
      if (joined.lastExtraction) onExtractionProgress(joined.lastExtraction)
    }
    return joined.promise.finally(() => {
      if (onProgress) joined.progress.delete(onProgress)
      if (onExtractionProgress) joined.extraction.delete(onExtractionProgress)
    })
  }

  /** Whether `code` is downloading right now. */
  isDownloading(code?: string): boolean {
    return this.downloads.has(code || this.currentLanguage)
  }

  private reportProgress(job: DownloadJob, progress: DownloadProgress): void {
    job.lastProgress = progress
    for (const listener of job.progress) listener(progress)
  }

  private reportExtraction(job: DownloadJob, progress: ExtractionProgress): void {
    job.lastExtraction = progress
    for (const listener of job.extraction) listener(progress)
  }

  private async downloadModelOnce(id: string, job: DownloadJob): Promise<void> {
    const language = this.languages[id]
    if (!language) {
      throw new Error(`Language ${id} not found`)
    }

    const modelUrl = language.downloadUrl ?? `${this.modelBaseUrl}${language.fileName}.tar.bz2`
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${language.fileName}.tar.bz2`
    const modelDir = this.getModelDirectory()
    const finalPath = this.getModelPath(id)
    // Extract next to the final folder and rename it into place only once it is
    // complete: a partial extract must never pass the files-exist check, because
    // loading a truncated model crashes inside native code.
    const partialPrefix = `.partial-${id}-`
    const partialPath = `${modelDir}/${partialPrefix}${Date.now()}`

    try {
      await RNFS.mkdir(modelDir, {NSURLIsExcludedFromBackupKey: true})
      await this.removeStalePartials(modelDir, partialPrefix)

      const downloadOptions = {
        fromUrl: modelUrl,
        toFile: tempPath,
        progress: (res: RNFS.DownloadProgressCallbackResultT) => {
          const percentage = res.contentLength > 0 ? Math.round((res.bytesWritten / res.contentLength) * 100) : 0
          this.reportProgress(job, {
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
      job.jobId = result.jobId
      if (job.cancelled) await RNFS.stopDownload(result.jobId)

      const downloadResult = await result.promise
      if (job.cancelled) throw new Error(`Download of ${id} was cancelled`)

      if (downloadResult.statusCode !== 200) {
        throw new Error(`Download failed with status code: ${downloadResult.statusCode}`)
      }

      this.reportExtraction(job, {percentage: 0})

      const subscription = BluetoothSdk.addListener("extraction_progress", (event) => {
        this.reportExtraction(job, {percentage: event.percentage})
      })

      try {
        const extractionResult = await BluetoothSdk.extractTarBz2(tempPath, partialPath)
        if (!extractionResult) {
          throw new Error("Native extraction returned failure status")
        }
      } catch (extractError) {
        console.error("Native extraction failed:", extractError)
        throw extractError
      } finally {
        subscription.remove()
      }

      await RNFS.unlink(tempPath)

      if (!(await this.hasModelFiles(language, partialPath))) {
        throw new Error(`Downloaded STT model ${id} is incomplete or invalid`)
      }
      if (await RNFS.exists(finalPath)) await RNFS.unlink(finalPath)
      await RNFS.moveFile(partialPath, finalPath)

      this.reportExtraction(job, {percentage: 100})

      if (!(await this.isModelAvailable(id))) {
        throw new Error(`Downloaded STT model ${id} is incomplete or invalid`)
      }
    } catch (error) {
      // Best-effort cleanup; never let it mask the original error. The final
      // folder is only ever replaced by a complete extract, so leave it alone.
      for (const path of [tempPath, partialPath]) {
        try {
          if (await RNFS.exists(path)) await RNFS.unlink(path)
        } catch (cleanupError) {
          console.warn(`STTModelManager: cleanup of ${path} failed:`, cleanupError)
        }
      }
      throw error
    }
  }

  /** Delete extracts left behind by a download that was interrupted mid-way. */
  private async removeStalePartials(modelDir: string, prefix: string): Promise<void> {
    try {
      for (const entry of await RNFS.readDir(modelDir)) {
        if (entry.name.startsWith(prefix)) await RNFS.unlink(entry.path)
      }
    } catch (error) {
      console.warn("STTModelManager: could not clean interrupted extracts:", error)
    }
  }

  /**
   * Cancel one in-flight download: `code`'s, or the most recently started one
   * when `code` is omitted. Other downloads keep running.
   */
  async cancelDownload(code?: string): Promise<void> {
    const id = code ?? this.lastStartedDownload
    const job = id ? this.downloads.get(id) : undefined
    if (!job) return
    job.cancelled = true
    if (job.jobId !== undefined) await RNFS.stopDownload(job.jobId)
  }

  async deleteModel(code?: string): Promise<void> {
    const id = code || this.currentLanguage
    const modelPath = this.getModelPath(id)
    if (await RNFS.exists(modelPath)) {
      await RNFS.unlink(modelPath)
    }
  }

  /**
   * Make `code` the selected model: persist its path natively, then notify
   * selection listeners. Rejects when it isn't downloaded.
   */
  async activateLanguage(code: string): Promise<void> {
    const language = this.config(code)
    if (!language) {
      throw new Error(`Language ${code} not found`)
    }

    const isAvailable = await this.isModelAvailable(code)
    if (!isAvailable) {
      throw new Error(`Language ${code} model is not downloaded`)
    }

    const modelPath = this.getModelPath(code)
    await this.setNativeModelPath(modelPath, language.languageCode)
    this.updateSelection(code)
  }

  private async setNativeModelPath(path: string, languageCode: string): Promise<void> {
    await BluetoothSdk.setSttModelDetails(path, languageCode)
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
