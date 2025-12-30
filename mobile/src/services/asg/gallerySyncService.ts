/**
 * Gallery Sync Service
 * Orchestrates gallery sync independently of UI lifecycle
 */

import CoreModule from "core"
import {Platform} from "react-native"
import WifiManager from "react-native-wifi-reborn"

import {useGallerySyncStore, HotspotInfo} from "@/stores/gallerySync"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {PhotoInfo} from "@/types/asg"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {MediaLibraryPermissions} from "@/utils/permissions/MediaLibraryPermissions"

import {asgCameraApi} from "./asgCameraApi"
import {gallerySettingsService} from "./gallerySettingsService"
import {gallerySyncNotifications} from "./gallerySyncNotifications"
import {localStorageService} from "./localStorageService"

// Timing constants
const TIMING = {
  HOTSPOT_CONNECT_DELAY_MS: 1000,
  HOTSPOT_REQUEST_TIMEOUT_MS: 30000, // Timeout waiting for hotspot to enable
  WIFI_CONNECTION_TIMEOUT_MS: 30000,
  RETRY_DELAY_MS: 2000,
  MAX_QUEUE_AGE_MS: 2 * 60 * 1000, // 2 min - glasses hotspot auto-disables after 40s inactivity
  // iOS WiFi connection timing - the system shows a dialog that user must accept
  IOS_WIFI_RETRY_DELAY_MS: 3000, // Wait for user to interact with iOS dialog
  IOS_WIFI_MAX_RETRIES: 5, // Retry multiple times to give user time to accept
} as const

class GallerySyncService {
  private static instance: GallerySyncService
  private hotspotListenerRegistered = false
  private hotspotConnectionTimeout: ReturnType<typeof setTimeout> | null = null
  private hotspotRequestTimeout: ReturnType<typeof setTimeout> | null = null
  private abortController: AbortController | null = null
  private isInitialized = false
  private glassesStoreUnsubscribe: (() => void) | null = null

  private constructor() {}

  static getInstance(): GallerySyncService {
    if (!GallerySyncService.instance) {
      GallerySyncService.instance = new GallerySyncService()
    }
    return GallerySyncService.instance
  }

  /**
   * Initialize the service - register event listeners
   */
  initialize(): void {
    if (this.isInitialized) return

    // Listen for hotspot status changes
    GlobalEventEmitter.addListener("hotspot_status_change", this.handleHotspotStatusChange)
    GlobalEventEmitter.addListener("hotspot_error", this.handleHotspotError)
    GlobalEventEmitter.addListener("gallery_status", this.handleGalleryStatus)

    // Subscribe to glasses store to detect disconnection during sync
    this.glassesStoreUnsubscribe = useGlassesStore.subscribe(
      state => state.connected,
      (connected, prevConnected) => {
        // Only trigger on disconnect (was connected, now not connected)
        if (prevConnected && !connected) {
          this.handleGlassesDisconnected()
        }
      },
    )

    this.hotspotListenerRegistered = true
    this.isInitialized = true

    console.log("[GallerySyncService] Initialized")

    // Check for resumable sync on startup
    this.checkForResumableSync()
  }

  /**
   * Cleanup - remove event listeners
   */
  cleanup(): void {
    if (this.hotspotListenerRegistered) {
      GlobalEventEmitter.removeListener("hotspot_status_change", this.handleHotspotStatusChange)
      GlobalEventEmitter.removeListener("hotspot_error", this.handleHotspotError)
      GlobalEventEmitter.removeListener("gallery_status", this.handleGalleryStatus)
      this.hotspotListenerRegistered = false
    }

    if (this.glassesStoreUnsubscribe) {
      this.glassesStoreUnsubscribe()
      this.glassesStoreUnsubscribe = null
    }

    if (this.hotspotConnectionTimeout) {
      clearTimeout(this.hotspotConnectionTimeout)
      this.hotspotConnectionTimeout = null
    }

    if (this.hotspotRequestTimeout) {
      clearTimeout(this.hotspotRequestTimeout)
      this.hotspotRequestTimeout = null
    }

    this.isInitialized = false
    console.log("[GallerySyncService] Cleaned up")
  }

