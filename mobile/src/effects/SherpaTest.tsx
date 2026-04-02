import {useState, useEffect, useRef} from "react"
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  Share,
  Platform,
  Pressable,
  ToastAndroid,
} from "react-native"
// import { styles } from './STTScreen.styles';
// import Clipboard from '@react-native-clipboard/clipboard';
import {SafeAreaView} from "react-native-safe-area-context"
// import * as DocumentPicker from '@react-native-documents/picker';
import {
  autoModelPath,
  getAssetPackPath,
  listAssetModels,
  resolveModelPath,
  listModelsAtPath,
} from "react-native-sherpa-onnx"
import {DocumentDirectoryPath} from "@dr.pogodin/react-native-fs"
import {ModelCategory} from "react-native-sherpa-onnx/download"
// import { getSizeHint, getQualityHint } from '/utils/recommendedModels';

import {
  createSTT,
  createStreamingSTT,
  detectSttModel,
  getOnlineTypeOrNull,
  type SttRecognitionResult,
  StreamingSttEngine,
  SttStream,
  SttEngine,
  STTModelType,
} from "react-native-sherpa-onnx/stt"

/**
 * Persists STT/TTS engine instances and UI state across screen navigation.
 * When the user leaves a screen, the instance is not released; when they return,
 * the same state (selected model, Free button visible) is restored.
 *
 * **Lifecycle note:** These module-level caches persist for the lifetime of the JS context.
 * If the JS context is reloaded (e.g. on hot reload or app restart), native instances will
 * not be automatically destroyed and may leak. Call `clearTtsCache` / `clearSttCache` and
 * `.destroy()` on the cached engine in app lifecycle hooks (e.g. AppState 'change' to
 * 'background' or before reloading the bundle) to free native resources.
 */

import type {TtsEngine, TTSModelType} from "react-native-sherpa-onnx/tts"
// import {getAudioFilesForModel, type AudioFileInfo} from "../../audioConfig"
// import { Ionicons } from '@react-native-vector-icons/ionicons';
import {createPcmLiveStream, type PcmLiveStreamHandle} from "react-native-sherpa-onnx/audio"

/**
 * Model configuration helpers for the example app.
 * This is app-specific and not part of the library.
 *
 * These helpers work with any model name - use listAssetModels() to discover
 * available models dynamically instead of hardcoding model names.
 */

import {assetModelPath, fileModelPath, getDefaultModelPath, type ModelPathConfig} from "react-native-sherpa-onnx"

// --- STT cache ---

let sttEngine: SttEngine | null = null
let sttModelFolder: string | null = null
let sttDetectedModels: Array<{type: STTModelType; modelDir: string}> = []
let sttSelectedModelType: STTModelType | null = null

export function getSttCache(): {
  engine: SttEngine | null
  modelFolder: string | null
  detectedModels: Array<{type: STTModelType; modelDir: string}>
  selectedModelType: STTModelType | null
} {
  return {
    engine: sttEngine,
    modelFolder: sttModelFolder,
    detectedModels: [...sttDetectedModels],
    selectedModelType: sttSelectedModelType,
  }
}

export function setSttCache(
  engine: SttEngine,
  modelFolder: string,
  detectedModels: Array<{type: STTModelType; modelDir: string}>,
  selectedModelType: STTModelType | null,
): void {
  sttEngine = engine
  sttModelFolder = modelFolder
  sttDetectedModels = detectedModels
  sttSelectedModelType = selectedModelType
}

export function clearSttCache(): void {
  sttEngine = null
  sttModelFolder = null
  sttDetectedModels = []
  sttSelectedModelType = null
}

// --- TTS cache ---

let ttsEngine: TtsEngine | null = null
let ttsModelFolder: string | null = null
let ttsDetectedModels: Array<{type: TTSModelType; modelDir: string}> = []
let ttsSelectedModelType: TTSModelType | null = null
let ttsModelInfo: {sampleRate: number; numSpeakers: number} | null = null

export function getTtsCache(): {
  engine: TtsEngine | null
  modelFolder: string | null
  detectedModels: Array<{type: TTSModelType; modelDir: string}>
  selectedModelType: TTSModelType | null
  modelInfo: {sampleRate: number; numSpeakers: number} | null
} {
  return {
    engine: ttsEngine,
    modelFolder: ttsModelFolder,
    detectedModels: [...ttsDetectedModels],
    selectedModelType: ttsSelectedModelType,
    modelInfo: ttsModelInfo ? {...ttsModelInfo} : null,
  }
}

export function setTtsCache(
  engine: TtsEngine,
  modelFolder: string,
  detectedModels: Array<{type: TTSModelType; modelDir: string}>,
  selectedModelType: TTSModelType | null,
  modelInfo: {sampleRate: number; numSpeakers: number} | null,
): void {
  ttsEngine = engine
  ttsModelFolder = modelFolder
  ttsDetectedModels = detectedModels
  ttsSelectedModelType = selectedModelType
  ttsModelInfo = modelInfo
}

export function clearTtsCache(): void {
  ttsEngine = null
  ttsModelFolder = null
  ttsDetectedModels = []
  ttsSelectedModelType = null
  ttsModelInfo = null
}
// import {getSttCache, setSttCache, clearSttCache} from "../../engineCache"
// import {
//   getAssetModelPath,
//   getFileModelPath,
//   getModelDisplayName,
// } from '../../modelConfig';

/**
 * Configuration for test audio files.
 * Audio files should be placed in:
 * - Android: example/android/app/src/main/assets/test_wavs/
 * - iOS: example/ios/sherpa_models/test_wavs/ (copied into the app bundle at build time)
 */

export const TEST_AUDIO_FILES = {
  // English test files (for Zipformer model)
  EN_1: "test_wavs/0-en.wav",
  EN_2: "test_wavs/1-en.wav",
  EN_3: "test_wavs/8k-en.wav",

  // Chinese test files (for Paraformer model)
  ZH_1: "test_wavs/0-zh.wav",
  ZH_2: "test_wavs/1-zh.wav",
  ZH_3: "test_wavs/8k-zh.wav",

  // Mixed language files (for Paraformer model)
  ZH_EN_1: "test_wavs/2-zh-en.wav",

  // Japanese, Korean, and Yue (Cantonese) test files (for SenseVoice model)
  JA_1: "test_wavs/ja.wav",
  KO_1: "test_wavs/ko.wav",
  YUE_1: "test_wavs/yue.wav",
} as const

export type AudioFileId = (typeof TEST_AUDIO_FILES)[keyof typeof TEST_AUDIO_FILES]

export interface AudioFileInfo {
  id: AudioFileId
  name: string
  description: string
  language: "en" | "zh" | "ja" | "ko" | "yue"
}

