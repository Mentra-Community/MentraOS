/**
 * @fileoverview BlobModule — phone-local persistent BINARY storage, scoped to
 * (userId, packageName). The binary counterpart to `session.storage`
 * (SimpleStorage), which is small string KV in MMKV.
 *
 * Blobs are arbitrary bytes written to the phone filesystem
 * (`Paths.document/mentra_blobs/{userId}/{packageName}/{id}`). Each blob has a
 * `BlobMeta` record (id, mimeType, size, timestamps, md5, file:// uri) plus the
 * bytes on disk. Per-app isolation is enforced host-side — a miniapp can only
 * see its own blobs.
 *
 * BACKGROUND-ONLY. Binary doesn't belong in the WebView (DOM memory +
 * postMessage). UIs mirror metadata over the miniapp's own UI channel and issue
 * play/export commands; they never hold bytes.
 *
 * Transfer model — the bridge moves JSON strings through a per-miniapp JS engine
 * (JSC/QuickJS) with a watchdog that kills a context whose single eval blocks
 * too long. So bytes never cross in one shot: writes/reads are CHUNKED
 * (`BLOB_WRITE` / `BLOB_READ`, ≤ ~1 MB raw per call). Audio capture buffers
 * `session.mic.onAudioChunk` frames and streams them here in ~1s chunks — the
 * host stays a generic byte store with no audio-specific code.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"
import {base64ToBytes, bytesToBase64, toUint8Array} from "./base64"

/** Metadata for one stored blob. `uri` is a `file://` path safe for speaker.play / export. */
export interface BlobMeta {
  /** Stable id. Host-assigned (uuid) unless the caller passed an explicit `id`. */
  id: string
  /** Optional human label, e.g. "rec-2026-06-24-1530.wav". */
  name?: string
  /** MIME type, e.g. "audio/wav". */
  mimeType: string
  /** Size on disk in bytes. */
  bytes: number
  /** Epoch ms when first committed. */
  createdAt: number
  /** Epoch ms of the last write. */
  updatedAt: number
  /** Content md5 (lowercase hex), computed host-side on commit. */
  md5?: string
  /** `file://` URI. Feed to `session.speaker.play({audioUrl})` or `blob.export`. */
  uri: string
  /** App-defined metadata persisted alongside the blob (e.g. {durationMs, sampleRate}). */
  meta?: Record<string, string | number | boolean>
}

export interface BlobCreateOptions {
  /** Explicit id. Reusing an existing id overwrites it on commit. Default: host uuid. */
  id?: string
  name?: string
  /** Default "application/octet-stream". */
  mimeType?: string
  meta?: Record<string, string | number | boolean>
}

/** Raw bytes per BLOB_WRITE call. ~1 MB raw → ~1.34 MB base64, well under the watchdog. */
export const BLOB_WRITE_CHUNK_BYTES = 1024 * 1024

/** Max bytes `readAll()` will buffer before throwing BLOB_TOO_LARGE. */
export const BLOB_READ_ALL_MAX_BYTES = 32 * 1024 * 1024

/**
 * Streaming writer. Created by `blob.create()`. Call `write()` as many times as
 * you like (each call is auto-split into bridge-safe chunks), then `commit()` to
 * publish the blob, or `abort()` to discard the partial file.
 */
export class BlobWriter {
  private settled = false

  constructor(
    private readonly session: MiniappSession,
    readonly id: string,
  ) {}

  /** Append bytes. Auto-chunked. Throws if the per-app quota would be exceeded. */
  async write(chunk: Uint8Array | ArrayBuffer): Promise<void> {
    if (this.settled) throw new Error("BlobWriter already committed/aborted")
    const bytes = toUint8Array(chunk)
    for (let offset = 0; offset < bytes.length; offset += BLOB_WRITE_CHUNK_BYTES) {
      const slice = bytes.subarray(offset, offset + BLOB_WRITE_CHUNK_BYTES)
      await this.session.sendRequest<{bytesWritten: number}>({
        type: MiniappRequestType.BLOB_WRITE,
        id: this.id,
        base64: bytesToBase64(slice),
      })
    }
  }

  /**
   * Overwrite bytes at a fixed offset within the not-yet-committed blob (a seek
   * write). Must stay within already-written bytes; does not grow the blob.
   * Used e.g. to patch a WAV header's size fields after the audio is written.
   */
  async writeAt(offset: number, chunk: Uint8Array | ArrayBuffer): Promise<void> {
    if (this.settled) throw new Error("BlobWriter already committed/aborted")
    await this.session.sendRequest<{bytesWritten: number}>({
      type: MiniappRequestType.BLOB_WRITE,
      id: this.id,
      offset,
      base64: bytesToBase64(toUint8Array(chunk)),
    })
  }