  /**
   * Handle glasses disconnection during sync
   */
  private handleGlassesDisconnected = (): void => {
    const store = useGallerySyncStore.getState()

    // Only handle if we're actively syncing
    if (!this.isSyncing()) {
      return
    }

    console.log("[GallerySyncService] Glasses disconnected during sync - cancelling")
    store.setSyncError("Glasses disconnected")

    // Abort ongoing downloads
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    // Clear timeouts
    if (this.hotspotConnectionTimeout) {
      clearTimeout(this.hotspotConnectionTimeout)
      this.hotspotConnectionTimeout = null
    }
    if (this.hotspotRequestTimeout) {
      clearTimeout(this.hotspotRequestTimeout)
      this.hotspotRequestTimeout = null
    }

    gallerySyncNotifications.showSyncError("Glasses disconnected")
  }

  /**
   * Handle gallery status from glasses
   */
  private handleGalleryStatus = (data: any): void => {
    console.log("[GallerySyncService] Received gallery_status:", data)

    const store = useGallerySyncStore.getState()
    store.setGlassesGalleryStatus(data.photos || 0, data.videos || 0, data.total || 0, data.has_content || false)
  }

  /**
   * Handle hotspot status change event
   */
  private handleHotspotStatusChange = async (eventData: any): Promise<void> => {
    console.log("[GallerySyncService] Hotspot status changed:", eventData)

    const store = useGallerySyncStore.getState()

    // Only process if we're in a connecting state
    if (store.syncState !== "requesting_hotspot" && store.syncState !== "connecting_wifi") {
      console.log("[GallerySyncService] Ignoring hotspot event - not in connecting state")
      return
    }

    if (!eventData.enabled || !eventData.ssid || !eventData.password) {
      console.log("[GallerySyncService] Hotspot not ready yet")
      return
    }

    // Clear the hotspot request timeout since we got a response
    if (this.hotspotRequestTimeout) {
      clearTimeout(this.hotspotRequestTimeout)
      this.hotspotRequestTimeout = null
    }

    const hotspotInfo: HotspotInfo = {
      ssid: eventData.ssid,
      password: eventData.password,
      ip: eventData.local_ip,
    }

    store.setHotspotInfo(hotspotInfo)

    // Wait for hotspot to become discoverable
    console.log("[GallerySyncService] Hotspot enabled, waiting before connecting...")

    if (this.hotspotConnectionTimeout) {
      clearTimeout(this.hotspotConnectionTimeout)
    }

    this.hotspotConnectionTimeout = setTimeout(() => {
      this.connectToHotspotWifi(hotspotInfo)
      this.hotspotConnectionTimeout = null
    }, TIMING.HOTSPOT_CONNECT_DELAY_MS)
  }

  /**
   * Handle hotspot error event
   */
  private handleHotspotError = (eventData: any): void => {
    console.error("[GallerySyncService] Hotspot error:", eventData)

    const store = useGallerySyncStore.getState()

    if (this.hotspotConnectionTimeout) {
      clearTimeout(this.hotspotConnectionTimeout)
      this.hotspotConnectionTimeout = null
    }

    store.setSyncError(eventData.error_message || "Failed to start hotspot")
    gallerySyncNotifications.showSyncError("Failed to start hotspot")
  }