export const AUDIO_FILES: AudioFileInfo[] = [
  {
    id: TEST_AUDIO_FILES.EN_1,
    name: "English Sample 1",
    description: "English audio sample 1",
    language: "en",
  },
  {
    id: TEST_AUDIO_FILES.EN_2,
    name: "English Sample 2",
    description: "English audio sample 2",
    language: "en",
  },
  {
    id: TEST_AUDIO_FILES.EN_3,
    name: "English Sample 3",
    description: "English audio sample 3",
    language: "en",
  },
  {
    id: TEST_AUDIO_FILES.ZH_1,
    name: "中文样本 1",
    description: "Chinese audio sample 1",
    language: "zh",
  },
  {
    id: TEST_AUDIO_FILES.ZH_2,
    name: "中文样本 2",
    description: "Chinese audio sample 2",
    language: "zh",
  },
  {
    id: TEST_AUDIO_FILES.ZH_3,
    name: "中文样本 3",
    description: "Chinese audio sample 3",
    language: "zh",
  },
  {
    id: TEST_AUDIO_FILES.ZH_EN_1,
    name: "中英混合样本",
    description: "Chinese-English mixed audio sample",
    language: "zh", // Paraformer supports both, so we can categorize it as 'zh'
  },
  {
    id: TEST_AUDIO_FILES.JA_1,
    name: "日本語サンプル",
    description: "Japanese audio sample",
    language: "ja",
  },
  {
    id: TEST_AUDIO_FILES.KO_1,
    name: "한국어 샘플",
    description: "Korean audio sample",
    language: "ko",
  },
  {
    id: TEST_AUDIO_FILES.YUE_1,
    name: "粵語樣本",
    description: "Yue (Cantonese) audio sample",
    language: "yue",
  },
]

/**
 * Get audio files compatible with the given model
 * - Zipformer: English files only
 * - Paraformer: All files (English and Chinese) - supports both languages
 * - NeMo CTC: English files only
 * - Whisper: English files only
 * - WeNet CTC: All files (Chinese, English, Cantonese/Yue) - supports multiple languages
 * - SenseVoice: All files (Chinese, English, Japanese, Korean, Yue) - supports multiple languages
 * - FunASR Nano: All files (multi-language support) - supports multiple languages
 */
export function getAudioFilesForModel(modelId: string): AudioFileInfo[] {
  const isParaformer = modelId.includes("paraformer")
  const isZipformer = modelId.includes("zipformer")
  const isNemoCtc = modelId.includes("nemo") && modelId.includes("ctc")
  const isWenetCtc = modelId.includes("wenet") && modelId.includes("ctc")
  const isWhisper = modelId.includes("whisper")
  const isSenseVoice = modelId.includes("sense") || modelId.includes("sensevoice")
  const isFunAsrNano = modelId.includes("funasr") && modelId.includes("nano")
  const isEnglish = modelId.includes("en") && !isParaformer && !isWenetCtc && !isSenseVoice && !isFunAsrNano

  // SenseVoice supports all languages including Japanese, Korean, and Yue
  if (isSenseVoice) {
    return AUDIO_FILES
  }

  // Paraformer, WeNet CTC, and FunASR Nano support multiple languages (but not ja/ko/yue)
  if (isParaformer || isWenetCtc || isFunAsrNano) {
    return AUDIO_FILES.filter((file) => file.language === "en" || file.language === "zh")
  }

  // Zipformer, NeMo CTC, and Whisper support only English
  if (isZipformer || isNemoCtc || isWhisper || isEnglish) {
    return AUDIO_FILES.filter((file) => file.language === "en")
  }

  // Default: return Chinese files (for other models)
  return AUDIO_FILES.filter((file) => file.language === "zh")
}

// import { ModelCategory } from 'react-native-sherpa-onnx/download';

/**
 * Curated list of recommended models for each category.
 * These are suitable for beginners - good balance of quality, size, and speed.
 */
export const RECOMMENDED_MODEL_IDS: Record<string, string[]> = {
  [ModelCategory.Tts]: [
    "vits-piper-en_GB-jenny-medium", // Female voice, English GB
    "vits-piper-en_US-lessac-low", // Male voice, English US, smaller
  ],
  [ModelCategory.Stt]: [
    "sherpa-onnx-en-zipformer-small", // Fast, reasonably accurate
    "sherpa-onnx-en-conformer-tiny-2024-08-19", // Ultra-small, fast
  ],
  [ModelCategory.Vad]: [
    "silero-vad", // Lightweight VAD
  ],
  [ModelCategory.Diarization]: [
    "sherpa-onnx-speaker-diarization-en", // Default diarization
  ],
  [ModelCategory.Enhancement]: [
    "sherpa-onnx-speech-enhancement-1d-cn", // Default enhancement
  ],
  [ModelCategory.Separation]: [
    "sherpa-onnx-source-separation-model", // Default separation
  ],
  [ModelCategory.Qnn]: [],
}

const titleCase = (value: string) => (value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value)

/**
 * Convert a model folder name into a more readable display name.
 */
export function getModelDisplayName(modelFolder: string): string {
  if (!modelFolder) return "Unknown model"
  const cleaned = modelFolder.replace(/^sherpa-onnx-/, "")
  const tokens = cleaned.split(/[-_]+/g).filter(Boolean)

  const mapped = tokens.map((token) => {
    const lower = token.toLowerCase()
    if (["en", "zh", "ja", "ko", "yue"].includes(lower)) {
      return lower.toUpperCase()
    }
    if (["us", "gb"].includes(lower)) {
      return lower.toUpperCase()
    }
    if (["ctc", "asr", "tts", "vits", "mms"].includes(lower)) {
      return lower.toUpperCase()
    }
    return titleCase(lower)
  })

  return mapped.join(" ")
}

/**
 * Get model path with auto-detection (tries asset first, then file system).
 *
 * @param modelName - Model folder name (e.g., 'sherpa-onnx-whisper-tiny-en')
 * @returns Model path configuration
 *
 * @example
 * // Discover models first
 * const models = await listAssetModels();
 * const modelPath = getModelPath(models[0].folder);
 */
export function getModelPath(modelName: string): ModelPathConfig {
  return autoModelPath(`models/${modelName}`)
}

/**
 * Get asset model path for a model folder name.
 *
 * @param modelName - Model folder name (e.g., 'sherpa-onnx-whisper-tiny-en')
 * @returns Model path configuration
 */
export function getAssetModelPath(modelName: string): ModelPathConfig {
  return assetModelPath(`models/${modelName}`)
}

/**
 * Get file system model path for a model folder name.
 *
 * @param modelName - Model folder name (e.g., 'sherpa-onnx-whisper-tiny-en')
 * @param basePath - Base path for file system models (default: platform-specific)
 * @returns Model path configuration
 */
export function getFileModelPath(modelName: string, category?: ModelCategory, basePath?: string): ModelPathConfig {
  const resolvedBase = basePath
    ? basePath.replace(/\/+$/, "")
    : category
      ? `${DocumentDirectoryPath}/sherpa-onnx/models/${category}`
      : getDefaultModelPath()
  const path = `${resolvedBase}/${modelName}`.replace(/\/+/g, "/")
  return fileModelPath(path)
}

/**
 * Model size tier information with icon names for display.
 */
export interface SizeHintInfo {
  tier: string
  description: string
  iconName: string
  iconColor: string
}

