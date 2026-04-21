/**
 * Media Processing Queue
 *
 * Decouples media processing (HDR merge, color correction, stabilization, camera roll save)
 * from the download pipeline. Downloads push items here; processing runs independently.
 */

import * as RNFS from "@dr.pogodin/react-native-fs"
import CrustModule from "crust"

import {asgCameraApi} from "@/services/asg/asgCameraApi"
import {localStorageService} from "@/services/asg/localStorageService"
import {useGallerySyncStore} from "@/stores/gallerySync"
import {BackgroundTimer} from "@/utils/timers"
import {MediaLibraryPermissions} from "@/utils/permissions/MediaLibraryPermissions"

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
  waitUntilDrained(timeoutMs: number = 600000): Promise<void> {
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
          BackgroundTimer.setTimeout(check, 200)
        }
      }
      check()
    })
  }

  /** Process items one at a time. */
  private async processLoop(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    const myGeneration = this.generation // C2: capture generation to detect reset()

    while (this.queue.length > 0 && !this.aborted && this.generation === myGeneration) {
      const item = this.queue.shift()!
      try {
        await this.processItem(item)
      } catch (error) {
        console.error(`${TAG} Error processing ${item.id}:`, error)
      }

      // Exit if generation changed (reset was called during processing)
      if (this.generation !== myGeneration) break

      // Mark processing complete in store
      const store = useGallerySyncStore.getState()
      store.onFileProcessed(item.id)
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

    // 5. Save to camera roll
    if (item.shouldAutoSave) {
      const success = await MediaLibraryPermissions.saveToLibrary(filePathToSave, item.timestamp)
      if (success) {
        console.log(`${TAG} ✅ Saved to camera roll: ${item.id}`)
      } else {
        console.warn(`${TAG} ❌ Failed to save to camera roll: ${item.id}`)
        // D1: Surface camera roll save failures to the UI
        const store = useGallerySyncStore.getState()
        store.onFileFailed(item.id, "camera roll save failed")
      }
    }

    // 6. Save metadata
    const isVideo = item.type === "video"
    const downloadedFile = localStorageService.convertToDownloadedFile(
      {
        name: item.id,
        url: "",
        download: "",
        size: item.totalSize,
        modified: item.timestamp || Date.now(),
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
    try {
      await localStorageService.saveDownloadedFile(downloadedFile)
    } catch (metadataError) {
      // D2: Clean up orphaned file if metadata save fails, then re-throw
      console.error(`${TAG} Metadata save failed for ${item.id}, cleaning up file:`, metadataError)
      await RNFS.unlink(filePathToSave).catch(() => {})
      throw metadataError
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

    // 7. Update file in sync queue with local paths for gallery display
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
      size: item.totalSize,
      modified: item.timestamp || Date.now(),
      is_video: isVideo,
      filePath: filePathToSave,
      mime_type: isVideo ? "video/mp4" : "image/jpeg",
      thumbnail_data: item.thumbnailData,
      thumbnailPath: localThumbUrl,
      duration: item.duration,
    })

    // 8. Delete from glasses now that processing is complete — but only if the
    // local file actually exists and has data. If the download was truncated or
    // processing failed silently, we must not destroy the only good copy.
    if (item.deleteFromGlasses && item.deleteFromGlasses.length > 0) {
      try {
        const localFileExists = await RNFS.exists(filePathToSave)
        if (!localFileExists) {
          console.error(`${TAG} Skipping glasses deletion for ${item.id}: local file missing at ${filePathToSave}`)
        } else {
          const localStat = await RNFS.stat(filePathToSave)
          if (localStat.size === 0) {
            console.error(`${TAG} Skipping glasses deletion for ${item.id}: local file is 0 bytes`)
          } else if (item.totalSize > 0 && localStat.size < item.totalSize * 0.5) {
            // If local file is less than 50% of expected size, something went wrong
            console.error(
              `${TAG} Skipping glasses deletion for ${item.id}: local file ${localStat.size} bytes is much smaller than expected ${item.totalSize} bytes`,
            )
          } else {
            await asgCameraApi.deleteFilesFromServer(item.deleteFromGlasses)
            console.log(`${TAG} 🗑️ Deleted ${item.deleteFromGlasses.join(", ")} from glasses`)
          }
        }
      } catch (deleteError) {
        console.warn(`${TAG} Delete from glasses failed for ${item.id} (non-fatal):`, deleteError)
      }
    }

    const elapsed = Date.now() - startTime
    console.log(`${TAG} ✅ Finished ${item.id} in ${elapsed}ms`)
  }
}

export const mediaProcessingQueue = new MediaProcessingQueue()
