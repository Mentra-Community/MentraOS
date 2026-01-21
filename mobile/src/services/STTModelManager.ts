import CoreModule from "core"
import {Platform} from "react-native"
import * as RNFS from "@dr.pogodin/react-native-fs"

export interface ModelInfo {
  name: string
  version: string
  size: number
  language: string
  downloaded: boolean
  path?: string
  modelId: string
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

export interface ModelConfig {
  id: string
  displayName: string
  fileName: string
  size: number
  type: "transducer" | "ctc"
  requiredFiles: string[]
  languageCode: string
}

class STTModelManager {
  private static instance: STTModelManager
  private downloadJobId?: number
  private currentModelId = "sherpa-onnx-streaming-zipformer-en-2023-06-21-mobile"
  private modelBaseUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"

  private models: Record<string, ModelConfig> = {
    "sherpa-onnx-streaming-zipformer-en-2023-06-21-mobile": {
      id: "sherpa-onnx-streaming-zipformer-en-2023-06-21-mobile",
      displayName: "English",
      fileName: "sherpa-onnx-streaming-zipformer-en-2023-06-21-mobile",
      size: 349 * 1024 * 1024, // 349MB
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "en-US",
    },
    // "sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms-int8": {
    //   id: "sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms-int8",
    //   displayName: "English (Faster)",
    //   fileName: "sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms-int8",
    //   size: 95 * 1024 * 1024, // 95MB
    //   type: "ctc",
    //   requiredFiles: ["model.int8.onnx", "tokens.txt"],
    //   languageCode: "en-US",
    // },
    "sherpa-onnx-streaming-zipformer-zh-2025-06-30": {
      id: "sherpa-onnx-streaming-zipformer-zh-2025-06-30",
      displayName: "Chinese",
      fileName: "sherpa-onnx-streaming-zipformer-zh-2025-06-30",
      size: 150 * 1024 * 1024, // Estimated
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "zh-CN",
    },
    "sherpa-onnx-streaming-zipformer-korean-2024-06-16": {
      id: "sherpa-onnx-streaming-zipformer-korean-2024-06-16",
      displayName: "Korean",
      fileName: "sherpa-onnx-streaming-zipformer-korean-2024-06-16",
      size: 200 * 1024 * 1024, // Estimated
      type: "transducer",
      requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      languageCode: "ko-KR",
    },
    // NOTE (yash): commenting this one for now because sherpa doesn't provide the language for multilingual models. And our current cloud architecture depends on the language
    // "sherpa-onnx-nemo-fast-conformer-ctc-be-de-en-es-fr-hr-it-pl-ru-uk-20k-int8": {
    //   id: "sherpa-onnx-nemo-fast-conformer-ctc-be-de-en-es-fr-hr-it-pl-ru-uk-20k-int8",
    //   displayName: "Multilingual (EN/DE/ES/FR/RU)",
    //   fileName: "sherpa-onnx-nemo-fast-conformer-ctc-be-de-en-es-fr-hr-it-pl-ru-uk-20k-int8",
    //   size: 102261698, // Actual size: 102MB
    //   type: "ctc",
    //   requiredFiles: ["model.int8.onnx", "tokens.txt"],
    // },
    // "sherpa-onnx-streaming-zipformer-ar-en-id-ja-ru-th-vi-zh-2025-10-17": {
    //   id: "sherpa-onnx-streaming-zipformer-ar-en-id-ja-ru-th-vi-zh-2025-10-17",
    //   displayName: "Multilingual",
    //   fileName: "sherpa-onnx-streaming-zipformer-ar-en-id-ja-ru-th-vi-zh-2025-10-17",
    //   size: 500 * 1024 * 1024, // Estimated larger size for multilingual
    //   type: "transducer",
    //   requiredFiles: ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
    // },
  }

  private constructor() {}

  static getInstance(): STTModelManager {
    if (!STTModelManager.instance) {
      STTModelManager.instance = new STTModelManager()
    }
    return STTModelManager.instance
  }

  async getCurrentModelIdFromPreferences(): Promise<string> {
    try {
      let path = await CoreModule.getSttModelPath()
      const modelId = path && path.length > 0 ? this.getModelIdFromPath(path) : ""

      this.setCurrentModelId(modelId)
      return modelId
    } catch (error) {
      console.error("Error getting current model id from preferences:", error)
      return ""
    }
  }

  getCurrentModelId(): string {
    return this.currentModelId
  }

  setCurrentModelId(modelId: string): void {
    if (this.models[modelId]) {
      this.currentModelId = modelId
    }
  }

  getAvailableModels(): ModelConfig[] {
    return Object.values(this.models)
  }

  getModelDirectory(): string {
    const baseDir = Platform.OS === "ios" ? RNFS.DocumentDirectoryPath : RNFS.DocumentDirectoryPath
    return `${baseDir}/stt_models`
  }

  getModelPath(modelId?: string): string {
    const id = modelId || this.currentModelId
    return `${this.getModelDirectory()}/${id}`
  }

  getModelIdFromPath(path: string): string {
    return path.split("/").pop() || ""
  }