export const MODEL_SIZE_HINTS: Record<string, SizeHintInfo> = {
  low: {
    tier: "Low",
    description: "Smaller, faster, lower quality",
    iconName: "speedometer",
    iconColor: "#2E7D32",
  },
  tiny: {
    tier: "Tiny",
    description: "Very small (~10-50MB), fast, suitable for basic use",
    iconName: "flash",
    iconColor: "#388E3C",
  },
  small: {
    tier: "Small",
    description: "Compact (~50-150MB), good speed, decent quality",
    iconColor: "#F9A825",
    iconName: "checkmark-circle",
  },
  medium: {
    tier: "Medium",
    description: "Moderate size (~150-300MB), balanced quality & speed",
    iconName: "options",
    iconColor: "#FB8C00",
  },
  high: {
    tier: "High",
    description: "High quality, larger and slower",
    iconName: "diamond",
    iconColor: "#D32F2F",
  },
  large: {
    tier: "Large",
    description: "Large (>300MB), slower, best quality & accuracy",
    iconName: "star",
    iconColor: "#C62828",
  },
  unknown: {
    tier: "Unknown",
    description: "Size unknown, check before downloading",
    iconName: "help-circle",
    iconColor: "#999999",
  },
}

/**
 * Get size tier hint for a model ID or bytes.
 * Returns icon name, color, and description for display.
 */
export function getSizeHint(id: string, bytes?: number): SizeHintInfo {
  const idLower = id.toLowerCase()
  const unknownFallback: SizeHintInfo = MODEL_SIZE_HINTS.unknown ?? {
    tier: "Unknown",
    description: "Size unknown",
    iconName: "help-circle",
    iconColor: "#999999",
  }

  // Try to infer from ID
  if (idLower.includes("low")) return MODEL_SIZE_HINTS.low ?? unknownFallback
  if (idLower.includes("tiny")) return MODEL_SIZE_HINTS.tiny ?? unknownFallback
  if (idLower.includes("small") || idLower.includes("small-2024")) return MODEL_SIZE_HINTS.small ?? unknownFallback
  if (idLower.includes("medium")) return MODEL_SIZE_HINTS.medium ?? unknownFallback
  if (idLower.includes("high")) return MODEL_SIZE_HINTS.high ?? unknownFallback
  if (idLower.includes("large")) return MODEL_SIZE_HINTS.large ?? unknownFallback

  // Try to infer from bytes
  if (bytes != null) {
    const mb = bytes / (1024 * 1024)
    if (mb < 50) return MODEL_SIZE_HINTS.tiny ?? unknownFallback
    if (mb < 150) return MODEL_SIZE_HINTS.small ?? unknownFallback
    if (mb < 300) return MODEL_SIZE_HINTS.medium ?? unknownFallback
    return MODEL_SIZE_HINTS.large ?? unknownFallback
  }

  return unknownFallback
}

/**
 * Quality hint information with icon names for display.
 */
export interface QualityHintInfo {
  text: string
  iconName: string
  iconColor: string
}

/**
 * Get quality hint based on model tier.
 */
export function getQualityHint(id: string): QualityHintInfo {
  const idLower = id.toLowerCase()

  if (idLower.includes("low")) {
    return {
      text: "Fast, smaller, lower quality",
      iconName: "speedometer",
      iconColor: "#2E7D32",
    }
  }

  if (idLower.includes("tiny") || idLower.includes("small-2024") || idLower.includes("conformer-tiny")) {
    return {
      text: "Fast, good for real-time",
      iconName: "flash",
      iconColor: "#F57C00",
    }
  }

  if (idLower.includes("small")) {
    return {
      text: "Balanced speed & quality",
      iconName: "swap-horizontal",
      iconColor: "#43A047",
    }
  }

  if (idLower.includes("medium")) {
    return {
      text: "Good quality, moderate speed",
      iconName: "options",
      iconColor: "#1E88E5",
    }
  }

  if (idLower.includes("high")) {
    return {
      text: "Best quality, slower",
      iconName: "diamond",
      iconColor: "#D32F2F",
    }
  }

  if (idLower.includes("large")) {
    return {
      text: "Best quality, slower",
      iconName: "star",
      iconColor: "#C62828",
    }
  }

  return {
    text: "Check details",
    iconName: "help-circle",
    iconColor: "#999999",
  }
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const value = (bytes / Math.pow(k, i)).toFixed(1)
  return `${value} ${sizes[i]}`
}

const PAD_PACK_NAME = "sherpa_models"

