/**
 * Main gallery screen component
 * Refactored to use gallerySyncService for background sync capability
 */

import {getModelCapabilities} from "@/../../cloud/packages/types/src"
import LinearGradient from "expo-linear-gradient"
import {useFocusEffect} from "expo-router"
import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Dimensions,
  FlatList,
  ImageStyle,
  Pressable,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native"
import * as RNFS from "@dr.pogodin/react-native-fs"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import {createShimmerPlaceholder} from "react-native-shimmer-placeholder"
import {useShallow} from "zustand/react/shallow"

import {MediaViewer} from "@/components/glasses/Gallery/MediaViewer"
import {PhotoImage} from "@/components/glasses/Gallery/PhotoImage"
import {ProgressRing} from "@/components/glasses/Gallery/ProgressRing"
import {Header, Icon, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {gallerySyncService} from "@/services/asg/gallerySyncService"
import {localStorageService} from "@/services/asg/localStorageService"
import {useGallerySyncStore} from "@/stores/gallerySync"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {spacing, ThemedStyle} from "@/theme"
import {PhotoInfo} from "@/types/asg"
import showAlert from "@/utils/AlertUtils"
// import {shareFile} from "@/utils/FileUtils"
import {MediaLibraryPermissions} from "@/utils/permissions/MediaLibraryPermissions"
import {ENABLE_TEST_GALLERY_DATA, TEST_GALLERY_ITEMS} from "@/utils/testGalleryData"

// @ts-ignore
const ShimmerPlaceholder = createShimmerPlaceholder(LinearGradient)

// Gallery timing constants
const TIMING = {
  PROGRESS_RING_DISPLAY_MS: 3000, // How long to show completed/failed progress rings
  ALERT_DELAY_MS: 100, // Delay before showing alerts to allow UI to settle
} as const

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
  const insets = useSafeAreaInsets()

  // Column calculation - 3 per row like Google Photos / Apple Photos
  const screenWidth = Dimensions.get("window").width
  const ITEM_SPACING = 2 // Minimal spacing between items (1-2px hairline)
  const HORIZONTAL_PADDING = spacing.s3 * 2 // Padding on left and right edges (12px * 2 = 24px)
  const numColumns = screenWidth < 320 ? 2 : 3 // 2 columns for very small screens, otherwise 3
  const itemWidth = (screenWidth - HORIZONTAL_PADDING - ITEM_SPACING * (numColumns - 1)) / numColumns
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const features = getModelCapabilities(defaultWearable)
  const glassesConnected = useGlassesStore((state) => state.connected)

  // Subscribe to sync store
  const syncState = useGallerySyncStore((state) => state.syncState)
  const currentFile = useGallerySyncStore((state) => state.currentFile)
  const currentFileProgress = useGallerySyncStore((state) => state.currentFileProgress)
  const completedFiles = useGallerySyncStore((state) => state.completedFiles)
  const totalFiles = useGallerySyncStore((state) => state.totalFiles)
  const failedFiles = useGallerySyncStore((state) => state.failedFiles)
  const syncQueue = useGallerySyncStore((state) => state.queue)
  const glassesGalleryStatus = useGallerySyncStore(
    useShallow((state) => ({
      photos: state.glassesPhotoCount,
      videos: state.glassesVideoCount,
      total: state.glassesTotalCount,
      hasContent: state.glassesHasContent,
    })),
  )

  // Permission state - no longer blocking, permission is requested lazily when saving
  const [_hasMediaLibraryPermission, setHasMediaLibraryPermission] = useState(false)

  // Data state
  const [downloadedPhotos, setDownloadedPhotos] = useState<PhotoInfo[]>([])
  const [selectedPhoto, setSelectedPhoto] = useState<PhotoInfo | null>(null)

  // Photo sync states for UI (progress rings on thumbnails)
  const [photoSyncStates, setPhotoSyncStates] = useState<
    Map<
      string,
      {
        status: "pending" | "downloading" | "completed" | "failed"
        progress: number
      }
    >
  >(new Map())

  // Selection mode state
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedPhotos, setSelectedPhotos] = useState<Set<string>>(new Set())

  // Initial loading state for first gallery load
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [loadingPhotoCount, setLoadingPhotoCount] = useState(0)
  const [showLoadingPlaceholders, setShowLoadingPlaceholders] = useState(false)

  // Post-sync validation state
  const [isValidating, setIsValidating] = useState(false)
  const [validatingCount, setValidatingCount] = useState(0)

  // Animation for smooth transition from placeholders to photos
  const fadeAnim = useRef(new Animated.Value(1)).current

  // DEBUG: Log state changes
  useEffect(() => {
    console.log("[GalleryScreen] 🔍 STATE CHANGE - isInitialLoading:", isInitialLoading)
  }, [isInitialLoading])

  useEffect(() => {
    console.log("[GalleryScreen] 🔍 STATE CHANGE - showLoadingPlaceholders:", showLoadingPlaceholders)
  }, [showLoadingPlaceholders])

  useEffect(() => {
    console.log("[GalleryScreen] 🔍 STATE CHANGE - loadingPhotoCount:", loadingPhotoCount)
  }, [loadingPhotoCount])

  useEffect(() => {
    console.log("[GalleryScreen] 🔍 STATE CHANGE - downloadedPhotos.length:", downloadedPhotos.length)
  }, [downloadedPhotos.length])

  // Load downloaded photos (validates files exist and cleans up stale entries)
  const loadDownloadedPhotos = useCallback(async () => {
    const loadStartTime = Date.now()
    console.log("[GalleryScreen] ⏱️ LOAD START at", loadStartTime)
    try {
      // console.log("[GalleryScreen] 🔍 Loading downloaded photos from storage...")
      const downloadedFiles = await localStorageService.getDownloadedFiles()
      const metadataLoadTime = Date.now()
      console.log(
        "[GalleryScreen] ⏱️ METADATA LOADED at",
        metadataLoadTime,
        "- took",
        metadataLoadTime - loadStartTime,
        "ms",
      )

      const totalFromStorage = Object.keys(downloadedFiles).length
      console.log(`[GalleryScreen] 📦 Found ${totalFromStorage} files in storage metadata`)

      // Set count immediately for placeholder display (FAST - no file validation yet)
      setLoadingPhotoCount(totalFromStorage)
      console.log("[GalleryScreen] ⏱️ SET loadingPhotoCount to", totalFromStorage)

      // Show validating status only for newly downloaded photos from this sync session
      // Use completedFiles from sync store (photos downloaded this session) instead of total gallery count
      if (completedFiles > 0) {
        setIsValidating(true)
        setValidatingCount(completedFiles)
        console.log(`[GalleryScreen] 🔄 Validating ${completedFiles} newly downloaded pictures`)
      }

      const validPhotoInfos: PhotoInfo[] = []
      const staleFileNames: string[] = []

      // Check all files exist on disk in parallel (50-100x faster than sequential)
      const validationPromises = Object.entries(downloadedFiles).map(async ([name, file]) => {
        // console.log(`[GalleryScreen]   Checking file: ${name} at ${file.filePath}`)
        const fileExists = await RNFS.exists(file.filePath)
        return {
          name,
          file,
          exists: fileExists,
        }
      })

      // Wait for all validations to complete (happens in parallel)
      const validationResults = await Promise.all(validationPromises)

      // Process results
      for (const result of validationResults) {
        if (result.exists) {
          // console.log(`[GalleryScreen]     ✅ File exists on disk`)
          validPhotoInfos.push(localStorageService.convertToPhotoInfo(result.file))
        } else {
          // console.log(`[GalleryScreen]     ❌ File missing on disk - marking as stale`)
          console.log(`[GalleryScreen] Cleaning up stale entry for missing file: ${result.name}`)
          staleFileNames.push(result.name)
        }
      }

      // Clean up stale metadata entries (files that no longer exist on disk)
      for (const fileName of staleFileNames) {
        await localStorageService.deleteDownloadedFile(fileName)
      }

      if (staleFileNames.length > 0) {
        console.log(`[GalleryScreen] Cleaned up ${staleFileNames.length} stale photo entries`)
      }

      const validationCompleteTime = Date.now()
      console.log(
        "[GalleryScreen] ⏱️ VALIDATION COMPLETE at",
        validationCompleteTime,
        "- took",
        validationCompleteTime - loadStartTime,
        "ms",
      )
      console.log(`[GalleryScreen] ✅ Loaded ${validPhotoInfos.length} valid photos`)
      validPhotoInfos.forEach((photo, idx) => {
        console.log(`[GalleryScreen]   ${idx + 1}. ${photo.name}`)
      })

      // Add test data in development mode
      if (ENABLE_TEST_GALLERY_DATA) {
        console.log(`[GalleryScreen] 🧪 Adding ${TEST_GALLERY_ITEMS.length} test items for development`)
        const allPhotos = [...TEST_GALLERY_ITEMS, ...validPhotoInfos]
        setDownloadedPhotos(allPhotos)
      } else {
        setDownloadedPhotos(validPhotoInfos)
      }

      const finalTime = Date.now()
      console.log("[GalleryScreen] ⏱️ LOAD COMPLETE at", finalTime, "- TOTAL TIME:", finalTime - loadStartTime, "ms")

      // Clear validation state
      setIsValidating(false)
      setValidatingCount(0)
    } catch (err) {
      console.error("Error loading downloaded photos:", err)
      // Clear validation state on error too
      setIsValidating(false)
      setValidatingCount(0)
    }
  }, [completedFiles])

  // Initialize pending status for all files when sync starts
  useEffect(() => {
    if (syncState === "syncing" && syncQueue.length > 0) {
      // On first render of syncing state, initialize all files as pending
      setPhotoSyncStates((prev) => {
        // Only initialize if we don't have states yet (avoid overwriting progress)
        if (prev.size === 0) {
          const initialStates = new Map()
          syncQueue.forEach((file) => {
            initialStates.set(file.name, {
              status: "pending" as const,
              progress: 0,
            })
          })
          console.log(`[GalleryScreen] Initialized ${syncQueue.length} files as pending`)
          return initialStates
        }
        return prev
      })
    }
  }, [syncState, syncQueue])

  // Update photo sync states based on store state
  useEffect(() => {
    if (syncState !== "syncing") {
      // Clear photo sync states when not syncing (after a delay to show completion)
      if (syncState === "complete" || syncState === "cancelled" || syncState === "error") {
        setTimeout(() => {
          setPhotoSyncStates(new Map())
        }, TIMING.PROGRESS_RING_DISPLAY_MS)
      }
      return
    }

    // Update the current file's progress
    if (currentFile) {
      setPhotoSyncStates((prev) => {
        const newStates = new Map(prev)

        // If current file is at 100%, remove it immediately (no green ring)
        if (currentFileProgress >= 100) {
          newStates.delete(currentFile)
        } else {
          // Set current file as downloading if not complete
          newStates.set(currentFile, {
            status: "downloading",
            progress: currentFileProgress,
          })
        }

        // Remove completed files from sync states immediately (no green ring)
        for (let i = 0; i < completedFiles; i++) {
          const completedFileName = syncQueue[i]?.name
          if (completedFileName) {
            newStates.delete(completedFileName)
          }
        }

        // Mark failed files
        for (const failedFileName of failedFiles) {
          newStates.set(failedFileName, {
            status: "failed",
            progress: 0,
          })
        }

        return newStates
      })
    }
  }, [syncState, currentFile, currentFileProgress, completedFiles, failedFiles, syncQueue])

  // Reload photos when sync completes to populate downloadedPhotos state
  // This ensures all photos (old + new) are visible in the gallery
  useEffect(() => {
    if (syncState === "complete") {
      console.log("[GalleryScreen] 🔄 Sync complete - reloading all photos from storage")
      loadDownloadedPhotos()
    }
  }, [syncState, loadDownloadedPhotos])

  // Exit selection mode
  // Memoized for stable reference in other callbacks
  const exitSelectionMode = useCallback(() => {
    setIsSelectionMode(false)
    setSelectedPhotos(new Set())
  }, [])

  // Toggle photo selection
  // Memoized for stable reference in handlePhotoPress
  const togglePhotoSelection = useCallback(
    (photoName: string) => {
      setSelectedPhotos((prev) => {
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
    },
    [exitSelectionMode],
  )

  // Enter selection mode
  // Memoized for stable reference in renderPhotoItem
  const enterSelectionMode = useCallback((photoName: string) => {
    setIsSelectionMode(true)
    setSelectedPhotos(new Set([photoName]))
  }, [])

  // Handle photo selection - direct open (no fancy transition)
  // Memoized for stable reference to prevent FlatList re-renders
  const handlePhotoPress = useCallback(
    (item: GalleryItem) => {
      if (!item.photo) return

      // If in selection mode, toggle selection
      if (isSelectionMode) {
        togglePhotoSelection(item.photo.name)
        return
      }

      // Prevent opening photos that are currently being downloaded (but allow completed ones)
      const itemSyncState = photoSyncStates.get(item.photo.name)
      if (itemSyncState && (itemSyncState.status === "downloading" || itemSyncState.status === "pending")) {
        console.log(`[GalleryScreen] Photo ${item.photo.name} is being synced, preventing open`)
        return
      }

      if (item.photo.is_video && item.isOnServer) {
        showAlert("Video Not Downloaded", "Please sync this video to your device to watch it", [
          {text: translate("common:ok")},
        ])
        return
      }

      // Open MediaViewer directly (no floating transition)
      // Index will be calculated from photo name when rendering MediaViewer
      console.log("[GalleryScreen] 🚀 Opening MediaViewer for photo:", item.photo.name)
      setSelectedPhoto(item.photo)
    },
    [isSelectionMode, photoSyncStates, togglePhotoSelection],
  )

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

  // Handle sync button press - delegate to service
  const handleSyncPress = () => {
    if (gallerySyncService.isSyncing()) {
      console.log("[GalleryScreen] Already syncing, ignoring press")
      return
    }
    gallerySyncService.startSync()
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
            const photosToDelete = Array.from(selectedPhotos)

            // All photos in gallery screen are local (downloaded) photos
            // Server photos are only shown during sync
            const localPhotos = photosToDelete

            let deleteErrors: string[] = []

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

  // Initial mount - load gallery data
  useEffect(() => {
    const mountTime = Date.now()
    console.log("[GalleryScreen] ⏱️ COMPONENT MOUNTED at", mountTime)
    console.log("[GalleryScreen] Component mounted - initializing gallery")

    // Check permission status in background (for state tracking, not blocking)
    MediaLibraryPermissions.checkPermission().then((hasPermission) => {
      setHasMediaLibraryPermission(hasPermission)
      console.log("[GalleryScreen] Media library permission status:", hasPermission)
    })

    // Initialize gallery immediately - no permission blocking
    // Only show placeholders if loading takes > 150ms (avoid flicker for cached photos)
    console.log("[GalleryScreen] ⏱️ SET isInitialLoading = true")
    setIsInitialLoading(true)

    console.log("[GalleryScreen] ⏱️ SET TIMEOUT for placeholders (150ms)")
    const placeholderTimeout = setTimeout(() => {
      console.log("[GalleryScreen] ⏱️ TIMEOUT FIRED - SET showLoadingPlaceholders = true")
      setShowLoadingPlaceholders(true)
    }, 150) // Delay showing placeholders by 150ms

    loadDownloadedPhotos().finally(() => {
      const completeTime = Date.now()
      console.log(
        "[GalleryScreen] ⏱️ FINALLY BLOCK at",
        completeTime,
        "- elapsed since mount:",
        completeTime - mountTime,
        "ms",
      )
      console.log("[GalleryScreen] ⏱️ CLEARING timeout")
      clearTimeout(placeholderTimeout)
      console.log("[GalleryScreen] ⏱️ SET showLoadingPlaceholders = false")
      setShowLoadingPlaceholders(false)
      console.log("[GalleryScreen] ⏱️ SET isInitialLoading = false")
      setIsInitialLoading(false)
      console.log("[GalleryScreen] Initial gallery load complete")
    })

    // Only query glasses if we have glasses info (meaning glasses are connected) AND glasses have gallery capability
    if (glassesConnected && features?.hasCamera) {
      console.log("[GalleryScreen] Glasses connected with gallery capability - querying gallery status")
      gallerySyncService.queryGlassesGalleryStatus()
    }

    // Note: Sync service is initialized globally in GallerySyncEffect
  }, [])

  // Reset gallery state when glasses disconnect
  useEffect(() => {
    if (!glassesConnected) {
      console.log("[GalleryScreen] Glasses disconnected - clearing gallery state")
      useGallerySyncStore.getState().clearGlassesGalleryStatus()
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
        // Handle modal viewer dismissal
        if (selectedPhoto) {
          setSelectedPhoto(null)
          return true
        }
        return false
      }

      const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress)
      return () => subscription.remove()
    }, [selectedPhoto, isSelectionMode, exitSelectionMode]),
  )

  // Combine syncing photos with downloaded photos
  const allPhotos = useMemo(() => {
    console.log("[GalleryScreen] 🖼️ Computing allPhotos display list...")
    console.log(`[GalleryScreen] 📊 Input state:`)
    console.log(`[GalleryScreen]   - syncQueue.length: ${syncQueue.length}`)
    console.log(`[GalleryScreen]   - downloadedPhotos.length: ${downloadedPhotos.length}`)
    console.log(`[GalleryScreen]   - syncState: ${syncState}`)

    const items: GalleryItem[] = []

    // Show photos from the sync queue in chronological order (newest first for UX)
    // Files download in chronological order (oldest first), but we re-sort for display
    // Keep showing queue even when state transitions to idle after sync
    if (syncQueue.length > 0) {
      console.log(`[GalleryScreen] 📋 syncQueue contains:`)
      syncQueue.forEach((photo, idx) => {
        console.log(`[GalleryScreen]   ${idx + 1}. ${photo.name} (filePath: ${photo.filePath ? "✅" : "❌"})`)
      })

      const sortedQueue = [...syncQueue].sort((a, b) => {
        const aTime = typeof a.modified === "string" ? new Date(a.modified).getTime() : a.modified || 0
        const bTime = typeof b.modified === "string" ? new Date(b.modified).getTime() : b.modified || 0
        return bTime - aTime // Newest first
      })

      sortedQueue.forEach((photo, i) => {
        items.push({
          id: `sync-${photo.name}`,
          type: "server",
          index: i,
          photo,
          // File is only on server if it hasn't been downloaded yet (no filePath)
          isOnServer: !photo.filePath,
        })
      })
      // console.log(`[GalleryScreen] ➕ Added ${sortedQueue.length} items from syncQueue`)
    }

    // Downloaded photos (exclude any that are in the sync queue or are AVIF artifacts)
    const syncQueueNames = new Set(syncQueue.map((p) => p.name))
    // console.log(
    //   `[GalleryScreen] 🚫 Will exclude these names from downloadedPhotos: ${Array.from(syncQueueNames).join(", ")}`,
    // )

    const isAvifArtifact = (name: string) => {
      // Filter out AVIF transfer artifacts by pattern
      return (
        name.match(/^I\d+$/) || // "I" + digits
        name.match(/^ble_\d+$/) || // "ble_" + digits
        name.match(/^\d+$/) || // Pure digits
        name.endsWith(".avif") ||
        name.endsWith(".avifs")
      )
    }

    // console.log(`[GalleryScreen] 📥 Processing downloadedPhotos:`)
    // const filteredBeforeAvif = downloadedPhotos.filter(p => !syncQueueNames.has(p.name))
    // console.log(`[GalleryScreen]   - After removing syncQueue duplicates: ${filteredBeforeAvif.length}`)
    // filteredBeforeAvif.forEach((photo, idx) => {
    //   const isAvif = isAvifArtifact(photo.name)
    //   console.log(`[GalleryScreen]     ${idx + 1}. ${photo.name}${isAvif ? " (AVIF - will be filtered)" : ""}`)
    // })

    const downloadedOnly = downloadedPhotos
      .filter((p) => !syncQueueNames.has(p.name) && !isAvifArtifact(p.name))
      .sort((a, b) => {
        const aTime = typeof a.modified === "string" ? new Date(a.modified).getTime() : a.modified
        const bTime = typeof b.modified === "string" ? new Date(b.modified).getTime() : b.modified
        return bTime - aTime
      })

    // console.log(`[GalleryScreen]   - After AVIF filtering: ${downloadedOnly.length}`)

    downloadedOnly.forEach((photo, i) => {
      items.push({
        id: `local-${photo.name}`,
        type: "local",
        index: (syncState === "syncing" ? syncQueue.length : 0) + i,
        photo,
        isOnServer: false,
      })
    })
    // console.log(`[GalleryScreen] ➕ Added ${downloadedOnly.length} items from downloadedPhotos`)

    // console.log(`[GalleryScreen] ✅ Final allPhotos list: ${items.length} items`)
    // items.forEach((item, idx) => {
    //   console.log(`[GalleryScreen]   ${idx + 1}. ${item.photo?.name} (type: ${item.type})`)
    // })

    return items
  }, [syncState, syncQueue, downloadedPhotos])

  // Create placeholder items during initial load (only if loading is taking a while)
  const placeholderItems = useMemo(() => {
    // Don't show placeholders if we already have photos from syncQueue
    if (!showLoadingPlaceholders || loadingPhotoCount === 0 || allPhotos.length > 0) return []

    // Create placeholder items matching expected photo count
    return Array.from({length: loadingPhotoCount}, (_, i) => ({
      id: `placeholder-${i}`,
      type: "placeholder" as const,
      index: i,
      photo: undefined,
      isOnServer: false,
    }))
  }, [showLoadingPlaceholders, loadingPhotoCount, allPhotos.length])

  // Use placeholders during initial load, otherwise use real photos
  // Only show placeholders if allPhotos is truly empty (no syncQueue photos)
  const displayItems =
    showLoadingPlaceholders && placeholderItems.length > 0 && allPhotos.length === 0 ? placeholderItems : allPhotos

  // DEBUG: Log what we're displaying
  useEffect(() => {
    console.log("[GalleryScreen] 🎨 RENDER displayItems:", {
      showLoadingPlaceholders,
      placeholderItemsCount: placeholderItems.length,
      allPhotosCount: allPhotos.length,
      displayItemsCount: displayItems.length,
      usingPlaceholders: showLoadingPlaceholders && placeholderItems.length > 0,
    })
  }, [displayItems.length, showLoadingPlaceholders, placeholderItems.length, allPhotos.length])

  // Animate transition from placeholders to photos
  const wasShowingPlaceholders = useRef(false)
  useEffect(() => {
    const isShowingPlaceholders = showLoadingPlaceholders && placeholderItems.length > 0

    // Detect transition from placeholders to real photos
    if (wasShowingPlaceholders.current && !isShowingPlaceholders && allPhotos.length > 0) {
      console.log("[GalleryScreen] 🎬 Animating fade-in from placeholders to photos")
      // Start from 0 opacity
      fadeAnim.setValue(0)
      // Fade in over 300ms
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start()
    }

    wasShowingPlaceholders.current = isShowingPlaceholders
  }, [showLoadingPlaceholders, placeholderItems.length, allPhotos.length, fadeAnim])

  // Viewability tracking - DISABLED for performance
  // onViewableItemsChanged callbacks block touch input when scroll stops (~0.5s delay)
  // FlatList calculates viewable items even if callback is empty, blocking main thread
  // We don't need this for current functionality, so commenting out entirely
  //
  // const onViewableItemsChanged = useRef(({viewableItems: _viewableItems}: {viewableItems: ViewToken[]}) => {
  //   // Could be used for lazy loading thumbnails in the future
  // }).current
  //
  // const viewabilityConfig = useRef({
  //   itemVisiblePercentThreshold: 10,
  //   minimumViewTime: 100,
  // }).current

  // NOTE: getItemLayout is intentionally REMOVED for multi-column grids
  // While it provides performance benefits, it causes critical scroll bugs at edges:
  // - Scroll gets stuck at bottom when trying to scroll back up
  // - Last row calculation errors when row isn't fully filled
  // - React Native's FlatList has known issues with getItemLayout + numColumns > 1
  //
  // Without getItemLayout, FlatList measures items dynamically, which is:
  // - Slightly slower initial render
  // - But MUCH more reliable for edge scrolling
  // - Handles partial last rows correctly
  // - No scroll position miscalculations
  //
  // The performance trade-off is acceptable for correct scrolling behavior.

  // UI state
  const isLoading = syncState === "connecting_wifi" || syncState === "requesting_hotspot" || isInitialLoading
  const isSyncing = syncState === "syncing"

  const shouldShowSyncButton =
    glassesGalleryStatus.hasContent ||
    syncState === "requesting_hotspot" ||
    syncState === "connecting_wifi" ||
    syncState === "syncing" ||
    syncState === "complete"

  const renderStatusBar = () => {
    if (!shouldShowSyncButton) return null

    const statusContent = () => {
      switch (syncState) {
        case "idle":
          if (!glassesGalleryStatus.hasContent) return null
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
                  Sync {glassesGalleryStatus.total}{" "}
                  {glassesGalleryStatus.photos > 0 && glassesGalleryStatus.videos > 0
                    ? glassesGalleryStatus.total === 1
                      ? "item"
                      : "items"
                    : glassesGalleryStatus.photos > 0
                      ? glassesGalleryStatus.photos === 1
                        ? "photo"
                        : "photos"
                      : glassesGalleryStatus.videos === 1
                        ? "video"
                        : "videos"}
                </Text>
              </View>
            </View>
          )

        case "requesting_hotspot":
          return (
            <View style={themed($syncButtonRow)}>
              <ActivityIndicator size="small" color={theme.colors.text} style={{marginRight: spacing.s2}} />
              <Text style={themed($syncButtonText)}>Starting connection...</Text>
            </View>
          )

        case "connecting_wifi":
          return (
            <View style={themed($syncButtonRow)}>
              <ActivityIndicator size="small" color={theme.colors.text} style={{marginRight: spacing.s2}} />
              <Text style={themed($syncButtonText)}>Connecting...</Text>
            </View>
          )

        case "syncing":
          if (totalFiles === 0) {
            return (
              <View style={themed($syncButtonRow)}>
                <ActivityIndicator size="small" color={theme.colors.text} style={{marginRight: spacing.s2}} />
                <Text style={themed($syncButtonText)}>Preparing sync...</Text>
              </View>
            )
          }
          return (
            <>
              <Text style={themed($syncButtonText)}>
                Syncing {Math.min(completedFiles + 1, totalFiles)} of {totalFiles} items
              </Text>
              <View style={themed($syncButtonProgressBar)}>
                <View
                  style={[
                    themed($syncButtonProgressFill),
                    {
                      width: `${Math.round(((completedFiles + currentFileProgress / 100) / totalFiles) * 100)}%`,
                    },
                  ]}
                />
              </View>
            </>
          )

        case "complete":
          // Show validating status for newly downloaded photos
          if (isValidating && validatingCount > 0) {
            return (
              <View style={themed($syncButtonRow)}>
                <ActivityIndicator size="small" color={theme.colors.text} style={{marginRight: spacing.s2}} />
                <Text style={themed($syncButtonText)}>
                  Validating {validatingCount} {validatingCount === 1 ? "picture" : "pictures"}...
                </Text>
              </View>
            )
          }
          return (
            <View style={themed($syncButtonRow)}>
              <Text style={themed($syncButtonText)}>Sync complete!</Text>
            </View>
          )

        case "error":
          return (
            <View style={themed($syncButtonRow)}>
              <Text style={themed($syncButtonText)}>Sync failed - tap to retry</Text>
            </View>
          )

        default:
          return null
      }
    }

    const isTappable = syncState === "idle" || syncState === "error"

    return (
      <TouchableOpacity
        style={[themed($syncButtonFixed), {bottom: insets.bottom + spacing.s12}]}
        onPress={isTappable ? handleSyncPress : undefined}
        activeOpacity={isTappable ? 0.8 : 1}
        disabled={!isTappable}>
        <View style={themed($syncButtonContent)}>{statusContent()}</View>
      </TouchableOpacity>
    )
  }

  // Memoize renderPhotoItem to prevent FlatList scroll interruptions
  // CRITICAL: Without useCallback, this function is recreated on every render,
  // causing FlatList to lose scroll momentum
  const renderPhotoItem = useCallback(
    ({item}: {item: GalleryItem}) => {
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

      const itemSyncState = photoSyncStates.get(item.photo.name)
      const isDownloading =
        itemSyncState && (itemSyncState.status === "downloading" || itemSyncState.status === "pending")
      // Don't include "completed" - those are accessible and should allow interaction
      const isSelected = selectedPhotos.has(item.photo.name)

      return (
        <Pressable
          style={[themed($photoItem), {width: itemWidth}, isDownloading && themed($photoItemDisabled)]}
          onPress={() => handlePhotoPress(item)}
          onLongPress={() => {
            if (item.photo && !isDownloading) {
              enterSelectionMode(item.photo.name)
            }
          }}
          disabled={isDownloading}>
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
            const syncStateForItem = photoSyncStates.get(item.photo.name)
            if (
              syncStateForItem &&
              (syncStateForItem.status === "pending" ||
                syncStateForItem.status === "downloading" ||
                syncStateForItem.status === "failed")
            ) {
              const isFailed = syncStateForItem.status === "failed"

              return (
                <View style={themed($progressRingOverlay)}>
                  <ProgressRing
                    progress={Math.max(0, Math.min(100, syncStateForItem.progress || 0))}
                    size={50}
                    strokeWidth={4}
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
                </View>
              )
            }
            return null
          })()}
        </Pressable>
      )
    },
    [
      itemWidth,
      theme.colors,
      photoSyncStates,
      selectedPhotos,
      isSelectionMode,
      themed,
      handlePhotoPress,
      enterSelectionMode,
    ],
  )

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
            const showEmpty = allPhotos.length === 0 && !isLoading && !isSyncing
            const showSpinner = isInitialLoading && !showLoadingPlaceholders && displayItems.length === 0

            // Show spinner during initial load before placeholders appear
            if (showSpinner) {
              return (
                <View style={themed($loadingSpinnerContainer)}>
                  <ActivityIndicator size="large" color={theme.colors.primary} />
                  <Text style={themed($loadingSpinnerText)}>Loading gallery...</Text>
                </View>
              )
            }

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
                <Animated.View style={{flex: 1, opacity: fadeAnim}}>
                  <FlatList
                    data={displayItems}
                    numColumns={numColumns}
                    key={numColumns}
                    renderItem={renderPhotoItem}
                    keyExtractor={(item) => item.id}
                    contentContainerStyle={[
                      themed($photoGridContent),
                      {
                        paddingBottom: shouldShowSyncButton
                          ? 100 + insets.bottom + spacing.s6
                          : spacing.s6 + insets.bottom,
                      },
                    ]}
                    columnWrapperStyle={numColumns > 1 ? themed($columnWrapper) : undefined}
                    ItemSeparatorComponent={() => <View style={{height: ITEM_SPACING}} />}
                    initialNumToRender={21}
                    maxToRenderPerBatch={21}
                    windowSize={7}
                    removeClippedSubviews={false}
                    updateCellsBatchingPeriod={50}
                    scrollEventThrottle={16}
                    bounces={false}
                    overScrollMode="never"
                    decelerationRate="fast"
                  />
                </Animated.View>
              )
            }
          })()}
        </View>

        {renderStatusBar()}

        {/* Gallery viewer - direct open (no floating transition) */}
        {selectedPhoto &&
          (() => {
            // Calculate the actual index in the flattened photos array
            // GalleryItem.index includes sync queue offsets, so we need to find the real position
            const flatPhotos = allPhotos.map((item) => item.photo).filter((p): p is PhotoInfo => p !== undefined)
            const actualIndex = flatPhotos.findIndex((p) => p?.name === selectedPhoto.name)

            if (actualIndex === -1) {
              console.error("[GalleryScreen] ❌ Selected photo not found in photos array:", selectedPhoto.name)
              return null
            }

            console.log("[GalleryScreen] 🎬 Rendering MediaViewer with", flatPhotos.length, "photos")
            console.log("[GalleryScreen] 🎬 actualIndex for", selectedPhoto.name, ":", actualIndex)

            return (
              <MediaViewer
                visible={true}
                photo={selectedPhoto}
                photos={flatPhotos}
                initialIndex={actualIndex}
                onClose={() => {
                  console.log("[GalleryScreen] 🎬 MediaViewer closed by user")
                  setSelectedPhoto(null)
                }}
                // onShare={() => selectedPhoto && handleSharePhoto(selectedPhoto)}
              />
            )
          })()}
      </View>
    </>
  )
}

// Styles
const $screenContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  marginHorizontal: -spacing.s6,
})

const $photoGridContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s3, // Add padding on left and right edges
  paddingTop: 0,
})

const $columnWrapper: ThemedStyle<ViewStyle> = () => ({
  justifyContent: "flex-start",
  gap: 2,
})

const $loadingSpinnerContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
})

const $loadingSpinnerText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  color: colors.textDim,
  marginTop: spacing.s4,
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
  borderRadius: 0,
  overflow: "hidden",
  backgroundColor: "rgba(0,0,0,0.05)",
  // No marginBottom needed - ItemSeparatorComponent handles vertical spacing to match horizontal gap
})

const $photoImage: ThemedStyle<ImageStyle> = () => ({
  width: "100%",
  borderRadius: 0,
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
  paddingVertical: spacing.s6,
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
  backgroundColor: colors.primary,
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
