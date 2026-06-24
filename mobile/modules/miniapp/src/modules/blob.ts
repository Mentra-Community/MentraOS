/**
 * @fileoverview BlobModule — phone-local persistent BINARY storage, keyed and
 * scoped to (userId, packageName). The binary sibling of `session.storage`:
 * where storage holds small strings, blob holds arbitrary bytes (PDFs, EPUBs,
 * audio, video, model files, caches) as files on the phone.
 *
 * It deliberately mirrors `session.storage`'s shape — `set` / `get` / `delete` /
 * `keys` / `has` / `clear` — so it's instantly familiar, plus the things files
 * (and not strings) need:
 *   - `setFromUrl(key, url)` — the host downloads a URL straight to disk
 *     (like the web Cache API's `cache.add`, iOS `URLSession` download task, or
 *     Android `DownloadManager`). Bytes never cross the bridge.
 *   - `importFile()` — opens the OS file picker and stores the chosen file.
 *     Bytes never cross the bridge.
 *   - `share(key)` — hands the file to the OS share sheet.
 *   - `createWriteStream` / `createReadStream` — for streaming huge payloads
 *     (named like Node's `fs.createWriteStream`).
 *
 * BACKGROUND-ONLY. Binary doesn't belong in the WebView. A blob's `uri` is a
 * `file://` path in the app's private storage — fine for `session.speaker.play`,
 * `blob.share`, or another host capability, but a WebView generally can't load
 * it directly (route rendering through a host viewer for now).
 *
 * Transfer model: the bridge moves JSON strings through a per-miniapp JS engine
 * (JSC/QuickJS) with a watchdog, so in-JS writes/reads are CHUNKED (≤ ~1 MB raw
 * per call). Prefer `setFromUrl` / `importFile` when you can — they keep the
 * bytes entirely host-side.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"
import {base64ToBytes, bytesToBase64, toUint8Array} from "./base64"

/** Metadata for one stored blob. `uri` is a `file://` path. */
export interface BlobMeta {
  /** The key it's stored under (caller-chosen). */
  key: string
  /** Optional display/file name (e.g. the original filename for an import). */
  name?: string
  /** MIME type, e.g. "application/pdf". */
  mimeType: string
  /** Size on disk in bytes. */
  bytes: number
  /** Epoch ms first written. */
  createdAt: number
  /** Epoch ms last written. */
  updatedAt: number
  /** Content md5 (lowercase hex), computed host-side (skipped for very large blobs). */
  md5?: string
  /** `file://` URI. Feed to `session.speaker.play`, `blob.share`, etc. */
  uri: string
  /** App-defined metadata persisted with the blob. */
  meta?: Record<string, string | number | boolean>
}

export interface BlobSetOptions {
  /** Default "application/octet-stream". */
  mimeType?: string
  name?: string
  meta?: Record<string, string | number | boolean>
}

export interface BlobSetFromUrlOptions extends BlobSetOptions {
  /** Request headers (e.g. an Authorization token) for the download. */
  headers?: Record<string, string>
}

export interface BlobImportOptions {
  /** Key to store under. Default: a generated key. */
  key?: string
  /** Restrict the picker to a MIME type, e.g. "application/pdf". */
  mimeType?: string
  meta?: Record<string, string | number | boolean>
}

/** Raw bytes per chunked write. ~1 MB raw → ~1.34 MB base64, under the watchdog. */
export const BLOB_WRITE_CHUNK_BYTES = 1024 * 1024
const BLOB_WRITE_CHUNK_B64 = Math.floor(BLOB_WRITE_CHUNK_BYTES / 3) * 4
/** Max bytes `bytes()` will buffer before throwing — read large blobs as a stream. */
export const BLOB_READ_ALL_MAX_BYTES = 32 * 1024 * 1024

/**
 * Streaming writer (`fs.createWriteStream`-like). Call `write`/`writeBase64` as
 * many times as you like (each is auto-split into bridge-safe chunks), then
 * `close()` to publish, or `abort()` to discard the partial blob.
 */
export class BlobWriter {
  private settled = false

  constructor(
    private readonly session: MiniappSession,
    readonly key: string,
  ) {}