export default function SherpaTest() {
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [padModelIds, setPadModelIds] = useState<string[]>([])
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [initResult, setInitResult] = useState<string | null>(null)
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(null)
  const [selectedModelForInit, setSelectedModelForInit] = useState<string | null>(null)
  const [detectedModels, setDetectedModels] = useState<Array<{type: STTModelType; modelDir: string}>>([])
  const [selectedModelType, setSelectedModelType] = useState<STTModelType | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorSource, setErrorSource] = useState<"init" | "transcribe" | null>(null)
  const [audioSourceType, setAudioSourceType] = useState<"example" | "own" | "live" | null>(null)
  const [isLiveRecording, setIsLiveRecording] = useState(false)
  const [selectedAudio, setSelectedAudio] = useState<AudioFileInfo | null>(null)
  const [customAudioPath, setCustomAudioPath] = useState<string | null>(null)
  const [customAudioName, setCustomAudioName] = useState<string | null>(null)
  const [transcriptionResult, setTranscriptionResult] = useState<SttRecognitionResult | null>(null)
  const [tokensExpanded, setTokensExpanded] = useState(false)
  const [timestampsExpanded, setTimestampsExpanded] = useState(false)
  const [durationsExpanded, setDurationsExpanded] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [soundPlayer, setSoundPlayer] = useState<any>(null)

  const sttEngineRef = useRef<SttEngine | null>(null)
  const streamingEngineRef = useRef<StreamingSttEngine | null>(null)
  const liveStreamRef = useRef<SttStream | null>(null)
  const liveProcessPromiseRef = useRef<Promise<void>>(Promise.resolve())
  const pcmLiveStreamRef = useRef<{
    handle: PcmLiveStreamHandle
    unsubData: () => void
    unsubError: () => void
  } | null>(null)
  const STT_NUM_THREADS = 2
  const LIVE_SAMPLE_RATE = 16000

  const isLiveSupported = getOnlineTypeOrNull(selectedModelType ?? undefined) !== null

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels()
  }, [])

  // Restore persisted instance state when entering the screen (no cleanup on unmount)
  useEffect(() => {
    const cached = getSttCache()
    if (cached.engine != null && cached.modelFolder != null) {
      sttEngineRef.current = cached.engine
      setCurrentModelFolder(cached.modelFolder)
      setSelectedModelForInit(cached.modelFolder)
      setDetectedModels(cached.detectedModels)
      setSelectedModelType(cached.selectedModelType)
      setInitResult(
        `Initialized: ${getModelDisplayName(cached.modelFolder)}\nDetected models: ${cached.detectedModels
          .map((m: any) => m.type)
          .join(", ")}`,
      )
    }
  }, [])

  const loadAvailableModels = async () => {
    setLoadingModels(true)
    setError(null)
    setErrorSource(null)
    try {
      const assetModels = await listAssetModels()
      const sttFolders = assetModels.filter((model) => model.hint === "stt").map((model) => model.folder)

      // PAD (Play Asset Delivery) or filesystem models: prefer real PAD path, fallback to DocumentDirectoryPath/models
      let padFolders: string[] = []
      let resolvedPadPath: string | null = null
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME)
        const fallbackPath = `${DocumentDirectoryPath}/models`
        const padPath = padPathFromNative ?? fallbackPath
        const padResults = await listModelsAtPath(padPath)
        padFolders = (padResults || []).filter((m) => m.hint === "stt").map((m) => m.folder)
        if (padFolders.length > 0) {
          resolvedPadPath = padPath
          console.log("STTScreen: Found PAD/filesystem STT models:", padFolders, "at", padPath)
        }
      } catch (e) {
        console.warn("STTScreen: PAD/listModelsAtPath failed", e)
        padFolders = []
      }
      setPadModelsPath(resolvedPadPath)

      // Merge: PAD folders, then bundled asset folders (no duplicates)
      const combined = [...padFolders, ...sttFolders.filter((f) => !padFolders.includes(f))]

      setPadModelIds(padFolders)
      if (sttFolders.length > 0) {
        console.log("STTScreen: Found asset models:", sttFolders)
      }
      setAvailableModels(combined)

      if (combined.length === 0) {
        setErrorSource("init")
        setError("No STT models found. Use bundled assets or PAD models. See STT_MODEL_SETUP.md")
      }
    } catch (err) {
      console.error("STTScreen: Failed to load models:", err)
      setErrorSource("init")
      setError("Failed to load available models")
      setAvailableModels([])
    } finally {
      setLoadingModels(false)
    }
  }

  const handleInitialize = async (modelFolder: string) => {
    setLoading(true)
    setError(null)
    setErrorSource(null)
    setInitResult(null)
    setDetectedModels([])
    setSelectedModelType(null)

    try {
      // Release previous engine if switching to another model
      const previous = sttEngineRef.current
      if (previous) {
        await previous.destroy()
        sttEngineRef.current = null
        clearSttCache()
      }

      const useFilePath = padModelIds.includes(modelFolder)
      const modelPath = useFilePath
        ? padModelIds.includes(modelFolder) && padModelsPath
          ? getFileModelPath(modelFolder, ModelCategory.Stt, padModelsPath)
          : getFileModelPath(modelFolder, ModelCategory.Stt)
        : getAssetModelPath(modelFolder)

      const engine = await createSTT({
        modelPath,
        numThreads: STT_NUM_THREADS,
      })

      const detectResult = await detectSttModel(modelPath)
      if (!detectResult.success || !detectResult.detectedModels?.length) {
        await engine.destroy()
        setErrorSource("init")
        setError("No models detected in the directory")
        setInitResult("Initialization failed: No compatible models found")
        return
      }

      const normalizedDetected = detectResult.detectedModels.map((model) => ({
        ...model,
        type: model.type as STTModelType,
      }))
      const loadedType = (detectResult.modelType as STTModelType) ?? normalizedDetected[0]?.type

      sttEngineRef.current = engine
      setDetectedModels(normalizedDetected)
      setCurrentModelFolder(modelFolder)
      setSelectedModelForInit(modelFolder)
      if (loadedType) {
        setSelectedModelType(loadedType)
      } else if (normalizedDetected.length === 1 && normalizedDetected[0]) {
        setSelectedModelType(normalizedDetected[0].type)
      }

      const detectedTypes = normalizedDetected.map((m) => m.type).join(", ")
      setInitResult(`Initialized: ${getModelDisplayName(modelFolder)}\nDetected models: ${detectedTypes}`)

      setSttCache(engine, modelFolder, normalizedDetected, loadedType ?? normalizedDetected[0]?.type ?? null)

      setAudioSourceType(null)
      setSelectedAudio(null)
      setCustomAudioPath(null)
      setCustomAudioName(null)
      setTranscriptionResult(null)
    } catch (err) {
      // Log full error details for debugging
      console.error("Initialization error:", err)

      let errorMessage = "Unknown error"
      if (err instanceof Error) {
        errorMessage = err.message
        // Include error code if available (React Native error objects)
        if ("code" in err) {
          errorMessage = `[${err.code}] ${errorMessage}`
        }
        // Include stack trace in console
        if (err.stack) {
          console.error("Stack trace:", err.stack)
        }
      } else if (typeof err === "object" && err !== null) {
        // Handle React Native error objects
        const errorObj = err as any
        errorMessage = errorObj.message || errorObj.userInfo?.NSLocalizedDescription || JSON.stringify(err)
        if (errorObj.code) {
          errorMessage = `[${errorObj.code}] ${errorMessage}`
        }
      }

      setErrorSource("init")
      setError(errorMessage)
      setInitResult(
        `Initialization failed: ${errorMessage}\n\nThe error has been reported. We will address it as soon as possible in the next app update.`,
      )
    } finally {
      setLoading(false)
    }
  }

  const handleTranscribe = async () => {
    if (!currentModelFolder) {
      setErrorSource("transcribe")
      setError("Please select a model first")
      return
    }

    // If a custom audio file was chosen, prefer it
    if (!selectedAudio && !customAudioPath) {
      setErrorSource("transcribe")
      setError("Please select an audio file (example or local WAV)")
      return
    }

    setTranscribing(true)
    setError(null)
    setErrorSource(null)
    setTranscriptionResult(null)

    try {
      let pathToTranscribe: string

      if (customAudioPath) {
        pathToTranscribe = customAudioPath
      } else {
        // Resolve audio file path (using auto detection - tries asset first, then file system)
        const audioPathConfig = autoModelPath(selectedAudio!.id)
        pathToTranscribe = await resolveModelPath(audioPathConfig)
      }

      const engine = sttEngineRef.current
      if (!engine) {
        setErrorSource("transcribe")
        setError("STT engine not initialized")
        return
      }
      const result = await engine.transcribeFile(pathToTranscribe)
      setTranscriptionResult(result)
    } catch (err) {
      const msg = (err instanceof Error ? err.message : (err as any)?.message) ?? ""
      if (msg.includes("cache_last_time")) {
        const friendly =
          'This model appears to be a NeMo streaming transducer (e.g. "streaming fast conformer"). File transcription currently requires a non-streaming NeMo transducer model. Please use a model exported for offline/non-streaming use, or choose another STT model.'
        Alert.alert("Transcription not supported", friendly)
        setErrorSource("transcribe")
        setError(friendly)
        return
      }

      let errorMessage = "Unknown error"
      if (err instanceof Error) {
        errorMessage = err.message
        if ("code" in err) {
          errorMessage = `[${err.code}] ${errorMessage}`
        }
      } else if (typeof err === "object" && err !== null) {
        const errorObj = err as any
        errorMessage = errorObj.message || errorObj.userInfo?.NSLocalizedDescription || JSON.stringify(err)
        if (errorObj.code) {
          errorMessage = `[${errorObj.code}] ${errorMessage}`
        }
      }

      setErrorSource("transcribe")
      setError(errorMessage)
    } finally {
      setTranscribing(false)
    }
  }

  const handleFree = async () => {
    const engine = sttEngineRef.current
    if (!engine) return
    try {
      await engine.destroy()
    } catch (err) {
      console.error("STTScreen: Failed to destroy STT:", err)
    }
    sttEngineRef.current = null
    clearSttCache()
    setCurrentModelFolder(null)
    setSelectedModelForInit(null)
    setDetectedModels([])
    setSelectedModelType(null)
    setInitResult(null)
    setAudioSourceType(null)
    setSelectedAudio(null)
    setCustomAudioPath(null)
    setCustomAudioName(null)
    setTranscriptionResult(null)
    setError(null)
    setErrorSource(null)
  }

  const handlePickLocalFile = async () => {
    setError(null)
    setErrorSource(null)
    setTranscriptionResult(null)

    // try {
    //   const res = await DocumentPicker.pick({
    //     type: [DocumentPicker.types.audio],
    //   });

    //   // res may be an array or single object depending on version/config
    //   const file = Array.isArray(res) ? res[0] : res;
    //   const uri = file.uri || file.name;
    //   const name = file.name || uri?.split('/')?.pop() || 'local.wav';

    //   if (!uri) {
    //     setErrorSource('transcribe');
    //     setError('Could not get file URI from picker result');
    //     return;
    //   }

    //   setCustomAudioPath(uri);
    //   setCustomAudioName(name);
    //   // clear example selection when choosing a local file
    //   setSelectedAudio(null);
    // } catch (err: any) {
    // //   const isCancel =
    // //     (DocumentPicker &&
    // //       typeof (DocumentPicker as any).isCancel === 'function' &&
    // //       (DocumentPicker as any).isCancel(err)) ||
    // //     err?.code === 'DOCUMENT_PICKER_CANCELED' ||
    // //     err?.name === 'DocumentPickerCanceled' ||
    // //     (typeof err?.message === 'string' &&
    // //       err.message.toLowerCase().includes('cancel'));
    // //   if (isCancel) {
    // //     // user cancelled, ignore
    // //     return;
    // //   }
    // //   console.error('File pick error:', err);
    // //   setErrorSource('transcribe');
    // //   setError(err instanceof Error ? err.message : String(err));
    // }
  }

  const handlePlayAudio = () => {
    if (!customAudioPath) return

    try {
      // Try to use react-native-sound if available

      const Sound = require("react-native-sound")
      Sound.setCategory("Playback")

      // Stop previous player if any
      if (soundPlayer) {
        soundPlayer.stop()
        soundPlayer.release()
      }

      const player = new Sound(customAudioPath, "", (soundErr: any) => {
        if (soundErr) {
          console.error("Failed to load sound", soundErr)
          Alert.alert("Error", "Failed to load audio file")
          return
        }
        // Play the audio
        player.play((success: boolean) => {
          if (!success) {
            Alert.alert("Error", "Playback failed")
          }
          player.release()
        })
      })

      setSoundPlayer(player)
    } catch {
      Alert.alert(
        "Audio Playback Not Available",
        "Please install react-native-sound to play audio files:\n\ncd example\nnpm install react-native-sound",
      )
    }
  }

  const handleLivePressIn = async () => {
    if (!currentModelFolder || !selectedModelType || !isLiveSupported) return
    if (isLiveRecording) {
      handleLivePressOut()
      return
    }
    setError(null)
    setErrorSource(null)
    setTranscriptionResult(null)

    try {
      const useFilePath = padModelIds.includes(currentModelFolder)
      const modelPathConfig = useFilePath
        ? padModelsPath
          ? getFileModelPath(currentModelFolder, ModelCategory.Stt, padModelsPath)
          : getFileModelPath(currentModelFolder, ModelCategory.Stt)
        : getAssetModelPath(currentModelFolder)

      const onlineType = getOnlineTypeOrNull(selectedModelType)
      if (!onlineType) return

      const engine = await createStreamingSTT({
        modelPath: modelPathConfig,
        modelType: onlineType,
        numThreads: STT_NUM_THREADS,
      })
      streamingEngineRef.current = engine
      const stream = await engine.createStream()
      liveStreamRef.current = stream

      const pcmHandle = createPcmLiveStream({sampleRate: LIVE_SAMPLE_RATE})
      const unsubData = pcmHandle.onData((samples, sampleRate) => {
        const streamCurrent = liveStreamRef.current
        if (!streamCurrent) return
        const prev = liveProcessPromiseRef.current
        liveProcessPromiseRef.current = (async () => {
          await prev
          if (!liveStreamRef.current) return
          try {
            const {result} = await streamCurrent.processAudioChunk(samples, sampleRate)
            setTranscriptionResult({
              text: result.text,
              tokens: result.tokens,
              timestamps: result.timestamps,
              lang: "",
              emotion: "",
              event: "",
              durations: [],
            })
          } catch {
            // ignore chunk errors (e.g. after release)
          }
        })()
      })
      const unsubError = pcmHandle.onError((message) => {
        setErrorSource("transcribe")
        setError(message)
      })
      pcmLiveStreamRef.current = {handle: pcmHandle, unsubData, unsubError}
      try {
        await pcmHandle.start()
      } catch (startErr) {
        pcmHandle.stop().catch(() => {})
        unsubData()
        unsubError()
        pcmLiveStreamRef.current = null
        throw startErr
      }
      setIsLiveRecording(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorSource("transcribe")
      setError(msg)
    }
  }

  const handleLivePressOut = async () => {
    if (!isLiveRecording) return
    setIsLiveRecording(false)

    const pcmCur = pcmLiveStreamRef.current
    if (pcmCur) {
      await pcmCur.handle.stop()
      pcmCur.unsubData()
      pcmCur.unsubError()
      pcmLiveStreamRef.current = null
    }

    const stream = liveStreamRef.current
    const engine = streamingEngineRef.current

    try {
      await Promise.race([liveProcessPromiseRef.current, new Promise<void>((r) => setTimeout(r, 3000))])
    } catch {
      // ignore
    }

    if (stream && engine) {
      try {
        await stream.inputFinished()
        while (await stream.isReady()) {
          await stream.decode()
          const result = await stream.getResult()
          setTranscriptionResult({
            text: result.text,
            tokens: result.tokens,
            timestamps: result.timestamps,
            lang: "",
            emotion: "",
            event: "",
            durations: [],
          })
        }
      } catch {
        // ignore
      } finally {
        try {
          await stream.release()
        } catch {}
        try {
          await engine.destroy()
        } catch {}
        streamingEngineRef.current = null
        liveStreamRef.current = null
      }
    }
  }

  const showLiveNotSupportedMessage = () => {
    const message =
      "This model does not support live transcription. Use a streaming model (e.g. transducer, paraformer, zipformer2_ctc)."
    if (Platform.OS === "android") {
      ToastAndroid.show(message, ToastAndroid.LONG)
    } else {
      Alert.alert("Live not supported", message)
    }
  }

  // Get available audio files for current model
  const availableAudioFiles = currentModelFolder ? getAudioFilesForModel(currentModelFolder) : []

  return (
    <View className="flex-1 absolute inset-0 bg-white z-10 pt-30">
      <ScrollView
        className="flex-1"
        contentContainerClassName="p-4 pb-10"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        {currentModelFolder != null && (
          <TouchableOpacity
            className="bg-red-50 border border-red-300 rounded-lg py-2 px-4 mb-4 self-start"
            onPress={handleFree}
            disabled={loading}>
            <Text className="text-red-600 font-medium">Release model</Text>
          </TouchableOpacity>
        )}

        {/* Section 1: Initialize Model */}
        <View className="mb-6">
          <Text className="text-lg font-bold text-gray-900 mb-1">1. Initialize Model</Text>
          <Text className="text-sm text-gray-500 mb-3">Select a model, then tap "Use model".</Text>

          {(currentModelFolder || selectedModelForInit) && (
            <View className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-3">
              <Text className="text-green-800 text-sm font-medium">
                {currentModelFolder
                  ? `Initialized: ${getModelDisplayName(currentModelFolder)}`
                  : `Selected: ${selectedModelForInit ? getModelDisplayName(selectedModelForInit) : ""}`}
              </Text>
            </View>
          )}

          {loadingModels ? (
            <View className="items-center py-8">
              <ActivityIndicator size="large" color="#007AFF" />
              <Text className="text-gray-500 mt-3">Discovering available models...</Text>
            </View>
          ) : availableModels.length === 0 ? (
            <View className="bg-yellow-50 border border-yellow-300 rounded-lg p-3">
              <Text className="text-yellow-800 text-sm">
                No models found in assets/models/ folder. Please add STT models first. See STT_MODEL_SETUP.md for
                details.
              </Text>
            </View>
          ) : (
            <View className="flex-row flex-wrap gap-2">
              {availableModels.map((modelFolder) => {
                const isSelected = selectedModelForInit === modelFolder
                const isInitialized = currentModelFolder === modelFolder
                return (
                  <TouchableOpacity
                    key={modelFolder}
                    className={`border rounded-lg p-3 min-w-[140px] flex-1 ${
                      isInitialized
                        ? "bg-green-50 border-green-400"
                        : isSelected
                          ? "bg-blue-50 border-blue-400"
                          : "bg-white border-gray-200"
                    } ${loading ? "opacity-50" : ""}`}
                    onPress={() => setSelectedModelForInit(modelFolder)}
                    disabled={loading}>
                    <Text className={`font-semibold text-sm ${isSelected ? "text-blue-700" : "text-gray-800"}`}>
                      {getModelDisplayName(modelFolder)}
                    </Text>
                    {(() => {
                      const sizeHintInfo = getSizeHint(modelFolder)
                      const qualityHintInfo = getQualityHint(modelFolder)
                      return (
                        <View className="flex-row gap-3 mt-1">
                          <View className="flex-row items-center gap-1">
                            <Text style={{color: sizeHintInfo.iconColor}} className="text-xs">
                              ●
                            </Text>
                            <Text className="text-xs text-gray-500">{sizeHintInfo.tier}</Text>
                          </View>
                          <View className="flex-row items-center gap-1">
                            <Text style={{color: qualityHintInfo.iconColor}} className="text-xs">
                              ★
                            </Text>
                            <Text className="text-xs text-gray-500">{qualityHintInfo.text.split(",")[0]}</Text>
                          </View>
                        </View>
                      )
                    })()}
                    <Text className="text-xs text-gray-400 mt-1">{modelFolder}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          )}

          <TouchableOpacity
            className={`bg-blue-600 rounded-lg py-3 px-4 mt-4 items-center ${
              loading || (!selectedModelForInit && !currentModelFolder) ? "opacity-50" : ""
            }`}
            onPress={() => handleInitialize(selectedModelForInit ?? currentModelFolder ?? "")}
            disabled={loading || (!selectedModelForInit && !currentModelFolder)}>
            {loading ? (
              <View className="flex-row items-center gap-2">
                <ActivityIndicator size="small" color="#FFFFFF" />
                <Text className="text-white font-semibold">Initializing…</Text>
              </View>
            ) : (
              <Text className="text-white font-semibold">Use model</Text>
            )}
          </TouchableOpacity>

          {initResult && !(error && errorSource === "init") && (
            <View className="bg-gray-50 rounded-lg p-3 mt-3">
              <Text className="text-xs font-semibold text-gray-500 mb-1">Result:</Text>
              <Text className="text-sm text-gray-800">{initResult}</Text>
            </View>
          )}

          {error && errorSource === "init" && (
            <View className="bg-red-50 border border-red-200 rounded-lg p-3 mt-3">
              <Text className="text-xs font-semibold text-red-500 mb-1">Error:</Text>
              <Text className="text-sm text-red-700">{error}</Text>
            </View>
          )}
        </View>

        {/* Section 2: Select Model Type (if multiple detected) */}
        {detectedModels.length > 1 && (
          <View className="mb-6">
            <Text className="text-lg font-bold text-gray-900 mb-1">2. Select Model Type</Text>
            <Text className="text-sm text-gray-500 mb-3">
              Multiple model types were detected. Select which one to use for transcription.
            </Text>

            <View className="gap-2">
              {detectedModels.map((model, index) => (
                <TouchableOpacity
                  key={`${model.type}-${index}`}
                  className={`border rounded-lg p-3 ${
                    selectedModelType === model.type ? "bg-blue-50 border-blue-400" : "bg-white border-gray-200"
                  }`}
                  onPress={() => setSelectedModelType(model.type)}>
                  <Text
                    className={`font-bold text-sm ${
                      selectedModelType === model.type ? "text-blue-700" : "text-gray-800"
                    }`}>
                    {model.type.toUpperCase()}
                  </Text>
                  <Text className="text-xs text-gray-400 mt-1">
                    {getModelDisplayName(model.modelDir.replace(/^.*[/\\]/, "") || model.modelDir)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {!selectedModelType && (
              <View className="bg-yellow-50 border border-yellow-300 rounded-lg p-3 mt-3">
                <Text className="text-yellow-800 text-sm">Please select a model type above</Text>
              </View>
            )}
          </View>
        )}

        {/* Section: Transcribe Audio */}
        <View className="mb-6">
          <Text className="text-lg font-bold text-gray-900 mb-1">
            {detectedModels.length > 1 ? "3. Transcribe Audio" : "2. Transcribe Audio"}
          </Text>
          <Text className="text-sm text-gray-500 mb-3">
            Select an audio source and transcribe it using the selected model.
          </Text>

          {!selectedModelType && (
            <View className="bg-yellow-50 border border-yellow-300 rounded-lg p-3">
              <Text className="text-yellow-800 text-sm">
                {!currentModelFolder ? "Please initialize a model directory first" : "Please select a model type first"}
              </Text>
            </View>
          )}

          {/* Audio source chooser */}
          {selectedModelType && !audioSourceType && (
            <>
              <Text className="font-semibold text-gray-700 mb-2">Choose Audio Source:</Text>
              <View className="flex-row gap-2">
                <TouchableOpacity
                  className="flex-1 bg-gray-50 border border-gray-200 rounded-lg p-3 items-center"
                  onPress={() => setAudioSourceType("example")}>
                  <Text className="text-lg mb-1">📁</Text>
                  <Text className="text-sm font-medium text-gray-700 text-center">Example Audio</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  className="flex-1 bg-gray-50 border border-gray-200 rounded-lg p-3 items-center"
                  onPress={() => setAudioSourceType("own")}>
                  <Text className="text-lg mb-1">🎵</Text>
                  <Text className="text-sm font-medium text-gray-700 text-center">Your Own Audio</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  className={`flex-1 border rounded-lg p-3 items-center ${
                    isLiveSupported ? "bg-gray-50 border-gray-200" : "bg-gray-100 border-gray-100 opacity-50"
                  }`}
                  onPress={() => {
                    if (isLiveSupported) setAudioSourceType("live")
                    else showLiveNotSupportedMessage()
                  }}>
                  <Text className="text-lg mb-1">🎤</Text>
                  <Text className="text-sm font-medium text-gray-700 text-center">Live Transcription</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* Example audio */}
          {selectedModelType && audioSourceType === "example" && availableAudioFiles.length > 0 && (
            <>
              <Text className="font-semibold text-gray-700 mb-2">Select Audio File:</Text>
              <View className="gap-2">
                {availableAudioFiles.map((audioFile: any) => (
                  <TouchableOpacity
                    key={audioFile.id}
                    className={`border rounded-lg p-3 ${
                      selectedAudio?.id === audioFile.id ? "bg-blue-50 border-blue-400" : "bg-white border-gray-200"
                    }`}
                    onPress={() => setSelectedAudio(audioFile)}>
                    <Text
                      className={`font-semibold text-sm ${
                        selectedAudio?.id === audioFile.id ? "text-blue-700" : "text-gray-800"
                      }`}>
                      {audioFile.name}
                    </Text>
                    <Text className="text-xs text-gray-500 mt-1">{audioFile.description}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {selectedAudio && (
                <TouchableOpacity
                  className={`bg-blue-600 rounded-lg py-3 px-4 mt-3 items-center ${
                    transcribing || loading ? "opacity-50" : ""
                  }`}
                  onPress={handleTranscribe}
                  disabled={transcribing || loading}>
                  {transcribing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text className="text-white font-semibold">Transcribe Audio</Text>
                  )}
                </TouchableOpacity>
              )}

              <TouchableOpacity
                className="mt-4 py-2"
                onPress={() => {
                  setAudioSourceType(null)
                  setSelectedAudio(null)
                  setTranscriptionResult(null)
                }}>
                <Text className="text-blue-600 text-sm">← Change Audio Source</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Own audio */}
          {selectedModelType && audioSourceType === "own" && (
            <>
              <Text className="font-semibold text-gray-700 mb-2">Select Local WAV File:</Text>
              <TouchableOpacity
                className={`bg-blue-600 rounded-lg py-3 px-4 items-center flex-row justify-center gap-2 ${
                  loading ? "opacity-50" : ""
                }`}
                onPress={handlePickLocalFile}
                disabled={loading}>
                <Text className="text-white">📂</Text>
                <Text className="text-white font-semibold">Choose Local WAV</Text>
              </TouchableOpacity>

              {customAudioName && (
                <View className="bg-gray-50 rounded-lg p-3 mt-3">
                  <Text className="text-xs text-gray-500">Selected file:</Text>
                  <Text className="text-sm font-medium text-gray-800 mt-1">{customAudioName}</Text>
                  <TouchableOpacity className="flex-row items-center gap-1 mt-2" onPress={handlePlayAudio}>
                    <Text>▶️</Text>
                    <Text className="text-blue-600 text-sm font-medium">Play Audio</Text>
                  </TouchableOpacity>
                </View>
              )}

              {customAudioPath && (
                <TouchableOpacity
                  className={`bg-blue-600 rounded-lg py-3 px-4 mt-3 items-center ${
                    transcribing || loading ? "opacity-50" : ""
                  }`}
                  onPress={handleTranscribe}
                  disabled={transcribing || loading}>
                  {transcribing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text className="text-white font-semibold">Transcribe Audio</Text>
                  )}
                </TouchableOpacity>
              )}

              <TouchableOpacity
                className="mt-4 py-2"
                onPress={() => {
                  setAudioSourceType(null)
                  setCustomAudioPath(null)
                  setCustomAudioName(null)
                  setTranscriptionResult(null)
                  if (soundPlayer) {
                    soundPlayer.stop()
                    soundPlayer.release()
                    setSoundPlayer(null)
                  }
                }}>
                <Text className="text-blue-600 text-sm">← Change Audio Source</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Live transcription */}
          {selectedModelType && audioSourceType === "live" && (
            <>
              <Text className="font-semibold text-gray-700 mb-1">Live Transcription</Text>
              <Text className="text-xs text-gray-400 mb-4">Input: Default</Text>
              <View className="items-center">
                <Pressable
                  className={`w-24 h-24 rounded-full items-center justify-center ${
                    isLiveRecording ? "bg-red-500" : "bg-blue-600"
                  }`}
                  onPressIn={handleLivePressIn}
                  onPressOut={handleLivePressOut}>
                  <Text className="text-white text-4xl">🎤</Text>
                </Pressable>
              </View>
              <Text className="text-xs text-gray-500 text-center mt-3">
                Hold the button and speak. Release to see the final result.
              </Text>
              <TouchableOpacity
                className="mt-4 py-2"
                onPress={() => {
                  if (isLiveRecording) return
                  setAudioSourceType(null)
                  setTranscriptionResult(null)
                }}
                disabled={isLiveRecording}>
                <Text className="text-blue-600 text-sm">← Change Audio Source</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Transcription results */}
          {selectedModelType &&
            (audioSourceType === "example" || audioSourceType === "own" || audioSourceType === "live") &&
            (audioSourceType === "live" || transcriptionResult) && (
              <View
                className={`bg-green-50 border border-green-200 rounded-lg p-4 mt-4 ${
                  audioSourceType === "live" ? "min-h-[120px]" : ""
                }`}>
                {transcriptionResult ? (
                  <>
                    <View className="flex-row justify-between items-center mb-2">
                      <Text className="text-xs font-semibold text-green-800">Transcription:</Text>
                      <View className="flex-row gap-3">
                        <TouchableOpacity
                          onPress={() => {
                            const t = transcriptionResult.text ?? ""
                            //   if (t) Clipboard.setString(t)
                          }}
                          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                          <Text className="text-green-700 text-sm">📋</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => {
                            const t = transcriptionResult.text ?? ""
                            if (t) Share.share({message: t, title: "Transcription"})
                          }}
                          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                          <Text className="text-green-700 text-sm">↗</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                    <Text className="text-base text-gray-900 leading-6" selectable>
                      {transcriptionResult.text ?? ""}
                    </Text>

                    {(transcriptionResult.lang || transcriptionResult.emotion || transcriptionResult.event) && (
                      <View className="flex-row gap-3 mt-2">
                        {transcriptionResult.lang && (
                          <Text className="text-xs text-gray-500">Lang: {transcriptionResult.lang}</Text>
                        )}
                        {transcriptionResult.emotion && (
                          <Text className="text-xs text-gray-500">Emotion: {transcriptionResult.emotion}</Text>
                        )}
                        {transcriptionResult.event && (
                          <Text className="text-xs text-gray-500">Event: {transcriptionResult.event}</Text>
                        )}
                      </View>
                    )}

                    {/* Tokens collapsible */}
                    <TouchableOpacity
                      className="flex-row items-center mt-3"
                      onPress={() => setTokensExpanded((e) => !e)}>
                      <Text className="text-green-700 text-xs mr-1">{tokensExpanded ? "▼" : "▶"}</Text>
                      <Text className="text-green-700 text-xs font-semibold">
                        Tokens ({(transcriptionResult.tokens ?? []).length})
                      </Text>
                    </TouchableOpacity>
                    {tokensExpanded && (
                      <View className="bg-white rounded-md p-2 mt-1">
                        <View className="flex-row gap-3 mb-2">
                          <TouchableOpacity
                            className="flex-row items-center gap-1"
                            onPress={() => {
                              const arr = transcriptionResult.tokens ?? []
                              // Clipboard.setString(JSON.stringify(arr))
                            }}>
                            <Text className="text-green-700 text-xs">📋</Text>
                            <Text className="text-green-700 text-xs">Copy</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            className="flex-row items-center gap-1"
                            onPress={() => {
                              const arr = transcriptionResult.tokens ?? []
                              Share.share({message: JSON.stringify(arr), title: "Tokens"})
                            }}>
                            <Text className="text-green-700 text-xs">↗</Text>
                            <Text className="text-green-700 text-xs">Share</Text>
                          </TouchableOpacity>
                        </View>
                        <Text className="text-xs text-gray-600">{(transcriptionResult.tokens ?? []).join(", ")}</Text>
                      </View>
                    )}

                    {/* Timestamps collapsible */}
                    <TouchableOpacity
                      className="flex-row items-center mt-3"
                      onPress={() => setTimestampsExpanded((e) => !e)}>
                      <Text className="text-green-700 text-xs mr-1">{timestampsExpanded ? "▼" : "▶"}</Text>
                      <Text className="text-green-700 text-xs font-semibold">
                        Timestamps ({(transcriptionResult.timestamps ?? []).length})
                      </Text>
                    </TouchableOpacity>
                    {timestampsExpanded && (
                      <View className="bg-white rounded-md p-2 mt-1">
                        <View className="flex-row gap-3 mb-2">
                          <TouchableOpacity
                            className="flex-row items-center gap-1"
                            onPress={() => {
                              // Clipboard.setString(JSON.stringify(transcriptionResult.timestamps ?? []))
                            }}>
                            <Text className="text-green-700 text-xs">📋 Copy</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            className="flex-row items-center gap-1"
                            onPress={() => {
                              Share.share({
                                message: JSON.stringify(transcriptionResult.timestamps ?? []),
                                title: "Timestamps",
                              })
                            }}>
                            <Text className="text-green-700 text-xs">↗ Share</Text>
                          </TouchableOpacity>
                        </View>
                        {(transcriptionResult.timestamps ?? []).length > 0 && (
                          <ScrollView className="max-h-40" nestedScrollEnabled showsVerticalScrollIndicator>
                            {(transcriptionResult.timestamps ?? []).map((item, i) => (
                              <Text key={`ts-${i}`} className="text-xs text-gray-600">
                                [{String(item)}]
                              </Text>
                            ))}
                          </ScrollView>
                        )}
                      </View>
                    )}

                    {/* Durations collapsible */}
                    <TouchableOpacity
                      className="flex-row items-center mt-3"
                      onPress={() => setDurationsExpanded((e) => !e)}>
                      <Text className="text-green-700 text-xs mr-1">{durationsExpanded ? "▼" : "▶"}</Text>
                      <Text className="text-green-700 text-xs font-semibold">
                        Durations ({(transcriptionResult.durations ?? []).length})
                      </Text>
                    </TouchableOpacity>
                    {durationsExpanded && (
                      <View className="bg-white rounded-md p-2 mt-1">
                        <View className="flex-row gap-3 mb-2">
                          <TouchableOpacity
                            className="flex-row items-center gap-1"
                            onPress={() => {
                              // Clipboard.setString(JSON.stringify(transcriptionResult.durations ?? []))
                            }}>
                            <Text className="text-green-700 text-xs">📋 Copy</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            className="flex-row items-center gap-1"
                            onPress={() => {
                              Share.share({
                                message: JSON.stringify(transcriptionResult.durations ?? []),
                                title: "Durations",
                              })
                            }}>
                            <Text className="text-green-700 text-xs">↗ Share</Text>
                          </TouchableOpacity>
                        </View>
                        {(transcriptionResult.durations ?? []).length > 0 && (
                          <ScrollView className="max-h-40" nestedScrollEnabled showsVerticalScrollIndicator>
                            {(transcriptionResult.durations ?? []).map((item, i) => (
                              <Text key={`d-${i}`} className="text-xs text-gray-600">
                                [{String(item)}]
                              </Text>
                            ))}
                          </ScrollView>
                        )}
                      </View>
                    )}

                    {/* Export actions */}
                    <View className="flex-row gap-3 mt-4 pt-3 border-t border-green-200">
                      <TouchableOpacity
                        className="flex-row items-center gap-1"
                        //   onPress={() => Clipboard.setString(JSON.stringify(transcriptionResult, null, 2))}>
                      >
                        <Text className="text-green-700 text-sm">📋</Text>
                        <Text className="text-green-700 text-sm font-medium">Copy all as JSON</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        className="flex-row items-center gap-1"
                        onPress={() =>
                          Share.share({
                            message: JSON.stringify(transcriptionResult, null, 2),
                            title: "Export all as JSON",
                          })
                        }>
                        <Text className="text-green-700 text-sm font-medium">Export all as JSON</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <Text className="text-gray-500 text-sm">Transcription will appear here while you speak.</Text>
                )}
              </View>
            )}

          {selectedModelType && audioSourceType === "example" && availableAudioFiles.length === 0 && (
            <View className="py-4">
              <Text className="text-gray-500 text-sm">No audio files available for this model</Text>
            </View>
          )}

          {error && errorSource === "transcribe" && (
            <View className="bg-red-50 border border-red-200 rounded-lg p-3 mt-3">
              <Text className="text-xs font-semibold text-red-500">Error:</Text>
              <Text className="text-sm text-red-700">{error}</Text>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  )
}
