/**
 * Main gallery screen component
 */

import {getModelCapabilities} from "@/../../cloud/packages/types/src"
import CoreModule from "core"
import LinearGradient from "expo-linear-gradient"
import {useFocusEffect} from "expo-router"
import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {
  ActivityIndicator,
  BackHandler,
  Dimensions,
  FlatList,
  ImageStyle,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
  ViewToken,
} from "react-native"
import RNFS from "react-native-fs"
import {createShimmerPlaceholder} from "react-native-shimmer-placeholder"
import WifiManager from "react-native-wifi-reborn"

import {MediaViewer} from "@/components/glasses/Gallery/MediaViewer"
import {PhotoImage} from "@/components/glasses/Gallery/PhotoImage"
import {ProgressRing} from "@/components/glasses/Gallery/ProgressRing"
import {Header, Icon, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {asgCameraApi} from "@/services/asg/asgCameraApi"
import {gallerySettingsService} from "@/services/asg/gallerySettingsService"
import {localStorageService} from "@/services/asg/localStorageService"
import {networkConnectivityService, NetworkStatus} from "@/services/asg/networkConnectivityService"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {spacing, ThemedStyle} from "@/theme"
import {PhotoInfo} from "@/types/asg"
import showAlert from "@/utils/AlertUtils"
// import {shareFile} from "@/utils/FileUtils"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {MediaLibraryPermissions} from "@/utils/MediaLibraryPermissions"
import {useAppTheme} from "@/utils/useAppTheme"

// @ts-ignore
const ShimmerPlaceholder = createShimmerPlaceholder(LinearGradient)

// Gallery timing constants
const TIMING = {
  PROGRESS_RING_DISPLAY_MS: 3000, // How long to show completed/failed progress rings
  SYNC_COMPLETE_DISPLAY_MS: 1000, // How long to show "Sync complete!" message
  ALERT_DELAY_MS: 100, // Delay before showing alerts to allow UI to settle
  HOTSPOT_LOAD_DELAY_MS: 500, // Delay before loading photos after hotspot connects
  HOTSPOT_CONNECT_DELAY_MS: 1000, // Delay before attempting WiFi connection to allow hotspot to fully activate
  RETRY_AFTER_RATE_LIMIT_MS: 5000, // Delay before retrying after 429 rate limit
} as const

// Gallery state machine states
enum GalleryState {
  INITIALIZING = "initializing",
  QUERYING_GLASSES = "querying_glasses",
  NO_MEDIA_ON_GLASSES = "no_media_on_glasses",
  MEDIA_AVAILABLE = "media_available",
  REQUESTING_HOTSPOT = "requesting_hotspot",
  WAITING_FOR_WIFI_PROMPT = "waiting_for_wifi_prompt",
  USER_CANCELLED_WIFI = "user_cancelled_wifi",
  CONNECTING_TO_HOTSPOT = "connecting_to_hotspot",
  CONNECTED_LOADING = "connected_loading",
  READY_TO_SYNC = "ready_to_sync",
  SYNCING = "syncing",
  SYNC_COMPLETE = "sync_complete",
  ERROR = "error",
}

interface GalleryItem {
  id: string
  type: "server" | "local" | "placeholder"
  index: number
  photo?: PhotoInfo
  isOnServer?: boolean
}

export function GalleryScreen() {
  const {goBack, push} = useNavigationHistory()
  const {theme, themed} = useAppTheme()

  // Column calculation - 3 per row like Google Photos / Apple Photos
  const screenWidth = Dimensions.get("window").width
  const ITEM_SPACING = 2 // Minimal spacing between items (1-2px hairline)
  const numColumns = screenWidth < 320 ? 2 : 3 // 2 columns for very small screens, otherwise 3
  const itemWidth = (screenWidth - ITEM_SPACING * (numColumns - 1)) / numColumns
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const features = getModelCapabilities(defaultWearable)
  const hotspotSsid = useGlassesStore(state => state.hotspotSsid)
  const hotspotPassword = useGlassesStore(state => state.hotspotPassword)
  const hotspotGatewayIp = useGlassesStore(state => state.hotspotGatewayIp)
  const hotspotEnabled = useGlassesStore(state => state.hotspotEnabled)
  const glassesConnected = useGlassesStore(state => state.connected)

  const [networkStatus] = useState<NetworkStatus>(networkConnectivityService.getStatus())

  // Permission state - no longer blocking, permission is requested lazily when saving
  // Keeping state for potential future use (e.g., showing a hint in settings)
  const [_hasMediaLibraryPermission, setHasMediaLibraryPermission] = useState(false)

  // State machine
  const [galleryState, setGalleryState] = useState<GalleryState>(GalleryState.INITIALIZING)

  const transitionToState = (newState: GalleryState) => {
    console.log(`[GalleryScreen] State transition: ${galleryState} → ${newState}`)
    setGalleryState(newState)
  }

  // Data state
  const [totalServerCount, setTotalServerCount] = useState(0)
  const [loadedServerPhotos, setLoadedServerPhotos] = useState<Map<number, PhotoInfo>>(new Map())
  const [downloadedPhotos, setDownloadedPhotos] = useState<PhotoInfo[]>([])
  const [selectedPhoto, setSelectedPhoto] = useState<PhotoInfo | null>(null)
  const [syncProgress, setSyncProgress] = useState<{
    current: number
    total: number
    message: string
    fileProgress?: number
  } | null>(null)
  const [photoSyncStates, setPhotoSyncStates] = useState<
    Map<
      string,
      {
        status: "pending" | "downloading" | "completed" | "failed"
        progress: number
      }
    >
  >(new Map())
  const [glassesGalleryStatus, setGlassesGalleryStatus] = useState<{
    photos: number
    videos: number
    total: number
    has_content: boolean
  } | null>(null)

  // Selection mode state
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedPhotos, setSelectedPhotos] = useState<Set<string>>(new Set())

  // Track if gallery opened the hotspot
  const galleryOpenedHotspotRef = useRef(false)
  const [galleryOpenedHotspot, setGalleryOpenedHotspot] = useState(false)
  const hotspotConnectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track loaded ranges
  const loadedRanges = useRef<Set<string>>(new Set())
  const loadingRanges = useRef<Set<string>>(new Set())
  const syncTriggeredRef = useRef(false)
  const PAGE_SIZE = 20

  // Load downloaded photos (validates files exist and cleans up stale entries)
  const loadDownloadedPhotos = useCallback(async () => {
    try {
      const downloadedFiles = await localStorageService.getDownloadedFiles()
      const validPhotoInfos: PhotoInfo[] = []
      const staleFileNames: string[] = []

      // Check each file exists on disk
      for (const [name, file] of Object.entries(downloadedFiles)) {
        const fileExists = await RNFS.exists(file.filePath)
        if (fileExists) {
          validPhotoInfos.push(localStorageService.convertToPhotoInfo(file))
        } else {
          console.log(`[GalleryScreen] Cleaning up stale entry for missing file: ${name}`)
          staleFileNames.push(name)
        }
      }

      // Clean up stale metadata entries (files that no longer exist on disk)
      for (const fileName of staleFileNames) {
        await localStorageService.deleteDownloadedFile(fileName)
      }

      if (staleFileNames.length > 0) {
        console.log(`[GalleryScreen] Cleaned up ${staleFileNames.length} stale photo entries`)
      }

      setDownloadedPhotos(validPhotoInfos)
    } catch (err) {
      console.error("Error loading downloaded photos:", err)
    }
  }, [])

  // Initial load - get total count and first batch
  const loadInitialPhotos = useCallback(
    async (overrideServerIp?: string, skipThumbnails: boolean = false) => {
      const serverIp = overrideServerIp || hotspotGatewayIp
      const hasConnection = overrideServerIp || (hotspotEnabled && hotspotGatewayIp)

      if (!hasConnection || !serverIp) {
        console.log("[GalleryScreen] Glasses not connected")
        setTotalServerCount(0)
        if (galleryState === GalleryState.CONNECTED_LOADING) {
          transitionToState(GalleryState.NO_MEDIA_ON_GLASSES)
        }
        return
      }

      if (galleryState !== GalleryState.CONNECTED_LOADING) {
        transitionToState(GalleryState.CONNECTED_LOADING)
      }

      try {
        asgCameraApi.setServer(serverIp, 8089)

        // If skipThumbnails is true, just transition to READY_TO_SYNC without loading thumbnails
        // The thumbnails will be loaded progressively during sync
        if (skipThumbnails) {
          console.log("[GalleryScreen] Skipping thumbnail load, will show during sync")
          transitionToState(GalleryState.READY_TO_SYNC)
          return
        }

        const result = await asgCameraApi.getGalleryPhotos(PAGE_SIZE, 0)

        setTotalServerCount(result.totalCount)

        if (result.totalCount === 0) {
          console.log("[GalleryScreen] No photos on glasses")
          transitionToState(GalleryState.NO_MEDIA_ON_GLASSES)
          return
        }

        const newMap = new Map<number, PhotoInfo>()
        result.photos.forEach((photo, index) => {
          newMap.set(index, photo)
        })
        setLoadedServerPhotos(newMap)
        loadedRanges.current.add("0-19")
        transitionToState(GalleryState.READY_TO_SYNC)
      } catch (err) {
        console.error("[GalleryScreen] Failed to load initial photos:", err)
        setTotalServerCount(0)

        let errorMsg = "Failed to load photos"
        if (err instanceof Error) {
          if (err.message.includes("429")) {
            errorMsg = "Server is busy, please try again in a moment"
            // Auto-retry for rate limit errors
            setTimeout(() => {
              console.log("[GalleryScreen] Retrying after rate limit...")
              transitionToState(GalleryState.CONNECTED_LOADING)
              loadInitialPhotos()
            }, TIMING.RETRY_AFTER_RATE_LIMIT_MS)
            // Don't show alert for auto-retry, just transition to retryable state
            transitionToState(GalleryState.MEDIA_AVAILABLE)
            return
          } else if (err.message.includes("400")) {
            errorMsg = "Invalid request to server"
          } else {
            errorMsg = err.message
          }
        }

        // Show error alert and return to retryable state
        showAlert("Error", errorMsg, [{text: translate("common:ok")}])
        transitionToState(GalleryState.MEDIA_AVAILABLE)
      }
    },
    [galleryState, hotspotEnabled, hotspotGatewayIp],
  )

  // Load photos for specific indices
  const loadPhotosForIndices = useCallback(
    async (indices: number[]) => {
      if (!hotspotEnabled || !hotspotGatewayIp || indices.length === 0) return

      const unloadedIndices = indices.filter(i => !loadedServerPhotos.has(i))
      if (unloadedIndices.length === 0) return

      const sortedIndices = [...unloadedIndices].sort((a, b) => a - b)
      const minIndex = sortedIndices[0]
      const maxIndex = sortedIndices[sortedIndices.length - 1]
      const rangeKey = `${minIndex}-${maxIndex}`

      if (loadingRanges.current.has(rangeKey) || loadedRanges.current.has(rangeKey)) return

      loadingRanges.current.add(rangeKey)

      try {
        asgCameraApi.setServer(hotspotGatewayIp, 8089)
        const limit = maxIndex - minIndex + 1
        const result = await asgCameraApi.getGalleryPhotos(limit, minIndex)

        setLoadedServerPhotos(prev => {
          const newMap = new Map(prev)
          result.photos.forEach((photo, i) => {
            newMap.set(minIndex + i, photo)
          })
          return newMap
        })

        loadedRanges.current.add(rangeKey)
      } catch (err) {
        console.error(`[GalleryScreen] Failed to load range ${rangeKey}:`, err)
      } finally {
        loadingRanges.current.delete(rangeKey)
      }
    },
    [hotspotEnabled, hotspotGatewayIp, loadedServerPhotos],
  )

  // Sync files from server
  const handleSync = async () => {
    const hasConnection = hotspotEnabled && hotspotGatewayIp
    const serverIp = hotspotGatewayIp

    if (!hasConnection || !serverIp) {
      showAlert("Cannot Sync", "Your glasses are not connected. Please connect them to WiFi or enable hotspot.", [
        {text: translate("common:ok")},
      ])
      return
    }

    transitionToState(GalleryState.SYNCING)
    setSyncProgress(null)

    try {
      console.log(`[GalleryScreen] Starting sync with server IP: ${serverIp}`)
      asgCameraApi.setServer(serverIp, 8089)

      const syncState = await localStorageService.getSyncState()
      const syncResponse = await asgCameraApi.syncWithServer(syncState.client_id, syncState.last_sync_time, true)

      const syncData = syncResponse.data || syncResponse

      if (!syncData.changed_files || syncData.changed_files.length === 0) {
        console.log("Sync Complete - no new files")
        // Stop hotspot if gallery opened it
        if (galleryOpenedHotspot) {
          console.log("[GalleryScreen] No files to sync, closing hotspot...")
          await handleStopHotspot()
        }
        transitionToState(GalleryState.SYNC_COMPLETE)
        return
      }

      // Initialize photo sync states
      const initialSyncStates = new Map()
      syncData.changed_files.forEach(photo => {
        initialSyncStates.set(photo.name, {
          status: "pending" as const,
          progress: 0,
        })
      })
      setPhotoSyncStates(initialSyncStates)

      setSyncProgress({
        current: 0,
        total: syncData.changed_files.length,
        message: "Downloading files...",
      })

      const downloadResult = await asgCameraApi.batchSyncFiles(
        syncData.changed_files,
        true,
        (current, total, fileName, fileProgress) => {
          console.log(`[GalleryScreen] Progress callback: ${fileName} - ${fileProgress}% (${current}/${total})`)

          // Use requestAnimationFrame to ensure immediate UI updates
          requestAnimationFrame(() => {
            // Add thumbnail to gallery when we start downloading this file (first progress update)
            if (fileProgress === 0 || fileProgress === undefined) {
              const fileInfo = syncData.changed_files.find(f => f.name === fileName)
              if (fileInfo) {
                setLoadedServerPhotos(prev => {
                  const newMap = new Map(prev)
                  // Add with index based on current position
                  newMap.set(current - 1, fileInfo)
                  return newMap
                })
              }
            }

            // Update individual photo progress
            setPhotoSyncStates(prev => {
              const newStates = new Map(prev)

              // Update the current file being downloaded
              newStates.set(fileName, {
                status: "downloading",
                progress: fileProgress || 0,
              })

              // Mark previously completed files as completed (if not already marked)
              for (let i = 0; i < current - 1; i++) {
                const completedFileName = syncData.changed_files[i]?.name
                if (completedFileName && !newStates.has(completedFileName)) {
                  newStates.set(completedFileName, {
                    status: "completed",
                    progress: 100,
                  })
                }
              }

              // If this is the last file and progress is 100%, mark it as completed
              if (current === total && fileProgress === 100) {
                newStates.set(fileName, {
                  status: "completed",
                  progress: 100,
                })
              }

              // Mark previous files as completed when moving to next file
              if (fileProgress === 0 && current > 1) {
                // Mark the previous file as completed
                const previousFileName = syncData.changed_files[current - 2]?.name
                if (previousFileName) {
                  newStates.set(previousFileName, {
                    status: "completed",
                    progress: 100,
                  })
                }
              }

              console.log(`[GalleryScreen] Updated sync states:`, Array.from(newStates.entries()))
              return newStates
            })

            setSyncProgress({
              current,
              total,
              message: `Downloading ${fileName}...`,
              fileProgress,
            })
          })
        },
      )

      // Save downloaded files but keep progress states visible
      for (const photoInfo of downloadResult.downloaded) {
        const downloadedFile = localStorageService.convertToDownloadedFile(
          photoInfo,
          photoInfo.filePath || "",
          photoInfo.thumbnailPath,
          defaultWearable,
        )
        await localStorageService.saveDownloadedFile(downloadedFile)
      }

      // Auto-save to camera roll if enabled
      const shouldAutoSave = await gallerySettingsService.getAutoSaveToCameraRoll()
      if (shouldAutoSave && downloadResult.downloaded.length > 0) {
        console.log("[GalleryScreen] Auto-saving photos to camera roll...")

        // Request permission if needed (this is a no-op on Android 10+)
        const hasPermission = await MediaLibraryPermissions.checkPermission()
        if (!hasPermission) {
          const granted = await MediaLibraryPermissions.requestPermission()
          if (!granted) {
            console.warn("[GalleryScreen] Camera roll permission denied, skipping auto-save")
            // Continue without saving to camera roll - photos are still in local storage
          }
        }

        let savedCount = 0
        let failedCount = 0

        for (const photoInfo of downloadResult.downloaded) {
          const filePath = photoInfo.filePath || localStorageService.getPhotoFilePath(photoInfo.name)
          const success = await MediaLibraryPermissions.saveToLibrary(filePath)
          if (success) {
            savedCount++
          } else {
            failedCount++
          }
        }

        console.log(`[GalleryScreen] Saved ${savedCount}/${downloadResult.downloaded.length} photos to camera roll`)
        if (failedCount > 0) {
          console.warn(`[GalleryScreen] Failed to save ${failedCount} photos to camera roll`)
        }
      }

      // Keep all progress states visible for a moment to show completion
      setTimeout(() => {
        setPhotoSyncStates(new Map())
      }, TIMING.PROGRESS_RING_DISPLAY_MS)

      // Mark failed photos
      for (const failedFileName of downloadResult.failed) {
        setPhotoSyncStates(prev => {
          const newStates = new Map(prev)
          newStates.set(failedFileName, {
            status: "failed",
            progress: 0,
          })
          return newStates
        })
      }

      // Remove failed progress rings after a delay to show error state
      if (downloadResult.failed.length > 0) {
        setTimeout(() => {
          setPhotoSyncStates(prev => {
            const newStates = new Map(prev)
            for (const failedFileName of downloadResult.failed) {
              newStates.delete(failedFileName)
            }
            return newStates
          })
        }, TIMING.PROGRESS_RING_DISPLAY_MS)
      }

      // Files are now deleted immediately after each successful download in batchSyncFiles
      if (downloadResult.downloaded.length > 0) {
        console.log(
          `[GalleryScreen] Successfully synced ${downloadResult.downloaded.length} files (deleted from glasses after each download)`,
        )
      }

      await localStorageService.updateSyncState({
        last_sync_time: syncData.server_time,
        total_downloaded: syncState.total_downloaded + downloadResult.downloaded.length,
        total_size: syncState.total_size + downloadResult.total_size,
      })

      // Load downloaded photos first to ensure smooth transition
      await loadDownloadedPhotos()

      // Clear sync progress states (progress rings no longer needed)
      setPhotoSyncStates(new Map())
      setSyncProgress(null)

      // Show brief success state
      transitionToState(GalleryState.SYNC_COMPLETE)

      // Stop hotspot if gallery opened it
      if (galleryOpenedHotspot) {
        console.log("[GalleryScreen] Sync completed with files, closing hotspot...")
        try {
          await handleStopHotspot()
          console.log("[GalleryScreen] Hotspot closed successfully after sync")
        } catch (error) {
          console.error("[GalleryScreen] Failed to close hotspot after sync:", error)
        }
      }

      // Gradually clear server state after downloads are loaded
      setTimeout(() => {
        setLoadedServerPhotos(new Map())
        setTotalServerCount(0)
        loadedRanges.current.clear()
        loadingRanges.current.clear()
        transitionToState(GalleryState.NO_MEDIA_ON_GLASSES)
      }, TIMING.SYNC_COMPLETE_DISPLAY_MS)
    } catch (err) {
      let errorMsg = "Sync failed"
      if (err instanceof Error) {
        if (err.message.includes("429")) {
          errorMsg = "Server is busy, please try again in a moment"
        } else if (err.message.includes("400")) {
          errorMsg = "Invalid sync request"
        } else {
          errorMsg = err.message
        }
      }

      // Show error alert
      showAlert("Sync Error", errorMsg, [{text: translate("common:ok")}])

      // Clear sync progress and states
      setSyncProgress(null)
      setPhotoSyncStates(new Map())
      setLoadedServerPhotos(new Map())
      setTotalServerCount(0)
      loadedRanges.current.clear()
      loadingRanges.current.clear()

      // Reload downloaded photos to show what we have
      await loadDownloadedPhotos()

      // Return to a recoverable state and re-query glasses
      if (glassesConnected && features?.hasCamera) {
        transitionToState(GalleryState.QUERYING_GLASSES)
        queryGlassesGalleryStatus()
      } else {
        transitionToState(GalleryState.NO_MEDIA_ON_GLASSES)
      }
    }
  }

  // Handle photo selection
  const handlePhotoPress = (item: GalleryItem) => {
    if (!item.photo) return

    // If in selection mode, toggle selection
    if (isSelectionMode) {
      togglePhotoSelection(item.photo.name)
      return
    }

    // Prevent opening photos that are currently being synced
    const syncState = photoSyncStates.get(item.photo.name)
    if (
      syncState &&
      (syncState.status === "downloading" || syncState.status === "pending" || syncState.status === "completed")
    ) {
      console.log(`[GalleryScreen] Photo ${item.photo.name} is being synced, preventing open`)
      return
    }

    if (item.photo.is_video && item.isOnServer) {
      showAlert("Video Not Downloaded", "Please sync this video to your device to watch it", [
        {text: translate("common:ok")},
      ])
      return
    }
    setSelectedPhoto(item.photo)
  }

  // Toggle photo selection
  const togglePhotoSelection = (photoName: string) => {
    setSelectedPhotos(prev => {
      const newSet = new Set(prev)
      if (newSet.has(photoName)) {
        newSet.delete(photoName)
        // Exit selection mode if no photos are selected
        if (newSet.size === 0) {
          setTimeout(() => exitSelectionMode(), 0)
        }
      } else {
        newSet.add(photoName)
      }
      return newSet
    })
  }

  // Enter selection mode
  const enterSelectionMode = (photoName: string) => {
    setIsSelectionMode(true)
    setSelectedPhotos(new Set([photoName]))
  }

  // Exit selection mode
  const exitSelectionMode = () => {
    setIsSelectionMode(false)
    setSelectedPhotos(new Set())
  }

  // Handle photo sharing
  // const handleSharePhoto = async (photo: PhotoInfo) => {
  //   if (!photo) {
  //     console.error("No photo provided to share")
  //     return
  //   }

  //   try {
  //     const shareUrl = photo.is_video && photo.download ? photo.download : photo.url
  //     let filePath = ""

  //     if (shareUrl?.startsWith("file://")) {
  //       filePath = shareUrl.replace("file://", "")
  //     } else if (photo.filePath) {
  //       filePath = photo.filePath.startsWith("file://") ? photo.filePath.replace("file://", "") : photo.filePath
  //     } else {
  //       const mediaType = photo.is_video ? "video" : "photo"
  //       setSelectedPhoto(null)
  //       setTimeout(() => {
  //         showAlert("Info", `Please sync this ${mediaType} first to share it`, [{text: translate("common:ok")}])
  //       }, TIMING.ALERT_DELAY_MS)
  //       return
  //     }

  //     if (!filePath) {
  //       console.error("No valid file path found")
  //       setSelectedPhoto(null)
  //       setTimeout(() => {
  //         showAlert("Error", "Unable to share this photo", [{text: translate("common:ok")}])
  //       }, TIMING.ALERT_DELAY_MS)
  //       return
  //     }

  //     let shareMessage = photo.is_video ? "Check out this video" : "Check out this photo"
  //     if (photo.glassesModel) {
  //       shareMessage += ` taken with ${photo.glassesModel}`
  //     }
  //     shareMessage += "!"

  //     const mimeType = photo.mime_type || (photo.is_video ? "video/mp4" : "image/jpeg")
  //     await shareFile(filePath, mimeType, "Share Photo", shareMessage)
  //     console.log("Share completed successfully")
  //   } catch (error) {
  //     if (error instanceof Error && error.message?.includes("FileProvider")) {
  //       setSelectedPhoto(null)
  //       setTimeout(() => {
  //         showAlert(
  //           "Sharing Not Available",
  //           "File sharing will work after the next app build. For now, you can find your photos in the AugmentOS folder.",
  //           [{text: translate("common:ok")}],
  //         )
  //       }, TIMING.ALERT_DELAY_MS)
  //     } else {
  //       console.error("Error sharing photo:", error)
  //       setSelectedPhoto(null)
  //       setTimeout(() => {
  //         showAlert("Error", "Failed to share photo", [{text: translate("common:ok")}])
  //       }, TIMING.ALERT_DELAY_MS)
  //     }
  //   }
  // }

  // Handle hotspot request
  const handleRequestHotspot = async () => {
    transitionToState(GalleryState.REQUESTING_HOTSPOT)
    try {
      await CoreModule.setHotspotState(true)
      setGalleryOpenedHotspot(true)
      galleryOpenedHotspotRef.current = true
      console.log("[GalleryScreen] Gallery initiated hotspot")
      transitionToState(GalleryState.WAITING_FOR_WIFI_PROMPT)
    } catch (error) {
      console.error("[GalleryScreen] Failed to start hotspot:", error)
      showAlert("Error", "Failed to start hotspot. Please try again.", [{text: "OK"}])
      // Return to MEDIA_AVAILABLE so user can retry
      transitionToState(GalleryState.MEDIA_AVAILABLE)
    }
  }

  // Handle stop hotspot
  const handleStopHotspot = async () => {
    console.log("[GalleryScreen] Stopping hotspot...")
    try {
      const result = await CoreModule.setHotspotState(false)
      console.log("[GalleryScreen] Hotspot stop command sent")
      setGalleryOpenedHotspot(false)
      galleryOpenedHotspotRef.current = false
      return result
    } catch (error) {
      console.error("[GalleryScreen] Failed to stop hotspot:", error)
      throw error
    }
  }

  // Handle deletion of selected photos
  const handleDeleteSelectedPhotos = async () => {
    if (selectedPhotos.size === 0) return

    const selectedCount = selectedPhotos.size
    const itemText = selectedCount === 1 ? "item" : "items"

    showAlert("Delete Photos", `Are you sure you want to delete ${selectedCount} ${itemText}?`, [
      {text: translate("common:cancel"), style: "cancel"},
      {
        text: translate("common:delete"),
        style: "destructive",
        onPress: async () => {
          try {
            const hasConnection = hotspotEnabled && hotspotGatewayIp
            const photosToDelete = Array.from(selectedPhotos)

            // Separate server photos and local photos
            const serverPhotos: string[] = []
            const localPhotos: string[] = []

            for (const photoName of photosToDelete) {
              // Check if photo is on server
              let isOnServer = false
              for (const [_, photo] of loadedServerPhotos) {
                if (photo.name === photoName) {
                  isOnServer = true
                  break
                }
              }

              if (isOnServer) {
                serverPhotos.push(photoName)
              } else {
                localPhotos.push(photoName)
              }
            }

            let deleteErrors: string[] = []

            // Delete server photos if connected
            if (serverPhotos.length > 0 && hasConnection) {
              try {
                await asgCameraApi.deleteFilesFromServer(serverPhotos)
                console.log(`[GalleryScreen] Deleted ${serverPhotos.length} photos from server`)
              } catch (err) {
                console.error("Error deleting server photos:", err)
                deleteErrors.push(`Failed to delete ${serverPhotos.length} photos from glasses`)
              }
            }

            // Delete local photos
            if (localPhotos.length > 0) {
              for (const photoName of localPhotos) {
                try {
                  await localStorageService.deleteDownloadedFile(photoName)
                } catch (err) {
                  console.error(`Error deleting local photo ${photoName}:`, err)
                  deleteErrors.push(`Failed to delete ${photoName} from local storage`)
                }
              }
              console.log(`[GalleryScreen] Deleted ${localPhotos.length} photos from local storage`)
            }

            // Refresh gallery
            await loadDownloadedPhotos()
            if (hasConnection) {
              loadInitialPhotos()
            }

            // Exit selection mode
            exitSelectionMode()

            if (deleteErrors.length > 0) {
              showAlert("Partial Success", deleteErrors.join(". "), [{text: translate("common:ok")}])
            } else {
              showAlert("Success", `${selectedCount} ${itemText} deleted successfully!`, [
                {text: translate("common:ok")},
              ])
            }
          } catch (err) {
            console.error("Error deleting photos:", err)
            showAlert("Error", "Failed to delete photos", [{text: translate("common:ok")}])
          }
        },
      },
    ])
  }

  // Handle delete all photos
  // const _handleDeleteAll = async () => {
  //   const totalServerPhotos = totalServerCount
  //   const totalLocalPhotos = downloadedPhotos.length
  //   const totalPhotos = totalServerPhotos + totalLocalPhotos

  //   if (totalPhotos === 0) {
  //     showAlert("No Photos", "There are no photos to delete", [{text: translate("common:ok")}])
  //     return
  //   }

  //   const itemText = totalPhotos === 1 ? "item" : "items"
  //   let message = `This will permanently delete all ${totalPhotos} ${itemText}`

  //   if (totalServerPhotos > 0 && totalLocalPhotos > 0) {
  //     message += ` (${totalServerPhotos} from glasses, ${totalLocalPhotos} from local storage)`
  //   } else if (totalServerPhotos > 0) {
  //     message += ` from your glasses`
  //   } else {
  //     message += ` from local storage`
  //   }

  //   message += ". This action cannot be undone."

  //   showAlert("Delete All Photos", message, [
  //     {text: translate("common:cancel"), style: "cancel"},
  //     {
  //       text: "Delete All",
  //       style: "destructive",
  //       onPress: async () => {
  //         try {
  //           let deleteErrors: string[] = []

  //           // Delete all server photos if connected
  //           if (totalServerPhotos > 0 && hotspotEnabled && hotspotGatewayIp) {
  //             try {
  //               // Get all server photo names
  //               const serverPhotoNames: string[] = []
  //               for (let i = 0; i < totalServerCount; i++) {
  //                 const photo = loadedServerPhotos.get(i)
  //                 if (photo) {
  //                   serverPhotoNames.push(photo.name)
  //                 }
  //               }

  //               if (serverPhotoNames.length > 0) {
  //                 const deleteResult = await asgCameraApi.deleteFilesFromServer(serverPhotoNames)
  //                 if (deleteResult.failed.length > 0) {
  //                   deleteErrors.push(`Failed to delete ${deleteResult.failed.length} photos from glasses`)
  //                 }
  //                 console.log(`[GalleryScreen] Deleted ${deleteResult.deleted.length} photos from server`)
  //               }
  //             } catch (err) {
  //               console.error("Error deleting server photos:", err)
  //               deleteErrors.push("Failed to delete photos from glasses")
  //             }
  //           }

  //           // Delete all local photos
  //           if (totalLocalPhotos > 0) {
  //             try {
  //               await localStorageService.clearAllFiles()
  //               console.log(`[GalleryScreen] Cleared all local photos`)
  //             } catch (err) {
  //               console.error("Error deleting local photos:", err)
  //               deleteErrors.push("Failed to delete local photos")
  //             }
  //           }

  //           // Refresh the gallery
  //           setLoadedServerPhotos(new Map())
  //           setTotalServerCount(0)
  //           loadedRanges.current.clear()
  //           loadingRanges.current.clear()
  //           setPhotoSyncStates(new Map())
  //           await loadDownloadedPhotos()

  //           // Refresh server photos if connected
  //           if (hotspotEnabled && hotspotGatewayIp) {
  //             loadInitialPhotos()
  //           }

  //           if (deleteErrors.length > 0) {
  //             showAlert("Partial Success", deleteErrors.join(". "), [{text: translate("common:ok")}])
  //           } else {
  //             showAlert("Success", "All photos deleted successfully!", [{text: translate("common:ok")}])
  //           }
  //         } catch {
  //           showAlert("Error", "Failed to delete photos", [{text: translate("common:ok")}])
  //         }
  //       },
  //     },
  //   ])
  // }

  // Connect to hotspot
  const connectToHotspot = async (ssid: string, password: string, ip: string) => {
    try {
      console.log(`[GalleryScreen] Connecting to ${ssid}...`)
      transitionToState(GalleryState.CONNECTING_TO_HOTSPOT)

      await WifiManager.connectToProtectedSSID(ssid, password, false, false)
      console.log("[GalleryScreen] Successfully connected to hotspot!")

      if (ip) {
        asgCameraApi.setServer(ip, 8089)
        transitionToState(GalleryState.CONNECTED_LOADING)

        try {
          const currentSSID = await WifiManager.getCurrentWifiSSID()
          console.log("[GalleryScreen] Phone's current SSID:", currentSSID)
        } catch (error) {
          console.log("[GalleryScreen] Failed to get current SSID:", error)
        }

        setTimeout(() => {
          loadInitialPhotos(ip, true) // Skip thumbnails, they'll appear during sync
        }, TIMING.HOTSPOT_LOAD_DELAY_MS)
      }
    } catch (error: any) {
      console.log("[GalleryScreen] Failed to connect:", error)

      if (
        error?.code === "userDenied" ||
        error?.code === "unableToConnect" ||
        error?.message?.includes("cancel") ||
        error?.message?.includes("approval")
      ) {
        console.log("[GalleryScreen] User cancelled WiFi connection")
        transitionToState(GalleryState.USER_CANCELLED_WIFI)
      } else if (error?.message?.includes("user has to enable wifi manually")) {
        // Android 10+ requires manual WiFi enable
        showAlert("WiFi Required", "Please enable WiFi in your device settings and try again", [{text: "OK"}])
        transitionToState(GalleryState.USER_CANCELLED_WIFI)
      } else {
        const errorMsg = error?.message || "Failed to connect to hotspot"
        showAlert("Connection Error", errorMsg + ". Please try again.", [{text: "OK"}])
        // Return to MEDIA_AVAILABLE so user can retry
        transitionToState(GalleryState.MEDIA_AVAILABLE)
      }
    }
  }

  // Retry hotspot connection
  const retryHotspotConnection = () => {
    if (!hotspotSsid || !hotspotPassword || !hotspotGatewayIp) {
      handleRequestHotspot()
      return
    }

    transitionToState(GalleryState.WAITING_FOR_WIFI_PROMPT)
    connectToHotspot(hotspotSsid, hotspotPassword, hotspotGatewayIp)
  }

  // Query gallery status
  const queryGlassesGalleryStatus = () => {
    console.log("[GalleryScreen] Querying glasses gallery status...")
    CoreModule.queryGalleryStatus().catch(error =>
      console.error("[GalleryScreen] Failed to send gallery status query:", error),
    )
  }

  // Initial mount - initialize gallery immediately, permission is handled lazily when saving
  useEffect(() => {
    console.log("[GalleryScreen] Component mounted - initializing gallery")

    // Check permission status in background (for state tracking, not blocking)
    MediaLibraryPermissions.checkPermission().then(hasPermission => {
      setHasMediaLibraryPermission(hasPermission)
      console.log("[GalleryScreen] Media library permission status:", hasPermission)
    })

    // Initialize gallery immediately - no permission blocking
    loadDownloadedPhotos()

    // Only query glasses if we have glasses info (meaning glasses are connected) AND glasses have gallery capability
    if (glassesConnected && features?.hasCamera) {
      console.log("[GalleryScreen] Glasses connected with gallery capability - querying gallery status")
      transitionToState(GalleryState.QUERYING_GLASSES)
      queryGlassesGalleryStatus()
    } else {
      console.log(
        "[GalleryScreen] No glasses connected or glasses don't have gallery capability - showing local photos only",
      )
      transitionToState(GalleryState.NO_MEDIA_ON_GLASSES)
    }
  }, [])

  // Reset gallery state when glasses disconnect
  useEffect(() => {
    if (!glassesConnected) {
      console.log("[GalleryScreen] Glasses disconnected - clearing gallery state")
      setGlassesGalleryStatus(null)
      setTotalServerCount(0)
      setLoadedServerPhotos(new Map())
      loadedRanges.current.clear()
      loadingRanges.current.clear()
      setSyncProgress(null)
      setPhotoSyncStates(new Map())
      transitionToState(GalleryState.NO_MEDIA_ON_GLASSES)
    }
  }, [glassesConnected])

  // Refresh downloaded photos when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      console.log("[GalleryScreen] Screen focused - refreshing downloaded photos")
      loadDownloadedPhotos()
    }, []),
  )

  // Handle back button
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        if (isSelectionMode) {
          exitSelectionMode()
          return true
        }
        if (!selectedPhoto) return false
        setSelectedPhoto(null)
        return true
      }

      const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress)
      return () => subscription.remove()
    }, [selectedPhoto, isSelectionMode]),
  )

  // Listen for gallery status
  useEffect(() => {
    const handleGalleryStatus = (data: any) => {
      console.log("[GalleryScreen] Received GLASSES_GALLERY_STATUS event:", data)

      setGlassesGalleryStatus({
        photos: data.photos || 0,
        videos: data.videos || 0,
        total: data.total || 0,
        has_content: data.has_content || false,
      })

      if (!data.has_content) {
        console.log("[GalleryScreen] No content on glasses")
        setTotalServerCount(0)
        transitionToState(GalleryState.NO_MEDIA_ON_GLASSES)
        return
      }

      if (data.camera_busy) {
        const busyMessage =
          data.camera_busy === "stream"
            ? "streaming"
            : data.camera_busy === "video"
              ? "recording video"
              : "using the camera"
        const itemText = data.total === 1 ? "item" : "items"

        showAlert(
          "Camera Busy",
          `Cannot fetch ${
            data.total || 0
          } ${itemText} from glasses while ${busyMessage}. Please stop ${busyMessage} first to sync.`,
          [{text: "OK"}],
          {iconName: "camera", iconColor: "#FF9800"},
        )

        setTotalServerCount(0)
        transitionToState(GalleryState.NO_MEDIA_ON_GLASSES)
        return
      }

      const phoneConnectedToHotspot = networkStatus.phoneSSID && hotspotSsid && networkStatus.phoneSSID === hotspotSsid

      if (phoneConnectedToHotspot) {
        console.log("[GalleryScreen] Already connected to hotspot")
        transitionToState(GalleryState.CONNECTED_LOADING)
        setTotalServerCount(data.total || 0)
        loadInitialPhotos(hotspotGatewayIp, true)
        return
      }

      // Handle different gallery states - transition to MEDIA_AVAILABLE unless already connecting/syncing
      const canTransitionToMediaAvailable = ![
        GalleryState.REQUESTING_HOTSPOT,
        GalleryState.WAITING_FOR_WIFI_PROMPT,
        GalleryState.CONNECTING_TO_HOTSPOT,
        GalleryState.CONNECTED_LOADING,
        GalleryState.READY_TO_SYNC,
        GalleryState.SYNCING,
      ].includes(galleryState)

      if (canTransitionToMediaAvailable) {
        if (galleryState === GalleryState.QUERYING_GLASSES) {
          console.log("21 [GalleryScreen] Media available, requesting hotspot")
        } else {
          console.log("[GalleryScreen] 📸 Gallery status update (state: " + galleryState + "), showing sync option")
        }
        setTotalServerCount(data.total || 0)
        transitionToState(GalleryState.MEDIA_AVAILABLE)
      }
    }

    GlobalEventEmitter.addListener("GALLERY_STATUS", handleGalleryStatus)
    return () => {
      GlobalEventEmitter.removeListener("GALLERY_STATUS", handleGalleryStatus)
    }
  }, [galleryState, networkStatus.phoneSSID, hotspotSsid])

  // MEDIA_AVAILABLE state shows the sync button - user can manually tap to initiate connection
  // No auto-request behavior needed

  // Listen for hotspot ready
  useEffect(() => {
    const handleHotspotStatusChange = (eventData: any) => {
      console.log(
        "[GalleryScreen] hotspot status changed:",
        eventData.enabled,
        eventData.ssid,
        eventData.password,
        eventData.local_ip,
      )

      if (!eventData.enabled || !eventData.ssid || !eventData.password || !galleryOpenedHotspotRef.current) {
        return
      }

      console.log("[GalleryScreen] Hotspot enabled, waiting for it to become discoverable...")
      // Wait for hotspot to become fully active and discoverable before attempting connection
      // On Android 10+, connectToProtectedSSID shows system WiFi picker which needs the network to be broadcasting

      // Clear any existing timeout
      if (hotspotConnectionTimeoutRef.current) {
        clearTimeout(hotspotConnectionTimeoutRef.current)
      }

      hotspotConnectionTimeoutRef.current = setTimeout(() => {
        console.log("[GalleryScreen] Attempting to connect to hotspot...")
        connectToHotspot(eventData.ssid, eventData.password, eventData.local_ip)
        hotspotConnectionTimeoutRef.current = null
      }, TIMING.HOTSPOT_CONNECT_DELAY_MS)
    }

    GlobalEventEmitter.addListener("HOTSPOT_STATUS_CHANGE", handleHotspotStatusChange)
    return () => {
      // Clean up timeout on unmount
      if (hotspotConnectionTimeoutRef.current) {
        console.log("[GalleryScreen] Cleaning up hotspot connection timeout")
        clearTimeout(hotspotConnectionTimeoutRef.current)
        hotspotConnectionTimeoutRef.current = null
      }
      GlobalEventEmitter.removeListener("HOTSPOT_STATUS_CHANGE", handleHotspotStatusChange)
    }
  }, [])

  // Handle hotspot errors from glasses
  useEffect(() => {
    const handleHotspotError = (eventData: any) => {
      console.error("[GalleryScreen] Hotspot error:", eventData.error_message)

      // Clear any pending connection attempts
      if (hotspotConnectionTimeoutRef.current) {
        clearTimeout(hotspotConnectionTimeoutRef.current)
        hotspotConnectionTimeoutRef.current = null
      }

      // Show error alert and return to retryable state
      const errorMsg = eventData.error_message || "Failed to start hotspot"
      showAlert("Hotspot Error", errorMsg + ". Please try again.", [{text: "OK"}])
      transitionToState(GalleryState.MEDIA_AVAILABLE)
    }

    GlobalEventEmitter.addListener("HOTSPOT_ERROR", handleHotspotError)
    return () => {
      GlobalEventEmitter.removeListener("HOTSPOT_ERROR", handleHotspotError)
    }
  }, [])

  // Monitor phone SSID
  useEffect(() => {
    const phoneSSID = networkStatus.phoneSSID

    if (!phoneSSID || !hotspotSsid || phoneSSID !== hotspotSsid || !hotspotGatewayIp) return

    console.log("[GalleryScreen] Phone connected to glasses hotspot!")
    transitionToState(GalleryState.CONNECTED_LOADING)
    asgCameraApi.setServer(hotspotGatewayIp, 8089)

    const timeoutId = setTimeout(() => {
      console.log("[GalleryScreen] Loading photos via hotspot...")
      loadInitialPhotos(hotspotGatewayIp, true)
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [networkStatus.phoneSSID, hotspotSsid, hotspotGatewayIp])

  // Auto-trigger sync
  useEffect(() => {
    if (galleryState !== GalleryState.READY_TO_SYNC || totalServerCount === 0 || syncTriggeredRef.current) {
      return
    }

    console.log("[GalleryScreen] Ready to sync, auto-starting...")
    syncTriggeredRef.current = true
    const timeoutId = setTimeout(() => {
      handleSync().finally(() => {
        syncTriggeredRef.current = false
      })
    }, 500)

    return () => {
      clearTimeout(timeoutId)
      syncTriggeredRef.current = false
    }
  }, [galleryState, totalServerCount])

  // Note: Hotspot cleanup after sync is now handled directly in syncAllPhotos()
  // instead of using useEffect to watch for SYNC_COMPLETE state, which was unreliable
  // due to immediate state transitions

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (!galleryOpenedHotspot) return

      console.log("[GalleryScreen] Gallery unmounting - closing hotspot")
      CoreModule.setHotspotState(false)
        .then(() => console.log("[GalleryScreen] Closed hotspot on exit"))
        .catch(error => console.error("[GalleryScreen] Failed to close hotspot on exit:", error))
    }
  }, [galleryOpenedHotspot])

  // Combine photos with placeholders
  const allPhotos = useMemo(() => {
    const items: GalleryItem[] = []

    // Server photos - only show photos that have been loaded (no placeholders)
    for (let i = 0; i < totalServerCount; i++) {
      const photo = loadedServerPhotos.get(i)
      // Only add items that have actually been loaded
      if (photo) {
        items.push({
          id: `server-${i}`,
          type: "server",
          index: i,
          photo,
          isOnServer: true,
        })
      }
    }

    // Downloaded-only photos
    const serverPhotoNames = new Set<string>()
    loadedServerPhotos.forEach(photo => serverPhotoNames.add(photo.name))

    const downloadedOnly = downloadedPhotos
      .filter(p => !serverPhotoNames.has(p.name))
      .sort((a, b) => {
        const aTime = typeof a.modified === "string" ? new Date(a.modified).getTime() : a.modified
        const bTime = typeof b.modified === "string" ? new Date(b.modified).getTime() : b.modified
        return bTime - aTime
      })

    downloadedOnly.forEach((photo, i) => {
      items.push({
        id: `local-${photo.name}`,
        type: "local",
        index: totalServerCount + i,
        photo,
        isOnServer: false,
      })
    })

    return items
  }, [totalServerCount, loadedServerPhotos, downloadedPhotos])

  // Viewability tracking
  const onViewableItemsChanged = useRef(({viewableItems}: {viewableItems: ViewToken[]}) => {
    const placeholderIndices = viewableItems
      .filter(item => item.item?.type === "placeholder")
      .map(item => item.item.index)

    if (placeholderIndices.length === 0) return

    const minIndex = Math.max(0, Math.min(...placeholderIndices) - 5)
    const maxIndex = Math.min(totalServerCount - 1, Math.max(...placeholderIndices) + 5)

    const indicesToLoad = []
    for (let i = minIndex; i <= maxIndex; i++) {
      indicesToLoad.push(i)
    }

    loadPhotosForIndices(indicesToLoad)
  }).current

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 10,
    minimumViewTime: 100,
  }).current

  // UI state
  const isLoadingServerPhotos = [GalleryState.CONNECTED_LOADING, GalleryState.INITIALIZING].includes(galleryState)
  const serverPhotosToSync = totalServerCount

  const shouldShowSyncButton =
    [
      GalleryState.MEDIA_AVAILABLE,
      GalleryState.CONNECTED_LOADING,
      GalleryState.USER_CANCELLED_WIFI,
      GalleryState.WAITING_FOR_WIFI_PROMPT,
      GalleryState.CONNECTING_TO_HOTSPOT,
      GalleryState.REQUESTING_HOTSPOT,
      GalleryState.SYNCING,
      GalleryState.SYNC_COMPLETE,
    ].includes(galleryState) ||
    (galleryState === GalleryState.READY_TO_SYNC && serverPhotosToSync > 0)

  const renderStatusBar = () => {
    if (!shouldShowSyncButton) return null

    const statusContent = () => {
      console.log("[GalleryScreen] Rendering status content for state:", galleryState)
      switch (galleryState) {
        case GalleryState.MEDIA_AVAILABLE:
          return (
            <View>
              <View style={themed($syncButtonRow)}>
                <Icon
                  name="download-circle-outline"
                  size={20}
                  color={theme.colors.text}
                  style={{marginRight: spacing.s2}}
                />
                <Text style={themed($syncButtonText)}>
                  Sync {glassesGalleryStatus?.total || 0}{" "}
                  {(glassesGalleryStatus?.photos || 0) > 0 && (glassesGalleryStatus?.videos || 0) > 0
                    ? (glassesGalleryStatus?.total || 0) === 1
                      ? "item"
                      : "items"
                    : (glassesGalleryStatus?.photos || 0) > 0
                      ? (glassesGalleryStatus?.photos || 0) === 1
                        ? "photo"
                        : "photos"
                      : (glassesGalleryStatus?.videos || 0) === 1
                        ? "video"
                        : "videos"}
                </Text>
              </View>
            </View>
          )

        case GalleryState.REQUESTING_HOTSPOT:
          return (
            <View style={themed($syncButtonRow)}>
              <ActivityIndicator size="small" color={theme.colors.text} style={{marginRight: spacing.s2}} />
              <Text style={themed($syncButtonText)}>Starting connection...</Text>
            </View>
          )

        case GalleryState.WAITING_FOR_WIFI_PROMPT:
          return (
            <View style={themed($syncButtonRow)}>
              <ActivityIndicator size="small" color={theme.colors.text} style={{marginRight: spacing.s2}} />
              <Text style={themed($syncButtonText)}>Waiting for connection...</Text>
            </View>
          )

        case GalleryState.CONNECTING_TO_HOTSPOT:
          return (
            <View style={themed($syncButtonRow)}>
              <ActivityIndicator size="small" color={theme.colors.text} style={{marginRight: spacing.s2}} />
              <Text style={themed($syncButtonText)}>Connecting...</Text>
            </View>
          )

        case GalleryState.CONNECTED_LOADING:
          return (
            <View style={themed($syncButtonRow)}>
              <ActivityIndicator size="small" color={theme.colors.text} style={{marginRight: spacing.s2}} />
              <Text style={themed($syncButtonText)}>Loading photos...</Text>
            </View>
          )

        case GalleryState.USER_CANCELLED_WIFI:
          // if (!hotspotSsid || !glassesGalleryStatus?.has_content) return null
          return (
            <View>
              <View style={themed($syncButtonRow)}>
                <Icon name="wifi-alert" size={20} color={theme.colors.text} style={{marginRight: spacing.s2}} />
                <Text style={themed($syncButtonText)}>
                  Sync {glassesGalleryStatus?.total || 0}{" "}
                  {(glassesGalleryStatus?.photos || 0) > 0 && (glassesGalleryStatus?.videos || 0) > 0
                    ? (glassesGalleryStatus?.total || 0) === 1
                      ? "item"
                      : "items"
                    : (glassesGalleryStatus?.photos || 0) > 0
                      ? (glassesGalleryStatus?.photos || 0) === 1
                        ? "photo"
                        : "photos"
                      : (glassesGalleryStatus?.videos || 0) === 1
                        ? "video"
                        : "videos"}
                </Text>
              </View>
            </View>
          )

        case GalleryState.READY_TO_SYNC:
          if (serverPhotosToSync === 0) return null
          return (
            <View style={themed($syncButtonRow)}>
              <Text style={themed($syncButtonText)}>Syncing {serverPhotosToSync} items...</Text>
            </View>
          )

        case GalleryState.SYNCING:
          if (!syncProgress) {
            return (
              <View style={themed($syncButtonRow)}>
                <ActivityIndicator size="small" color={theme.colors.text} style={{marginRight: spacing.s2}} />
                <Text style={themed($syncButtonText)}>Syncing {serverPhotosToSync} items...</Text>
              </View>
            )
          }
          return (
            <>
              <Text style={themed($syncButtonText)}>
                Syncing {syncProgress.current} of {syncProgress.total} items
              </Text>
              <View style={themed($syncButtonProgressBar)}>
                <View
                  style={[
                    themed($syncButtonProgressFill),
                    {
                      width: `${Math.round((syncProgress.current / syncProgress.total) * 100)}%`,
                    },
                  ]}
                />
              </View>
            </>
          )

        case GalleryState.SYNC_COMPLETE:
          return (
            <View style={themed($syncButtonRow)}>
              <Text style={themed($syncButtonText)}>Sync complete!</Text>
            </View>
          )

        default:
          return null
      }
    }

    const isTappable =
      galleryState === GalleryState.MEDIA_AVAILABLE || galleryState === GalleryState.USER_CANCELLED_WIFI

    return (
      <TouchableOpacity
        style={[themed($syncButtonFixed)]}
        onPress={isTappable ? retryHotspotConnection : undefined}
        activeOpacity={isTappable ? 0.8 : 1}
        disabled={!isTappable}>
        <View style={themed($syncButtonContent)}>{statusContent()}</View>
      </TouchableOpacity>
    )
  }

  const renderPhotoItem = ({item}: {item: GalleryItem}) => {
    if (!item.photo) {
      return (
        <View style={[themed($photoItem), {width: itemWidth}]}>
          <ShimmerPlaceholder
            shimmerColors={[theme.colors.border, theme.colors.background, theme.colors.border]}
            shimmerStyle={{
              width: itemWidth,
              height: itemWidth, // Square aspect ratio like Google/Apple Photos
              borderRadius: 0,
            }}
            duration={1500}
          />
        </View>
      )
    }

    const syncState = photoSyncStates.get(item.photo.name)
    const isDownloading =
      syncState &&
      (syncState.status === "downloading" || syncState.status === "pending" || syncState.status === "completed")
    const isSelected = selectedPhotos.has(item.photo.name)

    return (
      <TouchableOpacity
        style={[themed($photoItem), {width: itemWidth}, isDownloading && themed($photoItemDisabled)]}
        onPress={() => handlePhotoPress(item)}
        onLongPress={() => {
          if (item.photo && !isDownloading) {
            enterSelectionMode(item.photo.name)
          }
        }}
        disabled={isDownloading}
        activeOpacity={isDownloading ? 1 : 0.8}>
        <View style={{position: "relative"}}>
          <PhotoImage photo={item.photo} style={{...themed($photoImage), width: itemWidth, height: itemWidth}} />
          {isDownloading && <View style={themed($photoDimmingOverlay)} />}
        </View>
        {item.isOnServer && !isSelectionMode && (
          <View style={themed($serverBadge)}>
            <Icon name="glasses" size={14} color="white" />
          </View>
        )}
        {item.photo.is_video && !isSelectionMode && (
          <View style={themed($videoIndicator)}>
            <Icon name="video" size={14} color="white" />
          </View>
        )}
        {isSelectionMode &&
          (isSelected ? (
            <View style={themed($selectionCheckbox)}>
              <Icon name={"check"} size={24} color={"white"} />
            </View>
          ) : (
            <View style={themed($unselectedCheckbox)}>
              <Icon name={"checkbox-blank-circle-outline"} size={24} color={"white"} />
            </View>
          ))}
        {(() => {
          const syncState = photoSyncStates.get(item.photo.name)
          if (syncState) {
            console.log(`[GalleryScreen] Rendering progress for ${item.photo.name}:`, syncState)
          }
          if (
            syncState &&
            (syncState.status === "pending" ||
              syncState.status === "downloading" ||
              syncState.status === "failed" ||
              syncState.status === "completed")
          ) {
            const isFailed = syncState.status === "failed"
            const isCompleted = syncState.status === "completed"

            return (
              <View style={themed($progressRingOverlay)}>
                <ProgressRing
                  progress={Math.max(0, Math.min(100, syncState.progress || 0))}
                  size={50}
                  strokeWidth={4}
                  showPercentage={!isFailed && !isCompleted}
                  progressColor={isFailed ? theme.colors.error : theme.colors.primary}
                />
                {isFailed && (
                  <View
                    style={{
                      position: "absolute",
                      justifyContent: "center",
                      alignItems: "center",
                      width: 50,
                      height: 50,
                    }}>
                    <Icon name="alert-circle" size={20} color={theme.colors.error} />
                  </View>
                )}
                {isCompleted && (
                  <View
                    style={{
                      position: "absolute",
                      justifyContent: "center",
                      alignItems: "center",
                      width: 50,
                      height: 50,
                    }}>
                    <Icon name="check-circle" size={20} color={theme.colors.tint} />
                  </View>
                )}
              </View>
            )
          }
          return null
        })()}
      </TouchableOpacity>
    )
  }

  // Permission is no longer blocking - gallery loads immediately
  // Permission is requested lazily when saving to camera roll

  return (
    <>
      <Header
        title={isSelectionMode ? "" : "Glasses Gallery"}
        leftIcon={isSelectionMode ? undefined : "chevron-left"}
        onLeftPress={isSelectionMode ? undefined : () => goBack()}
        LeftActionComponent={
          isSelectionMode ? (
            <TouchableOpacity onPress={() => exitSelectionMode()}>
              <View style={themed($selectionHeader)}>
                <Icon name="x" size={20} color={theme.colors.text} />
                <Text style={themed($selectionCountText)}>{selectedPhotos.size}</Text>
              </View>
            </TouchableOpacity>
          ) : undefined
        }
        RightActionComponent={
          isSelectionMode ? (
            <TouchableOpacity
              onPress={() => {
                if (selectedPhotos.size > 0) {
                  handleDeleteSelectedPhotos()
                }
              }}
              disabled={selectedPhotos.size === 0}>
              <View style={themed($deleteButton)}>
                <Icon name="trash" size={20} color={theme.colors.text} />
                <Text style={themed($deleteButtonText)}>Delete</Text>
              </View>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={() => push("/asg/gallery-settings")} style={themed($settingsButton)}>
              <Icon name="settings" size={24} color={theme.colors.text} />
            </TouchableOpacity>
          )
        }
      />
      <View style={themed($screenContainer)}>
        <View style={themed($galleryContainer)}>
          {(() => {
            const showEmpty = allPhotos.length === 0 && !isLoadingServerPhotos

            if (showEmpty) {
              return (
                <View style={themed($emptyContainer)}>
                  <Icon
                    name="image-outline"
                    size={64}
                    color={theme.colors.textDim}
                    style={{marginBottom: spacing.s6}}
                  />
                  <Text style={themed($emptyText)}>{translate("glasses:noPhotos")}</Text>
                  <Text style={themed($emptySubtext)}>{translate("glasses:takePhotoWithButton")}</Text>
                </View>
              )
            } else {
              return (
                <FlatList
                  data={allPhotos}
                  numColumns={numColumns}
                  key={numColumns}
                  renderItem={renderPhotoItem}
                  keyExtractor={item => item.id}
                  contentContainerStyle={[
                    themed($photoGridContent),
                    {paddingBottom: shouldShowSyncButton ? 100 : spacing.s6},
                  ]}
                  columnWrapperStyle={numColumns > 1 ? themed($columnWrapper) : undefined}
                  ItemSeparatorComponent={() => <View style={{height: ITEM_SPACING}} />}
                  initialNumToRender={10}
                  maxToRenderPerBatch={10}
                  windowSize={10}
                  removeClippedSubviews={true}
                  updateCellsBatchingPeriod={50}
                  onViewableItemsChanged={onViewableItemsChanged}
                  viewabilityConfig={viewabilityConfig}
                />
              )
            }
          })()}
        </View>

        {renderStatusBar()}

        <MediaViewer
          visible={!!selectedPhoto}
          photo={selectedPhoto}
          onClose={() => setSelectedPhoto(null)}
          // onShare={() => selectedPhoto && handleSharePhoto(selectedPhoto)}
        />
      </View>
    </>
  )
}

