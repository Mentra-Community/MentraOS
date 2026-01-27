/**
 * Cloud Gallery Sync Service
 * Polls cloud for pending photos/videos and downloads them to mobile
 * Works alongside WiFi Direct sync with deduplication
 */

import NetInfo from "@react-native-community/netinfo"
import axios from "axios"
import * as RNFS from "@dr.pogodin/react-native-fs"

import restComms from "@/services/RestComms"
import {useGallerySyncStore} from "@/stores/gallerySync"
import {calculateFileHash, isDuplicateFile} from "@/utils/FileHashUtil"
import {MediaLibraryPermissions} from "@/utils/permissions/MediaLibraryPermissions"

import {gallerySettingsService} from "./gallerySettingsService"
import {localStorageService, DownloadedFile} from "./localStorageService"

interface PendingItem {
  id: string
  type: "image" | "video"
  filename: string
  mimeType: string
  sizeBytes: number
  capturedAt: string
  uploadedAt: string
  downloadUrl: string
  thumbnailUrl?: string // Presigned URL for thumbnail preview
  metadata?: {
    width?: number
    height?: number
    duration?: number
  }
}

interface PendingResponse {
  pendingCount: number
  pendingTotalBytes: number
  items: PendingItem[]
  cursor?: string
}

// Timing constants
const TIMING = {
  ACTIVE_POLL_INTERVAL_MS: 30000, // 30s when active
  BACKGROUND_POLL_INTERVAL_MS: 300000, // 5min when background
  IDLE_POLL_INTERVAL_MS: 600000, // 10min when no pending items
  REQUEST_TIMEOUT_MS: 30000, // 30s timeout for API requests
  DOWNLOAD_TIMEOUT_MS: 120000, // 2min timeout for image downloads
  VIDEO_DOWNLOAD_TIMEOUT_MS: 600000, // 10min timeout for video downloads
} as const

class CloudGallerySyncService {
  private static instance: CloudGallerySyncService
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private isDownloading = false
  private isPolling = false
  private consecutiveEmptyPolls = 0
  private glassesUploadingToCloud = false // Pause downloads while glasses are uploading
  private activeDownloads = new Set<string>() // Track filenames currently being downloaded

  private constructor() {}

  /**
   * Called when glasses start uploading to cloud.
   * Pauses cloud downloads to prevent race conditions.
   */
  setGlassesUploading(uploading: boolean): void {
    const wasUploading = this.glassesUploadingToCloud
    this.glassesUploadingToCloud = uploading

    if (uploading) {
      console.log("[CloudGallerySync] 🚫 Glasses uploading to cloud - pausing downloads")
    } else if (wasUploading) {
      console.log("[CloudGallerySync] ✅ Glasses finished uploading - resuming downloads")
      // Immediately check for pending items after upload completes
      if (this.isPolling && !this.isDownloading) {
        setTimeout(() => this.checkPending(), 2000) // Brief delay to let cloud process
      }
    }
  }

  /**
   * Check if glasses are currently uploading to cloud
   */
  isGlassesUploading(): boolean {
    return this.glassesUploadingToCloud
  }

  static getInstance(): CloudGallerySyncService {
    if (!CloudGallerySyncService.instance) {
      CloudGallerySyncService.instance = new CloudGallerySyncService()
    }
    return CloudGallerySyncService.instance
  }

  /**
   * Start polling cloud for pending files
   */
  startPolling(): void {
    if (this.isPolling) {
      console.log("[CloudGallerySync] Already polling")
      return
    }

    console.log("[CloudGallerySync] Starting polling")
    this.isPolling = true
    this.consecutiveEmptyPolls = 0

    // Initial check immediately
    this.checkPending()

    // Then poll at intervals
    this.pollInterval = setInterval(() => {
      this.checkPending()
    }, TIMING.ACTIVE_POLL_INTERVAL_MS)
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    this.isPolling = false
    this.activeDownloads.clear() // Clear any pending download tracking
    console.log("[CloudGallerySync] Stopped polling")
  }