  async isModelAvailable(modelId?: string): Promise<boolean> {
    try {
      const id = modelId || this.currentModelId
      const model = this.models[id]
      if (!model) return false

      const modelPath = this.getModelPath(id)
      const requiredFiles = model.requiredFiles

      // Debug logging for multilingual model
      if (id.includes("be-de-en-es-fr")) {
        console.log(`Checking model at path: ${modelPath}`)
        const dirExists = await RNFS.exists(modelPath)
        console.log(`Directory exists: ${dirExists}`)

        if (dirExists) {
          const files = await RNFS.readDir(modelPath)
          console.log(
            `Files in directory:`,
            files.map((f) => f.name),
          )
        }
      }

      for (const file of requiredFiles) {
        const filePath = `${modelPath}/${file}`
        const exists = await RNFS.exists(filePath)
        if (!exists) {
          console.log(`Missing required file: ${file} at ${filePath}`)
          return false
        }
      }

      // Validate model with native module
      const isValid = await CoreModule.validateSttModel(modelPath)
      return isValid
    } catch (error) {
      console.error("Error checking model availability:", error)
      return false
    }
  }

  async getModelInfo(modelId?: string): Promise<ModelInfo> {
    const id = modelId || this.currentModelId
    const model = this.models[id]
    if (!model) {
      throw new Error(`Model ${id} not found`)
    }

    const downloaded = await this.isModelAvailable(id)
    const path = downloaded ? this.getModelPath(id) : undefined

    return {
      name: model.displayName,
      version: model.id,
      size: model.size,
      language: "English",
      downloaded,
      path,
      modelId: id,
      type: model.type,
    }
  }

  async getAllModelsInfo(): Promise<ModelInfo[]> {
    const infos = []
    for (const modelId of Object.keys(this.models)) {
      const info = await this.getModelInfo(modelId)
      infos.push(info)
    }
    return infos
  }

  async downloadModel(
    modelId?: string,
    onProgress?: (progress: DownloadProgress) => void,
    onExtractionProgress?: (progress: ExtractionProgress) => void,
  ): Promise<void> {
    const id = modelId || this.currentModelId
    const model = this.models[id]
    if (!model) {
      throw new Error(`Model ${id} not found`)
    }

    const modelUrl = `${this.modelBaseUrl}${model.fileName}.tar.bz2`
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${model.fileName}.tar.bz2`
    const modelDir = this.getModelDirectory()
    const finalPath = this.getModelPath(id)

    try {
      // Create directories
      await RNFS.mkdir(modelDir, {NSURLIsExcludedFromBackupKey: true})

      // Download the model
      const downloadOptions = {
        fromUrl: modelUrl,
        toFile: tempPath,
        progress: (res: RNFS.DownloadProgressCallbackResult) => {
          const percentage = Math.round((res.bytesWritten / res.contentLength) * 100)
          onProgress?.({
            jobId: res.jobId,
            bytesWritten: res.bytesWritten,
            contentLength: res.contentLength,
            percentage,
          })
        },
        progressDivider: 10, // Update every 10%
        begin: (res: RNFS.DownloadBeginCallbackResult) => {
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

      console.log("Download completed, extracting...")
      console.log(`Temp file path: ${tempPath}`)
      console.log(`Final path: ${finalPath}`)

      // Extract the tar.bz2 file
      onExtractionProgress?.({percentage: 0})

      console.log(`Calling native extractTarBz2 for ${Platform.OS}...`)
      try {
        onExtractionProgress?.({percentage: 25})
        const extractionResult = await CoreModule.extractTarBz2(tempPath, finalPath)
        if (!extractionResult) {
          throw new Error("Native extraction returned failure status")
        }
        onExtractionProgress?.({percentage: 90})
        console.log("Native extraction completed")
      } catch (extractError) {
        console.error("Native extraction failed:", extractError)
        throw extractError
      }

      // Use native extraction on both platforms

      onExtractionProgress?.({percentage: 100})

      // Clean up temp file
      await RNFS.unlink(tempPath)

      // Set the model path in native modules if this is the current model
      if (id === this.currentModelId) {
        const currentModelLanguageCode = this.models[id].languageCode
        await this.setNativeModelPath(finalPath, currentModelLanguageCode)
      }

      console.log("Model downloaded and extracted successfully")
    } catch (error) {
      // Clean up on error
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

  async deleteModel(modelId?: string): Promise<void> {
    const id = modelId || this.currentModelId
    const modelPath = this.getModelPath(id)
    if (await RNFS.exists(modelPath)) {
      await RNFS.unlink(modelPath)
    }
  }

  async activateModel(modelId: string): Promise<void> {
    const model = this.models[modelId]
    if (!model) {
      throw new Error(`Model ${modelId} not found`)
    }

    const isAvailable = await this.isModelAvailable(modelId)
    if (!isAvailable) {
      throw new Error(`Model ${modelId} is not downloaded`)
    }

    this.currentModelId = modelId
    const modelPath = this.getModelPath(modelId)
    await this.setNativeModelPath(modelPath, model.languageCode)
  }

  private async setNativeModelPath(path: string, languageCode: string): Promise<void> {
    CoreModule.setSttModelDetails(path, languageCode)
    return
  }

  async getStorageInfo(): Promise<{free: number; total: number}> {
    const fsInfo = await RNFS.getFSInfo()
    return {
      free: fsInfo.freeSpace,
      total: fsInfo.totalSpace,
    }
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes"
    const k = 1024
    const sizes = ["Bytes", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
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