// Styles remain the same
const $screenContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  // backgroundColor: colors.background,
  marginHorizontal: -spacing.s6,
})

const $photoGridContent: ThemedStyle<ViewStyle> = () => ({
  paddingHorizontal: 0, // No horizontal padding for edge-to-edge layout
  paddingTop: 0, // No top padding for edge-to-edge layout
})

const $columnWrapper: ThemedStyle<ViewStyle> = () => ({
  justifyContent: "flex-start",
  gap: 2, // Minimal spacing between columns
})

const $emptyContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "flex-start",
  alignItems: "center",
  padding: spacing.s8,
  paddingTop: spacing.s12 * 2,
})

const $emptyText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 20,
  fontWeight: "600",
  color: colors.text,
  marginBottom: spacing.s2,
})

const $emptySubtext: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.textDim,
  textAlign: "center",
  lineHeight: 20,
  paddingHorizontal: spacing.s6,
})

const $photoItem: ThemedStyle<ViewStyle> = () => ({
  borderRadius: 0, // No rounding like Google Photos / Apple Photos
  overflow: "hidden",
  backgroundColor: "rgba(0,0,0,0.05)",
})

const $photoImage: ThemedStyle<ImageStyle> = () => ({
  width: "100%",
  borderRadius: 0, // No rounding like Google Photos / Apple Photos
})

