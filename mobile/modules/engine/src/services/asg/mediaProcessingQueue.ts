/**
 * Media Processing Queue
 *
 * Decouples media processing (HDR merge, color correction, stabilization, camera roll save)
 * from the download pipeline. Downloads push items here; processing runs independently.
 */

import * as RNFS from "@dr.pogodin/react-native-fs"
import CrustModule from "@mentra/crust"

import {asgCameraApi} from "./asgCameraApi"
import {localStorageService} from "./localStorageService"
import {INVALID_DOWNLOADED_MEDIA, validateDownloadedMediaFile} from "./galleryMediaValidation"
import {reportInvalidGalleryMedia} from "./GalleryMediaIntegrityReportService"
import {useGallerySyncStore} from "../../stores/gallerySync"
import {BgTimer} from "../../utils/timers"
import {galleryTransferLedger, GalleryTransferEntry} from "./galleryTransferLedger"
import {cameraRollExportCoordinator} from "./cameraRollExportCoordinator"

const TAG = "[MediaProcessingQueue]"

export interface ProcessingItem {
  /** Unique ID — capture_id (v2) or file name (v1) */
  id: string
  type: "photo" | "video"
  /** Path to the primary downloaded file */
  primaryPath: string
  /** HDR bracket paths (v2 only) */
  bracketPaths?: string[]
  /** IMU sidecar path for video stabilization */
  sidecarPath?: string
  /** Thumbnail base64 data */
  thumbnailData?: string
  /** Capture directory for saving thumbnail */
  captureDir?: string
  /** Original capture timestamp */
  timestamp?: number
  /** Total file size */
  totalSize: number
  /** Video duration in ms */
  duration?: number
  /** Glasses model */
  glassesModel?: string
  /** Whether to process (lens/color/stabilization) */
  shouldProcess: boolean
  /** Whether to auto-save to camera roll */
  shouldAutoSave: boolean
  /** Pre-downloaded thumbnail path (v1 legacy sync) */
  thumbnailPath?: string
  /** File names to delete from glasses after processing completes */
  deleteFromGlasses?: string[]
  /** Negotiated gallery protocol; absent entries are inferred from the transfer ledger. */
  protocolVersion?: number
}

class MediaProcessingQueue {
  private queue: ProcessingItem[] = []
  private isRunning = false
  private aborted = false
  private generation = 0 // C2: incremented on reset() to invalidate stale processLoop()

  /** Add an item to the processing queue. Starts processing if not already running. */
  enqueue(item: ProcessingItem): void {
    this.queue.push(item)
    console.log(`${TAG} Enqueued ${item.id} (${item.type}), queue size: ${this.queue.length}`)

    // Only mark as processing if we'll actually process this item
    if (item.shouldProcess) {
      const store = useGallerySyncStore.getState()
      store.onFileProcessing(item.id)
    }

    if (!this.isRunning) {
      this.processLoop()
    }
  }

  /** Cancel all pending processing. */
  abort(): void {
    this.aborted = true
    this.queue = []
    console.log(`${TAG} Aborted`)
  }

  /** Reset state for a new sync session. */
  reset(): void {
    this.queue = []
    this.isRunning = false
    this.aborted = false
    this.generation++ // C2: invalidate any running processLoop
  }

  /** Returns true if there are items queued or currently processing. */
  get hasPending(): boolean {
    return this.queue.length > 0 || this.isRunning
  }

