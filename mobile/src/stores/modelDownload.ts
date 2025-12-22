/**
 * Model Download Store
 * Manages STT model download state independently of UI lifecycle
 */

import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

// Download state machine states
export type DownloadState = "idle" | "downloading" | "extracting" | "activating" | "complete" | "error" | "cancelled"

export interface ModelDownloadInfo {
  // State machine
  downloadState: DownloadState

  // Current download info
  modelId: string | null
  modelDisplayName: string | null

  // Progress tracking
  downloadProgress: number // 0-100
  extractionProgress: number // 0-100

  // Error tracking
  lastError: string | null

  // Last successful download (for UI feedback)
  lastDownloadedModelId: string | null
}

interface ModelDownloadState extends ModelDownloadInfo {
  // State transitions
  setDownloading: (modelId: string, displayName: string) => void
  setDownloadProgress: (progress: number) => void
  setExtracting: () => void
  setExtractionProgress: (progress: number) => void
  setActivating: () => void
  setComplete: () => void
  setError: (error: string) => void
  setCancelled: () => void
  reset: () => void
}

const initialState: ModelDownloadInfo = {
  downloadState: "idle",
  modelId: null,
  modelDisplayName: null,
  downloadProgress: 0,
  extractionProgress: 0,
  lastError: null,
  lastDownloadedModelId: null,
}

export const useModelDownloadStore = create<ModelDownloadState>()(
  subscribeWithSelector((set, get) => ({
    ...initialState,

    setDownloading: (modelId: string, displayName: string) =>
      set({
        downloadState: "downloading",
        modelId,
        modelDisplayName: displayName,
        downloadProgress: 0,
        extractionProgress: 0,
        lastError: null,
      }),

    setDownloadProgress: (progress: number) =>
      set({
        downloadProgress: Math.max(0, Math.min(100, progress)),
      }),

    setExtracting: () =>
      set({
        downloadState: "extracting",
        downloadProgress: 100,
        extractionProgress: 0,
      }),

    setExtractionProgress: (progress: number) =>
      set({
        extractionProgress: Math.max(0, Math.min(100, progress)),
      }),

    setActivating: () =>
      set({
        downloadState: "activating",
        extractionProgress: 100,
      }),

    setComplete: () => {
      const state = get()
      set({
        downloadState: "complete",
        lastDownloadedModelId: state.modelId,
      })
    },

    setError: (error: string) =>
      set({
        downloadState: "error",
        lastError: error,
      }),

    setCancelled: () =>
      set({
        downloadState: "cancelled",
        downloadProgress: 0,
        extractionProgress: 0,
      }),

    reset: () => set(initialState),
  })),
)

// Selector helpers
export const selectIsDownloading = (state: ModelDownloadState) =>
  state.downloadState === "downloading" || state.downloadState === "extracting" || state.downloadState === "activating"

export const selectDownloadProgress = (state: ModelDownloadState) => ({
  downloadState: state.downloadState,
  downloadProgress: state.downloadProgress,
  extractionProgress: state.extractionProgress,
  modelId: state.modelId,
  modelDisplayName: state.modelDisplayName,
})

export const selectCanStartDownload = (state: ModelDownloadState) =>
  state.downloadState === "idle" ||
  state.downloadState === "complete" ||
  state.downloadState === "error" ||
  state.downloadState === "cancelled"
