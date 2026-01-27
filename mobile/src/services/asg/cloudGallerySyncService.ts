/**
 * Cloud Gallery Sync Service
 * Polls cloud for pending photos/videos and downloads them to mobile
 * Works alongside WiFi Direct sync with deduplication
 */

import NetInfo from "@react-native-community/netinfo"
import axios from "axios"
import * as RNFS from "@dr.pogodin/react-native-fs"
import CoreModule from "core"

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
  private activeDownloads = new Set<string>() // Track filenames currently being downloaded
  // Track temp files for active downloads so we can clean them up on cancel
  private activeTempFiles = new Map<string, string>() // filename -> tempPath
  // Cooldown after cancellation to prevent immediate re-download attempts
  private downloadCooldownUntil: number | null = null
  private readonly DOWNLOAD_COOLDOWN_MS = 30 * 1000 // 30 seconds

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
    this.activeDownloads.clear() // Clear any pending download tracking
    console.log("[CloudGallerySync] Stopped polling")
  }

  /**
   * Get current gallery status from cloud
   */
  async getGalleryStatus(): Promise<{
    isUploading: boolean
    isDownloading: boolean
    uploadProgress?: {current: number; total: number; currentFile?: string}
    pendingCount: number
  } | null> {
    try {
      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code

      const token = restComms.getCoreToken()
      if (!token) {
        console.log("[CloudGallerySync] ⚠️ No auth token available for status check")
        return null
      }

      const response = await axios.get<{
        success: boolean
        data: {
          isUploading: boolean
          isDownloading: boolean
          uploadProgress?: {current: number; total: number; currentFile?: string}
          pendingCount: number
        }
      }>(`${baseUrl}/api/client/asg/gallery/status`, {
        headers: {Authorization: `Bearer ${token}`},
        timeout: TIMING.REQUEST_TIMEOUT_MS,
      })

      if (response.data.success) {
        const status = response.data.data
        console.log(
          `[CloudGallerySync] 📊 Gallery status: isUploading=${status.isUploading}, isDownloading=${status.isDownloading}, pendingCount=${status.pendingCount}`,
        )
        if (status.isUploading && status.uploadProgress) {
          console.log(
            `[CloudGallerySync] 📊 Upload progress: ${status.uploadProgress.current}/${status.uploadProgress.total}`,
          )
        }
        return status
      }
      console.warn("[CloudGallerySync] ⚠️ Status check returned success=false")
      return null
    } catch (error: any) {
      // 503/502/504 are temporary server errors - don't log as errors, just return null
      const statusCode = error?.response?.status
      if (statusCode === 503 || statusCode === 502 || statusCode === 504) {
        console.log(`[CloudGallerySync] ⏸️ Server temporarily unavailable (${statusCode}) - will retry on next poll`)
        // Clear any previous error since this is just a temporary server issue
        const store = useGallerySyncStore.getState()
        store.setCloudSyncError(null)
        return null
      }
      console.warn("[CloudGallerySync] ❌ Failed to get gallery status:", error?.message || error)
      return null
    }
  }

  /**
   * Request permission to start cloud download
   */
  async requestDownloadPermission(): Promise<{allowed: boolean; reason?: string}> {
    try {
      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code

      const token = restComms.getCoreToken()
      if (!token) {
        console.warn("[CloudGallerySync] ⚠️ No auth token - denying download permission")
        return {allowed: false, reason: "No auth token"}
      }

      const response = await axios.post<{
        success: boolean
        data: {allowed: boolean; reason?: string}
      }>(
        `${baseUrl}/api/client/asg/gallery/request-download`,
        {},
        {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: 10000, // 10 second timeout for permission check
        },
      )

      if (response.data.success && response.data.data) {
        const result = response.data.data
        if (result.allowed) {
          console.log("[CloudGallerySync] ✅ Download permission granted by cloud")
        } else {
          console.warn(`[CloudGallerySync] ❌ Download permission denied: ${result.reason || "Unknown reason"}`)
        }
        return result
      }

      console.warn("[CloudGallerySync] ⚠️ Invalid response format from permission endpoint")
      return {allowed: false, reason: "Invalid response format"}
    } catch (error: any) {
      // Timeout or network error - treat as denial (fail-safe)
      const statusCode = error?.response?.status
      if (statusCode === 503 || statusCode === 502 || statusCode === 504) {
        console.warn(`[CloudGallerySync] ⚠️ Server temporarily unavailable (${statusCode}) - denying permission`)
        return {allowed: false, reason: "Server temporarily unavailable"}
      }
      console.error(
        "[CloudGallerySync] ❌ Error requesting download permission (cloud unreachable):",
        error?.message || error,
      )
      return {allowed: false, reason: "Cloud unreachable"}
    }
  }

  /**
   * Request permission to start WiFi Direct sync
   */
  async requestWifiDirectPermission(): Promise<{allowed: boolean; reason?: string}> {
    try {
      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code

      const token = restComms.getCoreToken()
      if (!token) {
        console.warn("[CloudGallerySync] ⚠️ No auth token - denying WiFi Direct permission")
        return {allowed: false, reason: "No auth token"}
      }

      const response = await axios.post<{
        success: boolean
        data: {allowed: boolean; reason?: string}
      }>(
        `${baseUrl}/api/client/asg/gallery/request-wifi-direct`,
        {},
        {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: 10000, // 10 second timeout for permission check
        },
      )

      if (response.data.success && response.data.data) {
        const result = response.data.data
        if (result.allowed) {
          console.log("[CloudGallerySync] ✅ WiFi Direct permission granted by cloud")
        } else {
          console.warn(`[CloudGallerySync] ❌ WiFi Direct permission denied: ${result.reason || "Unknown reason"}`)
        }
        return result
      }

      console.warn("[CloudGallerySync] ⚠️ Invalid response format from permission endpoint")
      return {allowed: false, reason: "Invalid response format"}
    } catch (error: any) {
      // Timeout or network error - treat as denial (fail-safe)
      const statusCode = error?.response?.status
      if (statusCode === 503 || statusCode === 502 || statusCode === 504) {
        console.warn(`[CloudGallerySync] ⚠️ Server temporarily unavailable (${statusCode}) - denying permission`)
        return {allowed: false, reason: "Server temporarily unavailable"}
      }
      console.error(
        "[CloudGallerySync] ❌ Error requesting WiFi Direct permission (cloud unreachable):",
        error?.message || error,
      )
      return {allowed: false, reason: "Cloud unreachable"}
    }
  }

  /**
   * Check for pending files in cloud
   */
  async checkPending(ignoreUploadStatus = false): Promise<void> {
    if (this.isDownloading) {
      console.log("[CloudGallerySync] Already downloading, skipping poll")
      return
    }

    // Check cooldown after cancellation
    if (this.downloadCooldownUntil !== null && Date.now() < this.downloadCooldownUntil) {
      const remainingSeconds = Math.ceil((this.downloadCooldownUntil - Date.now()) / 1000)
      console.log(`[CloudGallerySync] ⏸️ Download cooldown active (${remainingSeconds}s remaining) - skipping poll`)
      return
    } else if (this.downloadCooldownUntil !== null) {
      // Cooldown expired, clear it
      console.log("[CloudGallerySync] ✅ Download cooldown expired - resuming normal polling")
      this.downloadCooldownUntil = null
    }

    // Block cloud downloads during WiFi Direct sync
    const store = useGallerySyncStore.getState()
    const isWifiDirectSyncActive =
      store.syncState === "syncing" || store.syncState === "connecting_wifi" || store.syncState === "requesting_hotspot"
    if (isWifiDirectSyncActive) {
      console.log(`[CloudGallerySync] 🚫 WiFi Direct sync active (state: ${store.syncState}) - blocking cloud download`)
      return
    }

    // Check cloud status first - wait if glasses are uploading (unless explicitly ignored)
    const status = await this.getGalleryStatus()
    if (status?.isUploading && !ignoreUploadStatus) {
      console.log(
        `[CloudGallerySync] 🚫 Glasses uploading to cloud (${status.uploadProgress?.current || 0}/${status.uploadProgress?.total || 0}) - skipping poll`,
      )
      // Update store with upload progress
      const store = useGallerySyncStore.getState()
      if (status.uploadProgress) {
        store.setCloudUploadStatus(
          true,
          status.uploadProgress.current,
          status.uploadProgress.total,
          status.uploadProgress.currentFile,
        )
      }
      return
    }

    // If cloud says not uploading but local state says uploading, clear local state
    if (!status?.isUploading) {
      const store = useGallerySyncStore.getState()
      if (store.cloudUploadIsUploading) {
        console.log("[CloudGallerySync] 🔄 Clearing stale upload state (cloud says no active upload)")
        store.setCloudUploadStatus(false, 0, 0, undefined)
      }
    }

    // If we're ignoring upload status (e.g., after failure notification), log it
    if (ignoreUploadStatus && status?.isUploading) {
      console.log(
        `[CloudGallerySync] ⚠️ Cloud still shows uploading, but proceeding anyway due to failure notification`,
      )
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
      // 503/502/504 are temporary server errors - don't show as user-facing errors
      const statusCode = error?.response?.status
      if (statusCode === 503 || statusCode === 502 || statusCode === 504) {
        console.log(`[CloudGallerySync] ⏸️ Server temporarily unavailable (${statusCode}) - will retry on next poll`)
        // Clear any previous error since this is just a temporary server issue
        const store = useGallerySyncStore.getState()
        store.setCloudSyncError(null)
        return
      }

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

    // Block cloud downloads during WiFi Direct sync
    const store = useGallerySyncStore.getState()
    const isWifiDirectSyncActive =
      store.syncState === "syncing" || store.syncState === "connecting_wifi" || store.syncState === "requesting_hotspot"
    if (isWifiDirectSyncActive) {
      console.log(
        `[CloudGallerySync] 🚫 BLOCKED: Cannot download from cloud while WiFi Direct sync is active (state: ${store.syncState})`,
      )
      return
    }

    // Request permission from cloud before starting download
    console.log("[CloudGallerySync] 🔐 Requesting download permission from cloud...")
    const permission = await this.requestDownloadPermission()
    if (!permission.allowed) {
      console.warn(
        `[CloudGallerySync] ❌ Download permission denied or cloud unreachable: ${permission.reason || "Unknown reason"}`,
      )
      const store = useGallerySyncStore.getState()
      store.setCloudSyncError(permission.reason || "Download permission denied")
      return
    }

    // Check cloud status - wait if glasses are uploading (prevents race conditions)
    const status = await this.getGalleryStatus()
    if (status?.isUploading) {
      console.log(
        `[CloudGallerySync] 🚫 BLOCKED: Cannot download while glasses are uploading (${status.uploadProgress?.current || 0}/${status.uploadProgress?.total || 0})`,
      )
      return
    }

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

      // Only set active state after confirming there are items to download
      this.isDownloading = true
      const store = useGallerySyncStore.getState()
      store.setCloudSyncActive(true)

      // Notify cloud that download has started
      try {
        // TEMPORARY OVERRIDE - DO NOT COMMIT
        const baseUrl = "https://clouddev.ngrok.app"
        // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code
        const token = restComms.getCoreToken()
        if (token) {
          await axios.post(
            `${baseUrl}/api/client/asg/gallery/download-started`,
            {},
            {
              headers: {Authorization: `Bearer ${token}`},
              timeout: TIMING.REQUEST_TIMEOUT_MS,
            },
          )
          console.log("[CloudGallerySync] ✅ Notified cloud: download started")
        }
      } catch (error: any) {
        console.warn("[CloudGallerySync] Failed to notify cloud of download start:", error?.message || error)
        // Non-fatal - continue with download
      }

      // Filter out items that are in WiFi sync queue (WiFi sync takes priority)
      const syncQueue = store.queue || []
      const syncQueueNames = new Set(syncQueue.map((p) => p.name))
      const itemsToDownload = items.filter((item) => !syncQueueNames.has(item.filename))
      const skippedWiFiSync = items.length - itemsToDownload.length

      if (skippedWiFiSync > 0) {
        console.log(`[CloudGallerySync] ⏭️ Skipping ${skippedWiFiSync} item(s) - already in WiFi Direct sync queue`)
      }

      console.log(`[CloudGallerySync] Downloading ${itemsToDownload.length} items`)

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
      const sortedItems = [...itemsToDownload].sort((a, b) => {
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

        // Check if glasses started uploading (check status periodically)
        if (i % 5 === 0) {
          // Check every 5 files to avoid too many status checks
          const status = await this.getGalleryStatus()
          if (status?.isUploading) {
            console.log("[CloudGallerySync] 🛑 ABORT: Glasses started uploading - stopping download batch")
            break
          }
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

        // Generate unique temp filename to prevent race conditions
        // Even with activeDownloads guard, use unique suffix for extra safety
        const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const tempFilename = `temp_${uniqueSuffix}_${item.filename}`
        let tempPath: string | null = null

        try {
          console.log(`[CloudGallerySync] Downloading: ${item.filename} (${this.formatBytes(item.sizeBytes)})`)

          // Download to temp location first with progress tracking
          tempPath = await this.downloadFile(item.downloadUrl, tempFilename, (progress) => {
            // Update progress in store for gallery screen to display
            store.setCloudFileProgress(item.filename, progress)
          })

          // Track temp file for cleanup if download is cancelled
          if (tempPath) {
            this.activeTempFiles.set(item.filename, tempPath)
          }

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

          // Remove from temp file tracking (file moved successfully)
          this.activeTempFiles.delete(item.filename)

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

          // Cleanup temp file if it exists
          const tempPathToClean = this.activeTempFiles.get(item.filename)
          if (tempPathToClean) {
            try {
              if (await RNFS.exists(tempPathToClean)) {
                await RNFS.unlink(tempPathToClean)
                console.log(`[CloudGallerySync] 🗑️ Cleaned up temp file: ${item.filename}`)
              }
            } catch (cleanupError: any) {
              console.warn(
                `[CloudGallerySync] ⚠️ Failed to cleanup temp file ${item.filename}:`,
                cleanupError?.message || cleanupError,
              )
            }
            this.activeTempFiles.delete(item.filename)
          }

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

      // Notify cloud that download has completed
      try {
        // TEMPORARY OVERRIDE - DO NOT COMMIT
        const baseUrl = "https://clouddev.ngrok.app"
        // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code
        const token = restComms.getCoreToken()
        if (token) {
          await axios.post(
            `${baseUrl}/api/client/asg/gallery/download-complete`,
            {},
            {
              headers: {Authorization: `Bearer ${token}`},
              timeout: TIMING.REQUEST_TIMEOUT_MS,
            },
          )
          console.log("[CloudGallerySync] ✅ Notified cloud: download completed")
        }
      } catch (error: any) {
        console.warn("[CloudGallerySync] Failed to notify cloud of download completion:", error?.message || error)
        // Non-fatal - continue with cleanup
      }

      // Show "Sync complete" message briefly, then hide banner
      this.isDownloading = false
      this.activeDownloads.clear() // Batch complete, clear tracking
      // Clear cooldown on successful completion
      this.downloadCooldownUntil = null
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

      // Notify cloud that download failed/completed (cleanup session)
      try {
        // TEMPORARY OVERRIDE - DO NOT COMMIT
        const baseUrl = "https://clouddev.ngrok.app"
        // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code
        const token = restComms.getCoreToken()
        if (token) {
          await axios.post(
            `${baseUrl}/api/client/asg/gallery/download-complete`,
            {},
            {
              headers: {Authorization: `Bearer ${token}`},
              timeout: TIMING.REQUEST_TIMEOUT_MS,
            },
          )
          console.log("[CloudGallerySync] ✅ Notified cloud: download ended (error cleanup)")
        }
      } catch (notifyError: any) {
        console.warn("[CloudGallerySync] Failed to notify cloud of download end:", notifyError?.message || notifyError)
        // Non-fatal
      }

      this.isDownloading = false
      this.activeDownloads.clear() // Batch failed, clear tracking
      const store = useGallerySyncStore.getState()
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
   * Notify cloud that WiFi Direct sync completed (clears reservation)
   */
  async notifyWifiDirectComplete(): Promise<void> {
    try {
      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code

      const token = restComms.getCoreToken()
      if (!token) {
        console.warn("[CloudGallerySync] ⚠️ No auth token - cannot notify WiFi Direct complete")
        return
      }

      await axios.post(
        `${baseUrl}/api/client/asg/gallery/wifi-direct-complete`,
        {},
        {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: TIMING.REQUEST_TIMEOUT_MS,
        },
      )

      console.log("[CloudGallerySync] ✅ Notified cloud: WiFi Direct sync completed")
    } catch (error: any) {
      console.warn(
        "[CloudGallerySync] ⚠️ Failed to notify cloud of WiFi Direct completion (non-fatal):",
        error?.message || error,
      )
      // Non-fatal - reservation will expire automatically
    }
  }

  /**
   * Delete cloud copies of files that were synced via WiFi Direct.
   * Called after WiFi Direct sync completes to clean up cloud duplicates.
   */
  async deleteCloudCopiesByFilenames(filenames: string[]): Promise<void> {
    if (filenames.length === 0) {
      return
    }

    try {
      console.log(
        `[CloudGallerySync] 🗑️ Checking cloud for ${filenames.length} files synced via WiFi Direct to delete cloud copies...`,
      )

      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      console.warn("[CloudGallerySync] ⚠️ TEMPORARY OVERRIDE ACTIVE:", baseUrl, "- DO NOT COMMIT THIS!")
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code

      const token = restComms.getCoreToken()

      if (!token) {
        console.warn("[CloudGallerySync] ⚠️ No auth token - skipping cloud cleanup")
        return
      }

      // Query cloud for pending items
      const response = await axios.get<{success: boolean; data: PendingResponse}>(
        `${baseUrl}/api/client/asg/gallery/pending?limit=100`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: TIMING.REQUEST_TIMEOUT_MS,
        },
      )

      if (!response.data.success) {
        console.warn("[CloudGallerySync] ⚠️ Failed to query cloud for cleanup")
        return
      }

      const {items} = response.data.data
      const filenameSet = new Set(filenames)

      // Find cloud items matching the synced filenames
      const itemsToDelete = items.filter((item) => filenameSet.has(item.filename))

      if (itemsToDelete.length === 0) {
        console.log(
          `[CloudGallerySync] ✅ No cloud copies found for ${filenames.length} WiFi Direct synced files (already cleaned up or not uploaded yet)`,
        )
        return
      }

      const idsToDelete = itemsToDelete.map((item) => item.id)
      console.log(
        `[CloudGallerySync] 🗑️ Found ${itemsToDelete.length} cloud copies to delete: ${itemsToDelete.map((i) => i.filename).join(", ")}`,
      )

      // Delete them from cloud
      await this.markSynced(idsToDelete)
      console.log(`[CloudGallerySync] ✅ Deleted ${itemsToDelete.length} cloud copies of WiFi Direct synced files`)
    } catch (error: any) {
      console.warn(`[CloudGallerySync] ⚠️ Failed to delete cloud copies (non-fatal):`, error?.message || error)
      // Don't throw - this is cleanup, not critical
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
   * Cancel active download session
   */
  async cancelDownload(): Promise<void> {
    if (!this.isDownloading) {
      console.log("[CloudGallerySync] No active download to cancel")
      return
    }

    console.log("[CloudGallerySync] 🛑 Cancelling download...")

    // Stop downloading
    this.isDownloading = false
    const store = useGallerySyncStore.getState()
    store.setCloudSyncActive(false)

    // Clear UI state (shimmers and downloading items)
    store.clearCloudFileProgress()
    store.setCloudDownloadingItems([])
    console.log("[CloudGallerySync] ✅ Cleared cloud downloading items and progress from UI")

    // Set cooldown to prevent immediate re-download attempts
    this.downloadCooldownUntil = Date.now() + this.DOWNLOAD_COOLDOWN_MS
    console.log(
      `[CloudGallerySync] ⏸️ Download cooldown active for ${this.DOWNLOAD_COOLDOWN_MS / 1000} seconds (until ${new Date(this.downloadCooldownUntil).toLocaleTimeString()})`,
    )

    // Cleanup temp files for active downloads
    const tempFilesToClean = Array.from(this.activeTempFiles.entries())
    if (tempFilesToClean.length > 0) {
      console.log(
        `[CloudGallerySync] 🗑️ Cleaning up ${tempFilesToClean.length} temp file(s) from cancelled downloads...`,
      )
      for (const [filename, tempPath] of tempFilesToClean) {
        try {
          if (await RNFS.exists(tempPath)) {
            await RNFS.unlink(tempPath)
            console.log(`[CloudGallerySync] ✅ Cleaned up temp file: ${filename}`)
          }
        } catch (cleanupError: any) {
          console.warn(
            `[CloudGallerySync] ⚠️ Failed to cleanup temp file ${filename}:`,
            cleanupError?.message || cleanupError,
          )
        }
      }
      this.activeTempFiles.clear()
    }

    // Notify cloud that download was cancelled
    try {
      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code
      const token = restComms.getCoreToken()
      if (token) {
        await axios.post(
          `${baseUrl}/api/client/asg/gallery/cancel-download`,
          {},
          {
            headers: {Authorization: `Bearer ${token}`},
            timeout: TIMING.REQUEST_TIMEOUT_MS,
          },
        )
        console.log("[CloudGallerySync] ✅ Notified cloud: download cancelled")
      }
    } catch (error: any) {
      console.warn("[CloudGallerySync] Failed to notify cloud of download cancellation:", error?.message || error)
    }

    // Clear active downloads set
    this.activeDownloads.clear()
  }

  private isCancellingUpload = false

  /**
   * Cancel active upload session (notify cloud)
   */
  async cancelUpload(): Promise<void> {
    // Prevent multiple rapid calls
    if (this.isCancellingUpload) {
      console.log("[CloudGallerySync] ⏳ Upload cancellation already in progress")
      return
    }

    this.isCancellingUpload = true
    console.log("[CloudGallerySync] 🛑 Cancelling upload...")

    try {
      // TEMPORARY OVERRIDE - DO NOT COMMIT
      const baseUrl = "https://clouddev.ngrok.app"
      // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code
      const token = restComms.getCoreToken()
      if (token) {
        const response = await axios.post(
          `${baseUrl}/api/client/asg/gallery/cancel-upload`,
          {},
          {
            headers: {Authorization: `Bearer ${token}`},
            timeout: TIMING.REQUEST_TIMEOUT_MS,
          },
        )

        if (response.data.success) {
          console.log("[CloudGallerySync] ✅ Upload cancelled on cloud")
          // Clear upload status in store
          const store = useGallerySyncStore.getState()
          store.setCloudUploadStatus(false, 0, 0, undefined)

          // Send BLE message to glasses to stop uploading
          try {
            CoreModule.sendCancelCloudUpload()
            console.log("[CloudGallerySync] ✅ Sent cancel_cloud_upload command to glasses via BLE")
          } catch (error: any) {
            console.warn("[CloudGallerySync] Failed to send cancel command to glasses:", error?.message || error)
          }
        } else {
          console.log("[CloudGallerySync] ℹ️ No active upload session to cancel")
          // Still clear local state in case it's stale
          const store = useGallerySyncStore.getState()
          store.setCloudUploadStatus(false, 0, 0, undefined)

          // Still send cancel command to glasses in case they're uploading
          try {
            CoreModule.sendCancelCloudUpload()
            console.log("[CloudGallerySync] ✅ Sent cancel_cloud_upload command to glasses via BLE (preventive)")
          } catch (error: any) {
            console.warn("[CloudGallerySync] Failed to send cancel command to glasses:", error?.message || error)
          }
        }
      }
    } catch (error: any) {
      // 404 means no active upload session - this is fine, just clear local state
      if (error?.response?.status === 404) {
        console.log("[CloudGallerySync] ℹ️ No active upload session to cancel (404)")
        const store = useGallerySyncStore.getState()
        store.setCloudUploadStatus(false, 0, 0, undefined)
      } else {
        console.warn("[CloudGallerySync] Failed to cancel upload:", error?.message || error)
      }

      // Always send cancel command to glasses regardless of cloud response
      // (glasses might still be uploading even if cloud says no session)
      try {
        CoreModule.sendCancelCloudUpload()
        console.log("[CloudGallerySync] ✅ Sent cancel_cloud_upload command to glasses via BLE")
      } catch (error: any) {
        console.warn("[CloudGallerySync] Failed to send cancel command to glasses:", error?.message || error)
      }
    } finally {
      this.isCancellingUpload = false
    }
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