  /**
   * Start the sync process
   */
  async startSync(): Promise<void> {
    const store = useGallerySyncStore.getState()
    const glassesStore = useGlassesStore.getState()

    // Check if already syncing
    if (store.syncState === "syncing" || store.syncState === "connecting_wifi") {
      console.log("[GallerySyncService] Already syncing, ignoring start request")
      return
    }

    // Check if glasses are connected
    if (!glassesStore.connected) {
      store.setSyncError("Glasses not connected")
      return
    }

    console.log("[GallerySyncService] Starting sync...")

    // Request all permissions upfront so user isn't interrupted during WiFi/download
    // 1. Notification permission (for background sync progress)
    await gallerySyncNotifications.requestPermissions()

    // 2. Camera roll permission (if auto-save is enabled)
    const shouldAutoSave = await gallerySettingsService.getAutoSaveToCameraRoll()
    if (shouldAutoSave) {
      const hasPermission = await MediaLibraryPermissions.checkPermission()
      if (!hasPermission) {
        console.log("[GallerySyncService] Requesting camera roll permission upfront...")
        const granted = await MediaLibraryPermissions.requestPermission()
        if (!granted) {
          console.log("[GallerySyncService] Camera roll permission denied - photos will still sync to app")
          // Don't block sync - photos will still be downloaded to app storage
          // They just won't be saved to the camera roll
        }
      }
    }

    // Reset abort controller
    this.abortController = new AbortController()

    // Check if already connected to hotspot
    const isAlreadyConnected = glassesStore.hotspotEnabled && glassesStore.hotspotGatewayIp

    if (isAlreadyConnected) {
      console.log("[GallerySyncService] Already connected to hotspot, starting download directly")
      const hotspotInfo: HotspotInfo = {
        ssid: glassesStore.hotspotSsid,
        password: glassesStore.hotspotPassword,
        ip: glassesStore.hotspotGatewayIp,
      }
      store.setHotspotInfo(hotspotInfo)
      store.setSyncState("connecting_wifi")
      await this.startFileDownload(hotspotInfo)
      return
    }

    // Request hotspot
    store.setRequestingHotspot()
    store.setSyncServiceOpenedHotspot(true)

    // Set timeout for hotspot request - if we don't get a response, fail gracefully
    this.hotspotRequestTimeout = setTimeout(() => {
      const currentStore = useGallerySyncStore.getState()
      if (currentStore.syncState === "requesting_hotspot") {
        console.error("[GallerySyncService] Hotspot request timed out")
        currentStore.setSyncError("Hotspot request timed out")
        currentStore.setSyncServiceOpenedHotspot(false)
        gallerySyncNotifications.showSyncError("Could not start hotspot - please try again")
      }
      this.hotspotRequestTimeout = null
    }, TIMING.HOTSPOT_REQUEST_TIMEOUT_MS)

    try {
      await CoreModule.setHotspotState(true)
      console.log("[GallerySyncService] Hotspot requested")
    } catch (error) {
      // Clear the timeout since we got an immediate error
      if (this.hotspotRequestTimeout) {
        clearTimeout(this.hotspotRequestTimeout)
        this.hotspotRequestTimeout = null
      }
      console.error("[GallerySyncService] Failed to request hotspot:", error)
      store.setSyncError("Failed to start hotspot")
      store.setSyncServiceOpenedHotspot(false)
    }
  }