  /** Returns a promise that resolves when the queue is fully drained, or rejects on timeout. */
  waitUntilDrained(timeoutMs: number = 4 * 60 * 60 * 1000): Promise<void> {
    if (!this.hasPending) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const check = () => {
        if (!this.hasPending || this.aborted) {
          resolve()
        } else if (Date.now() >= deadline) {
          console.error(`${TAG} waitUntilDrained timed out after ${timeoutMs}ms, aborting queue`)
          this.abort()
          reject(new Error(`Processing queue timed out after ${timeoutMs / 1000}s`))
        } else {
          BgTimer.setTimeout(check, 200)
        }
      }
      check()
    })
  }

  /** Retry durable export/ack work after an app restart without downloading media again. */
  async retryPending(): Promise<{retried: number; failed: number}> {
    let retried = 0
    let failed = 0
    for (let entry of galleryTransferLedger.pendingRecovery()) {
      try {
        if (entry.state === "RESTORE_PENDING") {
          await asgCameraApi.restoreCapture(entry.captureId)
          galleryTransferLedger.transition(entry.captureId, "DISCOVERED", {lastError: undefined})
          retried++
          continue
        }
        if (!entry.finalPath || !(await RNFS.exists(entry.finalPath))) {
          throw new Error(`Recovery file is missing for ${entry.captureId}`)
        }
        // Rebuild a missing app index before any source acknowledgement, even when camera-roll
        // saving is disabled or an export receipt was already committed before restart.
        const downloadedFile = await this.recoverDownloadedFile(entry)
        if (entry.state === "EXPORT_PENDING" || entry.state === "INDEXED") {
          const shouldAutoSave = await cameraRollExportCoordinator.isAutoSaveEnabled()
          entry = galleryTransferLedger.update(entry.captureId, {shouldAutoSave, lastError: undefined})
          if (shouldAutoSave) {
            if (entry.state !== "EXPORT_PENDING") {
              entry = galleryTransferLedger.transition(entry.captureId, "EXPORT_PENDING")
            }
            const receipt = await cameraRollExportCoordinator.exportForSource(downloadedFile, entry.captureId)
            entry = receipt
              ? galleryTransferLedger.transition(entry.captureId, "EXPORTED", {assetReceipt: receipt})
              : galleryTransferLedger.transition(entry.captureId, "INDEXED", {
                  shouldAutoSave: false,
                  lastError: undefined,
                })
          } else if (entry.state === "EXPORT_PENDING") {
            entry = galleryTransferLedger.transition(entry.captureId, "INDEXED", {
              shouldAutoSave: false,
              lastError: undefined,
            })
          }
        }
        entry = galleryTransferLedger.transition(entry.captureId, "ACK_PENDING")
        await this.acknowledgeEntry(entry)
        galleryTransferLedger.transition(entry.captureId, "TRASHED", {lastError: undefined})
        retried++
      } catch (error) {
        galleryTransferLedger.recordFailure(entry.captureId, error)
        failed++
        console.warn(`${TAG} Recovery remains pending for ${entry.captureId}:`, error)
      }
    }
    return {retried, failed}
  }

  private async acknowledgeEntry(entry: GalleryTransferEntry): Promise<void> {
    if (entry.protocolVersion >= 3) {
      await asgCameraApi.acknowledgeCapture(entry.captureId, entry.ackId)
      return
    }
    const result = await asgCameraApi.deleteFilesFromServer(
      entry.deleteFromGlasses.length > 0 ? entry.deleteFromGlasses : [entry.captureId],
    )
    if (result.failed.length > 0 || result.deleted.length === 0) {
      throw new Error(`Glasses did not acknowledge ${entry.captureId}`)
    }
  }

  /** Process items one at a time. */
  private async processLoop(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    const myGeneration = this.generation // C2: capture generation to detect reset()

    while (this.queue.length > 0 && !this.aborted && this.generation === myGeneration) {
      const item = this.queue.shift()!
      let processFailed = false
      try {
        await this.processItem(item)
      } catch (error) {
        console.error(`${TAG} Error processing ${item.id}:`, error)
        processFailed = true
        const store = useGallerySyncStore.getState()
        if (!store.failedFiles.includes(item.id)) {
          store.onFileFailed(item.id, error instanceof Error ? error.message : String(error))
        }
      }

      // Exit if generation changed (reset was called during processing)
      if (this.generation !== myGeneration) break

      const store = useGallerySyncStore.getState()
      if (!processFailed) {
        // Success: increment processedFiles and remove from processingFiles set.
        store.onFileProcessed(item.id)
      } else {
        // Failure is counted exactly once above. Still clear the processingFiles entry so the UI
        // does not show it as in-progress.
        const current = store.processingFiles
        if (current.has(item.id)) {
          const newSet = new Set(current)
          newSet.delete(item.id)
          useGallerySyncStore.setState({processingFiles: newSet})
        }
      }
    }

    // Only clear isRunning if this loop owns the current generation
    if (this.generation === myGeneration) {
      this.isRunning = false
    }
  }

  /** Process a single item through the full pipeline. */
  private async processItem(item: ProcessingItem): Promise<void> {
    const startTime = Date.now()
    let filePathToSave = item.primaryPath
    let ledgerEntry = galleryTransferLedger.get(item.id)
    if (!ledgerEntry) {
      ledgerEntry = galleryTransferLedger.ensureCapture(
        {
          capture_id: item.id,
          type: item.type,
          timestamp: item.timestamp || Date.now(),
          total_size: item.totalSize,
          files: (item.deleteFromGlasses?.length ? item.deleteFromGlasses : [item.id]).map((name, index) => ({
            name,
            size: index === 0 ? item.totalSize : 0,
            role: index === 0 ? "primary" : "sidecar",
          })),
        },
        item.protocolVersion || 2,
      )
    }

    // 1. HDR merge (photos with brackets only)
    if (item.shouldProcess && item.type === "photo" && item.bracketPaths && item.bracketPaths.length >= 3) {
      try {
        const underPath = item.bracketPaths.find((p) => p.includes("ev-2")) || item.bracketPaths[0]
        const normalPath = item.bracketPaths.find((p) => p.includes("ev0")) || item.bracketPaths[1]
        const overPath = item.bracketPaths.find((p) => p.includes("ev2") && !p.includes("ev-2")) || item.bracketPaths[2]

        const hdrPath = item.primaryPath + ".hdr.jpg"
        const hdrResult = await CrustModule.mergeHdrBrackets(underPath, normalPath, overPath, hdrPath)
        if (hdrResult.success && hdrResult.outputPath) {
          filePathToSave = hdrResult.outputPath
          console.log(`${TAG} HDR merged ${item.id} in ${hdrResult.processingTimeMs}ms`)
        }
      } catch (hdrError) {
        console.warn(`${TAG} HDR merge error for ${item.id}, continuing:`, hdrError)
      }
    }

    // 2. Image processing (lens + color correction)
    if (item.shouldProcess && item.type === "photo") {
      try {
        const processedPath = filePathToSave + ".processed.jpg"
        const result = await CrustModule.processGalleryImage(filePathToSave, processedPath, {
          lensCorrection: true,
          colorCorrection: true,
        })
        if (result.success && result.outputPath) {
          filePathToSave = result.outputPath
          console.log(`${TAG} 🎨 Processed ${item.id} in ${result.processingTimeMs}ms`)
        }
      } catch (procError) {
        console.warn(`${TAG} Processing error for ${item.id}, using original:`, procError)
      }
    }

    // 3. Video stabilization + color correction
    if (item.shouldProcess && item.type === "video" && item.sidecarPath) {
      try {
        const stabilizedPath = item.primaryPath + ".stabilized.mp4"
        const result = await CrustModule.stabilizeVideo(item.primaryPath, item.sidecarPath, stabilizedPath)
        if (result.success && result.outputPath) {
          filePathToSave = result.outputPath
          console.log(`${TAG} 📹 Stabilized ${item.id} in ${result.processingTimeMs}ms`)
        }
      } catch (stabError) {
        console.warn(`${TAG} Stabilization error for ${item.id}, using original:`, stabError)
      }
    }

    // 4. Save thumbnail to disk (or use pre-downloaded thumbnail from v1 sync)
    let localThumbnailPath: string | undefined = item.thumbnailPath
    if (item.thumbnailData && item.captureDir) {
      try {
        const thumbPath = `${item.captureDir}/.thumb.jpg`
        const base64Data = item.thumbnailData.startsWith("data:")
          ? item.thumbnailData.split(",")[1]
          : item.thumbnailData
        await RNFS.writeFile(thumbPath, base64Data, "base64")
        localThumbnailPath = thumbPath
      } catch (thumbError) {
        console.warn(`${TAG} Failed to save thumbnail for ${item.id}:`, thumbError)
      }
    }

    // 5. Validate local file before persisting metadata or deleting from glasses
    try {
      await validateDownloadedMediaFile({
        path: filePathToSave,
        name: item.id,
        mediaKind: item.type,
      })
    } catch (validationError: any) {
      const reason = validationError?.message?.includes(INVALID_DOWNLOADED_MEDIA)
        ? validationError.message
        : `${INVALID_DOWNLOADED_MEDIA}: ${item.id}`
      console.error(`${TAG} Validation failed for ${item.id}: ${reason}`)
      reportInvalidGalleryMedia({
        name: item.id,
        path: filePathToSave,
        mediaKind: item.type,
        stage: "processing_validation",
        reason,
        expectedSize: item.totalSize,
        duration: item.duration,
        glassesModel: item.glassesModel,
      })
      const store = useGallerySyncStore.getState()
      store.onFileFailed(item.id, reason)
      galleryTransferLedger.recordFailure(item.id, validationError)
      throw new Error(reason)
    }

    // 6. Commit the app-local index before any export or source acknowledgement. Use the final
    // on-disk output metadata for camera-roll identity: processing can change byte size, while
    // recovery reconstructs this row from the same file and the transfer ledger timestamp.
    const isVideo = item.type === "video"
    const finalFileStat = await RNFS.stat(filePathToSave)
    const finalFileSize = Number(finalFileStat.size)
    const downloadedFile = localStorageService.convertToDownloadedFile(
      {
        name: item.id,
        url: "",
        download: "",
        size: finalFileSize,
        modified: ledgerEntry.timestamp,
        is_video: isVideo,
        thumbnail_data: item.thumbnailData,
        duration: item.duration,
        filePath: filePathToSave,
        glassesModel: item.glassesModel,
      },
      filePathToSave,
      localThumbnailPath,
      item.glassesModel,
    )
    downloadedFile.capture_id = item.id
    const shouldAutoSave = await cameraRollExportCoordinator.isAutoSaveEnabled()
    try {
      await localStorageService.saveDownloadedFile(downloadedFile)
      ledgerEntry = galleryTransferLedger.transition(item.id, "INDEXED", {
        finalPath: filePathToSave,
        thumbnailPath: localThumbnailPath,
        shouldAutoSave,
      })
      await cameraRollExportCoordinator.recordIndexed(
        downloadedFile,
        shouldAutoSave,
        shouldAutoSave ? "SOURCE_BARRIER" : "HISTORICAL_BACKFILL",
        item.id,
      )
    } catch (metadataError) {
      console.error(`${TAG} Metadata save failed for ${item.id}; retaining local and glasses copies:`, metadataError)
      galleryTransferLedger.recordFailure(item.id, metadataError)
      throw metadataError
    }

    // 7. While enabled, export is a durable, receipted step whose failures block ack. Turning
    // auto-save off safely falls back to the already-verified app-local copy and later backfill.
    if (shouldAutoSave) {
      galleryTransferLedger.transition(item.id, "EXPORT_PENDING")
      let receipt
      try {
        receipt = await cameraRollExportCoordinator.exportForSource(downloadedFile, item.id)
      } catch (error) {
        galleryTransferLedger.recordFailure(item.id, error)
        throw error
      }
      if (receipt) {
        ledgerEntry = galleryTransferLedger.transition(item.id, "EXPORTED", {
          assetReceipt: receipt,
        })
        console.log(`${TAG} ✅ Saved to camera roll with receipt: ${item.id}`)
      } else {
        ledgerEntry = galleryTransferLedger.transition(item.id, "INDEXED", {
          shouldAutoSave: false,
          lastError: undefined,
        })
        console.log(`${TAG} Automatic camera-roll saving was disabled; keeping app-local copy: ${item.id}`)
      }
    }

    // S4: Clean up intermediate processing files
    const intermediates = [
      item.primaryPath + ".hdr.jpg",
      item.primaryPath + ".processed.jpg",
      item.primaryPath + ".stabilized.mp4",
    ]
    for (const intermediate of intermediates) {
      if (intermediate !== filePathToSave) {
        RNFS.unlink(intermediate).catch(() => {}) // fire-and-forget
      }
    }

    // 8. Update file in sync queue with local paths for gallery display
    const store = useGallerySyncStore.getState()
    const localFileUrl = filePathToSave.startsWith("file://") ? filePathToSave : `file://${filePathToSave}`
    const localThumbUrl = localThumbnailPath
      ? localThumbnailPath.startsWith("file://")
        ? localThumbnailPath
        : `file://${localThumbnailPath}`
      : undefined
    store.updateFileInQueue(item.id, {
      name: item.id,
      url: localFileUrl,
      download: localFileUrl,
      size: finalFileSize,
      modified: ledgerEntry.timestamp,
      is_video: isVideo,
      filePath: filePathToSave,
      mime_type: isVideo ? "video/mp4" : "image/jpeg",
      thumbnail_data: item.thumbnailData,
      thumbnailPath: localThumbUrl,
      duration: item.duration,
    })

    // 9. Acknowledge only after VERIFIED -> INDEXED -> (EXPORTED). The server turns this into
    // recoverable trash; failures remain ACK_PENDING and are retried without re-downloading.
    const localFileExists = await RNFS.exists(filePathToSave)
    const localStat = localFileExists ? await RNFS.stat(filePathToSave) : null
    if (!localStat || localStat.size <= 0) {
      const error = new Error(`Cannot acknowledge ${item.id}: committed local file is missing or empty`)
      galleryTransferLedger.recordFailure(item.id, error)
      throw error
    }
    ledgerEntry = galleryTransferLedger.transition(item.id, "ACK_PENDING")
    try {
      await this.acknowledgeEntry(ledgerEntry)
      galleryTransferLedger.transition(item.id, "TRASHED", {lastError: undefined})
    } catch (ackError) {
      galleryTransferLedger.recordFailure(item.id, ackError)
      throw ackError
    }

    const elapsed = Date.now() - startTime
    console.log(`${TAG} ✅ Finished ${item.id} in ${elapsed}ms`)
  }

  /** Rebuild a missing app-local index row from the durable transfer ledger. */
  private async recoverDownloadedFile(entry: GalleryTransferEntry) {
    if (!entry.finalPath) throw new Error(`Recovery file is missing for ${entry.captureId}`)

    // The transfer ledger is the durable source of truth for a committed generation. A local
    // index row can survive an interrupted replacement and still point at an older/missing path,
    // or contain the pre-processing size. Only reuse it when its path and identity still match the
    // ledger's committed file; otherwise rebuild the row before export or source acknowledgement.
    const finalPath = entry.finalPath.replace(/^file:\/\//, "")
    const indexed = await localStorageService.getDownloadedFile(entry.captureId)
    if (indexed) {
      try {
        const indexedPath = indexed.filePath?.replace(/^file:\/\//, "")
        if (indexedPath === finalPath && (await RNFS.exists(indexedPath))) {
          const indexedStat = await RNFS.stat(indexedPath)
          const indexedSize = Number(indexedStat.size)
          if (indexedSize > 0 && indexed.size === indexedSize && indexed.modified === entry.timestamp) {
            return indexed
          }
        }
      } catch (error) {
        console.warn(`${TAG} Ignoring stale local index for ${entry.captureId}:`, error)
      }
    }

    const stat = await RNFS.stat(finalPath)
    const finalSize = Number(stat.size)
    if (!Number.isFinite(finalSize) || finalSize <= 0) {
      throw new Error(`Recovery file is missing or empty for ${entry.captureId}`)
    }
    const recovered = localStorageService.convertToDownloadedFile(
      {
        name: entry.captureId,
        url: "",
        download: "",
        size: finalSize,
        modified: entry.timestamp,
        mime_type: entry.captureType === "video" ? "video/mp4" : "image/jpeg",
        is_video: entry.captureType === "video",
        filePath: finalPath,
      },
      finalPath,
      entry.thumbnailPath,
    )
    recovered.capture_id = entry.captureId
    recovered.assetReceipt = entry.assetReceipt
    await localStorageService.saveDownloadedFile(recovered)
    return recovered
  }
}

export const mediaProcessingQueue = new MediaProcessingQueue()
