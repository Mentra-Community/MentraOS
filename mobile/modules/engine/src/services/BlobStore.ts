/**
 * BlobStore
 *
 * Host-side implementation of `session.blob` — persistent, per-(data partition,
 * packageName) BINARY storage for local miniapps, keyed like SimpleStorage (its
 * small-string sibling). Extracted from LocalMiniappRuntime the same way
 * NavigationHandlers is, to keep the runtime file small.
 *
 * Generic byte store — it knows nothing about any specific format. Highlights:
 *   - chunked write/read (BLOB_CREATE/WRITE/COMMIT, BLOB_OPEN_READ/READ) so no
 *     single bridge message is large;
 *   - `setFromUrl` downloads a URL straight to disk (File.downloadFileAsync) and
 *     `importFile` runs the OS picker (expo-document-picker) — both keep bytes
 *     entirely host-side;
 *   - `share` hands a stored file to the OS share sheet;
 *   - a blob written with `cache: true` is a copy of something the app can get again (a server file, a photo the
 *     host took): outside the quota, deleted least recently read first when the app's cache is over its budget,
 *     like a browser's HTTP cache. A deleted one is simply absent, and the app downloads it again.
 *
 * Miniapp code is untrusted: `setFromUrl` downloads only http: and https: URLs,
 * and a shared copy's name is one safe file name (blobPaths.shareFileName).
 * This directory is the miniapp's own files (`ownFilesDirectory`), the only
 * ones `session.system.share` and `session.speaker.play` accept by file URL.
 *
 * Layout (mirrors SimpleStorage's scoping; see miniappDataPartition.ts):
 *   bytes:    Paths.document/mentra_blobs/{partitionId}/{packageName}/{fileName}
 *   metadata: MMKV key  mentraos_blobmeta/{partitionId}/{packageName}/{key}  → StoredBlobMeta JSON
 * Blobs from before partitions ({userId} in place of {partitionId}) move into the personal partition on first use.
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
import * as DocumentPicker from "expo-document-picker"
import {Directory, File, Paths, type FileHandle} from "expo-file-system"

import {MiniappErrorCode} from "@mentra/miniapp"
import {storage as mmkvStorage} from "../utils/storage/storage"
import {sanitizeSegment, shareFileName, withDiskExt} from "./blobPaths"
import {canonicalPath} from "./miniappFiles"
import {miniappFileUrl} from "./miniappScreenOrigin"
import {filePathOfUri, isNetworkUrl} from "./miniappPaths"
import type {MiniappDataPartition} from "./miniappDataPartition"

const LOG_TAG = "LocalMiniappRuntime"

/**
 * Per-app blob quota: half the space the app could use (what it stores plus the phone's free
 * space), never below 1 GB unless the phone has less room than that. It moves with the phone's
 * free space, and an app that reaches it still leaves as much free as it holds, so one app never
 * fills the phone.
 */
export const BLOB_MIN_QUOTA_BYTES = 1024 * 1024 * 1024
/**
 * Per-app cache budget: a quarter of the room the cache could use (what it holds plus the phone's free space), at
 * most this. It shrinks as the phone fills.
 */
export const BLOB_CACHE_MAX_BYTES = 512 * 1024 * 1024
const ROOT_DIR_NAME = "mentra_blobs"
/** Cache dir root holding short-lived, properly-named copies handed to the OS share sheet (one subdir per stored blob). */
const SHARE_DIR_NAME = "mentra_blob_share"
/**
 * Keep prepared share handoffs alive long enough for recipient apps to read
 * them asynchronously (for example, an email composer attaching the file).
 * Stale copies are collected before the next share; the OS may evict cache
 * files sooner under storage pressure.
 */
const SHARE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const SHARE_LAST_USED_FILE = ".last-shared"
const META_KEY_ROOT = "mentraos_blobmeta/"
const LEGACY_META_KEY_ROOT = "mentraos_blobmeta_"
const MIGRATED_KEY_ROOT = "mentraos_blobmeta_migrated/"
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
  /** The data partition `packageName` uses now (same source SimpleStorage uses). Throws while no account is known. */
  getPartition: (packageName: string) => MiniappDataPartition
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
  /** A cached blob: outside the quota, deleted when the app's cache is over its budget. */
  cached?: true
  /** When a cached blob was last written or used: the least recently read goes first. */
  readAt?: number
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
  cached: boolean
}