  /**
   * Connect to hotspot WiFi with retry logic (unified for both platforms)
   * Both iOS and Android benefit from retries:
   * - iOS: Library throws "internal error" before user responds to system dialog
   * - Android: Hotspot needs time to initialize, especially when glasses WiFi was cold
   */
  private async connectToHotspotWifi(hotspotInfo: HotspotInfo): Promise<void> {
    const store = useGallerySyncStore.getState()
    let lastError: any = null

    console.log(`[GallerySyncService] Connecting to WiFi: ${hotspotInfo.ssid}`)
    store.setSyncState("connecting_wifi")

    for (let attempt = 1; attempt <= TIMING.IOS_WIFI_MAX_RETRIES; attempt++) {
      // Check if cancelled
      if (this.abortController?.signal.aborted) {
        store.setSyncError("Sync cancelled")
        return
      }

      try {
        console.log(
          `[GallerySyncService] WiFi connection attempt ${attempt}/${TIMING.IOS_WIFI_MAX_RETRIES} (${Platform.OS})`,
        )

        // Use connectToProtectedSSID with joinOnce=false for persistent connection
        await WifiManager.connectToProtectedSSID(hotspotInfo.ssid, hotspotInfo.password, false, false)

        console.log(`[GallerySyncService] Connected to hotspot WiFi (${Platform.OS})`)

        // Start the actual download
        await this.startFileDownload(hotspotInfo)
        return // Success - exit the retry loop
      } catch (error: any) {
        lastError = error
        console.log(
          `[GallerySyncService] WiFi attempt ${attempt} failed (${Platform.OS}):`,
          error?.message || error?.code || "unknown error",
        )

        // If user explicitly denied, don't retry
        if (error?.code === "userDenied" || error?.message?.includes("cancel")) {
          console.log("[GallerySyncService] User cancelled WiFi connection")
          store.setSyncError("WiFi connection cancelled")
          if (store.syncServiceOpenedHotspot) {
            await this.closeHotspot()
          }
          return
        }

        // For "internal error" or "unableToConnect", wait and retry
        // iOS: Gives user time to interact with system dialog
        // Android: Gives hotspot time to fully initialize and start broadcasting
        if (attempt < TIMING.IOS_WIFI_MAX_RETRIES) {
          const reason =
            Platform.OS === "ios" ? "user may be seeing system dialog" : "hotspot may still be initializing"
          console.log(`[GallerySyncService] Waiting ${TIMING.IOS_WIFI_RETRY_DELAY_MS}ms before retry (${reason})...`)
          await new Promise(resolve => setTimeout(resolve, TIMING.IOS_WIFI_RETRY_DELAY_MS))
        }
      }
    }

    // All retries exhausted
    console.error(`[GallerySyncService] WiFi connection failed after all retries (${Platform.OS}):`, lastError)
    store.setSyncError(
      lastError?.message?.includes("internal error")
        ? "Could not connect to glasses WiFi. Please ensure you accept the WiFi prompt when it appears."
        : lastError?.message || "Failed to connect to glasses WiFi",
    )

    if (store.syncServiceOpenedHotspot) {
      await this.closeHotspot()
    }
  }

  /**
   * Start downloading files
   */
  private async startFileDownload(hotspotInfo: HotspotInfo): Promise<void> {
    const store = useGallerySyncStore.getState()

    console.log(`[GallerySyncService] Starting file download from ${hotspotInfo.ip}`)

    try {
      // Set up the API client
      asgCameraApi.setServer(hotspotInfo.ip, 8089)

      // Get sync state and files to download
      const syncState = await localStorageService.getSyncState()
      const syncResponse = await asgCameraApi.syncWithServer(syncState.client_id, syncState.last_sync_time, true)

      const syncData = syncResponse.data || syncResponse

      if (!syncData.changed_files || syncData.changed_files.length === 0) {
        console.log("[GallerySyncService] No files to sync")
        store.setSyncComplete()
        await this.onSyncComplete(0, 0)
        return
      }

      const filesToSync = syncData.changed_files
      // console.log(`[GallerySyncService] 🔄 Found ${filesToSync.length} files to sync from server`)
      // console.log(`[GallerySyncService] 📊 Server returned these files:`)
      // filesToSync.slice(0, 10).forEach((file: any, idx: number) => {
      //   console.log(
      //     `[GallerySyncService]   ${idx + 1}. ${file.name} (${file.is_video ? "video" : "photo"}, ${file.size} bytes, modified: ${file.modified})`,
      //   )
      // })
      // if (filesToSync.length > 10) {
      //   console.log(`[GallerySyncService]   ... and ${filesToSync.length - 10} more files`)
      // }

      // Update store with files
      store.setSyncing(filesToSync)

      // Save queue for resume capability
      await localStorageService.saveSyncQueue({
        files: filesToSync,
        currentIndex: 0,
        startedAt: Date.now(),
        hotspotInfo,
      })

      // Show notification
      await gallerySyncNotifications.showSyncStarted(filesToSync.length)

      // Execute the download
      await this.executeDownload(filesToSync, syncData.server_time)
    } catch (error: any) {
      console.error("[GallerySyncService] Failed to start download:", error)
      store.setSyncError(error?.message || "Failed to start download")
      await gallerySyncNotifications.showSyncError("Failed to start download")

      if (store.syncServiceOpenedHotspot) {
        await this.closeHotspot()
      }
    }
  }

