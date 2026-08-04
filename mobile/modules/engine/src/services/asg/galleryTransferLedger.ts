import {CaptureGroup} from "../../types/asg"
import {storage} from "../../utils/storage"
import * as RNFS from "@dr.pogodin/react-native-fs"

export type GalleryTransferState =
  | "DISCOVERED"
  | "TRANSFERRING"
  | "VERIFIED"
  | "INDEXED"
  | "EXPORT_PENDING"
  | "EXPORTED"
  | "ACK_PENDING"
  | "TRASHED"
  | "RESTORE_PENDING"
  | "GARBAGE_COLLECTED"

export interface GalleryAssetReceipt {
  platform: "ios" | "android" | "unknown"
  uri?: string
  identifier?: string
  exportedAt: number
}

export interface GalleryLedgerFile {
  name: string
  size: number
  role: "primary" | "bracket" | "sidecar"
  etag?: string
  sha256?: string
  completedSegments: number[]
}

export interface GalleryTransferEntry {
  captureId: string
  state: GalleryTransferState
  protocolVersion: number
  captureType: "photo" | "video"
  timestamp: number
  totalSize: number
  files: GalleryLedgerFile[]
  deleteFromGlasses: string[]
  finalPath?: string
  thumbnailPath?: string
  shouldAutoSave?: boolean
  assetReceipt?: GalleryAssetReceipt
  ackId: string
  retryCount: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

type GalleryTransferLedgerData = {
  version: 1
  entries: Record<string, GalleryTransferEntry>
}

const LEDGER_KEY = "asg_gallery_transfer_ledger_v1"

const STATE_ORDER: Record<GalleryTransferState, number> = {
  DISCOVERED: 0,
  TRANSFERRING: 1,
  VERIFIED: 2,
  INDEXED: 3,
  EXPORT_PENDING: 4,
  EXPORTED: 5,
  ACK_PENDING: 6,
  TRASHED: 7,
  RESTORE_PENDING: 0,
  GARBAGE_COLLECTED: 8,
}

class GalleryTransferLedger {
  private load(): GalleryTransferLedgerData {
    const result = storage.load<GalleryTransferLedgerData>(LEDGER_KEY)
    if (result.is_error() || result.value?.version !== 1) {
      return {version: 1, entries: {}}
    }
    return {
      ...result.value,
      entries: Object.fromEntries(
        Object.entries(result.value.entries).map(([id, entry]) => [
          id,
          {
            ...entry,
            finalPath: entry.finalPath ? this.toRuntimePath(entry.finalPath) : undefined,
            thumbnailPath: entry.thumbnailPath ? this.toRuntimePath(entry.thumbnailPath) : undefined,
          },
        ]),
      ),
    }
  }

  private save(data: GalleryTransferLedgerData): void {
    const portableData: GalleryTransferLedgerData = {
      ...data,
      entries: Object.fromEntries(
        Object.entries(data.entries).map(([id, entry]) => [
          id,
          {
            ...entry,
            finalPath: entry.finalPath ? this.toStoredPath(entry.finalPath) : undefined,
            thumbnailPath: entry.thumbnailPath ? this.toStoredPath(entry.thumbnailPath) : undefined,
          },
        ]),
      ),
    }
    const result = storage.save(LEDGER_KEY, portableData)
    if (result.is_error()) {
      throw result.error
    }
  }

  ensureCapture(capture: CaptureGroup, protocolVersion: number): GalleryTransferEntry {
    const data = this.load()
    const existing = data.entries[capture.capture_id]
    const now = Date.now()
    const incomingFiles = capture.files.map((file) => {
      const previous = existing?.files.find((candidate) => candidate.name === file.name)
      const sameGeneration =
        previous &&
        previous.size === file.size &&
        ((!file.etag && !previous.etag) || (!!file.etag && !!previous.etag && previous.etag === file.etag))
      return {
        name: file.name,
        size: file.size,
        role: file.role,
        etag: file.etag,
        sha256: file.sha256,
        completedSegments: sameGeneration ? previous.completedSegments || [] : [],
      }
    })

    const generationChanged =
      !!existing &&
      (existing.totalSize !== capture.total_size ||
        existing.files.length !== incomingFiles.length ||
        incomingFiles.some((file) => {
          const previous = existing.files.find((candidate) => candidate.name === file.name)
          return !previous || file.size !== previous.size || file.role !== previous.role || file.etag !== previous.etag
        }))

    const entry: GalleryTransferEntry = {
      ...(existing || {
        captureId: capture.capture_id,
        state: "DISCOVERED" as const,
        ackId: `${capture.capture_id}-${now}-${Math.random().toString(36).slice(2, 10)}`,
        retryCount: 0,
        createdAt: now,
      }),
      protocolVersion,
      captureType: capture.type,
      timestamp: capture.timestamp,
      totalSize: capture.total_size,
      files: incomingFiles,
      deleteFromGlasses: capture.files.map((file) => file.name),
      state: generationChanged ? "DISCOVERED" : existing?.state || "DISCOVERED",
      ackId: generationChanged
        ? `${capture.capture_id}-${now}-${Math.random().toString(36).slice(2, 10)}`
        : existing?.ackId || `${capture.capture_id}-${now}-${Math.random().toString(36).slice(2, 10)}`,
      retryCount: generationChanged ? 0 : existing?.retryCount || 0,
      updatedAt: now,
    }
    if (generationChanged) {
      delete entry.finalPath
      delete entry.thumbnailPath
      delete entry.assetReceipt
      delete entry.lastError
    }
    data.entries[capture.capture_id] = entry
    this.save(data)
    return entry
  }

