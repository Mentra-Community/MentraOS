import {storage} from "../../utils/storage"
import {toPortableGalleryPath} from "./galleryPathMigration"
import type {GalleryAssetReceipt} from "./galleryTransferLedger"

export type CameraRollExportState =
  | "NOT_REQUESTED"
  | "LEGACY_UNKNOWN"
  | "QUEUED"
  | "RECONCILING"
  | "EXPORTING"
  | "EXPORTED"
  | "BLOCKED_PERMISSION"
  | "FAILED_RETRYABLE"
  | "FAILED_PERMANENT"
  | "MISSING_LOCAL"

export type CameraRollExportPriority = "SOURCE_BARRIER" | "HISTORICAL_BACKFILL"

export interface CameraRollExportEntry {
  /** Stable identity for one local-file generation. */
  id: string
  mediaName: string
  generation: string
  filePath: string
  size: number
  modified: number
  isVideo: boolean
  captureId?: string
  /** False while this generation is absent from the local index; exported receipts remain as hidden tombstones. */
  localPresent?: boolean
  /** True when an older client may already have exported this file without persisting a receipt. */
  requiresFullLibraryReconciliation?: boolean
  state: CameraRollExportState
  priority: CameraRollExportPriority
  receipt?: GalleryAssetReceipt
  attempts: number
  nextRetryAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

const ENTRY_PREFIX = "asg_camera_roll_export_v1:"

export function cameraRollGeneration(mediaName: string, size: number, modified: number): string {
  return `${mediaName}:${size}:${modified}`
}

export function cameraRollEntryId(mediaName: string, size: number, modified: number): string {
  return encodeURIComponent(cameraRollGeneration(mediaName, size, modified))
}

class CameraRollExportLedger {
  private runtimeDocumentDirectory = ""

  setDocumentDirectory(path: string): void {
    this.runtimeDocumentDirectory = path
  }

  get(id: string): CameraRollExportEntry | undefined {
    const result = storage.load<CameraRollExportEntry>(`${ENTRY_PREFIX}${id}`)
    if (result.is_error()) return undefined
    return this.toRuntimeEntry(result.value)
  }

  list(): CameraRollExportEntry[] {
    return storage
      .getAllKeys()
      .filter((key) => key.startsWith(ENTRY_PREFIX))
      .map((key) => {
        const result = storage.load<CameraRollExportEntry>(key)
        return result.is_error() ? undefined : this.toRuntimeEntry(result.value)
      })
      .filter((entry): entry is CameraRollExportEntry => !!entry)
  }

  put(entry: CameraRollExportEntry): CameraRollExportEntry {
    const updated = {...entry, updatedAt: Date.now()}
    const result = storage.save(`${ENTRY_PREFIX}${entry.id}`, this.toStoredEntry(updated))
    if (result.is_error()) throw result.error
    return updated
  }

  update(id: string, patch: Partial<CameraRollExportEntry>): CameraRollExportEntry {
    const current = this.get(id)
    if (!current) throw new Error(`Camera-roll export entry missing: ${id}`)
    return this.put({...current, ...patch, id})
  }

  remove(id: string): void {
    const result = storage.remove(`${ENTRY_PREFIX}${id}`)
    if (result.is_error()) throw result.error
  }

  removeForMedia(mediaName: string): void {
    for (const entry of this.list()) {
      if (entry.mediaName === mediaName) this.remove(entry.id)
    }
  }

  clear(): void {
    const keys = storage.getAllKeys().filter((key) => key.startsWith(ENTRY_PREFIX))
    if (keys.length === 0) return
    const result = storage.removeMultiple(keys)
    if (result.is_error()) throw result.error
  }

  private toStoredEntry(entry: CameraRollExportEntry): CameraRollExportEntry {
    if (!this.runtimeDocumentDirectory) return entry
    return {
      ...entry,
      filePath: toPortableGalleryPath(entry.filePath, this.runtimeDocumentDirectory) || entry.filePath,
    }
  }

  private toRuntimeEntry(entry: CameraRollExportEntry): CameraRollExportEntry {
    if (!this.runtimeDocumentDirectory || entry.filePath.startsWith("/")) return entry
    return {...entry, filePath: `${this.runtimeDocumentDirectory}/${entry.filePath}`}
  }
}

export const cameraRollExportLedger = new CameraRollExportLedger()
