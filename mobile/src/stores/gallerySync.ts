/**
 * Gallery Sync Store
 * Manages gallery sync state independently of UI lifecycle
 */

import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

import {PhotoInfo} from "@/types/asg"

// Sync state machine states
export type SyncState =
  | "idle"
  | "requesting_hotspot"
  | "connecting_wifi"
  | "syncing"
  | "complete"
  | "error"
  | "cancelled"

export interface HotspotInfo {
  ssid: string
  password: string
  ip: string
}

export interface SyncQueue {
  files: PhotoInfo[]
  currentIndex: number
  startedAt: number
  hotspotInfo: HotspotInfo
}

export interface GallerySyncInfo {
  // State machine
  syncState: SyncState

  // Progress tracking
  currentFile: string | null
  currentFileProgress: number // 0-100
  completedFiles: number
  totalFiles: number
  failedFiles: string[]

  // Queue (persisted separately via localStorageService)
  queue: PhotoInfo[]
  queueIndex: number

  // Hotspot info
  hotspotInfo: HotspotInfo | null
  syncServiceOpenedHotspot: boolean

  // Gallery status from glasses
  glassesPhotoCount: number
  glassesVideoCount: number
  glassesTotalCount: number
  glassesHasContent: boolean

  // Cloud sync state
  cloudPendingCount: number
  cloudPendingBytes: number
  cloudSyncActive: boolean
  cloudSyncComplete: boolean
  cloudSyncError: string | null
  lastCloudPollTime: number | null
  cloudCurrentFile: number
  cloudTotalFiles: number
  cloudCurrentFileName: string | null
  cloudCompletedFiles: number
  cloudFileProgress: Map<string, number> // Track progress per file (filename -> progress 0-100)
  cloudDownloadingItems: Array<{filename: string; capturedAt: number; mimeType: string; is_video: boolean}> // Items currently being downloaded (for preview)

  // Error tracking
  lastError: string | null
}

interface GallerySyncState extends GallerySyncInfo {
  // State transitions
  setSyncState: (state: SyncState) => void
  setRequestingHotspot: () => void
  setConnectingWifi: () => void
  setSyncing: (files: PhotoInfo[]) => void
  setSyncComplete: () => void
  setSyncError: (error: string) => void
  setSyncCancelled: () => void

  // Progress updates
  setCurrentFile: (fileName: string | null, progress: number) => void
  onFileProgress: (fileName: string, progress: number) => void
  onFileComplete: (fileName: string) => void
  onFileFailed: (fileName: string, error?: string) => void
  updateFileInQueue: (fileName: string, updatedFile: PhotoInfo) => void

  // Hotspot management
  setHotspotInfo: (info: HotspotInfo | null) => void
  setSyncServiceOpenedHotspot: (opened: boolean) => void

  // Gallery status from glasses
  setGlassesGalleryStatus: (photos: number, videos: number, total: number, hasContent: boolean) => void
  clearGlassesGalleryStatus: () => void

  // Cloud sync management
  setCloudPending: (count: number, bytes: number) => void
  setCloudSyncActive: (active: boolean) => void
  setCloudSyncComplete: (complete: boolean) => void
  setCloudSyncError: (error: string | null) => void
  setLastCloudPollTime: (time: number) => void
  setCloudProgress: (current: number, total: number, fileName?: string | null) => void
  setCloudFileProgress: (fileName: string, progress: number) => void
  onCloudFileComplete: (fileName: string) => void
  clearCloudFileProgress: () => void
  setCloudDownloadingItems: (
    items: Array<{filename: string; capturedAt: number; mimeType: string; is_video: boolean}>,
  ) => void

  // Queue management (for resume)
  setQueue: (files: PhotoInfo[], startIndex?: number) => void
  advanceQueue: () => void
  clearQueue: () => void

  // Full reset
  reset: () => void
}

