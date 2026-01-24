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
  DOWNLOAD_TIMEOUT_MS: 120000, // 2min timeout for file downloads
} as const

class CloudGallerySyncService {
  private static instance: CloudGallerySyncService
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private isDownloading = false
  private isPolling = false
  private consecutiveEmptyPolls = 0
  private glassesUploadingToCloud = false // Pause downloads while glasses are uploading

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
        store.setCloudProgress(i + 1, sortedItems.length, item.filename)

        // Initialize photo sync state for this file
        store.setCloudFileProgress(item.filename, 0)

        try {
          console.log(`[CloudGallerySync] Downloading: ${item.filename} (${this.formatBytes(item.sizeBytes)})`)

          // Download to temp location first with progress tracking
          const tempPath = await this.downloadFile(item.downloadUrl, `temp_${item.filename}`, (progress) => {
            // Update progress in store for gallery screen to display
            store.setCloudFileProgress(item.filename, progress)
          })

          // Check for duplicates by hash
          const isDuplicate = await isDuplicateFile(tempPath, existingFilesArray)

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
          await RNFS.moveFile(tempPath, finalPath)

          // Calculate hash for future deduplication
          const fileHash = await calculateFileHash(finalPath)

          // Save to app storage with hash
          const downloadedFile: DownloadedFile = {
            name: item.filename,
            filePath: finalPath,
            size: item.sizeBytes,
            modified: new Date(item.capturedAt).getTime(),
            mime_type: item.mimeType,
            is_video: item.type === "video",
            downloaded_at: Date.now(),
            fileHash, // Store hash for deduplication
          }

          await localStorageService.saveDownloadedFile(downloadedFile)

          // Mark file as complete (100% progress) - this removes it from cloudFileProgress immediately
          store.setCloudFileProgress(item.filename, 100)

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
            const captureTime = new Date(item.capturedAt).getTime()
            const saved = await MediaLibraryPermissions.saveToLibrary(finalPath, captureTime)
            if (saved) {
              console.log(`[CloudGallerySync] Saved to camera roll: ${item.filename}`)
            } else {
              console.warn(`[CloudGallerySync] Failed to save to camera roll: ${item.filename}`)
            }
          }

          // Delete from cloud immediately after successful download
          await this.markSynced([item.id])
          console.log(`[CloudGallerySync] ✅ Downloaded and deleted from cloud: ${item.filename}`)
        } catch (error: any) {
          console.error(`[CloudGallerySync] Failed to download ${item.filename}:`, error?.message || error)
          failedDownloads.push(item.filename)
          // Mark as failed in progress tracking
          store.setCloudFileProgress(item.filename, -1) // Use -1 to indicate failed
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

    console.log(`[CloudGallerySync] Downloading to temp: ${tempPath}`)

    const result = await RNFS.downloadFile({
      fromUrl: url,
      toFile: tempPath,
      connectionTimeout: TIMING.REQUEST_TIMEOUT_MS,
      readTimeout: TIMING.DOWNLOAD_TIMEOUT_MS,
      progressDivider: 1, // Get progress updates every 1%
      progressInterval: 250, // Update progress every 250ms max
      progress: (res) => {
        const contentLength = res.contentLength || 0
        const bytesWritten = res.bytesWritten || 0
        let percentage = 0
        if (contentLength > 0 && bytesWritten >= 0) {
          percentage = Math.round((bytesWritten / contentLength) * 100)
          percentage = Math.max(0, Math.min(100, percentage))
        }
        if (onProgress) {
          onProgress(percentage)
        }
      },
    }).promise

    if (result.statusCode !== 200) {
      throw new Error(`Download failed with status ${result.statusCode}`)
    }

    return tempPath
  }

  /**
   * Mark items as synced (triggers cloud deletion)
   */
  async markSynced(ids: string[]): Promise<void> {
    try {
      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      console.warn("[CloudGallerySync] ⚠️ TEMPORARY OVERRIDE ACTIVE:", baseUrl, "- DO NOT COMMIT THIS!")
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code

      const token = restComms.getCoreToken()

      if (!token) {
        throw new Error("No auth token available")
      }

      console.log(`[CloudGallerySync] Marking ${ids.length} items as synced`)

      await axios.post(
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

      console.log(`[CloudGallerySync] ✅ Marked ${ids.length} items as synced (deleted from cloud)`)
    } catch (error: any) {
      console.error("[CloudGallerySync] Error marking as synced:", error?.message || error)
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