const $videoIndicator: ThemedStyle<ViewStyle> = ({spacing}) => ({
  position: "absolute",
  top: spacing.s2,
  left: spacing.s2,
  backgroundColor: "rgba(0,0,0,0.7)",
  borderRadius: 12,
  paddingHorizontal: 6,
  paddingVertical: 3,
  shadowColor: "#000",
  shadowOffset: {width: 0, height: 1},
  shadowOpacity: 0.3,
  shadowRadius: 2,
  elevation: 3,
})

const $progressRingOverlay: ThemedStyle<ViewStyle> = () => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  justifyContent: "center",
  alignItems: "center",
  borderRadius: 0,
})

const $galleryContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $syncButtonFixed: ThemedStyle<ViewStyle> = ({colors, spacing, isDark}) => ({
  position: "absolute",
  bottom: spacing.s8,
  left: spacing.s6,
  right: spacing.s6,
  backgroundColor: colors.primary_foreground,
  color: colors.text,
  borderRadius: spacing.s4,
  borderWidth: 1,
  borderColor: colors.border,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s6,
  ...(isDark
    ? {}
    : {
        shadowColor: "#000",
        shadowOffset: {width: 0, height: 2},
        shadowOpacity: 0.15,
        shadowRadius: 3.84,
        elevation: 5,
      }),
})

