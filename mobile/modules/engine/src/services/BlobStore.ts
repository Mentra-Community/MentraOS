/**
 * BlobStore
 *
 * Host-side implementation of `session.blob` — persistent, per-(userId,
 * packageName) BINARY storage for local miniapps, keyed like SimpleStorage (its
 * small-string sibling). Extracted from LocalMiniappRuntime the same way
 * NavigationHandlers is, to keep the runtime file small.
 *
 * Generic byte store — it knows nothing about any specific format. Highlights:
 *   - chunked write/read (BLOB_CREATE/WRITE/COMMIT, BLOB_OPEN_READ/READ) so no
 *     single bridge message is large;
 *   - `setFromUrl` downloads a URL straight to disk (File.downloadFileAsync) and
 *     `importFile` runs the OS picker (File.pickFileAsync) — both keep bytes
 *     entirely host-side;
 *   - `share` hands a stored file to the OS share sheet.
 *
 * Layout (mirrors SimpleStorage's scoping):
 *   bytes:    Paths.document/mentra_blobs/{userId}/{packageName}/{fileName}
 *   metadata: MMKV key  mentraos_blobmeta_{userId}_{packageName}_{key}  → StoredBlobMeta JSON
 *
 * The on-disk file name is a generated id plus a mime-derived extension (iOS
 * AVPlayer keys a local file's format off the path extension, so blobs played
 * via `session.speaker.play` must carry one); the logical `key` (caller-chosen)
 * is the MMKV key. This decouples the filesystem from arbitrary caller keys.
 *
 * expo-file-system's new API is synchronous (create/writeBytes/md5/size), so
 * streaming chunk writes do no async work.
 */

import {Buffer} from "buffer"
import Share from "react-native-share"
import {Directory, File, Paths, type FileHandle} from "expo-file-system"

import {MiniappErrorCode} from "@mentra/miniapp"
import {storage as mmkvStorage} from "../utils/storage/storage"
import {sanitizeSegment, shareFileName, withDiskExt} from "./blobPaths"

const LOG_TAG = "LocalMiniappRuntime"

/** Per-app blob quota: 1 GB. */
export const BLOB_QUOTA_BYTES = 1024 * 1024 * 1024
const ROOT_DIR_NAME = "mentra_blobs"
/** Cache dir root holding short-lived, properly-named copies handed to the OS share sheet (one unique subdir per share). */
const SHARE_DIR_NAME = "mentra_blob_share"
/**
 * Keep successful share handoffs alive long enough for recipient apps to read
 * them asynchronously (for example, an email composer attaching the file).
 * Stale copies are collected before the next share; the OS may evict cache
 * files sooner under storage pressure.
 */
const SHARE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const META_KEY_ROOT = "mentraos_blobmeta_"
/** Cap md5 computation so we don't block the JS thread hashing a huge file. */
const MD5_MAX_BYTES = 50 * 1024 * 1024

// Matches LocalMiniappRuntime.sendResult (see NavigationHandlers).
type SendResult = (
  packageName: string,
  requestId: string | undefined,
  ok: boolean,
  result?: unknown,
  error?: {code: MiniappErrorCode; message: string},
) => void

export interface BlobStoreHooks {
  sendResult: SendResult
  /** Resolve the current user id (same source SimpleStorage uses). */
  getUserId: () => string
}

interface StoredBlobMeta {
  key: string
  fileName: string
  name?: string
  mimeType: string
  bytes: number
  createdAt: number
  updatedAt: number
  md5?: string
  meta?: Record<string, string | number | boolean>
}

interface ActiveUpload {
  packageName: string
  key: string
  fileName: string
  partFile: File
  handle: FileHandle
  bytes: number
  /** Bytes already committed under this key (overwrite target) — excluded from the quota check. */
  priorBytes: number
  name?: string
  mimeType: string
  meta?: Record<string, string | number | boolean>
  createdAt: number
}