  get(captureId: string): GalleryTransferEntry | undefined {
    return this.load().entries[captureId]
  }

  list(): GalleryTransferEntry[] {
    return Object.values(this.load().entries)
  }

  update(captureId: string, patch: Partial<GalleryTransferEntry>): GalleryTransferEntry {
    const data = this.load()
    const existing = data.entries[captureId]
    if (!existing) {
      throw new Error(`Gallery transfer ledger entry missing: ${captureId}`)
    }
    const updated = {...existing, ...patch, captureId, updatedAt: Date.now()}
    data.entries[captureId] = updated
    this.save(data)
    return updated
  }

  transition(
    captureId: string,
    state: GalleryTransferState,
    patch: Partial<GalleryTransferEntry> = {},
  ): GalleryTransferEntry {
    return this.update(captureId, {...patch, state})
  }

  markSegmentComplete(captureId: string, fileName: string, segmentIndex: number): void {
    const data = this.load()
    const entry = data.entries[captureId]
    if (!entry) throw new Error(`Gallery transfer ledger entry missing: ${captureId}`)
    entry.files = entry.files.map((file) =>
      file.name === fileName
        ? {...file, completedSegments: [...new Set([...file.completedSegments, segmentIndex])].sort((a, b) => a - b)}
        : file,
    )
    entry.state = "TRANSFERRING"
    entry.updatedAt = Date.now()
    data.entries[captureId] = entry
    this.save(data)
  }

  markFileHash(captureId: string, fileName: string, sha256: string): void {
    const data = this.load()
    const entry = data.entries[captureId]
    if (!entry) throw new Error(`Gallery transfer ledger entry missing: ${captureId}`)
    entry.files = entry.files.map((file) => (file.name === fileName ? {...file, sha256} : file))
    entry.updatedAt = Date.now()
    this.save(data)
  }

  recordFailure(captureId: string, error: unknown): void {
    const entry = this.get(captureId)
    if (!entry) return
    this.update(captureId, {
      retryCount: entry.retryCount + 1,
      lastError: error instanceof Error ? error.message : String(error),
    })
  }

  isLocallyCommitted(captureId: string): boolean {
    const entry = this.get(captureId)
    return !!entry && entry.state !== "RESTORE_PENDING" && STATE_ORDER[entry.state] >= STATE_ORDER.INDEXED
  }

  isFileLocallyCommitted(fileName: string): boolean {
    return this.list().some(
      (entry) => entry.deleteFromGlasses.includes(fileName) && STATE_ORDER[entry.state] >= STATE_ORDER.INDEXED,
    )
  }

  pendingRecovery(): GalleryTransferEntry[] {
    return this.list().filter(
      (entry) =>
        entry.state === "INDEXED" ||
        entry.state === "EXPORT_PENDING" ||
        entry.state === "EXPORTED" ||
        entry.state === "ACK_PENDING" ||
        entry.state === "RESTORE_PENDING",
    )
  }

  hasPendingRecovery(): boolean {
    return this.pendingRecovery().length > 0
  }

  releaseMissingLocalCommit(captureId: string, recoverAcknowledged: boolean = false): void {
    const entry = this.get(captureId)
    if (!entry) return
    if (entry.state === "TRASHED" || entry.state === "GARBAGE_COLLECTED") {
      if (recoverAcknowledged) {
        this.update(captureId, {
          state: "RESTORE_PENDING",
          finalPath: undefined,
          thumbnailPath: undefined,
          assetReceipt: undefined,
          lastError: "Committed local media is missing; source restore is pending",
          files: entry.files.map((file) => ({...file, completedSegments: []})),
        })
      }
      return
    }
    this.update(captureId, {
      state: "DISCOVERED",
      finalPath: undefined,
      thumbnailPath: undefined,
      assetReceipt: undefined,
      lastError: "Local media was removed before source acknowledgement",
      files: entry.files.map((file) => ({...file, completedSegments: []})),
    })
  }

  releaseAllMissingLocalCommits(recoverAcknowledged: boolean = false): void {
    for (const entry of this.list()) {
      this.releaseMissingLocalCommit(entry.captureId, recoverAcknowledged)
    }
  }

  private toStoredPath(path: string): string {
    const cleanPath = path.replace(/^file:\/\//, "")
    const documentsPath = RNFS.DocumentDirectoryPath?.replace(/\/$/, "")
    if (!documentsPath) return cleanPath
    return cleanPath.startsWith(`${documentsPath}/`) ? cleanPath.substring(documentsPath.length + 1) : cleanPath
  }

  private toRuntimePath(path: string): string {
    if (!RNFS.DocumentDirectoryPath) return path
    if (path.startsWith("/")) {
      const marker = "/Documents/"
      const index = path.indexOf(marker)
      return index >= 0 ? `${RNFS.DocumentDirectoryPath}/${path.substring(index + marker.length)}` : path
    }
    return `${RNFS.DocumentDirectoryPath}/${path}`
  }
}

export const galleryTransferLedger = new GalleryTransferLedger()
