import BluetoothSdk from "@mentra/bluetooth-sdk"
import * as RNFS from "@dr.pogodin/react-native-fs"

/**
 * Offline TTS via Sherpa-ONNX Supertonic 3.
 *
 * Supertonic 3 ships as a single multilingual model bundle (123 MB int8)
 * with 31 languages and 10 preset voice styles inside one voice.bin.
 *
 * Speaker IDs are alphabetical by source filename, so:
 *   sid 0 = F1, 1 = F2, 2 = F3, 3 = F4, 4 = F5,
 *   sid 5 = M1, 6 = M2, 7 = M3, 8 = M4, 9 = M5.
 *
 * Default voice is F1 (sid 0) — a female "professional broadcast" voice.
 *
 * Per-call language selection is done by the native layer based on the
 * languageCode set via setTtsModelDetails (Supertonic accepts e.g. "en",
 * "ko", "ja", "fr", "de", "es", … — 31 codes total).
 */

const SUPERTONIC_FILE = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11"
const SUPERTONIC_SIZE = 128974848 // 123 MB
const SUPERTONIC_SHA256 = "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427"

// Speaker IDs for Supertonic 3.
export const SUPERTONIC_VOICES = {
  F1: 0,
  F2: 1,
  F3: 2,
  F4: 3,
  F5: 4,
  M1: 5,
  M2: 6,
  M3: 7,
  M4: 8,
  M5: 9,
} as const

export const DEFAULT_SUPERTONIC_VOICE_SID = SUPERTONIC_VOICES.F1

export interface TTSLanguageInfo {
  code: string
  displayName: string
  size: number
  language: string
  downloaded: boolean
  path?: string
  type: "supertonic"
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
  size: number
  type: "supertonic"
  requiredFiles: string[]
  languageCode: string
}

export interface TTSGenerateOptions {
  /** BCP-47 language tag, e.g. "en-US", "fr-FR". Maps to Supertonic 2-letter code. */
  languageCode?: string
  /** Speaker ID (0..9). Defaults to F1 (sid 0). */
  speakerId?: number
  /** Speech rate, clamped 0.5..2.0 on native side. */
  speed?: number
}

export interface TTSGenerateResult {
  audioUrl: string
  filePath: string
  cleanup: () => Promise<void>
}

/** Languages Supertonic 3 supports (BCP-47-ish tags surfaced to the UI). */
const LANGUAGE_DISPLAY: Record<string, {displayName: string; bcp47: string}> = {
  en: {displayName: "English", bcp47: "en-US"},
  fr: {displayName: "Français", bcp47: "fr-FR"},
  de: {displayName: "Deutsch", bcp47: "de-DE"},
  es: {displayName: "Español", bcp47: "es-ES"},
  it: {displayName: "Italiano", bcp47: "it-IT"},
  pt: {displayName: "Português", bcp47: "pt-PT"},
  nl: {displayName: "Nederlands", bcp47: "nl-NL"},
  pl: {displayName: "Polski", bcp47: "pl-PL"},
  ru: {displayName: "Русский", bcp47: "ru-RU"},
  uk: {displayName: "Українська", bcp47: "uk-UA"},
  ko: {displayName: "한국어", bcp47: "ko-KR"},
  ja: {displayName: "日本語", bcp47: "ja-JP"},
  ar: {displayName: "العربية", bcp47: "ar-SA"},
  hi: {displayName: "हिन्दी", bcp47: "hi-IN"},
  id: {displayName: "Bahasa Indonesia", bcp47: "id-ID"},
  vi: {displayName: "Tiếng Việt", bcp47: "vi-VN"},
  tr: {displayName: "Türkçe", bcp47: "tr-TR"},
  el: {displayName: "Ελληνικά", bcp47: "el-GR"},
  bg: {displayName: "Български", bcp47: "bg-BG"},
  cs: {displayName: "Čeština", bcp47: "cs-CZ"},
  da: {displayName: "Dansk", bcp47: "da-DK"},
  et: {displayName: "Eesti", bcp47: "et-EE"},
  fi: {displayName: "Suomi", bcp47: "fi-FI"},
  hr: {displayName: "Hrvatski", bcp47: "hr-HR"},
  hu: {displayName: "Magyar", bcp47: "hu-HU"},
  lt: {displayName: "Lietuvių", bcp47: "lt-LT"},
  lv: {displayName: "Latviešu", bcp47: "lv-LV"},
  ro: {displayName: "Română", bcp47: "ro-RO"},
  sk: {displayName: "Slovenčina", bcp47: "sk-SK"},
  sl: {displayName: "Slovenščina", bcp47: "sl-SI"},
  sv: {displayName: "Svenska", bcp47: "sv-SE"},
}

const DEFAULT_LANGUAGE = "en"

/** On-disk folder name for the single Supertonic install. */
const MODEL_FOLDER = "supertonic"

/** Files inside the Supertonic 3 archive — must match TTSTools native validators. */
const SUPERTONIC_REQUIRED_FILES = [
  "duration_predictor.int8.onnx",
  "text_encoder.int8.onnx",
  "vector_estimator.int8.onnx",
  "vocoder.int8.onnx",
  "tts.json",
  "unicode_indexer.bin",
  "voice.bin",
]

function buildLanguageRegistry(): Record<string, TTSLanguageConfig> {
  const out: Record<string, TTSLanguageConfig> = {}
  for (const [code, meta] of Object.entries(LANGUAGE_DISPLAY)) {
    out[code] = {
      code,
      displayName: meta.displayName,
      fileName: SUPERTONIC_FILE,
      size: SUPERTONIC_SIZE,
      type: "supertonic",
      requiredFiles: SUPERTONIC_REQUIRED_FILES,
      languageCode: meta.bcp47,
    }
  }
  return out
}