interface ActiveReader {
  packageName: string
  handle: FileHandle
  remaining: number
}

export class BlobStore {
  private readonly uploads = new Map<string, ActiveUpload>() // key: `${pkg} ${key}`
  private readonly readers = new Map<string, ActiveReader>() // key: host handle id
  /** user + package → committed usage bytes, cached; invalidated on commit/delete/clear. */
  private readonly usageCache = new Map<string, number>()

  constructor(private readonly hooks: BlobStoreHooks) {}

  // ---- path / meta helpers -------------------------------------------------

  private currentIdentity(packageName: string): {userId: string; scope: string} {
    const userId = this.hooks.getUserId().trim()
    if (!userId) throw new Error("Mentra user identity is unavailable")
    const scope = `${userId}\0${packageName}`
    return {userId, scope}
  }

  private dirFor(packageName: string): Directory {
    const dir = new Directory(
      Paths.document,
      ROOT_DIR_NAME,
      sanitizeSegment(this.currentIdentity(packageName).userId),
      sanitizeSegment(packageName),
    )
    if (!dir.exists) dir.create({intermediates: true})
    return dir
  }

  private metaPrefix(packageName: string): string {
    return `${META_KEY_ROOT}${sanitizeSegment(this.currentIdentity(packageName).userId)}_${packageName}_`
  }

  private metaKey(packageName: string, key: string): string {
    return this.metaPrefix(packageName) + key
  }

  private uploadKey(packageName: string, key: string): string {
    return `${packageName} ${key}`
  }

  private readMeta(packageName: string, key: string): StoredBlobMeta | null {
    const r = mmkvStorage.load<StoredBlobMeta>(this.metaKey(packageName, key))
    return r.is_ok() ? r.value : null
  }

  private writeMeta(packageName: string, meta: StoredBlobMeta): void {
    mmkvStorage.save(this.metaKey(packageName, meta.key), meta)
  }

  private allMeta(packageName: string): StoredBlobMeta[] {
    const prefix = this.metaPrefix(packageName)
    const out: StoredBlobMeta[] = []
    for (const k of mmkvStorage.getAllKeys()) {
      if (!k.startsWith(prefix)) continue
      const r = mmkvStorage.load<StoredBlobMeta>(k)
      if (r.is_ok() && r.value) out.push(r.value)
    }
    return out
  }

  private fileFor(packageName: string, fileName: string): File {
    return new File(this.dirFor(packageName), fileName)
  }

  /** Public API shape: stored meta + derived file:// uri. */
  private toBlobMeta(packageName: string, m: StoredBlobMeta) {
    return {
      key: m.key,
      name: m.name,
      mimeType: m.mimeType,
      bytes: m.bytes,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      md5: m.md5,
      uri: this.fileFor(packageName, m.fileName).uri,
      meta: m.meta,
    }
  }

  private committedUsage(packageName: string): number {
    const {scope} = this.currentIdentity(packageName)
    const cached = this.usageCache.get(scope)
    if (cached !== undefined) return cached
    let total = 0
    for (const m of this.allMeta(packageName)) total += m.bytes || 0
    this.usageCache.set(scope, total)
    return total
  }

  private bumpUsage(packageName: string, delta: number): void {
    const {scope} = this.currentIdentity(packageName)
    const cur = this.usageCache.get(scope)
    if (cur !== undefined) this.usageCache.set(scope, Math.max(0, cur + delta))
  }

  private safeMd5(file: File, bytes: number): string | undefined {
    if (bytes > MD5_MAX_BYTES) return undefined
    try {
      return file.md5 ?? undefined
    } catch {
      return undefined
    }
  }