  /** Append raw bytes. Auto-chunked. */
  async write(chunk: Uint8Array | ArrayBuffer): Promise<void> {
    this.assertOpen()
    const bytes = toUint8Array(chunk)
    for (let off = 0; off < bytes.length; off += BLOB_WRITE_CHUNK_BYTES) {
      await this.send(bytesToBase64(bytes.subarray(off, off + BLOB_WRITE_CHUNK_BYTES)))
    }
  }

  /** Append already-base64-encoded bytes (e.g. straight from `mic.onAudioChunk`). */
  async writeBase64(b64: string): Promise<void> {
    this.assertOpen()
    // Slice on 4-char boundaries so each chunk is whole base64 groups.
    for (let off = 0; off < b64.length; off += BLOB_WRITE_CHUNK_B64) {
      await this.send(b64.slice(off, off + BLOB_WRITE_CHUNK_B64))
    }
  }

  /**
   * Overwrite bytes at a fixed offset within the not-yet-closed blob (a seek
   * write). Must stay within already-written bytes; does not grow the blob.
   * Advanced — used e.g. to patch a container header on finalize.
   */
  async writeAt(offset: number, chunk: Uint8Array | ArrayBuffer): Promise<void> {
    this.assertOpen()
    await this.session.sendRequest<{bytesWritten: number}>({
      type: MiniappRequestType.BLOB_WRITE,
      key: this.key,
      offset,
      base64: bytesToBase64(toUint8Array(chunk)),
    })
  }

  /** Finalize and return the blob's metadata. Optional `meta` merges into the record. */
  async close(meta?: Record<string, string | number | boolean>): Promise<BlobMeta> {
    this.assertOpen()
    this.settled = true
    return this.session.sendRequest<BlobMeta>({type: MiniappRequestType.BLOB_COMMIT, key: this.key, meta})
  }

  /** Discard the partial blob. Idempotent. */
  async abort(): Promise<void> {
    if (this.settled) return
    this.settled = true
    await this.session.sendRequest<void>({type: MiniappRequestType.BLOB_ABORT, key: this.key})
  }

  private assertOpen(): void {
    if (this.settled) throw new Error("BlobWriter is already closed/aborted")
  }

  private send(base64: string): Promise<{bytesWritten: number}> {
    return this.session.sendRequest<{bytesWritten: number}>({
      type: MiniappRequestType.BLOB_WRITE,
      key: this.key,
      base64,
    })
  }
}

/** Streaming reader (`fs.createReadStream`-like). */
export class BlobReader {
  private closed = false

  constructor(
    private readonly session: MiniappSession,
    readonly handle: string,
    readonly meta: BlobMeta,
  ) {}

  /** Read up to `maxBytes` (default one chunk). `done` is true at end of file. */
  async read(maxBytes = BLOB_WRITE_CHUNK_BYTES): Promise<{bytes: Uint8Array; done: boolean}> {
    if (this.closed) throw new Error("BlobReader is closed")
    const res = await this.session.sendRequest<{base64: string; done: boolean}>({
      type: MiniappRequestType.BLOB_READ,
      handle: this.handle,
      maxBytes,
    })
    return {bytes: base64ToBytes(res?.base64 ?? ""), done: !!res?.done}
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.session.sendRequest<void>({type: MiniappRequestType.BLOB_CLOSE_READ, handle: this.handle})
  }
}

export class BlobModule {
  constructor(private readonly session: MiniappSession) {}

  // ── write ────────────────────────────────────────────────────────────────

  /** Store bytes under `key`. `data` may be a Uint8Array/ArrayBuffer or a base64 string. */
  async set(key: string, data: Uint8Array | ArrayBuffer | string, opts: BlobSetOptions = {}): Promise<BlobMeta> {
    const writer = await this.createWriteStream(key, opts)
    try {
      if (typeof data === "string") await writer.writeBase64(data)
      else await writer.write(data)
      return await writer.close()
    } catch (err) {
      await writer.abort().catch(() => {})
      throw err
    }
  }

  /**
   * Download `url` straight into a blob under `key`, host-side. The bytes never
   * cross the bridge (like the web Cache API's `cache.add`). `opts.headers` lets
   * you pass auth. Resolves to the stored blob's metadata.
   */
  setFromUrl(key: string, url: string, opts: BlobSetFromUrlOptions = {}): Promise<BlobMeta> {
    return this.session.sendRequest<BlobMeta>({
      type: MiniappRequestType.BLOB_SET_FROM_URL,
      key,
      url,
      mimeType: opts.mimeType,
      name: opts.name,
      headers: opts.headers,
      meta: opts.meta,
    })
  }