  /**
   * Execute the actual file download
   */
  private async executeDownload(files: PhotoInfo[], serverTime: number): Promise<void> {
    const store = useGallerySyncStore.getState()
    const settingsStore = useSettingsStore.getState()
    const defaultWearable = settingsStore.getSetting(SETTINGS.default_wearable.key)

    let downloadedCount = 0
    let failedCount = 0

    try {
      const downloadResult = await asgCameraApi.batchSyncFiles(
        files,
        true,
        (current, total, fileName, fileProgress, downloadedFile) => {
          // Check if cancelled
          if (this.abortController?.signal.aborted) {
            throw new Error("Sync cancelled")
          }

          // Update store
          const currentStore = useGallerySyncStore.getState()

          if (fileProgress === 0 || fileProgress === undefined) {
            // Starting a new file - but only mark previous complete if this is a NEW file
            // (not just another 0% progress report for the same file)
            // This prevents double-counting when both batchSyncFiles and RNFS report 0%
            const isNewFile = currentStore.currentFile !== fileName

            if (isNewFile) {
              // Mark previous file as complete when moving to next
              if (current > 1 && currentStore.currentFile) {
                currentStore.onFileComplete(currentStore.currentFile)
                // Persist queue index so we can resume from here if app is killed
                localStorageService.updateSyncQueueIndex(current - 1).catch(err => {
                  console.error("[GallerySyncService] Failed to persist queue index:", err)
                })
              }
              // Now set the new current file
              currentStore.setCurrentFile(fileName, 0)
            }
          } else {
            currentStore.onFileProgress(fileName, fileProgress || 0)
          }

          // When file completes (100%), update it in the queue with downloaded paths
          if (fileProgress === 100 && downloadedFile) {
            // Update file with local paths and URLs for immediate preview display
            const localFileUrl = downloadedFile.filePath
              ? downloadedFile.filePath.startsWith("file://")
                ? downloadedFile.filePath
                : `file://${downloadedFile.filePath}`
              : downloadedFile.url

            const localThumbnailUrl = downloadedFile.thumbnailPath
              ? downloadedFile.thumbnailPath.startsWith("file://")
                ? downloadedFile.thumbnailPath
                : `file://${downloadedFile.thumbnailPath}`
              : undefined

            const updatedFile = {
              ...downloadedFile,
              url: localFileUrl, // Update URL to local file for immediate preview
              download: localFileUrl, // Update download URL for videos
              filePath: downloadedFile.filePath,
              thumbnailPath: localThumbnailUrl,
            }
            currentStore.updateFileInQueue(fileName, updatedFile)
          }

          // Update notification
          gallerySyncNotifications.updateProgress(current, total, fileName, fileProgress || 0)
        },
      )

      downloadedCount = downloadResult.downloaded.length
      failedCount = downloadResult.failed.length

      // Mark the last file as complete (if any files were downloaded)
      if (downloadResult.downloaded.length > 0) {
        const lastFileName = downloadResult.downloaded[downloadResult.downloaded.length - 1]?.name
        if (lastFileName) {
          const currentStore = useGallerySyncStore.getState()
          currentStore.onFileComplete(lastFileName)
        }
      }

      // Save downloaded files metadata
      // console.log(`[GallerySyncService] 💾 Saving metadata for ${downloadResult.downloaded.length} downloaded files...`)
      for (const photoInfo of downloadResult.downloaded) {
        // console.log(
        //   `[GallerySyncService] 📝 Processing: ${photoInfo.name} (${photoInfo.is_video ? "video" : "photo"}, ${photoInfo.size} bytes)`,
        // )
        const downloadedFile = localStorageService.convertToDownloadedFile(
          photoInfo,
          photoInfo.filePath || "",
          photoInfo.thumbnailPath,
          defaultWearable,
        )
        await localStorageService.saveDownloadedFile(downloadedFile)
      }
      // console.log(`[GallerySyncService] ✅ Finished saving metadata for all files`)

      // Update queue index to final position
      await localStorageService.updateSyncQueueIndex(files.length)

      // Mark failed files in store
      for (const failedFileName of downloadResult.failed) {
        const currentStore = useGallerySyncStore.getState()
        currentStore.onFileFailed(failedFileName)
      }

      // Auto-save to camera roll if enabled
      await this.autoSaveToCameraRoll(downloadResult.downloaded)

      // Update sync state
      const currentSyncState = await localStorageService.getSyncState()
      await localStorageService.updateSyncState({
        last_sync_time: serverTime,
        total_downloaded: currentSyncState.total_downloaded + downloadedCount,
        total_size: currentSyncState.total_size + downloadResult.total_size,
      })

      // Complete
      store.setSyncComplete()
      await this.onSyncComplete(downloadedCount, failedCount)
    } catch (error: any) {
      if (error?.message === "Sync cancelled") {
        console.log("[GallerySyncService] Sync was cancelled")
        store.setSyncCancelled()
        await gallerySyncNotifications.showSyncCancelled()
      } else {
        console.error("[GallerySyncService] Download failed:", error)
        store.setSyncError(error?.message || "Download failed")
        await gallerySyncNotifications.showSyncError(error?.message || "Download failed")
      }

      if (store.syncServiceOpenedHotspot) {
        await this.closeHotspot()
      }
    }
  }

