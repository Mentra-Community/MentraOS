/**
 * Cloud Gallery Sync Service
 * Polls cloud for pending photos/videos and downloads them to mobile
 * Works alongside WiFi Direct sync with deduplication
 */

import NetInfo from "@react-native-community/netinfo"
import axios from "axios"
import RNFS from "react-native-fs"

import restComms from "@/services/RestComms"
import {useGallerySyncStore} from "@/stores/gallerySync"
import {useSettingsStore} from "@/stores/settings"
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

  private constructor() {}

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

    try {
      const baseUrl = useSettingsStore.getState().getRestUrl()
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
        const baseUrl = useSettingsStore.getState().getRestUrl()
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

      const downloadedIds: string[] = []
      const skippedDuplicates: string[] = []
      const failedDownloads: string[] = []

      // Sort items by capture time (oldest first) for chronological order
      const sortedItems = [...items].sort((a, b) => {
        const timeA = new Date(a.capturedAt).getTime()
        const timeB = new Date(b.capturedAt).getTime()
        return timeA - timeB
      })

      for (const item of sortedItems) {
        try {
          console.log(`[CloudGallerySync] Downloading: ${item.filename} (${this.formatBytes(item.sizeBytes)})`)

          // Download to temp location first
          const tempPath = await this.downloadFile(item.downloadUrl, `temp_${item.filename}`)

          // Check for duplicates by hash
          const isDuplicate = await isDuplicateFile(tempPath, existingFilesArray)

          if (isDuplicate) {
            console.log(`[CloudGallerySync] Skipping duplicate: ${item.filename}`)
            await RNFS.unlink(tempPath)
            skippedDuplicates.push(item.filename)
            downloadedIds.push(item.id) // Still mark as synced in cloud
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

          downloadedIds.push(item.id)
          console.log(`[CloudGallerySync] ✅ Downloaded: ${item.filename}`)
        } catch (error: any) {
          console.error(`[CloudGallerySync] Failed to download ${item.filename}:`, error?.message || error)
          failedDownloads.push(item.filename)
        }
      }

      // Mark all downloaded items as synced (triggers cloud deletion)
      if (downloadedIds.length > 0) {
        await this.markSynced(downloadedIds)
      }

      console.log(
        `[CloudGallerySync] Download complete: ${downloadedIds.length - skippedDuplicates.length} new, ${skippedDuplicates.length} duplicates, ${failedDownloads.length} failed`,
      )

      // Clear error state on success
      if (failedDownloads.length === 0) {
        store.setCloudSyncError(null)
      }
    } catch (error: any) {
      console.error("[CloudGallerySync] Download error:", error?.message || error)
      store.setCloudSyncError(error?.message || "Download failed")
    } finally {
      this.isDownloading = false
      store.setCloudSyncActive(false)
    }
  }

  /**
   * Download a single file from presigned URL
   */
  private async downloadFile(url: string, filename: string): Promise<string> {
    const tempPath = `${RNFS.TemporaryDirectoryPath}/${filename}`

    console.log(`[CloudGallerySync] Downloading to temp: ${tempPath}`)

    const result = await RNFS.downloadFile({
      fromUrl: url,
      toFile: tempPath,
      connectionTimeout: TIMING.REQUEST_TIMEOUT_MS,
      readTimeout: TIMING.DOWNLOAD_TIMEOUT_MS,
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
      const baseUrl = useSettingsStore.getState().getRestUrl()
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
      const baseUrl = useSettingsStore.getState().getRestUrl()
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