  /**
   * Open the OS file picker and store the chosen file as a blob, host-side.
   * Resolves to the blob's metadata, or `null` if the user cancelled.
   */
  importFile(opts: BlobImportOptions = {}): Promise<BlobMeta | null> {
    return this.session.sendRequest<BlobMeta | null>({
      type: MiniappRequestType.BLOB_IMPORT,
      key: opts.key,
      mimeType: opts.mimeType,
      meta: opts.meta,
    })
  }

  /** Open a streaming writer for `key` (for large/streamed payloads). */
  async createWriteStream(key: string, opts: BlobSetOptions = {}): Promise<BlobWriter> {
    const res = await this.session.sendRequest<{key: string}>({
      type: MiniappRequestType.BLOB_CREATE,
      key,
      mimeType: opts.mimeType,
      name: opts.name,
      meta: opts.meta,
    })
    return new BlobWriter(this.session, res.key)
  }

  // ── read ─────────────────────────────────────────────────────────────────

  /** Metadata (incl. the `file://` uri) for `key`, or null if absent. */
  get(key: string): Promise<BlobMeta | null> {
    return this.session.sendRequest<BlobMeta | null>({type: MiniappRequestType.BLOB_GET, key})
  }

  /** Alias of `get` — the file-stat verb. */
  stat(key: string): Promise<BlobMeta | null> {
    return this.get(key)
  }

  /** True iff a blob is stored under `key`. */
  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null
  }

  /** Every key this miniapp has stored, newest first. */
  async keys(): Promise<string[]> {
    return (await this.list()).map((m) => m.key)
  }

  /** Every blob this miniapp owns, newest first. */
  async list(): Promise<BlobMeta[]> {
    const res = await this.session.sendRequest<{blobs: BlobMeta[]}>({type: MiniappRequestType.BLOB_LIST})
    return res?.blobs ?? []
  }

  /** Open a streaming reader. Prefer `get(key).uri` when you just need to play/share it. */
  async createReadStream(key: string): Promise<BlobReader> {
    const res = await this.session.sendRequest<{handle: string; meta: BlobMeta}>({
      type: MiniappRequestType.BLOB_OPEN_READ,
      key,
    })
    return new BlobReader(this.session, res.handle, res.meta)
  }

  /** Read a whole blob into memory as bytes, or null if absent. Throws past the cap — stream big ones. */
  async bytes(key: string): Promise<Uint8Array | null> {
    let reader: BlobReader
    try {
      reader = await this.createReadStream(key)
    } catch {
      return null
    }
    const parts: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const {bytes, done} = await reader.read()
        if (bytes.length) {
          total += bytes.length
          if (total > BLOB_READ_ALL_MAX_BYTES) {
            throw new Error(`Blob "${key}" exceeds the in-memory read cap — stream it with createReadStream()`)
          }
          parts.push(bytes)
        }
        if (done) break
      }
    } finally {
      await reader.close().catch(() => {})
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }

  // ── manage ───────────────────────────────────────────────────────────────

  /** Per-app usage + the quota ceiling, in bytes. */
  usage(): Promise<{bytes: number; count: number; quotaBytes: number}> {
    return this.session.sendRequest<{bytes: number; count: number; quotaBytes: number}>({
      type: MiniappRequestType.BLOB_USAGE,
    })
  }

  /** Delete the blob under `key`. No-op if absent. */
  async delete(key: string): Promise<void> {
    await this.session.sendRequest<void>({type: MiniappRequestType.BLOB_DELETE, key})
  }

  /** Delete every blob this miniapp owns. */
  async clear(): Promise<void> {
    await this.session.sendRequest<void>({type: MiniappRequestType.BLOB_CLEAR})
  }

  /** Share the blob via the OS share sheet (host shares from disk — no bytes cross the bridge). */
  async share(key: string): Promise<{success: boolean; cancelled?: boolean}> {
    const res = await this.session.sendRequest<{success: boolean; cancelled?: boolean}>({
      type: MiniappRequestType.BLOB_SHARE,
      key,
    })
    return res ?? {success: false}
  }
}