  /**
   * Auto-save downloaded files to camera roll
   * Files are sorted chronologically (oldest first) before saving so gallery apps
   * display them in correct capture order (gallery apps sort by "date added" to MediaStore)
   */
  private async autoSaveToCameraRoll(downloadedFiles: PhotoInfo[]): Promise<void> {
    const shouldAutoSave = await gallerySettingsService.getAutoSaveToCameraRoll()
    if (!shouldAutoSave || downloadedFiles.length === 0) return

    console.log(
      `[GallerySyncService] Auto-saving ${downloadedFiles.length} files to camera roll in chronological order...`,
    )

    const hasPermission = await MediaLibraryPermissions.checkPermission()
    if (!hasPermission) {
      const granted = await MediaLibraryPermissions.requestPermission()
      if (!granted) {
        console.warn("[GallerySyncService] Camera roll permission denied")
        return
      }
    }

    // CRITICAL: Sort all downloaded files by capture time BEFORE saving to gallery
    // This ensures gallery displays them in chronological order, not download order
    // (photos download first by size, videos second, but we want chronological capture order)
    const sortedFiles = [...downloadedFiles].sort((a, b) => {
      // Parse capture timestamps - handle both string and number formats
      // Use Number.MAX_SAFE_INTEGER for invalid/missing timestamps to push them to the end
      const parseTime = (modified: string | number | undefined): number => {
        if (modified === undefined || modified === null) return Number.MAX_SAFE_INTEGER
        if (typeof modified === "number") return isNaN(modified) ? Number.MAX_SAFE_INTEGER : modified
        const parsed = parseInt(modified, 10)
        return isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed
      }

      const timeA = parseTime(a.modified)
      const timeB = parseTime(b.modified)

      // Sort oldest first (ascending) so they're added to gallery in chronological order
      return timeA - timeB
    })

    console.log(`[GallerySyncService] Sorted ${sortedFiles.length} files by capture time:`)
    sortedFiles.slice(0, 5).forEach((file, idx) => {
      const captureTime = typeof file.modified === "string" ? parseInt(file.modified, 10) : file.modified || 0
      const captureDate = new Date(captureTime)
      const fileType = file.is_video ? "video" : "photo"
      console.log(`  ${idx + 1}. ${file.name} - ${captureDate.toISOString()} (${fileType})`)
    })
    if (sortedFiles.length > 5) {
      console.log(`  ... and ${sortedFiles.length - 5} more files`)
    }

    let savedCount = 0
    let failedCount = 0

    // Save files in chronological order (oldest first)
    for (const photoInfo of sortedFiles) {
      const filePath = photoInfo.filePath || localStorageService.getPhotoFilePath(photoInfo.name)

      // Parse the capture timestamp from the photo metadata
      // The 'modified' field contains the original capture time from the glasses
      let captureTime: number | undefined
      if (photoInfo.modified) {
        captureTime = typeof photoInfo.modified === "string" ? parseInt(photoInfo.modified, 10) : photoInfo.modified
        if (isNaN(captureTime)) {
          console.warn(`[GallerySyncService] Invalid modified timestamp for ${photoInfo.name}:`, photoInfo.modified)
          captureTime = undefined
        }
      }

      // Save to camera roll with capture time for logging
      const success = await MediaLibraryPermissions.saveToLibrary(filePath, captureTime)
      if (success) {
        savedCount++
      } else {
        failedCount++
      }
    }

    console.log(
      `[GallerySyncService] Saved ${savedCount}/${sortedFiles.length} files to camera roll in chronological order`,
    )
    if (failedCount > 0) {
      console.warn(`[GallerySyncService] Failed to save ${failedCount} files to camera roll`)
    }
  }