  /**
   * Check for pending files in cloud
   */
  async checkPending(): Promise<void> {
    if (this.isDownloading) {
      console.log("[CloudGallerySync] Already downloading, skipping poll")
      return
    }

    // Don't check for pending items while glasses are uploading to cloud
    // This prevents race conditions where phone downloads incomplete uploads
    if (this.glassesUploadingToCloud) {
      console.log("[CloudGallerySync] 🚫 Glasses uploading to cloud - skipping poll to avoid race condition")
      return
    }

    try {
      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      console.warn("[CloudGallerySync] ⚠️ TEMPORARY OVERRIDE ACTIVE:", baseUrl, "- DO NOT COMMIT THIS!")
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code

      const token = restComms.getCoreToken()

      if (!token) {
        console.warn("[CloudGallerySync] No auth token available")
        return
      }

      console.log("[CloudGallerySync] Polling for pending items...")

      const response = await axios.get<{success: boolean; data: PendingResponse}>(
        `${baseUrl}/api/client/asg/gallery/pending?limit=50`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: TIMING.REQUEST_TIMEOUT_MS,
        },
      )

      if (response.data.success) {
        const {pendingCount, pendingTotalBytes, items} = response.data.data

        console.log(`[CloudGallerySync] Found ${pendingCount} pending items (${this.formatBytes(pendingTotalBytes)})`)

        // Update store
        const store = useGallerySyncStore.getState()
        store.setCloudPending(pendingCount, pendingTotalBytes)
        store.setLastCloudPollTime(Date.now())

        // Track empty polls for adaptive interval
        if (pendingCount === 0) {
          this.consecutiveEmptyPolls++
          // After 10 empty polls (5 minutes), slow down to 10 minute intervals
          if (this.consecutiveEmptyPolls >= 10 && this.pollInterval) {
            console.log("[CloudGallerySync] No pending items for 5 minutes - switching to idle polling")
            clearInterval(this.pollInterval)
            this.pollInterval = setInterval(() => {
              this.checkPending()
            }, TIMING.IDLE_POLL_INTERVAL_MS)
          }
        } else {
          this.consecutiveEmptyPolls = 0
        }

        // Auto-download if on WiFi and items exist
        if (items.length > 0) {
          const netState = await NetInfo.fetch()
          if (netState.isWifiEnabled && netState.isConnected) {
            console.log("[CloudGallerySync] WiFi available - starting auto-download")
            await this.downloadPending(items)
          } else {
            console.log("[CloudGallerySync] Not on WiFi - waiting for WiFi connection")
          }
        }
      }
    } catch (error: any) {
      console.error("[CloudGallerySync] Error checking pending:", error?.message || error)
      const store = useGallerySyncStore.getState()
      store.setCloudSyncError(error?.message || "Failed to check pending files")
    }
  }

  /**
   * Download all pending files
   */
  async downloadPending(items?: PendingItem[]): Promise<void> {
    if (this.isDownloading) {
      console.log("[CloudGallerySync] Already downloading")
      return
    }

    // NEVER download while glasses are uploading - prevents race conditions
    if (this.glassesUploadingToCloud) {
      console.log("[CloudGallerySync] 🚫 BLOCKED: Cannot download while glasses are uploading to cloud")
      return
    }

    this.isDownloading = true
    const store = useGallerySyncStore.getState()
    store.setCloudSyncActive(true)

    try {
      // Get items if not provided
      if (!items) {
        // TEMPORARY OVERRIDE - DO NOT COMMIT
        const baseUrl = "https://clouddev.ngrok.app"
        console.warn("[CloudGallerySync] ⚠️ TEMPORARY OVERRIDE ACTIVE:", baseUrl, "- DO NOT COMMIT THIS!")
        // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code
        const token = restComms.getCoreToken()

        if (!token) {
          throw new Error("No auth token available")
        }

        const response = await axios.get<{success: boolean; data: PendingResponse}>(
          `${baseUrl}/api/client/asg/gallery/pending?limit=50`,
          {
            headers: {Authorization: `Bearer ${token}`},
            timeout: TIMING.REQUEST_TIMEOUT_MS,
          },
        )

        items = response.data.data.items
      }

      if (!items || items.length === 0) {
        console.log("[CloudGallerySync] No items to download")
        return
      }

      console.log(`[CloudGallerySync] Downloading ${items.length} items`)

      // Get existing files for deduplication
      const existingFiles = await localStorageService.getDownloadedFiles()
      const existingFilesArray = Object.values(existingFiles)

      // Check if auto-save to camera roll is enabled
      const shouldAutoSave = await gallerySettingsService.getAutoSaveToCameraRoll()

      // Request camera roll permission upfront if needed
      if (shouldAutoSave) {
        const hasPermission = await MediaLibraryPermissions.checkPermission()
        if (!hasPermission) {
          const granted = await MediaLibraryPermissions.requestPermission()
          if (!granted) {
            console.log("[CloudGallerySync] Camera roll permission denied - photos will save to app only")
          }
        }
      }

      const skippedDuplicates: string[] = []
      const failedDownloads: string[] = []

      // Sort items by capture time (oldest first) for chronological order
      const sortedItems = [...items].sort((a, b) => {
        const timeA = new Date(a.capturedAt).getTime()
        const timeB = new Date(b.capturedAt).getTime()
        return timeA - timeB
      })

      // Set initial progress and reset completed files counter
      store.setCloudProgress(0, sortedItems.length, null)
      // Reset completed files count for new download batch
      useGallerySyncStore.setState({cloudCompletedFiles: 0})

      // Add all items to downloading list for gallery preview (thumbnails appear immediately)
      console.log(`[CloudGallerySync] 🖼️ Setting ${sortedItems.length} preview items for gallery`)
      store.setCloudDownloadingItems(
        sortedItems.map((item) => ({
          filename: item.filename,
          capturedAt: new Date(item.capturedAt).getTime(),
          mimeType: item.mimeType,
          is_video: item.type === "video",
          thumbnailUrl: item.thumbnailUrl, // Include thumbnail URL for preview
        })),
      )
      console.log(
        `[CloudGallerySync] 🖼️ Preview items set - gallery should now show ${sortedItems.length} thumbnails at top`,
      )

      for (let i = 0; i < sortedItems.length; i++) {
        const item = sortedItems[i]

        // Abort download batch if glasses started uploading
        if (this.glassesUploadingToCloud) {
          console.log("[CloudGallerySync] 🛑 ABORT: Glasses started uploading - stopping download batch")
          break
        }

        // Skip if this file is already being downloaded (prevents race condition)
        if (this.activeDownloads.has(item.filename)) {
          console.log(`[CloudGallerySync] ⏭️ Skipping ${item.filename} - already downloading`)
          continue
        }

        // Mark this file as actively downloading
        this.activeDownloads.add(item.filename)
        store.setCloudProgress(i + 1, sortedItems.length, item.filename)

        // Initialize photo sync state for this file
        store.setCloudFileProgress(item.filename, 0)

        try {
          console.log(`[CloudGallerySync] Downloading: ${item.filename} (${this.formatBytes(item.sizeBytes)})`)

          // Generate unique temp filename to prevent race conditions
          // Even with activeDownloads guard, use unique suffix for extra safety
          const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
          const tempFilename = `temp_${uniqueSuffix}_${item.filename}`

          // Download to temp location first with progress tracking
          const tempPath = await this.downloadFile(item.downloadUrl, tempFilename, (progress) => {
            // Update progress in store for gallery screen to display
            store.setCloudFileProgress(item.filename, progress)
          })

          // Check for duplicates by hash (skip for large files - too slow)
          // Videos > 5MB would take too long to hash in JS
          const SKIP_HASH_THRESHOLD = 5 * 1024 * 1024 // 5MB
          let isDuplicate = false

          if (item.sizeBytes < SKIP_HASH_THRESHOLD) {
            console.log(
              `[CloudGallerySync] 🔍 Checking for duplicates: ${item.filename} (${this.formatBytes(item.sizeBytes)})`,
            )
            const duplicateCheckStart = Date.now()
            isDuplicate = await isDuplicateFile(tempPath, existingFilesArray)
            const duplicateCheckDuration = Date.now() - duplicateCheckStart
            console.log(
              `[CloudGallerySync] ✅ Duplicate check complete: ${item.filename} (took ${duplicateCheckDuration}ms, isDuplicate: ${isDuplicate})`,
            )
          } else {
            console.log(
              `[CloudGallerySync] ⏭️ Skipping duplicate check for large file: ${item.filename} (${this.formatBytes(
                item.sizeBytes,
              )} > 5MB threshold)`,
            )
          }

          if (isDuplicate) {
            console.log(`[CloudGallerySync] Skipping duplicate: ${item.filename}`)
            await RNFS.unlink(tempPath)
            skippedDuplicates.push(item.filename)
            // Delete from cloud immediately (duplicate, no need to keep)
            await this.markSynced([item.id])
            continue
          }

          // Move to permanent location
          const finalPath = localStorageService.getPhotoFilePath(item.filename)
          console.log(`[CloudGallerySync] 📦 Moving ${item.filename} to permanent location: ${finalPath}`)
          await RNFS.moveFile(tempPath, finalPath)
          console.log(`[CloudGallerySync] ✅ File moved successfully: ${item.filename}`)

          // Calculate hash for future deduplication (skip for large files - too slow)
          let fileHash: string | undefined
          if (item.sizeBytes < SKIP_HASH_THRESHOLD) {
            console.log(`[CloudGallerySync] 🔐 Calculating hash for: ${item.filename}`)
            fileHash = await calculateFileHash(finalPath)
            console.log(`[CloudGallerySync] ✅ Hash calculated: ${item.filename} -> ${fileHash?.slice(0, 16)}...`)
          } else {
            console.log(`[CloudGallerySync] ⏭️ Skipping hash calculation for large file: ${item.filename}`)
          }

          // Download video thumbnail if available (so it persists after download completes)
          let thumbnailPath: string | undefined
          if (item.type === "video" && item.thumbnailUrl) {
            try {
              console.log(`[CloudGallerySync] 🖼️ Downloading video thumbnail for: ${item.filename}`)
              const thumbnailFilename = item.filename.replace(/\.(mp4|mov)$/i, "_thumb.jpg")
              thumbnailPath = localStorageService.getThumbnailFilePath(thumbnailFilename)
              await RNFS.downloadFile({
                fromUrl: item.thumbnailUrl,
                toFile: thumbnailPath,
              }).promise
              console.log(`[CloudGallerySync] ✅ Thumbnail downloaded: ${thumbnailFilename}`)
            } catch (thumbError: any) {
              console.warn(
                `[CloudGallerySync] ⚠️ Failed to download thumbnail for ${item.filename}:`,
                thumbError?.message || thumbError,
              )
              thumbnailPath = undefined // Clear path if download failed
            }
          }

          // Save to app storage with hash and thumbnail path
          const downloadedFile: DownloadedFile = {
            name: item.filename,
            filePath: finalPath,
            size: item.sizeBytes,
            modified: new Date(item.capturedAt).getTime(),
            mime_type: item.mimeType,
            is_video: item.type === "video",
            downloaded_at: Date.now(),
            fileHash, // Store hash for deduplication
            thumbnailPath, // Path to downloaded thumbnail (videos only)
          }

          console.log(`[CloudGallerySync] 💾 Saving to local storage: ${item.filename}`)
          await localStorageService.saveDownloadedFile(downloadedFile)
          console.log(`[CloudGallerySync] ✅ Saved to local storage: ${item.filename}`)

          // Mark file as complete (100% progress) - this removes it from cloudFileProgress immediately
          store.setCloudFileProgress(item.filename, 100)
          console.log(`[CloudGallerySync] ✅ Marked as 100% complete: ${item.filename}`)

          // Increment completed files count (like normal sync)
          store.onCloudFileComplete(item.filename)

          // Reload photos immediately so preview appears (like normal sync does)
          // Use a small delay to ensure file is fully written
          setTimeout(() => {
            // Trigger photo reload by emitting an event or calling a callback
            // For now, we'll rely on the effect in GalleryScreen that watches cloudFileProgress
            // But we should also trigger a reload here
            console.log(`[CloudGallerySync] ✅ File complete - should reload photos: ${item.filename}`)
          }, 100)

          // Save to camera roll if enabled
          if (shouldAutoSave) {
            console.log(`[CloudGallerySync] 📸 Saving to camera roll: ${item.filename}`)
            const captureTime = new Date(item.capturedAt).getTime()
            const saved = await MediaLibraryPermissions.saveToLibrary(finalPath, captureTime)
            if (saved) {
              console.log(`[CloudGallerySync] ✅ Saved to camera roll: ${item.filename}`)
            } else {
              console.warn(`[CloudGallerySync] ❌ Failed to save to camera roll: ${item.filename}`)
            }
          }

          // Delete from cloud immediately after successful download
          console.log(
            `[CloudGallerySync] 🗑️ Marking as synced (deleting from cloud): ${item.filename} (id: ${item.id})`,
          )
          await this.markSynced([item.id])
          console.log(`[CloudGallerySync] ✅ Downloaded and deleted from cloud: ${item.filename}`)

          // Remove from active downloads tracking
          this.activeDownloads.delete(item.filename)
        } catch (error: any) {
          console.error(`[CloudGallerySync] Failed to download ${item.filename}:`, error?.message || error)
          failedDownloads.push(item.filename)
          // Mark as failed in progress tracking
          store.setCloudFileProgress(item.filename, -1) // Use -1 to indicate failed
          // Remove from active downloads tracking
          this.activeDownloads.delete(item.filename)
        }
      }

      const successfulDownloads = sortedItems.length - skippedDuplicates.length - failedDownloads.length
      console.log(
        `[CloudGallerySync] Download complete: ${successfulDownloads} new, ${skippedDuplicates.length} duplicates, ${failedDownloads.length} failed`,
      )

      // Clear error state on success
      if (failedDownloads.length === 0) {
        store.setCloudSyncError(null)
      }

      // Show "Sync complete" message briefly, then hide banner
      this.isDownloading = false
      this.activeDownloads.clear() // Batch complete, clear tracking
      store.setCloudSyncComplete(true)
      setTimeout(() => {
        store.setCloudSyncComplete(false)
        store.setCloudSyncActive(false)
        // Clear cloud file progress, downloading items, reset counters, and pending count
        store.clearCloudFileProgress()
        store.setCloudDownloadingItems([])
        store.setCloudPending(0, 0) // Reset pending count since we downloaded everything
        useGallerySyncStore.setState({cloudCompletedFiles: 0, cloudTotalFiles: 0, cloudCurrentFile: 0})
      }, 2000) // Show "Sync complete" for 2 seconds, then hide banner
    } catch (error: any) {
      console.error("[CloudGallerySync] Download error:", error?.message || error)
      this.isDownloading = false
      this.activeDownloads.clear() // Batch failed, clear tracking
      store.setCloudSyncActive(false)
      store.setCloudSyncError(error?.message || "Download failed")
      // Reset counters on error (but keep pending count so user can retry)
      store.clearCloudFileProgress()
      store.setCloudDownloadingItems([])
      useGallerySyncStore.setState({cloudCompletedFiles: 0, cloudTotalFiles: 0, cloudCurrentFile: 0})
    }
  }

  /**
   * Download a single file from presigned URL with progress tracking
   */
  private async downloadFile(url: string, filename: string, onProgress?: (progress: number) => void): Promise<string> {
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${filename}`
    const isVideo = filename.toLowerCase().endsWith(".mp4") || filename.toLowerCase().endsWith(".mov")
    const downloadStartTime = Date.now()
    let lastLoggedPercent = -5 // Will log at 0%, 5%, 10%, etc.
    let progressCallbackCount = 0

    console.log(`[CloudGallerySync] 📥 ========================================`)
    console.log(`[CloudGallerySync] 📥 Starting download: ${filename}`)
    console.log(`[CloudGallerySync] 📥 ========================================`)
    console.log(`[CloudGallerySync]    URL: ${url.slice(0, 100)}...`)
    console.log(`[CloudGallerySync]    Temp path: ${tempPath}`)
    console.log(`[CloudGallerySync]    Is video: ${isVideo}`)
    console.log(
      `[CloudGallerySync]    Read timeout: ${
        isVideo ? TIMING.VIDEO_DOWNLOAD_TIMEOUT_MS : TIMING.DOWNLOAD_TIMEOUT_MS
      }ms`,
    )

    // Use longer timeout for videos
    const readTimeout = isVideo ? TIMING.VIDEO_DOWNLOAD_TIMEOUT_MS : TIMING.DOWNLOAD_TIMEOUT_MS

    const downloadResult = RNFS.downloadFile({
      fromUrl: url,
      toFile: tempPath,
      connectionTimeout: TIMING.REQUEST_TIMEOUT_MS,
      readTimeout,
      progressDivider: 1, // Get progress updates every 1%
      progressInterval: 250, // 250ms - balanced update frequency
      begin: (res) => {
        console.log(`[CloudGallerySync] 📥 Download began: ${filename}`)
        console.log(`[CloudGallerySync]    Content-Length: ${res.contentLength || "unknown"} bytes`)
        console.log(`[CloudGallerySync]    Status: ${res.statusCode}`)
        console.log(`[CloudGallerySync]    Job ID: ${res.jobId}`)
        console.log(`[CloudGallerySync]    Headers received at: ${Date.now() - downloadStartTime}ms`)
      },
      progress: (res) => {
        progressCallbackCount++
        const contentLength = res.contentLength || 0
        const bytesWritten = res.bytesWritten || 0
        let percentage = 0
        if (contentLength > 0 && bytesWritten >= 0) {
          percentage = Math.round((bytesWritten / contentLength) * 100)
          percentage = Math.max(0, Math.min(100, percentage))
        }

        // Log progress every 5%
        if (percentage >= lastLoggedPercent + 5) {
          lastLoggedPercent = percentage
          const elapsed = (Date.now() - downloadStartTime) / 1000
          const speed = elapsed > 0 ? bytesWritten / elapsed / 1024 : 0 // KB/s
          console.log(
            `[CloudGallerySync] 📊 ${filename}: ${percentage}% (${this.formatBytes(bytesWritten)}/${this.formatBytes(
              contentLength,
            )}) - ${speed.toFixed(1)} KB/s`,
          )
        }

        if (onProgress) {
          onProgress(percentage)
        }
      },
    })

    // Store job ID for potential cancellation
    console.log(`[CloudGallerySync] 📥 Download job started: ${downloadResult.jobId}`)

    const result = await downloadResult.promise

    const elapsed = (Date.now() - downloadStartTime) / 1000
    const avgSpeed = result.bytesWritten / elapsed / 1024 / 1024 // MB/s
    console.log(`[CloudGallerySync] ✅ ========================================`)
    console.log(`[CloudGallerySync] ✅ Download complete: ${filename}`)
    console.log(`[CloudGallerySync] ✅ ========================================`)
    console.log(`[CloudGallerySync]    Status: ${result.statusCode}`)
    console.log(`[CloudGallerySync]    Bytes: ${result.bytesWritten} (${this.formatBytes(result.bytesWritten)})`)
    console.log(`[CloudGallerySync]    Duration: ${elapsed.toFixed(1)}s`)
    console.log(`[CloudGallerySync]    Avg speed: ${avgSpeed.toFixed(2)} MB/s`)
    console.log(`[CloudGallerySync]    Total progress callbacks: ${progressCallbackCount}`)

    if (result.statusCode !== 200) {
      console.error(`[CloudGallerySync] ❌ Download failed: HTTP ${result.statusCode}`)
      throw new Error(`Download failed with status ${result.statusCode}`)
    }

    // Verify file exists and has correct size
    try {
      const fileInfo = await RNFS.stat(tempPath)
      console.log(`[CloudGallerySync]    File verified: ${fileInfo.size} bytes on disk`)
      if (fileInfo.size !== result.bytesWritten) {
        console.warn(
          `[CloudGallerySync] ⚠️ Size mismatch! Downloaded ${result.bytesWritten} but file is ${fileInfo.size}`,
        )
      }
    } catch (statError: any) {
      console.error(`[CloudGallerySync] ❌ Failed to verify downloaded file: ${statError?.message}`)
    }

    return tempPath
  }

  /**
   * Mark items as synced (triggers cloud deletion)
   */
  async markSynced(ids: string[]): Promise<void> {
    const startTime = Date.now()
    console.log(`[CloudGallerySync] 🗑️ markSynced() called with ${ids.length} ids: ${ids.join(", ")}`)

    try {
      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      console.warn("[CloudGallerySync] ⚠️ TEMPORARY OVERRIDE ACTIVE:", baseUrl, "- DO NOT COMMIT THIS!")
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code

      const token = restComms.getCoreToken()

      if (!token) {
        console.error("[CloudGallerySync] ❌ markSynced failed: No auth token available")
        throw new Error("No auth token available")
      }

      console.log(`[CloudGallerySync] 📤 POSTing to mark-synced endpoint...`)

      const response = await axios.post(
        `${baseUrl}/api/client/asg/gallery/mark-synced`,
        {ids},
        {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: TIMING.REQUEST_TIMEOUT_MS,
        },
      )

      const elapsed = Date.now() - startTime
      console.log(`[CloudGallerySync] ✅ Marked ${ids.length} items as synced (deleted from cloud)`)
      console.log(`[CloudGallerySync]    Response status: ${response.status}`)
      console.log(`[CloudGallerySync]    Response data: ${JSON.stringify(response.data)}`)
      console.log(`[CloudGallerySync]    Duration: ${elapsed}ms`)
    } catch (error: any) {
      const elapsed = Date.now() - startTime
      console.error(`[CloudGallerySync] ❌ markSynced FAILED after ${elapsed}ms`)
      console.error(`[CloudGallerySync]    IDs: ${ids.join(", ")}`)
      console.error(`[CloudGallerySync]    Error: ${error?.message || error}`)
      console.error(`[CloudGallerySync]    Response status: ${error?.response?.status}`)
      console.error(`[CloudGallerySync]    Response data: ${JSON.stringify(error?.response?.data)}`)
      // Don't throw - this is cleanup, not critical
    }
  }

  /**
   * Delete item from cloud without downloading
   */
  async deleteItem(itemId: string): Promise<void> {
    try {
      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      console.warn("[CloudGallerySync] ⚠️ TEMPORARY OVERRIDE ACTIVE:", baseUrl, "- DO NOT COMMIT THIS!")
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code

      const token = restComms.getCoreToken()

      if (!token) {
        throw new Error("No auth token available")
      }

      await axios.delete(`${baseUrl}/api/client/asg/gallery/${itemId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: TIMING.REQUEST_TIMEOUT_MS,
      })

      console.log(`[CloudGallerySync] Deleted item: ${itemId}`)
    } catch (error: any) {
      console.error("[CloudGallerySync] Error deleting item:", error?.message || error)
      throw error
    }
  }

  /**
   * Force an immediate check (for manual trigger)
   */
  async forceCheck(): Promise<void> {
    console.log("[CloudGallerySync] Force check requested")
    await this.checkPending()
  }

  /**
   * Check if currently downloading
   */
  isCurrentlyDownloading(): boolean {
    return this.isDownloading
  }

  /**
   * Format bytes to human readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + " B"
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB"
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB"
  }
}

export const cloudGallerySyncService = CloudGallerySyncService.getInstance()