interface ActiveReader {
  packageName: string
  handle: FileHandle
  remaining: number
}

export class BlobStore {
  private readonly uploads = new Map<string, ActiveUpload>() // key: `${pkg} ${key}`
  private readonly activeShareDirs = new Map<string, number>()
  private readonly readers = new Map<string, ActiveReader>() // key: host handle id
  /** user + package → committed usage bytes, cached; invalidated on commit/delete/clear. */
  private readonly usageCache = new Map<string, number>()
  private readonly migrated = new Set<string>()

  constructor(private readonly hooks: BlobStoreHooks) {}

  // ---- path / meta helpers -------------------------------------------------

  private currentIdentity(packageName: string): {partitionId: string; scope: string} {
    const partition = this.hooks.getPartition(packageName)
    if (!partition.id) throw new Error("Mentra user identity is unavailable")
    if (partition.personalUserId) this.migrateLegacy(partition.personalUserId, packageName, partition.id)
    return {partitionId: partition.id, scope: `${partition.id}\0${packageName}`}
  }

  /**
   * Move blobs stored before partitions (scoped by user id alone) into that account's personal partition, once.
   * Throws when the files cannot move, so the request fails and nothing is created in the partition: the next use
   * tries again, with the blobs and their metadata still where they were.
   */
  private migrateLegacy(userId: string, packageName: string, partitionId: string): void {
    const marker = `${MIGRATED_KEY_ROOT}${userId}/${packageName}`
    if (this.migrated.has(marker) || mmkvStorage.load<boolean>(marker).is_ok()) {
      this.migrated.add(marker)
      return
    }
    try {
      const legacyDir = new Directory(
        Paths.document,
        ROOT_DIR_NAME,
        sanitizeSegment(userId),
        sanitizeSegment(packageName),
      )
      const targetDir = new Directory(Paths.document, ROOT_DIR_NAME, partitionId, sanitizeSegment(packageName))
      if (legacyDir.exists && !targetDir.exists) {
        const parent = new Directory(Paths.document, ROOT_DIR_NAME, partitionId)
        if (!parent.exists) parent.create({intermediates: true})
        legacyDir.move(targetDir)
      } else if (legacyDir.exists) {
        for (const entry of legacyDir.list()) {
          if (entry instanceof File && !new File(targetDir, entry.name).exists) entry.move(targetDir)
        }
      }
      const legacyPrefix = `${LEGACY_META_KEY_ROOT}${sanitizeSegment(userId)}_${packageName}_`
      const prefix = `${META_KEY_ROOT}${partitionId}/${packageName}/`
      for (const key of mmkvStorage.getAllKeys()) {
        if (!key.startsWith(legacyPrefix)) continue
        const meta = mmkvStorage.load<StoredBlobMeta>(key)
        const target = prefix + key.slice(legacyPrefix.length)
        if (meta.is_ok() && !mmkvStorage.load<StoredBlobMeta>(target).is_ok()) mmkvStorage.save(target, meta.value)
        mmkvStorage.remove(key)
      }
      mmkvStorage.save(marker, true)
      this.migrated.add(marker)
    } catch (err) {
      console.warn(`${LOG_TAG}: blob migration for ${packageName} failed; retried on next use`, err)
      throw err
    }
  }

  /**
   * The directory holding this miniapp's blobs in the data partition it uses now:
   * the only files its file URLs may name. Throws while no account is known.
   */
  ownFilesDirectory(packageName: string): Directory {
    return this.dirFor(packageName)
  }

  private dirFor(packageName: string): Directory {
    const dir = new Directory(
      Paths.document,
      ROOT_DIR_NAME,
      this.currentIdentity(packageName).partitionId,
      sanitizeSegment(packageName),
    )
    if (!dir.exists) dir.create({intermediates: true})
    return dir
  }

