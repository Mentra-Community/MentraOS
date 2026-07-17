import * as RNFS from "@dr.pogodin/react-native-fs"

import {MediaLibraryPermissions} from "../../utils/permissions/MediaLibraryPermissions"
import {BgTimer} from "../../utils/timers"
import {
  cameraRollEntryId,
  cameraRollExportLedger,
  cameraRollGeneration,
  type CameraRollExportEntry,
  type CameraRollExportPriority,
} from "./cameraRollExportLedger"
import {gallerySettingsService} from "./gallerySettingsService"
import {galleryTransferLedger, type GalleryAssetReceipt} from "./galleryTransferLedger"
import {localStorageService, type DownloadedFile} from "./localStorageService"

const TAG = "[CameraRollExport]"
const MIN_FREE_SPACE_BYTES = 100 * 1024 * 1024
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000

export interface CameraRollExportSummary {
  enabled: boolean
  total: number
  exported: number
  pending: number
  failed: number
  blockedPermission: number
  fullAccessRequired: number
  missing: number
  bytesPending: number
  isRunning: boolean
}

type SummaryListener = (summary: CameraRollExportSummary) => void

class CameraRollExportCoordinator {
  private initialized = false
  private initializing: Promise<void> | null = null
  private enabled = true
  private running = false
  private rerunRequested = false
  private retryTimer: number | null = null
  private activeEntryId: string | null = null
  private clearInProgress = false
  private deletingMediaNames = new Set<string>()
  private listeners = new Set<SummaryListener>()
  private sourceWaiters = new Map<
    string,
    Array<{resolve: (receipt: GalleryAssetReceipt) => void; reject: (error: Error) => void}>
  >()

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    if (this.initializing) return this.initializing
    this.initializing = this.initializeInternal().finally(() => {
      this.initializing = null
    })
    return this.initializing
  }

  cleanup(): void {
    if (this.retryTimer != null) BgTimer.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.initialized = false
  }

  private async initializeInternal(): Promise<void> {
    cameraRollExportLedger.setDocumentDirectory(RNFS.DocumentDirectoryPath)
    this.enabled = await gallerySettingsService.getAutoSaveToCameraRoll()
    await this.reconcileLocalIndex()
    this.initialized = true
    this.emitSummary()
    if (this.enabled) void this.resume("startup")
  }

  /** Rebuild missing per-generation records after upgrading from legacy clients. */
  private async reconcileLocalIndex(): Promise<void> {
    const files = await localStorageService.getDownloadedFiles()
    const liveIds = new Set<string>()
    for (const file of Object.values(files)) {
      const id = cameraRollEntryId(file.name, file.size, file.modified)
      liveIds.add(id)
      const current = cameraRollExportLedger.get(id)
      const transfer = file.capture_id
        ? galleryTransferLedger.get(file.capture_id)
        : galleryTransferLedger.get(file.name)
      const receipt = file.assetReceipt || transfer?.assetReceipt || current?.receipt
      const now = Date.now()
      cameraRollExportLedger.put({
        ...(current || {
          id,
          mediaName: file.name,
          generation: cameraRollGeneration(file.name, file.size, file.modified),
          filePath: file.filePath,
          size: file.size,
          modified: file.modified,
          isVideo: file.is_video,
          captureId: file.capture_id || transfer?.captureId,
          priority: "HISTORICAL_BACKFILL" as const,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          state: "LEGACY_UNKNOWN" as const,
        }),
        filePath: file.filePath,
        receipt,
        requiresFullLibraryReconciliation: current?.requiresFullLibraryReconciliation ?? (!current && !receipt),
        state: receipt ? "EXPORTED" : this.nextEligibleState(current?.state),
      })
    }

    // Do not let stale generations recreate media after the user replaced/deleted local files.
    for (const entry of cameraRollExportLedger.list()) {
      if (!liveIds.has(entry.id)) cameraRollExportLedger.remove(entry.id)
    }
  }

  private nextEligibleState(current?: CameraRollExportEntry["state"]): CameraRollExportEntry["state"] {
    if (!this.enabled) return "NOT_REQUESTED"
    if (current === "FAILED_PERMANENT" || current === "MISSING_LOCAL") return current
    return "QUEUED"
  }

  async recordIndexed(
    file: DownloadedFile,
    shouldAutoSave: boolean,
    priority: CameraRollExportPriority = "HISTORICAL_BACKFILL",
    captureId?: string,
  ): Promise<CameraRollExportEntry> {
    await this.initialize()
    const id = cameraRollEntryId(file.name, file.size, file.modified)
    const current = cameraRollExportLedger.get(id)
    const now = Date.now()
    const entry = cameraRollExportLedger.put({
      ...(current || {
        id,
        mediaName: file.name,
        generation: cameraRollGeneration(file.name, file.size, file.modified),
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      }),
      filePath: file.filePath,
      size: file.size,
      modified: file.modified,
      isVideo: file.is_video,
      captureId: captureId || file.capture_id || current?.captureId,
      requiresFullLibraryReconciliation: current?.requiresFullLibraryReconciliation ?? false,
      priority,
      receipt: file.assetReceipt || current?.receipt,
      state: file.assetReceipt || current?.receipt ? "EXPORTED" : shouldAutoSave ? "QUEUED" : "NOT_REQUESTED",
      lastError: undefined,
      nextRetryAt: undefined,
    })
    this.emitSummary()
    return entry
  }

  /** Source deletion waits on this barrier; historical work never blocks a glasses sync. */
  async exportForSource(file: DownloadedFile, captureId?: string): Promise<GalleryAssetReceipt> {
    await this.initialize()
    if (!this.enabled) throw new Error("Automatic camera-roll saving is disabled")
    const entry = await this.recordIndexed(file, true, "SOURCE_BARRIER", captureId)
    if (entry.receipt) return entry.receipt
    return new Promise<GalleryAssetReceipt>((resolve, reject) => {
      const waiters = this.sourceWaiters.get(entry.id) || []
      waiters.push({resolve, reject})
      this.sourceWaiters.set(entry.id, waiters)
      void this.resume("source barrier")
    })
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.initialize()
    const previous = this.enabled
    await gallerySettingsService.setAutoSaveToCameraRoll(enabled)
    try {
      this.enabled = enabled
      if (!enabled && this.retryTimer != null) {
        BgTimer.clearTimeout(this.retryTimer)
        this.retryTimer = null
      }
      for (const entry of cameraRollExportLedger.list()) {
        if (entry.receipt || entry.state === "EXPORTED" || entry.state === "MISSING_LOCAL") continue
        if (!enabled && entry.id !== this.activeEntryId) {
          cameraRollExportLedger.update(entry.id, {state: "NOT_REQUESTED", nextRetryAt: undefined})
          this.rejectSourceWaiters(entry.id, new Error("Automatic camera-roll saving was disabled"))
        } else if (enabled) {
          cameraRollExportLedger.update(entry.id, {state: "QUEUED", nextRetryAt: undefined, lastError: undefined})
        }
      }
    } catch (error) {
      this.enabled = previous
      await gallerySettingsService.setAutoSaveToCameraRoll(previous)
      throw error
    }
    this.emitSummary()
    if (enabled) void this.resume("setting enabled")
  }

  async resume(reason: string): Promise<void> {
    await this.initialize()
    console.log(`${TAG} Resume requested: ${reason}`)
    if (cameraRollExportLedger.list().some((entry) => entry.state === "BLOCKED_PERMISSION")) {
      const hasPermission = await MediaLibraryPermissions.checkPermission()
      const hasLimitedAccess = hasPermission && (await MediaLibraryPermissions.hasLimitedAccess())
      if (hasPermission) {
        for (const entry of cameraRollExportLedger.list()) {
          if (entry.state === "BLOCKED_PERMISSION" && !(entry.requiresFullLibraryReconciliation && hasLimitedAccess)) {
            cameraRollExportLedger.update(entry.id, {state: "QUEUED", lastError: undefined})
          }
        }
      }
    }
    if (this.retryTimer != null) {
      BgTimer.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.running) {
      this.rerunRequested = true
      while (this.running) {
        await new Promise<void>((resolve) => BgTimer.setTimeout(resolve, 25))
      }
      return
    }
    this.running = true
    this.rerunRequested = false
    this.emitSummary()
    try {
      let entry = this.nextEntry()
      while (entry) {
        await this.processEntry(entry)
        entry = this.nextEntry()
      }
    } finally {
      const shouldRerun = this.rerunRequested
      this.rerunRequested = false
      this.running = false
      this.emitSummary()
      this.scheduleRetry()
      if (shouldRerun) void this.resume("work arrived")
    }
  }

  retryNow(): void {
    for (const entry of cameraRollExportLedger.list()) {
      if (entry.state === "FAILED_RETRYABLE" || entry.state === "BLOCKED_PERMISSION") {
        cameraRollExportLedger.update(entry.id, {state: "QUEUED", nextRetryAt: undefined})
      }
    }
    void this.resume("manual retry")
  }

  subscribe(listener: SummaryListener): () => void {
    this.listeners.add(listener)
    listener(this.getSummary())
    return () => this.listeners.delete(listener)
  }

  getSummary(): CameraRollExportSummary {
    const entries = cameraRollExportLedger.list()
    const pendingStates = new Set([
      "LEGACY_UNKNOWN",
      "QUEUED",
      "RECONCILING",
      "EXPORTING",
      "FAILED_RETRYABLE",
      "BLOCKED_PERMISSION",
    ])
    return {
      enabled: this.enabled,
      total: entries.length,
      exported: entries.filter((entry) => entry.state === "EXPORTED").length,
      pending: entries.filter((entry) => pendingStates.has(entry.state)).length,
      failed: entries.filter((entry) => entry.state === "FAILED_RETRYABLE" || entry.state === "FAILED_PERMANENT")
        .length,
      blockedPermission: entries.filter((entry) => entry.state === "BLOCKED_PERMISSION").length,
      fullAccessRequired: entries.filter(
        (entry) => entry.state === "BLOCKED_PERMISSION" && entry.requiresFullLibraryReconciliation,
      ).length,
      missing: entries.filter((entry) => entry.state === "MISSING_LOCAL").length,
      bytesPending: entries
        .filter((entry) => pendingStates.has(entry.state))
        .reduce((sum, entry) => sum + entry.size, 0),
      isRunning: this.running,
    }
  }

  countNotExported(mediaNames: string[]): number {
    const entries = cameraRollExportLedger.list()
    return new Set(mediaNames).size === 0
      ? 0
      : [...new Set(mediaNames)].filter(
          (name) => !entries.some((entry) => entry.mediaName === name && entry.state === "EXPORTED"),
        ).length
  }

  /** Serialize local deletion against an in-flight native copy of the same item. */
  async deleteLocalMedia(mediaName: string): Promise<boolean> {
    this.deletingMediaNames.add(mediaName)
    try {
      while (this.activeEntryId && cameraRollExportLedger.get(this.activeEntryId)?.mediaName === mediaName) {
        await new Promise<void>((resolve) => BgTimer.setTimeout(resolve, 25))
      }
      const deleted = await localStorageService.deleteDownloadedFile(mediaName)
      if (deleted) {
        // An already-running export gets to finish and resolve its source barrier. Queued work
        // cannot start while the name is in deletingMediaNames, so reject only after deletion
        // is confirmed. A failed delete leaves the barrier intact and eligible for retry.
        for (const entry of cameraRollExportLedger.list().filter((candidate) => candidate.mediaName === mediaName)) {
          this.rejectSourceWaiters(entry.id, new Error("Local media was deleted before camera-roll export"))
        }
        cameraRollExportLedger.removeForMedia(mediaName)
      }
      return deleted
    } finally {
      this.deletingMediaNames.delete(mediaName)
      this.emitSummary()
      if (this.enabled) void this.resume("local deletion finished")
    }
  }

  /** Stop scheduling exports, finish the current native copy, then atomically clear app media + receipts. */
  async clearLocalMedia(): Promise<void> {
    this.clearInProgress = true
    try {
      while (this.activeEntryId) {
        await new Promise<void>((resolve) => BgTimer.setTimeout(resolve, 25))
      }
      await localStorageService.clearAllFiles()
      // Let the active native copy deliver its receipt before rejecting queued barriers, and
      // reject them only after the app media clear is confirmed. If clear fails, the durable
      // work and its waiters remain eligible for retry.
      for (const entry of cameraRollExportLedger.list()) {
        this.rejectSourceWaiters(entry.id, new Error("Local media was deleted before camera-roll export"))
      }
      cameraRollExportLedger.clear()
    } finally {
      this.clearInProgress = false
      this.emitSummary()
      if (this.enabled) void this.resume("local clear finished")
    }
  }

  private nextEntry(): CameraRollExportEntry | undefined {
    const now = Date.now()
    return cameraRollExportLedger
      .list()
      .filter((entry) => {
        if (this.clearInProgress || this.deletingMediaNames.has(entry.mediaName)) return false
        if (entry.receipt || entry.state === "EXPORTED" || entry.state === "MISSING_LOCAL") return false
        if (!this.enabled) return false
        if (entry.state === "BLOCKED_PERMISSION" || entry.state === "FAILED_PERMANENT") return false
        if (entry.state === "FAILED_RETRYABLE" && (entry.nextRetryAt || 0) > now) return false
        return entry.state !== "NOT_REQUESTED"
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority === "SOURCE_BARRIER" ? -1 : 1
        return a.modified - b.modified
      })[0]
  }

  private async processEntry(original: CameraRollExportEntry): Promise<void> {
    let entry = original
    this.activeEntryId = entry.id
    try {
      if (!this.enabled) {
        cameraRollExportLedger.update(entry.id, {state: "NOT_REQUESTED", nextRetryAt: undefined})
        this.rejectSourceWaiters(entry.id, new Error("Automatic camera-roll saving was disabled"))
        return
      }
      if (!(await RNFS.exists(entry.filePath))) {
        cameraRollExportLedger.update(entry.id, {state: "MISSING_LOCAL", lastError: "Local media is missing"})
        throw new Error("Local media is missing")
      }
      const permission = await MediaLibraryPermissions.checkPermission()
      if (!permission) {
        cameraRollExportLedger.update(entry.id, {
          state: "BLOCKED_PERMISSION",
          lastError: "Camera-roll permission is required",
        })
        throw new Error("Camera-roll permission is required")
      }
      if (entry.requiresFullLibraryReconciliation && (await MediaLibraryPermissions.hasLimitedAccess())) {
        cameraRollExportLedger.update(entry.id, {
          state: "BLOCKED_PERMISSION",
          lastError: "Full photo-library access is required to reconcile this legacy export safely",
        })
        throw new Error("Full photo-library access is required to reconcile this legacy export safely")
      }
      const fsInfo = await RNFS.getFSInfo()
      if (fsInfo.freeSpace < entry.size + MIN_FREE_SPACE_BYTES) {
        throw new Error("Insufficient free space for camera-roll export")
      }
      // A setting change can land while the filesystem and permission checks are in flight.
      // Once the native save starts it must finish atomically, but do not begin a new save
      // after the user has disabled automatic camera-roll exports.
      if (!this.enabled) {
        cameraRollExportLedger.update(entry.id, {state: "NOT_REQUESTED", nextRetryAt: undefined})
        this.rejectSourceWaiters(entry.id, new Error("Automatic camera-roll saving was disabled"))
        return
      }

      entry = cameraRollExportLedger.update(entry.id, {state: "RECONCILING", lastError: undefined})
      entry = cameraRollExportLedger.update(entry.id, {state: "EXPORTING"})
      const result = await MediaLibraryPermissions.saveToLibraryWithReceipt(entry.filePath, entry.modified)
      if (!result.success) throw new Error(result.error || "Camera-roll export failed")
      const receipt: GalleryAssetReceipt = {
        platform: result.platform,
        uri: result.uri,
        identifier: result.identifier,
        exportedAt: Date.now(),
      }
      entry = cameraRollExportLedger.update(entry.id, {
        state: "EXPORTED",
        receipt,
        requiresFullLibraryReconciliation: false,
        attempts: entry.attempts + 1,
        nextRetryAt: undefined,
        lastError: undefined,
      })
      try {
        await this.mirrorReceipt(entry, receipt)
      } catch (mirrorError) {
        // The per-generation ledger is the authoritative durable receipt. A secondary
        // metadata mirror failure must not cause a duplicate insert or block source ack.
        console.warn(`${TAG} Export receipt mirror failed for ${entry.mediaName}:`, mirrorError)
      }
      this.resolveSourceWaiters(entry.id, receipt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const current = cameraRollExportLedger.get(entry.id)
      if (current && current.state !== "BLOCKED_PERMISSION" && current.state !== "MISSING_LOCAL") {
        const attempts = current.attempts + 1
        cameraRollExportLedger.update(entry.id, {
          state: "FAILED_RETRYABLE",
          attempts,
          lastError: message,
          nextRetryAt: Date.now() + Math.min(2 ** Math.min(attempts, 10) * 1000, MAX_RETRY_DELAY_MS),
        })
      }
      this.rejectSourceWaiters(entry.id, error instanceof Error ? error : new Error(message))
      console.warn(`${TAG} Export remains pending for ${entry.mediaName}: ${message}`)
    } finally {
      if (this.activeEntryId === entry.id) this.activeEntryId = null
      this.emitSummary()
    }
  }

  private async mirrorReceipt(entry: CameraRollExportEntry, receipt: GalleryAssetReceipt): Promise<void> {
    await localStorageService.updateDownloadedFileAssetReceipt(entry.mediaName, receipt)
    const transfer = entry.captureId
      ? galleryTransferLedger.get(entry.captureId)
      : galleryTransferLedger.get(entry.mediaName)
    if (transfer) galleryTransferLedger.update(transfer.captureId, {assetReceipt: receipt})
  }

  private scheduleRetry(): void {
    if (!this.enabled || this.retryTimer != null) return
    const next = cameraRollExportLedger
      .list()
      .filter((entry) => entry.state === "FAILED_RETRYABLE" && entry.nextRetryAt)
      .sort((a, b) => (a.nextRetryAt || 0) - (b.nextRetryAt || 0))[0]
    if (!next?.nextRetryAt) return
    this.retryTimer = BgTimer.setTimeout(
      () => {
        this.retryTimer = null
        void this.resume("retry timer")
      },
      Math.max(0, next.nextRetryAt - Date.now()),
    )
  }

  private resolveSourceWaiters(id: string, receipt: GalleryAssetReceipt): void {
    for (const waiter of this.sourceWaiters.get(id) || []) waiter.resolve(receipt)
    this.sourceWaiters.delete(id)
  }

  private rejectSourceWaiters(id: string, error: Error): void {
    for (const waiter of this.sourceWaiters.get(id) || []) waiter.reject(error)
    this.sourceWaiters.delete(id)
  }

  private emitSummary(): void {
    const summary = this.getSummary()
    for (const listener of this.listeners) {
      try {
        listener(summary)
      } catch (error) {
        console.warn(`${TAG} Summary listener failed`, error)
      }
    }
  }
}

export const cameraRollExportCoordinator = new CameraRollExportCoordinator()
