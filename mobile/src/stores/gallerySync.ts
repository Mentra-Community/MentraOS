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
      const updatedQueue = state.queue.map(file => (file.name === fileName ? updatedFile : file))
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
