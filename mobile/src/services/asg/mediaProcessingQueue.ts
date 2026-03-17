/**
 * Media Processing Queue
 *
 * Decouples media processing (HDR merge, color correction, stabilization, camera roll save)
 * from the download pipeline. Downloads push items here; processing runs independently.
 */

import CrustModule from "crust"

import {asgCameraApi} from "@/services/asg/asgCameraApi"
import {localStorageService} from "@/services/asg/localStorageService"
import {useGallerySyncStore} from "@/stores/gallerySync"
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
  }

  /** Returns true if there are items queued or currently processing. */
  get hasPending(): boolean {
    return this.queue.length > 0 || this.isRunning
  }

  /** Returns a promise that resolves when the queue is fully drained. */
  waitUntilDrained(): Promise<void> {
    if (!this.hasPending) return Promise.resolve()
    return new Promise((resolve) => {
      const check = () => {
        if (!this.hasPending || this.aborted) {
          resolve()
        } else {
          setTimeout(check, 200)
        }
      }
      check()
    })
  }

  /** Process items one at a time. */
  private async processLoop(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    while (this.queue.length > 0 && !this.aborted) {
      const item = this.queue.shift()!
      try {
        await this.processItem(item)
      } catch (error) {
        console.error(`${TAG} Error processing ${item.id}:`, error)
      }

      // Mark processing complete in store
      const store = useGallerySyncStore.getState()
      store.onFileProcessed(item.id)
    }

    this.isRunning = false
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
        const RNFS = require("@dr.pogodin/react-native-fs")
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
    await localStorageService.saveDownloadedFile(downloadedFile)

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

    // 8. Delete from glasses now that processing is complete
    if (item.deleteFromGlasses && item.deleteFromGlasses.length > 0) {
      try {
        await asgCameraApi.deleteFilesFromServer(item.deleteFromGlasses)
        console.log(`${TAG} 🗑️ Deleted ${item.deleteFromGlasses.join(", ")} from glasses`)
      } catch (deleteError) {
        console.warn(`${TAG} Delete from glasses failed for ${item.id} (non-fatal):`, deleteError)
      }
    }

    const elapsed = Date.now() - startTime
    console.log(`${TAG} ✅ Finished ${item.id} in ${elapsed}ms`)
  }
}

export const mediaProcessingQueue = new MediaProcessingQueue()
