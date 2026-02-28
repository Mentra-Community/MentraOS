/**
 * Model Download Service
 * Orchestrates STT model downloads independently of UI lifecycle
 */

import CoreModule from "core"
import {Platform} from "react-native"
import * as RNFS from "@dr.pogodin/react-native-fs"

import {useModelDownloadStore, selectCanStartDownload} from "@/stores/modelDownload"

import STTModelManager, {ModelConfig} from "./STTModelManager"
import {modelDownloadNotifications} from "./modelDownloadNotifications"

class ModelDownloadService {
  private static instance: ModelDownloadService
  private downloadJobId?: number
  private isInitialized = false

  private constructor() {}

  static getInstance(): ModelDownloadService {
    if (!ModelDownloadService.instance) {
      ModelDownloadService.instance = new ModelDownloadService()
    }
    return ModelDownloadService.instance
  }

  /**
   * Initialize the service
   */
  initialize(): void {
    if (this.isInitialized) return

    this.isInitialized = true
    console.log("[ModelDownloadService] Initialized")
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    this.isInitialized = false
    console.log("[ModelDownloadService] Cleaned up")
  }

  /**
   * Check if a download can be started
   */
  canStartDownload(): boolean {
    const store = useModelDownloadStore.getState()
    return selectCanStartDownload(store)
  }

  /**
   * Check if currently downloading
   */
  isDownloading(): boolean {
    const store = useModelDownloadStore.getState()
    return (
      store.downloadState === "downloading" ||
      store.downloadState === "extracting" ||
      store.downloadState === "activating"
    )
  }

  /**
   * Start downloading a model
   */
  async startDownload(modelId: string): Promise<void> {
    const store = useModelDownloadStore.getState()

    // Prevent double downloads
    if (!this.canStartDownload()) {
      console.log("[ModelDownloadService] Cannot start download - already in progress")
      return
    }

    // Get model info
    const models = STTModelManager.getAvailableModels()
    const model = models.find((m) => m.id === modelId)
    if (!model) {
      store.setError(`Model ${modelId} not found`)
      return
    }

    console.log(`[ModelDownloadService] Starting download for ${model.displayName}`)

    // Update store
    store.setDownloading(modelId, model.displayName)

    // Show started notification (permissions requested internally if notifications enabled)
    await modelDownloadNotifications.showDownloadStarted(model.displayName)

    try {
      // Download phase
      await this.executeDownload(model)

      // Extract phase
      store.setExtracting()
      await modelDownloadNotifications.updateExtractionProgress(model.displayName, 0)
      await this.executeExtraction(model)

      // Activate phase
      store.setActivating()
      await modelDownloadNotifications.showActivating(model.displayName)
      await this.activateModel(model)

      // Complete
      store.setComplete()
      await modelDownloadNotifications.showComplete(model.displayName)

      console.log(`[ModelDownloadService] Download complete for ${model.displayName}`)

      // Auto-reset to idle after a delay
      setTimeout(() => {
        const currentStore = useModelDownloadStore.getState()
        if (currentStore.downloadState === "complete") {
          currentStore.reset()
        }
      }, 3000)
    } catch (error: any) {
      if (error?.message === "Download cancelled") {
        console.log("[ModelDownloadService] Download was cancelled")
        store.setCancelled()
        await modelDownloadNotifications.showCancelled()
      } else {
        console.error("[ModelDownloadService] Download failed:", error)
        store.setError(error?.message || "Download failed")
        await modelDownloadNotifications.showError(error?.message || "Download failed")
      }

      // Cleanup partial files
      await this.cleanupPartialDownload(model)
    }
  }