  /**
   * Handle sync completion
   */
  private async onSyncComplete(downloadedCount: number, failedCount: number): Promise<void> {
    console.log(`[GallerySyncService] Sync complete: ${downloadedCount} downloaded, ${failedCount} failed`)

    // 🔍 DIAGNOSTIC: Show all pictures currently in storage after sync
    // try {
    //   const allStoredFiles = await localStorageService.getDownloadedFiles()
    //   const fileNames = Object.keys(allStoredFiles)
    //   console.log(`[GallerySyncService] 📸 POST-SYNC INVENTORY: ${fileNames.length} total files in storage`)
    //   console.log(`[GallerySyncService] 📋 Complete file list:`)
    //   fileNames
    //     .sort((a, b) => {
    //       const fileA = allStoredFiles[a]
    //       const fileB = allStoredFiles[b]
    //       return fileB.downloaded_at - fileA.downloaded_at // Most recent first
    //     })
    //     .slice(0, 20)
    //     .forEach((fileName, idx) => {
    //       const file = allStoredFiles[fileName]
    //       const captureDate = new Date(file.modified).toISOString()
    //       const downloadDate = new Date(file.downloaded_at).toISOString()
    //       console.log(
    //         `[GallerySyncService]   ${idx + 1}. ${fileName} - captured: ${captureDate}, downloaded: ${downloadDate}`,
    //       )
    //     })
    //   if (fileNames.length > 20) {
    //     console.log(`[GallerySyncService]   ... and ${fileNames.length - 20} more files`)
    //   }
    // } catch (error) {
    //   console.error(`[GallerySyncService] Failed to get post-sync inventory:`, error)
    // }

    // Clear the queue
    await localStorageService.clearSyncQueue()

    // Show completion notification
    await gallerySyncNotifications.showSyncComplete(downloadedCount, failedCount)

    // Close hotspot if we opened it
    const store = useGallerySyncStore.getState()
    if (store.syncServiceOpenedHotspot) {
      await this.closeHotspot()
    }

    // Auto-reset to idle after 3 seconds to clear "Sync complete!" message
    setTimeout(() => {
      const currentStore = useGallerySyncStore.getState()
      if (currentStore.syncState === "complete") {
        console.log("[GallerySyncService] Auto-resetting sync state to idle")
        currentStore.setSyncState("idle")
      }
    }, 4000)

    // Clear glasses gallery status since files are now synced
    store.clearGlassesGalleryStatus()
  }