  /** Finalize the blob and return its metadata. Optional `meta` merges into the record. */
  async commit(meta?: Record<string, string | number | boolean>): Promise<BlobMeta> {
    if (this.settled) throw new Error("BlobWriter already committed/aborted")
    this.settled = true
    return this.session.sendRequest<BlobMeta>({
      type: MiniappRequestType.BLOB_COMMIT,
      id: this.id,
      meta,
    })
  }

  /** Discard the partial blob. Idempotent. */
  async abort(): Promise<void> {
    if (this.settled) return
    this.settled = true
    await this.session.sendRequest<void>({type: MiniappRequestType.BLOB_ABORT, id: this.id})
  }
}

/** Streaming reader. Created by `blob.open()`. */
export class BlobReader {
  private closed = false

  constructor(
    private readonly session: MiniappSession,
    readonly handle: string,
    readonly meta: BlobMeta,
  ) {}

  /** Read up to `maxBytes` (default one chunk). `done` is true once the end is reached. */
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

  /** Open a streaming writer. */
  async create(opts: BlobCreateOptions = {}): Promise<BlobWriter> {
    const res = await this.session.sendRequest<{id: string}>({
      type: MiniappRequestType.BLOB_CREATE,
      id: opts.id,
      name: opts.name,
      mimeType: opts.mimeType,
      meta: opts.meta,
    })
    return new BlobWriter(this.session, res.id)
  }

  /** Convenience: write a whole buffer and commit. Auto-chunked. */
  async put(data: Uint8Array | ArrayBuffer, opts: BlobCreateOptions = {}): Promise<BlobMeta> {
    const writer = await this.create(opts)
    try {
      await writer.write(data)
      return await writer.commit()
    } catch (err) {
      await writer.abort().catch(() => {})
      throw err
    }
  }

  /** Metadata (incl. `file://` uri) for one blob, or null if absent. */
  get(id: string): Promise<BlobMeta | null> {
    return this.session.sendRequest<BlobMeta | null>({type: MiniappRequestType.BLOB_GET, id})
  }

  /** Alias of `get` — mirrors the file-stat verb. */
  stat(id: string): Promise<BlobMeta | null> {
    return this.session.sendRequest<BlobMeta | null>({type: MiniappRequestType.BLOB_STAT, id})
  }

  /** Every blob this miniapp owns, newest first. */
  async list(): Promise<BlobMeta[]> {
    const res = await this.session.sendRequest<{blobs: BlobMeta[]}>({type: MiniappRequestType.BLOB_LIST})
    return res?.blobs ?? []
  }

  /** Per-app usage + the quota ceiling, in bytes. */
  usage(): Promise<{bytes: number; count: number; quotaBytes: number}> {
    return this.session.sendRequest<{bytes: number; count: number; quotaBytes: number}>({
      type: MiniappRequestType.BLOB_USAGE,
    })
  }

  /** Delete one blob. No-op if absent. */
  async delete(id: string): Promise<void> {
    await this.session.sendRequest<void>({type: MiniappRequestType.BLOB_DELETE, id})
  }

  /** Delete every blob this miniapp owns. */
  async clear(): Promise<void> {
    await this.session.sendRequest<void>({type: MiniappRequestType.BLOB_CLEAR})
  }

  /** Open a streaming reader. Rarely needed — prefer `get().uri` for playback/export. */
  async open(id: string): Promise<BlobReader> {
    const res = await this.session.sendRequest<{handle: string; meta: BlobMeta}>({
      type: MiniappRequestType.BLOB_OPEN_READ,
      id,
    })
    return new BlobReader(this.session, res.handle, res.meta)
  }

  /** Read an entire blob into memory as bytes. Throws BLOB_TOO_LARGE past the cap. */
  async readAll(id: string): Promise<Uint8Array> {
    const reader = await this.open(id)
    const parts: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const {bytes, done} = await reader.read()
        if (bytes.length) {
          total += bytes.length
          if (total > BLOB_READ_ALL_MAX_BYTES) {
            throw new Error(`Blob ${id} exceeds readAll cap (${BLOB_READ_ALL_MAX_BYTES} bytes) — stream it instead`)
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

  /**
   * Share/export a stored blob via the OS share sheet. The host shares the file
   * straight from disk — the bytes never re-enter the JSContext.
   */
  async export(id: string, opts: {mode?: "share" | "download"} = {}): Promise<{success: boolean; cancelled?: boolean}> {
    const res = await this.session.sendRequest<{success: boolean; cancelled?: boolean}>({
      type: MiniappRequestType.BLOB_EXPORT,
      id,
      mode: opts.mode ?? "share",
    })
    return res ?? {success: false}
  }
}