class TTSModelManager {
  private static instance: TTSModelManager
  private downloadJobId?: number
  private currentLanguage = DEFAULT_LANGUAGE
  // Sherpa-onnx releases page hosts the tarball.
  private modelBaseUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"

  // Languages all map onto the same on-disk Supertonic install. Selecting a
  // language tells the native layer which lang to pass to the model — no
  // separate downloads per language.
  private languages: Record<string, TTSLanguageConfig> = buildLanguageRegistry()

  private constructor() {}

  static getInstance(): TTSModelManager {
    if (!TTSModelManager.instance) {
      TTSModelManager.instance = new TTSModelManager()
    }
    return TTSModelManager.instance
  }

  /** Expected SHA-256 of the Supertonic 3 tarball, for downstream integrity checks. */
  getExpectedSha256(): string {
    return SUPERTONIC_SHA256
  }

  async getCurrentLanguageFromPreferences(): Promise<string> {
    try {
      const path = await BluetoothSdk.getTtsModelPath()
      if (!path || path.length === 0) {
        return ""
      }
      if (!(await this.isModelAvailable())) {
        return ""
      }
      // The native side persists the BCP-47 tag (e.g. "fr-FR") that was passed
      // to setTtsModelDetails. Map it back to our registry key.
      const bcp47 = await BluetoothSdk.getTtsModelLanguage()
      const primary = bcp47.split("-")[0].toLowerCase()
      const code = this.languages[primary] ? primary : ""
      if (code) {
        this.currentLanguage = code
      }
      return code
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

  /** All languages share the same on-disk Supertonic install. */
  getModelPath(_code?: string): string {
    return `${this.getModelDirectory()}/${MODEL_FOLDER}`
  }

  /** Last path segment is "supertonic" (the on-disk install folder). */
  getLanguageFromPath(path: string): string {
    return path.split("/").pop() || ""
  }

  async isModelAvailable(code?: string): Promise<boolean> {
    try {
      const language = this.languages[code || this.currentLanguage]
      if (!language) return false

      const modelPath = this.getModelPath()
      for (const file of language.requiredFiles) {
        const exists = await RNFS.exists(`${modelPath}/${file}`)
        if (!exists) {
          console.log(`Missing required TTS file: ${file} at ${modelPath}`)
          return false
        }
      }

      return await BluetoothSdk.validateTtsModel(modelPath)
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
    const path = downloaded ? this.getModelPath() : undefined

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

    // All languages share the same archive — re-downloading is a no-op if
    // the on-disk model is already present and valid.
    if (await this.isModelAvailable(id)) {
      onExtractionProgress?.({percentage: 100})
      // Make sure the native layer has the latest language code.
      await this.setNativeModelPath(this.getModelPath(), language.languageCode)
      this.currentLanguage = id
      return
    }

    const modelUrl = `${this.modelBaseUrl}${SUPERTONIC_FILE}.tar.bz2`
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${SUPERTONIC_FILE}.tar.bz2`
    const modelDir = this.getModelDirectory()
    const finalPath = this.getModelPath()

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

      const subscription = BluetoothSdk.addListener("extraction_progress", (event) => {
        onExtractionProgress?.({percentage: event.percentage})
      })

      let extractionResult = false
      try {
        extractionResult = await BluetoothSdk.extractTarBz2(tempPath, finalPath)
      } finally {
        subscription.remove()
      }

      if (!extractionResult) {
        throw new Error("Native TTS model extraction returned failure status")
      }
      onExtractionProgress?.({percentage: 100})

      await RNFS.unlink(tempPath)

      await this.setNativeModelPath(finalPath, language.languageCode)
      this.currentLanguage = id
    } catch (error) {
      // Best-effort cleanup; never let it mask the original error.
      try {
        if (await RNFS.exists(tempPath)) await RNFS.unlink(tempPath)
      } catch (cleanupError) {
        console.warn("TTSModelManager: temp cleanup failed:", cleanupError)
      }
      try {
        if (await RNFS.exists(finalPath)) await RNFS.unlink(finalPath)
      } catch (cleanupError) {
        console.warn("TTSModelManager: final cleanup failed:", cleanupError)
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

  async deleteModel(_code?: string): Promise<void> {
    const modelPath = this.getModelPath()
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
    await this.setNativeModelPath(this.getModelPath(), language.languageCode)
  }

  async synthesizeToFile(text: string, options: TTSGenerateOptions = {}): Promise<TTSGenerateResult> {
    const id = options.languageCode || this.currentLanguage
    const language = this.languages[id]
    if (!language) {
      throw new Error(`TTS language ${id} not found`)
    }

    if (!(await this.isModelAvailable(id))) {
      throw new Error(`TTS model is not downloaded`)
    }

    // Make sure the native layer is synced to this language before generating;
    // Supertonic reads the BCP-47 tag from prefs when synthesising.
    if (id !== this.currentLanguage) {
      await this.activateLanguage(id)
    }

    const outputDir = RNFS.CachesDirectoryPath || RNFS.TemporaryDirectoryPath
    const safeId = `${Date.now()}_${Math.random().toString(36).slice(2)}`
    const outputPath = `${outputDir}/mentra_tts_${safeId}.wav`
    const ok = await BluetoothSdk.generateTtsAudio(
      text,
      this.getModelPath(),
      outputPath,
      options.speakerId ?? DEFAULT_SUPERTONIC_VOICE_SID,
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
    await BluetoothSdk.setTtsModelDetails(path, languageCode)
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