  private makeId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random()
      .toString(36)
      .slice(2, 6)}`
  }

  /** Would storing `incoming` bytes under `key` exceed the per-app quota? */
  private overQuota(packageName: string, key: string, incoming: number): boolean {
    const priorBytes = this.readMeta(packageName, key)?.bytes ?? 0
    return this.committedUsage(packageName) - priorBytes + incoming > BLOB_QUOTA_BYTES
  }

  /** Publish a file already sitting at `fileName` as the blob for `key`; returns its public meta. */
  private commitFile(
    packageName: string,
    key: string,
    fileName: string,
    mimeType: string,
    name: string | undefined,
    extraMeta: Record<string, string | number | boolean> | undefined,
  ) {
    // Attach a mime-derived extension to the on-disk name. Consumers that key
    // format off the path — iOS AVPlayer under `session.speaker.play` — cannot
    // open an extension-less file, even though the bytes are valid.
    const named = withDiskExt(fileName, mimeType)
    if (named !== fileName) {
      try {
        this.fileFor(packageName, fileName).rename(named)
        fileName = named
      } catch {
        /* keep the extension-less name — the blob still stores and shares fine */
      }
    }
    const prior = this.readMeta(packageName, key)
    if (prior && prior.fileName !== fileName) {
      this.deleteFileQuiet(packageName, prior.fileName)
      this.bumpUsage(packageName, -(prior.bytes || 0))
    }
    const finalFile = this.fileFor(packageName, fileName)
    const bytes = finalFile.size ?? 0
    const now = Date.now()
    const meta: StoredBlobMeta = {
      key,
      fileName,
      name,
      mimeType,
      bytes,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      md5: this.safeMd5(finalFile, bytes),
      meta: extraMeta,
    }
    this.writeMeta(packageName, meta)
    this.bumpUsage(packageName, bytes)
    return this.toBlobMeta(packageName, meta)
  }

  // ---- streaming write -----------------------------------------------------

  handleCreate(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    try {
      const key = (typeof payload.key === "string" && payload.key) || this.makeId()
      const mapKey = this.uploadKey(packageName, key)
      const existing = this.uploads.get(mapKey)
      if (existing) this.discardUpload(existing)

      const fileName = this.makeId()
      const partFile = this.fileFor(packageName, fileName + ".part")
      partFile.create({intermediates: true, overwrite: true})
      const handle = partFile.open()

      this.uploads.set(mapKey, {
        packageName,
        key,
        fileName,
        partFile,
        handle,
        bytes: 0,
        priorBytes: this.readMeta(packageName, key)?.bytes ?? 0,
        name: typeof payload.name === "string" ? payload.name : undefined,
        mimeType: typeof payload.mimeType === "string" ? payload.mimeType : "application/octet-stream",
        meta: (payload.meta as Record<string, string | number | boolean>) ?? undefined,
        createdAt: Date.now(),
      })
      this.hooks.sendResult(packageName, requestId, true, {key})
    } catch (err) {
      this.fail(packageName, requestId, MiniappErrorCode.BLOB_WRITE_FAILED, err)
    }
  }

  handleWrite(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const key = payload.key as string
    const up = this.uploads.get(this.uploadKey(packageName, key))
    if (!up) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_HANDLE_INVALID,
        message: `No open blob writer for key ${key}`,
      })
      return
    }
    try {
      const chunk = Buffer.from((payload.base64 as string) ?? "", "base64")
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      // A seek write (offset present) patches existing bytes in place — used to
      // rewrite a container header on finalize; it does not grow the blob.
      if (typeof payload.offset === "number") {
        if (payload.offset < 0 || payload.offset + bytes.length > up.bytes) {
          this.hooks.sendResult(packageName, requestId, false, undefined, {
            code: MiniappErrorCode.BLOB_WRITE_FAILED,
            message: "writeAt offset out of range (must stay within written bytes)",
          })
          return
        }
        up.handle.offset = payload.offset
        up.handle.writeBytes(bytes)
        up.handle.offset = up.bytes // restore append position
        this.hooks.sendResult(packageName, requestId, true, {bytesWritten: up.bytes})
        return
      }
      // Exclude the prior blob under this key — it's freed on commit (overwrite).
      if (this.committedUsage(packageName) - up.priorBytes + up.bytes + bytes.length > BLOB_QUOTA_BYTES) {
        this.hooks.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.BLOB_QUOTA_EXCEEDED,
          message: `Blob quota (${BLOB_QUOTA_BYTES} bytes) exceeded`,
        })
        return
      }
      up.handle.offset = up.bytes
      up.handle.writeBytes(bytes)
      up.bytes += bytes.length
      this.hooks.sendResult(packageName, requestId, true, {bytesWritten: up.bytes})
    } catch (err) {
      this.fail(packageName, requestId, MiniappErrorCode.BLOB_WRITE_FAILED, err)
    }
  }

  handleCommit(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const key = payload.key as string
    const mapKey = this.uploadKey(packageName, key)
    const up = this.uploads.get(mapKey)
    if (!up) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_HANDLE_INVALID,
        message: `No open blob writer for key ${key}`,
      })
      return
    }
    try {
      up.handle.close()
      up.partFile.rename(up.fileName) // drop ".part"
      const extraMeta = {
        ...(up.meta ?? {}),
        ...((payload.meta as Record<string, string | number | boolean>) ?? {}),
      }
      const meta = this.commitFile(packageName, key, up.fileName, up.mimeType, up.name, extraMeta)
      this.uploads.delete(mapKey)
      this.hooks.sendResult(packageName, requestId, true, meta)
    } catch (err) {
      this.discardUpload(up)
      this.uploads.delete(mapKey)
      this.fail(packageName, requestId, MiniappErrorCode.BLOB_WRITE_FAILED, err)
    }
  }

  handleAbort(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const mapKey = this.uploadKey(packageName, payload.key as string)
    const up = this.uploads.get(mapKey)
    if (up) {
      this.discardUpload(up)
      this.uploads.delete(mapKey)
    }
    this.hooks.sendResult(packageName, requestId, true)
  }

  // ---- download / import (host-side; no bytes cross the bridge) -------------

  async handleSetFromUrl(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const key = payload.key as string
    const url = payload.url as string
    if (!key || !url) {
      this.fail(packageName, requestId, MiniappErrorCode.INTERNAL, new Error("setFromUrl requires key + url"))
      return
    }
    if (url.startsWith("file:") || url.startsWith("javascript:")) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_DOWNLOAD_FAILED,
        message: "Unsupported URL scheme",
      })
      return
    }
    const headers = payload.headers as Record<string, string> | undefined
    const fileName = this.makeId()
    const partFile = this.fileFor(packageName, fileName + ".part")
    try {
      const dl = await File.downloadFileAsync(url, partFile, {idempotent: true, ...(headers ? {headers} : {})})
      const size = dl.size ?? 0
      if (this.overQuota(packageName, key, size)) {
        try {
          dl.delete()
        } catch {
          /* ignore */
        }
        this.hooks.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.BLOB_QUOTA_EXCEEDED,
          message: `Blob quota (${BLOB_QUOTA_BYTES} bytes) exceeded`,
        })
        return
      }
      partFile.rename(fileName)
      const mimeType =
        (payload.mimeType as string) || inferMime(basename(url)) || this.fileFor(packageName, fileName).type || OCTET
      const name = (payload.name as string) || basename(url) || key
      const meta = this.commitFile(
        packageName,
        key,
        fileName,
        mimeType,
        name,
        payload.meta as Record<string, string | number | boolean> | undefined,
      )
      this.hooks.sendResult(packageName, requestId, true, meta)
    } catch (err) {
      try {
        if (partFile.exists) partFile.delete()
      } catch {
        /* ignore */
      }
      this.fail(packageName, requestId, MiniappErrorCode.BLOB_DOWNLOAD_FAILED, err)
    }
  }

  async handleImport(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const key = (typeof payload.key === "string" && payload.key) || this.makeId()
    const mimeFilter = payload.mimeType as string | undefined

    let picked: File | File[] | null = null
    try {
      picked = await File.pickFileAsync(undefined, mimeFilter)
    } catch (err) {
      // Picker dismissed / cancelled (or unavailable) → resolve to null, not an error.
      console.log(`${LOG_TAG}: blob import picker dismissed`, err)
      this.hooks.sendResult(packageName, requestId, true, null)
      return
    }
    const file = Array.isArray(picked) ? picked[0] : picked
    if (!file) {
      this.hooks.sendResult(packageName, requestId, true, null)
      return
    }
    try {
      const size = file.size ?? 0
      if (this.overQuota(packageName, key, size)) {
        this.hooks.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.BLOB_QUOTA_EXCEEDED,
          message: `Blob quota (${BLOB_QUOTA_BYTES} bytes) exceeded`,
        })
        return
      }
      const fileName = this.makeId()
      file.copy(this.fileFor(packageName, fileName))
      const name = basename(file.uri) || key
      const mimeType = mimeFilter || file.type || inferMime(name) || OCTET
      const meta = this.commitFile(
        packageName,
        key,
        fileName,
        mimeType,
        name,
        payload.meta as Record<string, string | number | boolean> | undefined,
      )
      this.hooks.sendResult(packageName, requestId, true, meta)
    } catch (err) {
      this.fail(packageName, requestId, MiniappErrorCode.BLOB_IMPORT_FAILED, err)
    }
  }

  // ---- read ----------------------------------------------------------------

  handleGet(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const key = payload.key as string
    const meta = this.readMeta(packageName, key)
    if (!meta || !this.fileFor(packageName, meta.fileName).exists) {
      if (meta) this.dropMeta(packageName, meta) // reconcile dangling meta
      this.hooks.sendResult(packageName, requestId, true, null)
      return
    }
    this.hooks.sendResult(packageName, requestId, true, this.toBlobMeta(packageName, meta))
  }

  handleList(packageName: string, _payload: Record<string, unknown>, requestId?: string): void {
    const blobs = this.allMeta(packageName)
      .filter((m) => this.fileFor(packageName, m.fileName).exists)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((m) => this.toBlobMeta(packageName, m))
    this.hooks.sendResult(packageName, requestId, true, {blobs})
  }

  handleUsage(packageName: string, _payload: Record<string, unknown>, requestId?: string): void {
    const metas = this.allMeta(packageName)
    this.hooks.sendResult(packageName, requestId, true, {
      bytes: metas.reduce((s, m) => s + (m.bytes || 0), 0),
      count: metas.length,
      quotaBytes: BLOB_QUOTA_BYTES,
    })
  }

  handleDelete(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const meta = this.readMeta(packageName, payload.key as string)
    if (meta) this.dropMeta(packageName, meta)
    this.hooks.sendResult(packageName, requestId, true)
  }

  handleClear(packageName: string, _payload: Record<string, unknown>, requestId?: string): void {
    try {
      // Abort any in-flight uploads / open readers first so nothing keeps writing
      // to a .part file in the directory we're about to delete.
      this.closeAppHandles(packageName)
      for (const m of this.allMeta(packageName)) mmkvStorage.remove(this.metaKey(packageName, m.key))
      const dir = this.dirFor(packageName)
      try {
        if (dir.exists) dir.delete()
      } catch {
        /* best-effort */
      }
      this.usageCache.set(this.currentIdentity(packageName).scope, 0)
      this.hooks.sendResult(packageName, requestId, true)
    } catch (err) {
      this.fail(packageName, requestId, MiniappErrorCode.INTERNAL, err)
    }
  }

  handleOpenRead(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const key = payload.key as string
    const meta = this.readMeta(packageName, key)
    const file = meta ? this.fileFor(packageName, meta.fileName) : null
    if (!meta || !file || !file.exists) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_NOT_FOUND,
        message: `Blob ${key} not found`,
      })
      return
    }
    try {
      const handle = file.open()
      const handleId = `r_${this.makeId()}`
      this.readers.set(handleId, {packageName, handle, remaining: meta.bytes})
      this.hooks.sendResult(packageName, requestId, true, {handle: handleId, meta: this.toBlobMeta(packageName, meta)})
    } catch (err) {
      this.fail(packageName, requestId, MiniappErrorCode.INTERNAL, err)
    }
  }

  handleRead(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const handleId = payload.handle as string
    const reader = this.readers.get(handleId)
    if (!reader || reader.packageName !== packageName) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_HANDLE_INVALID,
        message: "Unknown blob read handle",
      })
      return
    }
    try {
      const want = Math.max(0, Math.min(Number(payload.maxBytes) || 1024 * 1024, reader.remaining))
      const bytes = want > 0 ? reader.handle.readBytes(want) : new Uint8Array(0)
      reader.remaining -= bytes.length
      const done = reader.remaining <= 0
      const base64 = bytes.length
        ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")
        : ""
      if (done) {
        try {
          reader.handle.close()
        } catch {
          /* ignore */
        }
        this.readers.delete(handleId)
      }
      this.hooks.sendResult(packageName, requestId, true, {base64, done})
    } catch (err) {
      this.fail(packageName, requestId, MiniappErrorCode.INTERNAL, err)
    }
  }

  handleCloseRead(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const handleId = payload.handle as string
    const reader = this.readers.get(handleId)
    if (reader && reader.packageName === packageName) {
      try {
        reader.handle.close()
      } catch {
        /* ignore */
      }
      this.readers.delete(handleId)
    }
    this.hooks.sendResult(packageName, requestId, true)
  }

  // ---- share ---------------------------------------------------------------

  /** Best-effort GC for completed share handoffs retained in the OS cache. */
  private cleanupShareCache(now = Date.now()): void {
    try {
      const root = new Directory(Paths.cache, SHARE_DIR_NAME)
      if (!root.exists) return
      const cutoff = now - SHARE_CACHE_MAX_AGE_MS
      for (const entry of root.list()) {
        if (!(entry instanceof Directory)) continue
        try {
          const info = entry.info()
          // modificationTime is available on both platforms; creationTime can
          // be absent on Android versions before API 26. The directory id
          // begins with Date.now().toString(36), which is a final fallback.
          const encoded = entry.name.split("-", 1)[0]
          const encodedTime = /^[0-9a-z]+$/.test(encoded) ? Number.parseInt(encoded, 36) : Number.NaN
          const timestamp = info.modificationTime ?? info.creationTime ?? encodedTime
          if (Number.isFinite(timestamp) && timestamp < cutoff) entry.delete()
        } catch {
          // Keep scanning if one cache entry disappears or is unreadable.
        }
      }
    } catch {
      // Cache cleanup must never prevent a share.
    }
  }

  async handleShare(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const key = payload.key as string
    const meta = this.readMeta(packageName, key)
    const file = meta ? this.fileFor(packageName, meta.fileName) : null
    if (!meta || !file || !file.exists) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_NOT_FOUND,
        message: `Blob ${key} not found`,
      })
      return
    }
    // The on-disk blob name is a generated id (mime extension attached at
    // commit; legacy blobs may lack it). react-native-share derives the shared
    // file's name + extension from the URL's path (its `filename` option only
    // applies to base64/data payloads, not file:// URLs), so sharing `file.uri`
    // directly would hand the recipient a machine-named file. Copy to a temp
    // file that carries the real display name + extension, share that, then
    // clean it up after the recipient has had time to consume it.
    const shareName = shareFileName(meta)
    // Copy into a per-share unique subdir so two concurrent shares that resolve
    // to the same display name can't clobber each other's temp file while
    // Share.open still references it. The file keeps `shareName` as its basename
    // so the OS share sheet shows the right name + extension.
    let tempDir: Directory | null = null
    let handedOff = false
    try {
      this.cleanupShareCache()
      tempDir = new Directory(Paths.cache, SHARE_DIR_NAME, this.makeId())
      tempDir.create({intermediates: true})
      const temp = new File(tempDir, shareName)
      file.copy(temp)
      await Share.open({
        url: temp.uri,
        type: meta.mimeType || OCTET,
        filename: shareName,
      })
      // Share.open resolves once the OS accepts the handoff. Recipient apps may
      // still read the URI asynchronously, so retain this cache copy for GC.
      handedOff = true
      this.hooks.sendResult(packageName, requestId, true, {success: true})
    } catch (error: any) {
      if (error?.message?.includes("User did not share")) {
        this.hooks.sendResult(packageName, requestId, true, {success: false, cancelled: true})
      } else {
        console.error(`${LOG_TAG}: blob share error:`, error)
        this.hooks.sendResult(packageName, requestId, true, {success: false})
      }
    } finally {
      // A cancelled/failed sheet has no recipient. Successful handoffs are
      // cleaned by cleanupShareCache after their retention window instead.
      if (tempDir && !handedOff) {
        try {
          if (tempDir.exists) tempDir.delete()
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ---- lifecycle / cleanup -------------------------------------------------

  /** Called from LocalMiniappRuntime.unregisterApp — drop this app's in-flight state. */
  onAppGone(packageName: string): void {
    this.closeAppHandles(packageName)
  }

  /** Abort in-flight uploads + close open read handles for an app (no-op if none). */
  private closeAppHandles(packageName: string): void {
    for (const [k, up] of this.uploads) {
      if (up.packageName === packageName) {
        this.discardUpload(up)
        this.uploads.delete(k)
      }
    }
    for (const [k, reader] of this.readers) {
      if (reader.packageName === packageName) {
        try {
          reader.handle.close()
        } catch {
          /* ignore */
        }
        this.readers.delete(k)
      }
    }
  }

  private discardUpload(up: ActiveUpload): void {
    try {
      up.handle.close()
    } catch {
      /* ignore */
    }
    try {
      if (up.partFile.exists) up.partFile.delete()
    } catch {
      /* ignore */
    }
  }

  private dropMeta(packageName: string, meta: StoredBlobMeta): void {
    this.deleteFileQuiet(packageName, meta.fileName)
    mmkvStorage.remove(this.metaKey(packageName, meta.key))
    this.bumpUsage(packageName, -(meta.bytes || 0))
  }

  private deleteFileQuiet(packageName: string, fileName: string): void {
    try {
      const f = this.fileFor(packageName, fileName)
      if (f.exists) f.delete()
    } catch {
      /* ignore */
    }
  }

  private fail(packageName: string, requestId: string | undefined, code: MiniappErrorCode, err: unknown): void {
    console.error(`${LOG_TAG}: blob error [${code}]:`, err)
    this.hooks.sendResult(packageName, requestId, false, undefined, {
      code,
      message: err instanceof Error ? err.message : "Blob error",
    })
  }
}

const OCTET = "application/octet-stream"

/** Last path segment of a URL/URI, query stripped + percent-decoded. */
function basename(uri: string): string {
  const noQuery = uri.split("?")[0].split("#")[0]
  const seg = noQuery.substring(noQuery.lastIndexOf("/") + 1)
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/** Best-effort MIME from a filename extension. Returns undefined when unknown. */
function inferMime(name: string): string | undefined {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return undefined
  const ext = name.slice(dot + 1).toLowerCase()
  const map: Record<string, string> = {
    pdf: "application/pdf",
    epub: "application/epub+zip",
    zip: "application/zip",
    json: "application/json",
    txt: "text/plain",
    csv: "text/csv",
    html: "text/html",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  }
  return map[ext]
}