  /**
   * Cancel the current sync
   */
  async cancelSync(): Promise<void> {
    console.log("[GallerySyncService] Cancelling sync...")

    // Abort any ongoing downloads
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    // Clear timeout
    if (this.hotspotConnectionTimeout) {
      clearTimeout(this.hotspotConnectionTimeout)
      this.hotspotConnectionTimeout = null
    }

    const store = useGallerySyncStore.getState()

    // Close hotspot if we opened it
    if (store.syncServiceOpenedHotspot) {
      await this.closeHotspot()
    }

    // Update store
    store.setSyncCancelled()

    // Clear queue
    await localStorageService.clearSyncQueue()

    // Dismiss notification
    await gallerySyncNotifications.showSyncCancelled()
  }

  /**
   * Close the hotspot
   */
  private async closeHotspot(): Promise<void> {
    const store = useGallerySyncStore.getState()

    try {
      console.log("[GallerySyncService] Closing hotspot...")
      await CoreModule.setHotspotState(false)
      store.setSyncServiceOpenedHotspot(false)
      store.setHotspotInfo(null)
      console.log("[GallerySyncService] Hotspot closed")
    } catch (error) {
      console.error("[GallerySyncService] Failed to close hotspot:", error)
    }
  }

  /**
   * Check for resumable sync on app start
   */
  async checkForResumableSync(): Promise<boolean> {
    const hasResumable = await localStorageService.hasResumableSyncQueue()

    if (hasResumable) {
      console.log("[GallerySyncService] Found resumable sync queue")
      // Don't auto-resume - let user decide
      // Could emit an event here for UI to show "Resume sync?" prompt
    }

    return hasResumable
  }

  /**
   * Resume a previously interrupted sync
   */
  async resumeSync(): Promise<void> {
    const queue = await localStorageService.getSyncQueue()

    if (!queue || queue.currentIndex >= queue.files.length) {
      console.log("[GallerySyncService] No queue to resume")
      await localStorageService.clearSyncQueue()
      return
    }

    // Check if queue is too old - hotspot auto-disables after 40s of inactivity,
    // so stale queues can't be resumed (hotspot credentials are no longer valid)
    const queueAge = Date.now() - queue.startedAt
    if (queueAge > TIMING.MAX_QUEUE_AGE_MS) {
      console.log(`[GallerySyncService] Queue too old (${Math.round(queueAge / 1000)}s) - clearing stale queue`)
      await localStorageService.clearSyncQueue()
      // Don't auto-start - let user tap sync button if they want to continue
      return
    }

    console.log(`[GallerySyncService] Resuming sync from file ${queue.currentIndex + 1}/${queue.files.length}`)

    const store = useGallerySyncStore.getState()
    const remainingFiles = queue.files.slice(queue.currentIndex)

    // Reset abort controller so cancellation works for resumed syncs
    this.abortController = new AbortController()

    // Set up state
    store.setHotspotInfo(queue.hotspotInfo)
    store.setSyncing(remainingFiles)

    // Try to connect and resume
    await this.connectToHotspotWifi(queue.hotspotInfo)
  }

  /**
   * Query glasses for gallery status
   */
  async queryGlassesGalleryStatus(): Promise<void> {
    try {
      await CoreModule.queryGalleryStatus()
    } catch (error) {
      console.error("[GallerySyncService] Failed to query gallery status:", error)
    }
  }

  /**
   * Check if sync is currently in progress
   */
  isSyncing(): boolean {
    const store = useGallerySyncStore.getState()
    return (
      store.syncState === "syncing" || store.syncState === "connecting_wifi" || store.syncState === "requesting_hotspot"
    )
  }
}

export const gallerySyncService = GallerySyncService.getInstance()