  /**
   * Execute the download phase
   */
  private async executeDownload(model: ModelConfig): Promise<void> {
    const store = useModelDownloadStore.getState()
    const modelBaseUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    const modelUrl = `${modelBaseUrl}${model.fileName}.tar.bz2`
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${model.fileName}.tar.bz2`
    const modelDir = STTModelManager.getModelDirectory()

    console.log(`[ModelDownloadService] Downloading from ${modelUrl}`)

    // Create directories
    await RNFS.mkdir(modelDir, {NSURLIsExcludedFromBackupKey: true})

    // Download with progress
    const downloadOptions = {
      fromUrl: modelUrl,
      toFile: tempPath,
      progress: (res: RNFS.DownloadProgressCallbackResult) => {
        const percentage = Math.round((res.bytesWritten / res.contentLength) * 100)

        // Update store
        const currentStore = useModelDownloadStore.getState()
        currentStore.setDownloadProgress(percentage)

        // Update notification
        modelDownloadNotifications.updateDownloadProgress(model.displayName, percentage)
      },
      progressDivider: 5, // Update every 5%
      begin: (res: RNFS.DownloadBeginCallbackResult) => {
        console.log("[ModelDownloadService] Download started:", res)
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

    console.log("[ModelDownloadService] Download completed")
    store.setDownloadProgress(100)
  }

  /**
   * Execute the extraction phase
   */
  private async executeExtraction(model: ModelConfig): Promise<void> {
    const store = useModelDownloadStore.getState()
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${model.fileName}.tar.bz2`
    const finalPath = STTModelManager.getModelPath(model.id)

    console.log(`[ModelDownloadService] Extracting to ${finalPath}`)

    // Update progress
    store.setExtractionProgress(25)
    await modelDownloadNotifications.updateExtractionProgress(model.displayName, 25)

    // Extract using native module
    console.log(`[ModelDownloadService] Calling native extractTarBz2 for ${Platform.OS}...`)
    const extractionResult = await CoreModule.extractTarBz2(tempPath, finalPath)

    if (!extractionResult) {
      throw new Error("Native extraction returned failure status")
    }

    store.setExtractionProgress(90)
    await modelDownloadNotifications.updateExtractionProgress(model.displayName, 90)

    console.log("[ModelDownloadService] Extraction completed")

    // Clean up temp file
    await RNFS.unlink(tempPath)

    store.setExtractionProgress(100)
    await modelDownloadNotifications.updateExtractionProgress(model.displayName, 100)
  }

  /**
   * Activate the model
   */
  private async activateModel(model: ModelConfig): Promise<void> {
    console.log(`[ModelDownloadService] Activating model ${model.id}`)

    // Validate model
    const modelPath = STTModelManager.getModelPath(model.id)
    const isValid = await CoreModule.validateSttModel(modelPath)

    if (!isValid) {
      throw new Error("Model validation failed")
    }

    // Set as current model
    STTModelManager.setCurrentModelId(model.id)
    CoreModule.setSttModelDetails(modelPath, model.languageCode)

    // Restart transcriber to initialize with the new model
    await CoreModule.restartTranscriber()

    console.log("[ModelDownloadService] Model activated")
  }

  /**
   * Cancel the current download
   */
  async cancelDownload(): Promise<void> {
    console.log("[ModelDownloadService] Cancelling download...")

    const store = useModelDownloadStore.getState()

    // Stop RNFS download if in progress
    if (this.downloadJobId !== undefined) {
      try {
        await RNFS.stopDownload(this.downloadJobId)
      } catch (error) {
        console.log("[ModelDownloadService] Error stopping download:", error)
      }
      this.downloadJobId = undefined
    }

    // Update store
    store.setCancelled()

    // Dismiss notification
    await modelDownloadNotifications.showCancelled()

    // Reset after a short delay
    setTimeout(() => {
      const currentStore = useModelDownloadStore.getState()
      if (currentStore.downloadState === "cancelled") {
        currentStore.reset()
      }
    }, 1000)
  }

  /**
   * Cleanup partial download files
   */
  private async cleanupPartialDownload(model: ModelConfig): Promise<void> {
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${model.fileName}.tar.bz2`
    const finalPath = STTModelManager.getModelPath(model.id)

    try {
      if (await RNFS.exists(tempPath)) {
        await RNFS.unlink(tempPath)
        console.log("[ModelDownloadService] Cleaned up temp file")
      }
    } catch (error) {
      console.log("[ModelDownloadService] Error cleaning temp file:", error)
    }

    try {
      if (await RNFS.exists(finalPath)) {
        await RNFS.unlink(finalPath)
        console.log("[ModelDownloadService] Cleaned up partial extraction")
      }
    } catch (error) {
      console.log("[ModelDownloadService] Error cleaning partial extraction:", error)
    }
  }
}

export const modelDownloadService = ModelDownloadService.getInstance()