const initialState: GallerySyncInfo = {
  syncState: "idle",
  currentFile: null,
  currentFileProgress: 0,
  completedFiles: 0,
  totalFiles: 0,
  failedFiles: [],
  queue: [],
  queueIndex: 0,
  hotspotInfo: null,
  syncServiceOpenedHotspot: false,
  glassesPhotoCount: 0,
  glassesVideoCount: 0,
  glassesTotalCount: 0,
  glassesHasContent: false,
  cloudPendingCount: 0,
  cloudPendingBytes: 0,
  cloudSyncActive: false,
  cloudSyncComplete: false,
  cloudSyncError: null,
  lastCloudPollTime: null,
  cloudCurrentFile: 0,
  cloudTotalFiles: 0,
  cloudCurrentFileName: null,
  cloudCompletedFiles: 0,
  cloudFileProgress: new Map<string, number>(),
  cloudDownloadingItems: [],
  lastError: null,
}

export const useGallerySyncStore = create<GallerySyncState>()(
  subscribeWithSelector((set, get) => ({
    ...initialState,

    // State transitions
    setSyncState: (syncState: SyncState) => set({syncState}),

    setRequestingHotspot: () =>
      set({
        syncState: "requesting_hotspot",
        lastError: null,
        failedFiles: [],
      }),

    setConnectingWifi: () =>
      set({
        syncState: "connecting_wifi",
      }),

    setSyncing: (files: PhotoInfo[]) =>
      set({
        syncState: "syncing",
        queue: files,
        queueIndex: 0,
        totalFiles: files.length,
        completedFiles: 0,
        currentFile: files.length > 0 ? files[0].name : null,
        currentFileProgress: 0,
        failedFiles: [],
        lastError: null,
      }),

    setSyncComplete: () =>
      set({
        syncState: "complete",
        currentFile: null,
        currentFileProgress: 0,
        // Keep queue intact so photos remain visible after sync
        // Don't clear: queue: [], queueIndex: 0
      }),

    setSyncError: (error: string) =>
      set({
        syncState: "error",
        lastError: error,
        currentFile: null,
        currentFileProgress: 0,
      }),

    setSyncCancelled: () =>
      set({
        syncState: "cancelled",
        currentFile: null,
        currentFileProgress: 0,
        queue: [],
        queueIndex: 0,
      }),

    // Progress updates
    setCurrentFile: (fileName: string | null, progress: number) =>
      set({
        currentFile: fileName,
        currentFileProgress: Math.max(0, Math.min(100, progress)),
      }),

    onFileProgress: (fileName: string, progress: number) =>
      set({
        currentFile: fileName,
        currentFileProgress: Math.max(0, Math.min(100, progress)),
      }),

    onFileComplete: (_fileName: string) => {
      const state = get()
      const newCompletedFiles = state.completedFiles + 1
      const newQueueIndex = state.queueIndex + 1
      const nextFile = state.queue[newQueueIndex]

      set({
        completedFiles: newCompletedFiles,
        queueIndex: newQueueIndex,
        currentFile: nextFile?.name || null,
        currentFileProgress: 0,
      })
    },

    onFileFailed: (fileName: string, _error?: string) => {
      const state = get()
      const newQueueIndex = state.queueIndex + 1
      const nextFile = state.queue[newQueueIndex]

      set({
        failedFiles: [...state.failedFiles, fileName],
        queueIndex: newQueueIndex,
        currentFile: nextFile?.name || null,
        currentFileProgress: 0,
      })
    },

    updateFileInQueue: (fileName: string, updatedFile: PhotoInfo) => {
      const state = get()
      const updatedQueue = state.queue.map((file) => (file.name === fileName ? updatedFile : file))
      set({queue: updatedQueue})
    },

    // Hotspot management
    setHotspotInfo: (info: HotspotInfo | null) => set({hotspotInfo: info}),

    setSyncServiceOpenedHotspot: (opened: boolean) => set({syncServiceOpenedHotspot: opened}),

    // Gallery status from glasses
    setGlassesGalleryStatus: (photos: number, videos: number, total: number, hasContent: boolean) => {
      const state = get()
      // Reset to idle if sync is in a terminal state and new content is available
      // This allows syncing again after taking new photos
      const shouldResetToIdle =
        hasContent && (state.syncState === "complete" || state.syncState === "error" || state.syncState === "cancelled")

      set({
        glassesPhotoCount: photos,
        glassesVideoCount: videos,
        glassesTotalCount: total,
        glassesHasContent: hasContent,
        ...(shouldResetToIdle ? {syncState: "idle" as SyncState} : {}),
      })
    },

    clearGlassesGalleryStatus: () =>
      set({
        glassesPhotoCount: 0,
        glassesVideoCount: 0,
        glassesTotalCount: 0,
        glassesHasContent: false,
      }),

    // Cloud sync management
    setCloudPending: (count: number, bytes: number) =>
      set({
        cloudPendingCount: count,
        cloudPendingBytes: bytes,
      }),

    setCloudSyncActive: (active: boolean) =>
      set({
        cloudSyncActive: active,
        cloudSyncComplete: false, // Reset complete state when starting new download
        ...(active === false ? {cloudCurrentFile: 0, cloudTotalFiles: 0, cloudCurrentFileName: null} : {}), // Reset progress when stopping
      }),

    setCloudSyncComplete: (complete: boolean) =>
      set({
        cloudSyncComplete: complete,
      }),

    setCloudSyncError: (error: string | null) =>
      set({
        cloudSyncError: error,
      }),

    setLastCloudPollTime: (time: number) =>
      set({
        lastCloudPollTime: time,
      }),

    setCloudProgress: (current: number, total: number, fileName?: string | null) =>
      set({
        cloudCurrentFile: current,
        cloudTotalFiles: total,
        cloudCurrentFileName: fileName ?? null,
      }),

    setCloudFileProgress: (fileName: string, progress: number) =>
      set((state) => {
        const newProgress = new Map(state.cloudFileProgress)
        if (progress >= 100) {
          // Remove when complete (like normal sync)
          newProgress.delete(fileName)
        } else {
          newProgress.set(fileName, progress)
        }
        return {cloudFileProgress: newProgress}
      }),

    onCloudFileComplete: (fileName: string) => {
      const state = get()
      const nextCompletedFiles = state.cloudCompletedFiles + 1
      // Find next file to download
      const currentIndex = state.cloudDownloadingItems.findIndex((item) => item.filename === fileName)
      const nextItem =
        currentIndex >= 0 && currentIndex < state.cloudDownloadingItems.length - 1
          ? state.cloudDownloadingItems[currentIndex + 1]
          : null

      set({
        cloudCompletedFiles: nextCompletedFiles,
        cloudCurrentFileName: nextItem?.filename ?? null,
        cloudCurrentFile: nextCompletedFiles + 1, // For display: "Downloading X of Y"
      })
    },

    clearCloudFileProgress: () => set({cloudFileProgress: new Map<string, number>()}),

    setCloudDownloadingItems: (
      items: Array<{filename: string; capturedAt: number; mimeType: string; is_video: boolean}>,
    ) => set({cloudDownloadingItems: items}),

    // Queue management
    setQueue: (files: PhotoInfo[], startIndex: number = 0) =>
      set({
        queue: files,
        queueIndex: startIndex,
        totalFiles: files.length,
        completedFiles: startIndex,
      }),

    advanceQueue: () => {
      const state = get()
      set({queueIndex: state.queueIndex + 1})
    },

    clearQueue: () =>
      set({
        queue: [],
        queueIndex: 0,
        totalFiles: 0,
        completedFiles: 0,
      }),

    // Full reset
    reset: () => set(initialState),
  })),
)

// Selector helpers for common subscriptions
export const selectSyncProgress = (state: GallerySyncState) => ({
  syncState: state.syncState,
  currentFile: state.currentFile,
  currentFileProgress: state.currentFileProgress,
  completedFiles: state.completedFiles,
  totalFiles: state.totalFiles,
  failedFiles: state.failedFiles,
})

export const selectIssyncing = (state: GallerySyncState) =>
  state.syncState === "syncing" || state.syncState === "requesting_hotspot" || state.syncState === "connecting_wifi"

export const selectGlassesGalleryStatus = (state: GallerySyncState) => ({
  photos: state.glassesPhotoCount,
  videos: state.glassesVideoCount,
  total: state.glassesTotalCount,
  hasContent: state.glassesHasContent,
})