const $syncButtonContent: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  justifyContent: "center",
})

const $syncButtonRow: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
})

const $syncButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.text,
  // marginBottom: 2,
})

const $serverBadge: ThemedStyle<ViewStyle> = ({spacing}) => ({
  position: "absolute",
  top: spacing.s2,
  right: spacing.s2,
  backgroundColor: "rgba(0,0,0,0.7)",
  borderRadius: 12,
  paddingHorizontal: 6,
  paddingVertical: 3,
  justifyContent: "center",
  alignItems: "center",
  shadowColor: "#000",
  shadowOffset: {width: 0, height: 1},
  shadowOpacity: 0.3,
  shadowRadius: 2,
  elevation: 3,
})

// const _$deleteAllButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
//   paddingHorizontal: spacing.s3,
//   paddingVertical: spacing.s2,
//   borderRadius: spacing.s3,
//   justifyContent: "center",
//   alignItems: "center",
//   minWidth: 44,
//   minHeight: 44,
// })

const $syncButtonProgressBar: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  height: 6,
  backgroundColor: colors.border,
  borderRadius: 3,
  overflow: "hidden",
  marginTop: spacing.s2,
  width: "100%",
})

const $syncButtonProgressFill: ThemedStyle<ViewStyle> = ({colors}) => ({
  height: "100%",
  backgroundColor: colors.palette.primary500,
  borderRadius: 2,
})