  private metaPrefix(packageName: string): string {
    return `${META_KEY_ROOT}${this.currentIdentity(packageName).partitionId}/${packageName}/`
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

  /** A request used the blob: a cached one moves to the back of the eviction order. */
  private touch(packageName: string, meta: StoredBlobMeta): void {
    if (meta.cached) this.writeMeta(packageName, {...meta, readAt: Date.now()})
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

  /** Public API shape: stored meta + derived file:// uri, and the URL the package's screen loads it from. */
  private toBlobMeta(packageName: string, m: StoredBlobMeta) {
    const url = miniappFileUrl(packageName, m.fileName)
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
      ...(url ? {url} : {}),
      ...(m.cached ? {cached: true} : {}),
    }
  }

  private committedUsage(packageName: string): number {
    const {scope} = this.currentIdentity(packageName)
    const cached = this.usageCache.get(scope)
    if (cached !== undefined) return cached
    let total = 0
    for (const m of this.allMeta(packageName)) if (!m.cached) total += m.bytes || 0
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

  private quotaBytes(packageName: string): number {
    const room = this.committedUsage(packageName) + Paths.availableDiskSpace
    return Math.min(room, Math.max(BLOB_MIN_QUOTA_BYTES, Math.floor(room / 2)))
  }

  /** Fails the request with BLOB_QUOTA_EXCEEDED when the app would store more than its quota. */
  private rejectOverQuota(packageName: string, requestId: string | undefined, bytesAfter: number): boolean {
    const quota = this.quotaBytes(packageName)
    if (bytesAfter <= quota) return false
    this.hooks.sendResult(packageName, requestId, false, undefined, {
      code: MiniappErrorCode.BLOB_QUOTA_EXCEEDED,
      message: `Blob quota (${quota} bytes) exceeded`,
    })
    return true
  }

  /** What the app would store with `incoming` bytes under `key`, the blob there now replaced. */
  private usageWith(packageName: string, key: string, incoming: number): number {
    return this.committedUsage(packageName) - this.quotaBytesOf(packageName, key) + incoming
  }

  /** The bytes the blob now under `key` counts toward the quota: none when absent or cached. */
  private quotaBytesOf(packageName: string, key: string): number {
    const prior = this.readMeta(packageName, key)
    return prior && !prior.cached ? prior.bytes || 0 : 0
  }

  /** Publish a file already sitting at `fileName` as the blob for `key`; returns its public meta. */
  private commitFile(
    packageName: string,
    key: string,
    fileName: string,
    mimeType: string,
    name: string | undefined,
    extraMeta: Record<string, string | number | boolean> | undefined,
    cached = false,
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
      if (!prior.cached) this.bumpUsage(packageName, -(prior.bytes || 0))
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
      ...(cached ? {cached: true, readAt: now} : {}),
    }
    this.writeMeta(packageName, meta)
    if (cached) this.trimCache(packageName, key)
    else this.bumpUsage(packageName, bytes)
    return this.toBlobMeta(packageName, meta)
  }

  // ---- cache ---------------------------------------------------------------

  /**
   * Take a file the host produced for this miniapp (`sourceUri`, moved, not copied), such as a photo it took, and
   * publish it as the cached blob for `key`. To keep it, the miniapp copies it or calls `setCached(key, false)`.
   */
  storeCachedFile(packageName: string, key: string, sourceUri: string, mimeType: string) {
    const fileName = this.makeId()
    new File(sourceUri).move(this.fileFor(packageName, fileName))
    return this.commitFile(packageName, key, fileName, mimeType, undefined, undefined, true)
  }

  /** Whether the package's store holds the blob now, its file included. */
  hasBlob(packageName: string, key: string): boolean {
    const meta = this.readMeta(packageName, key)
    return meta !== null && meta !== undefined && this.fileFor(packageName, meta.fileName).exists
  }

  /** Publish bytes the host fetched for this miniapp as the cached blob for `key`. */
  storeCachedBytes(packageName: string, key: string, bytes: Uint8Array, mimeType: string) {
    const fileName = this.makeId()
    this.fileFor(packageName, fileName).write(bytes)
    return this.commitFile(packageName, key, fileName, mimeType, undefined, undefined, true)
  }

  /** Delete a host-produced file that could not be stored. */
  discardFile(uri: string): void {
    try {
      const file = new File(uri)
      if (file.exists) file.delete()
    } catch {
      /* ignore */
    }
  }

  /**
   * Delete the app's least recently read cached blobs until its cache is within budget. The blob just written
   * (`keep`) always stays, whatever its size. A file still being read keeps working: the OS frees it once closed.
   */
  private trimCache(packageName: string, keep: string): void {
    const cached = this.allMeta(packageName)
      .filter((m) => m.cached)
      .sort((a, b) => (b.readAt ?? b.updatedAt) - (a.readAt ?? a.updatedAt))
    let bytes = cached.reduce((sum, m) => sum + (m.bytes || 0), 0)
    const budget = Math.min(BLOB_CACHE_MAX_BYTES, Math.floor((bytes + Paths.availableDiskSpace) / 4))
    for (let i = cached.length - 1; i >= 0 && bytes > budget; i--) {
      if (cached[i].key === keep) continue
      bytes -= cached[i].bytes || 0
      this.dropMeta(packageName, cached[i])
    }
  }

  /** Make the blob under `key` cached (outside the quota) or permanent (under it), without copying it. */
  handleSetCached(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const key = payload.key as string
    const meta = key ? this.readMeta(packageName, key) : null
    if (!meta || !this.fileFor(packageName, meta.fileName).exists) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_NOT_FOUND,
        message: `Blob ${key} not found`,
      })
      return
    }
    const cached = payload.cached === true
    if (cached !== !!meta.cached) {
      if (!cached && this.rejectOverQuota(packageName, requestId, this.usageWith(packageName, key, meta.bytes || 0)))
        return
      const flipped: StoredBlobMeta = {...meta, cached: cached || undefined, readAt: cached ? Date.now() : undefined}
      this.writeMeta(packageName, flipped)
      this.bumpUsage(packageName, cached ? -(meta.bytes || 0) : meta.bytes || 0)
      if (cached) this.trimCache(packageName, key)
      this.hooks.sendResult(packageName, requestId, true, this.toBlobMeta(packageName, flipped))
      return
    }
    this.hooks.sendResult(packageName, requestId, true, this.toBlobMeta(packageName, meta))
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
        priorBytes: this.quotaBytesOf(packageName, key),
        name: typeof payload.name === "string" ? payload.name : undefined,
        mimeType: typeof payload.mimeType === "string" ? payload.mimeType : "application/octet-stream",
        meta: (payload.meta as Record<string, string | number | boolean>) ?? undefined,
        createdAt: Date.now(),
        cached: payload.cache === true,
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
      if (
        !up.cached &&
        this.rejectOverQuota(
          packageName,
          requestId,
          this.committedUsage(packageName) - up.priorBytes + up.bytes + bytes.length,
        )
      )
        return
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
      const meta = this.commitFile(packageName, key, up.fileName, up.mimeType, up.name, extraMeta, up.cached)
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
    // Only the network: a file: URL (in any case), content: URI or other local
    // scheme would copy one of the phone's files into the miniapp's storage.
    if (!isNetworkUrl(url)) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_DOWNLOAD_FAILED,
        message: "Unsupported URL scheme: setFromUrl downloads only http: and https: URLs",
      })
      return
    }
    const headers = payload.headers as Record<string, string> | undefined
    const cached = payload.cache === true
    const fileName = this.makeId()
    const partFile = this.fileFor(packageName, fileName + ".part")
    try {
      const dl = await File.downloadFileAsync(url, partFile, {idempotent: true, ...(headers ? {headers} : {})})
      const size = dl.size ?? 0
      if (!cached && this.rejectOverQuota(packageName, requestId, this.usageWith(packageName, key, size))) {
        try {
          dl.delete()
        } catch {
          /* ignore */
        }
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
        cached,
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

  /** Send a blob's file as a request body (a presigned upload): native code reads it from disk. */
  async handleUpload(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const key = payload.key as string
    const url = payload.url as string
    const stored = key ? this.readMeta(packageName, key) : null
    const file = stored ? this.fileFor(packageName, stored.fileName) : null
    if (!stored || !file?.exists) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_NOT_FOUND,
        message: `Blob ${key} not found`,
      })
      return
    }
    if (!url || !isNetworkUrl(url)) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_UPLOAD_FAILED,
        message: "upload sends only to http: and https: URLs",
      })
      return
    }
    this.touch(packageName, stored)
    try {
      // The legacy module is the one with a native upload from a file; loaded only when needed.
      const {uploadAsync, FileSystemUploadType} = await import("expo-file-system/legacy")
      const answer = await uploadAsync(url, file.uri, {
        httpMethod: payload.method === "POST" ? "POST" : "PUT",
        uploadType: FileSystemUploadType.BINARY_CONTENT,
        headers: payload.headers as Record<string, string> | undefined,
      })
      if (answer.status < 200 || answer.status >= 300) throw new Error(`The server answered ${answer.status}`)
      this.hooks.sendResult(packageName, requestId, true, {status: answer.status})
    } catch (err) {
      this.fail(packageName, requestId, MiniappErrorCode.BLOB_UPLOAD_FAILED, err)
    }
  }

  async handleImport(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const key = (typeof payload.key === "string" && payload.key) || this.makeId()
    const types = [payload.mimeType].flat().filter((type): type is string => typeof type === "string" && !!type)

    // The picker copies the chosen file into the app's cache, with its own name: Android's picker hands out a
    // content:// URI, which can't be copied as a file and whose last segment is an id, not the file's name.
    let picked: DocumentPicker.DocumentPickerAsset | undefined
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: types.length ? types : "*/*",
        copyToCacheDirectory: true,
      })
      picked = result.canceled ? undefined : result.assets[0]
    } catch (err) {
      // The picker unavailable: as a cancel, null rather than an error.
      console.log(`${LOG_TAG}: blob import picker failed`, err)
    }
    if (!picked) {
      this.hooks.sendResult(packageName, requestId, true, null)
      return
    }
    const file = new File(picked.uri)
    try {
      const size = picked.size ?? file.size ?? 0
      const cached = payload.cache === true
      if (!cached && this.rejectOverQuota(packageName, requestId, this.usageWith(packageName, key, size))) {
        file.delete()
        return
      }
      const fileName = this.makeId()
      // The cache copy is ours: it becomes the blob.
      file.move(this.fileFor(packageName, fileName))
      const name = picked.name || basename(picked.uri) || key
      const mimeType = picked.mimeType || inferMime(name) || types[0] || OCTET
      const meta = this.commitFile(
        packageName,
        key,
        fileName,
        mimeType,
        name,
        payload.meta as Record<string, string | number | boolean> | undefined,
        cached,
      )
      this.hooks.sendResult(packageName, requestId, true, meta)
    } catch (err) {
      this.fail(packageName, requestId, MiniappErrorCode.BLOB_IMPORT_FAILED, err)
    }
  }

  /** Copy the blob under `from` to `key` on disk: permanent, under the quota, unless asked for `cache`. */
  handleCopy(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const from = payload.from as string
    const key = payload.key as string
    const source = from ? this.readMeta(packageName, from) : null
    const file = source ? this.fileFor(packageName, source.fileName) : null
    if (!key || !source || !file?.exists) {
      this.hooks.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.BLOB_NOT_FOUND,
        message: `Blob ${from} not found`,
      })
      return
    }
    const cached = payload.cache === true
    if (!cached && this.rejectOverQuota(packageName, requestId, this.usageWith(packageName, key, source.bytes || 0)))
      return
    this.touch(packageName, source)
    try {
      const fileName = this.makeId()
      file.copy(this.fileFor(packageName, fileName))
      const meta = this.commitFile(packageName, key, fileName, source.mimeType, source.name, source.meta, cached)
      this.hooks.sendResult(packageName, requestId, true, meta)
    } catch (err) {
      this.fail(packageName, requestId, MiniappErrorCode.INTERNAL, err)
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
    this.touch(packageName, meta)
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
    // Usage is what counts toward the quota, so cached blobs are left out.
    const metas = this.allMeta(packageName).filter((m) => !m.cached)
    this.hooks.sendResult(packageName, requestId, true, {
      bytes: metas.reduce((s, m) => s + (m.bytes || 0), 0),
      count: metas.length,
      quotaBytes: this.quotaBytes(packageName),
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
    this.touch(packageName, meta)
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

  /** Best-effort GC for prepared share handoffs retained in the OS cache. */
  private cleanupShareCache(now = Date.now()): void {
    try {
      const root = new Directory(Paths.cache, SHARE_DIR_NAME)
      if (!root.exists) return
      const cutoff = now - SHARE_CACHE_MAX_AGE_MS
      for (const entry of root.list()) {
        if (!(entry instanceof Directory) || this.activeShareDirs.has(entry.uri)) continue
        try {
          const lastUsed = new File(entry, SHARE_LAST_USED_FILE)
          const info = entry.info()
          // modificationTime is available on both platforms; creationTime can
          // be absent on Android versions before API 26. The directory id
          // begins with Date.now().toString(36), which is a final fallback.
          const encoded = entry.name.split("-", 1)[0]
          const encodedTime = /^[0-9a-z]+$/.test(encoded) ? Number.parseInt(encoded, 36) : Number.NaN
          const timestamp = lastUsed.exists
            ? Number(lastUsed.textSync())
            : (info.modificationTime ?? info.creationTime ?? encodedTime)
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
    this.touch(packageName, meta)
    const shareName = shareFileName(meta)
    // Key the cache directory by the immutable stored filename. Repeated or
    // concurrent shares of the same blob can safely reference the same bytes,
    // avoiding an extra full-sized cache copy for every share. Different blobs
    // still get isolated directories even when they use the same display name.
    // The file keeps `shareName` as its basename so the OS share sheet shows the
    // right name + extension.
    let tempDir: Directory | null = null
    let cacheReady = false
    let handoffStarted = false
    try {
      this.cleanupShareCache()
      tempDir = new Directory(Paths.cache, SHARE_DIR_NAME, sanitizeSegment(meta.fileName))
      if (!tempDir.exists) tempDir.create({intermediates: true})
      const temp = new File(tempDir, shareName)
      if (!temp.exists || temp.size !== meta.bytes) {
        if (temp.exists) temp.delete()
        file.copy(temp)
      }
      // Resolve, then verify: the copy is directly in its share directory.
      const tempPath = filePathOfUri(temp.uri)
      const real = tempPath ? canonicalPath(tempPath) : null
      const realDir = canonicalPath(filePathOfUri(tempDir.uri) ?? "")
      if (!real || !realDir || real.slice(0, real.lastIndexOf("/")) !== realDir) {
        throw new Error("blob share copy is outside its directory")
      }
      cacheReady = true
      // Persist each handoff's age, even when reusing old bytes. Directory
      // modification time does not change when an existing file is shared.
      new File(tempDir, SHARE_LAST_USED_FILE).write(String(Date.now()))
      this.activeShareDirs.set(tempDir.uri, (this.activeShareDirs.get(tempDir.uri) ?? 0) + 1)
      handoffStarted = true
      await Share.open({
        url: temp.uri,
        type: meta.mimeType || OCTET,
        filename: shareName,
      })
      // Share.open resolves once the OS accepts the handoff. Recipient apps may
      // still read the URI asynchronously, so retain this cache copy for GC.
      this.hooks.sendResult(packageName, requestId, true, {success: true})
    } catch (error: any) {
      if (error?.message?.includes("User did not share")) {
        this.hooks.sendResult(packageName, requestId, true, {success: false, cancelled: true})
      } else {
        console.error(`${LOG_TAG}: blob share error:`, error)
        this.hooks.sendResult(packageName, requestId, true, {success: false})
      }
    } finally {
      if (tempDir && handoffStarted) {
        // Give async readers a full window after the chooser returns, even
        // if it stayed open longer than the retention period.
        try {
          new File(tempDir, SHARE_LAST_USED_FILE).write(String(Date.now()))
        } catch (error) {
          console.warn(`${LOG_TAG}: could not refresh share retention`, error)
        }
        const remaining = (this.activeShareDirs.get(tempDir.uri) ?? 1) - 1
        if (remaining > 0) this.activeShareDirs.set(tempDir.uri, remaining)
        else this.activeShareDirs.delete(tempDir.uri)
      }
      // Once a reusable cache entry is ready, retain it even if this particular
      // sheet is cancelled or fails: another concurrent/recent share may still
      // be reading the same file. Only remove an entry whose preparation did
      // not finish; ready entries are collected after the retention window.
      if (tempDir && !cacheReady) {
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
    if (!meta.cached) this.bumpUsage(packageName, -(meta.bytes || 0))
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