const $photoDimmingOverlay: ThemedStyle<ViewStyle> = () => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0,0,0,0.5)",
  borderRadius: 0,
})

const $photoItemDisabled: ThemedStyle<ViewStyle> = () => ({
  // Removed opacity to prevent greyed out appearance during sync
})

const $settingsButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s2,
  borderRadius: spacing.s3,
  justifyContent: "center",
  alignItems: "center",
  minWidth: 44,
  minHeight: 44,
})

const $selectionCheckbox: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  position: "absolute",
  top: spacing.s1,
  left: spacing.s1,
  backgroundColor: colors.primary,
  borderRadius: 20,
  padding: 2,
  elevation: 3,
})

const $unselectedCheckbox: ThemedStyle<ViewStyle> = ({spacing}) => ({
  position: "absolute",
  top: spacing.s1,
  left: spacing.s1,
  backgroundColor: "rgba(0, 0, 0, 0.3)",
  borderRadius: 20,
  padding: 2,
})

const $deleteButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  backgroundColor: colors.primary_foreground,
  padding: 8,
  borderRadius: 32,
  gap: 6,
})

const $deleteButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  lineHeight: 24,
  fontWeight: "600",
})

const $selectionHeader: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  backgroundColor: colors.primary_foreground,
  padding: 8,
  borderRadius: 32,
  gap: 6,
})

const $selectionCountText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  lineHeight: 24,
  fontWeight: "600",
})
