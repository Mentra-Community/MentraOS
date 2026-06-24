# Miniapp Blob Storage (`session.blob`) + Audio Capture — Phase 2 Spec

Status: **shipped** (PR #3236). The primitive is general-purpose (photos, video,
model files, caches, any miniapp that needs to persist bytes); the Recorder debug
miniapp is the first consumer.

> **What shipped vs. this proposal — read this first.** The original proposal
> below included a *host-side* `session.recorder` that tapped PCM natively and
> wrote the WAV in the mobile app (to avoid the bridge). That was dropped: we do
> **not** want audio-recorder logic baked into the mobile app, and the audio
> bytes already cross the bridge today via `session.mic.onAudioChunk` (base64
> PCM). So the shipped design is:
>
> - **Host:** only the generic `session.blob` byte store. No audio code. One extra
>   generic primitive vs. this doc: `BlobWriter.writeAt(offset, bytes)` (a seek
>   write) so a miniapp can patch a container header on finalize, and an optional
>   `meta` arg on commit.
> - **Miniapp (Recorder):** does all capture itself — subscribes to
>   `session.mic.onAudioChunk`, buffers + base64-decodes frames, writes a 44-byte
>   placeholder WAV header, streams PCM into a blob in ~1.5s chunks, then patches
>   the real header via `writeAt(0, …)` and commits. WAV assembly + level meter +
>   duration all live in the miniapp.
>
> The host implementation sections below are accurate. The `session.recorder` /
> `BLOB_RECORD_*` / host-PCM-tap parts (the "Companion" subsection and ticket 2d)
> were **not** built — ignore them.
>
> **Final API surface** (reshaped for dev-ex to mirror `session.storage`, so the
> method names below in the older API section are superseded by these):
>
> ```ts
> blob.set(key, data, {mimeType?})          // data: Uint8Array | ArrayBuffer | base64 string
> blob.setFromUrl(key, url, {mimeType?, headers?})  // host downloads (like Cache API cache.add)
> blob.importFile({key?, mimeType?})        // OS file picker → blob (null if cancelled)
> blob.get(key) / stat(key)                 // → BlobMeta{key, uri, mimeType, bytes, ...} | null
> blob.bytes(key)                           // → Uint8Array | null (bounded; stream big ones)
> blob.has(key) / keys() / list() / delete(key) / clear() / usage()
> blob.share(key)                           // OS share sheet
> blob.createWriteStream(key) / createReadStream(key)   // streaming; writer: write/writeBase64/writeAt/close/abort
> ```
>
> `setFromUrl` + `importFile` keep bytes entirely host-side (the canonical mobile
> pattern: iOS `URLSession` download / Android `DownloadManager` / web
> `cache.add` / `expo-file-system.downloadFileAsync` + `pickFileAsync`). Blobs
> are background-only; a blob `uri` is a private `file://` a WebView generally
> can't load directly — render via a host capability for now (accepted for v1).

## Why this exists

`session.storage` (SimpleStorage) is a string KV store backed by MMKV, scoped to
`(userId, packageName)`, meant for settings/small state (< ~1 MB). There is **no
binary/file store** in the miniapp SDK today — which is exactly why the original
cloud Recorder needed R2 + local disk + Mongo.

Phase 1 (separately specced) shows you can already capture mic audio
(`mic.onAudioChunk` → base64 PCM16, ~16 kHz, host-forced PCM) and one-shot
**export** a WAV via `system.download`/`share`. What Phase 1 *cannot* do:
re-openable on-device library, on-device playback, or recordings longer than
what fits in JS memory + a single bridge envelope (~10 min). Phase 2 fixes all
three by adding a real persistent binary store.

## The hard constraint that shapes everything: the bridge

The miniapp **background** runs in a per-miniapp JS engine hosted by the **Crust**
native module — **JavaScriptCore on iOS** (`mobile/modules/crust/ios/Source/JSCRuntime.swift`),
**QuickJS on Android** (`mobile/modules/crust/android/.../JSCRuntime.kt`). The
bridge to the RN host (`LocalMiniappRuntime.ts`, Hermes) moves **strings**:

- JS→host: `globalThis.__dispatch("__bridge","send", JSON.stringify([raw]))`
  (sync native function) → `mentrajs_message` event → `LocalMiniappRuntime.handleRawMessage`.
- host→JS: `Crust.mentraJsDispatchToJs(pkg, …)` → evaluate `globalThis.__deliver(<jsStringLiteral(json)>)`
  on the context's serial queue (iOS) / single-thread executor (Android).

Properties that matter:

1. **Every byte is JSON-serialized twice** (encode the envelope, then embed it in
   a JS string literal for `eval`) and base64 inflates payloads +33%.
2. **A single `__deliver` eval blocks the context thread.** A watchdog **warns at
   5 s and KILLS the context at 30 s** (JSCRuntime, both platforms).
3. There is **no hard frame cap**, but a 30 MB string spikes memory on both
   engines and risks the watchdog.

**Implication:** never move a whole recording across the bridge in one call.
Two consequences drive the design:

- The general blob API uses **chunked** read/write (≤ ~2 MB base64 per call).
- The Recorder does **not** push audio bytes through the bridge at all — the host
  taps the PCM it *already has* (`MantleManager.ts:1087` forwards
  `event.pcm` from the BT SDK) and writes the WAV **host-side**, with only a
  `blobId` + progress crossing the bridge. (The "think very hard" insight: the
  naive design streams 70 MB through JSC/QuickJS; the right design keeps the bytes
  on the native side where they originate.)

This also means **Phase 2 needs no new Crust/JSC/QuickJS native engine work** —
it is SDK TypeScript (`@mentra/miniapp`) + host TypeScript (`LocalMiniappRuntime`)
+ `expo-file-system` + MMKV. "iOS and Android" is handled by the cross-platform
host layer and Expo FS, not by parallel Swift/Kotlin. The few genuinely
platform-specific items are called out in **§Platform notes**.

---

## Public API — `session.blob` (background-only)

Binary never belongs in the WebView (DOM memory + postMessage). The UI mirrors
**metadata** over the miniapp's own UI channel and issues play/export *commands*;
it never holds bytes. `session.blob` is exported only from `@mentra/miniapp/background`.

```ts
interface BlobMeta {
  id: string            // host-assigned (uuid) unless caller passes a key
  name?: string         // human label, e.g. "rec-2026-06-24-1530.wav"
  mimeType: string      // "audio/wav", "image/jpeg", …
  bytes: number         // decoded size on disk
  createdAt: number      // epoch ms
  updatedAt: number
  sha256?: string        // optional integrity hash (computed host-side on commit)
  uri: string           // file:// path — feed to speaker.play / system export
  meta?: Record<string, string | number | boolean>  // app-defined (e.g. {durationMs, sampleRate})
}

// ---- write (streaming, chunked under the hood) ----
session.blob.create(opts?: {id?: string; name?: string; mimeType?: string; meta?: …}): Promise<BlobWriter>
interface BlobWriter {
  readonly id: string
  write(chunk: Uint8Array | string /*base64*/): Promise<void>  // auto-splits > MAX_CHUNK
  commit(): Promise<BlobMeta>     // atomically publishes; returns final meta+uri
  abort(): Promise<void>          // discards the partial file
}
// convenience for a buffer already in JS (auto-chunks internally):
session.blob.put(data: Uint8Array | string, opts?: {id?; name?; mimeType?; meta?}): Promise<BlobMeta>

// ---- read ----
session.blob.get(id: string): Promise<BlobMeta | null>     // metadata + uri, NO bytes
session.blob.list(): Promise<BlobMeta[]>                     // this app's blobs, newest first
session.blob.open(id: string): Promise<BlobReader>          // streaming byte read (rarely needed)
interface BlobReader {
  read(maxBytes?: number): Promise<{ base64: string; done: boolean }>
  close(): Promise<void>
}
session.blob.readAll(id: string): Promise<string /*base64*/>  // bounded convenience; throws BLOB_TOO_LARGE

// ---- manage ----
session.blob.stat(id: string): Promise<BlobMeta | null>
session.blob.delete(id: string): Promise<void>
session.blob.clear(): Promise<void>
session.blob.usage(): Promise<{ bytes: number; count: number; quotaBytes: number }>

// ---- export off-device (host shares from disk; NO bridge round-trip) ----
session.blob.export(id: string, opts?: { mode?: "share" | "download" }): Promise<ShareResult>
```

### Companion: host-side audio capture → blob (the Recorder's engine)

Separate, optional capability. Requires `MICROPHONE` in the manifest. Writes the
WAV entirely host-side; bytes never cross the bridge.

```ts
session.recorder.start(opts?: {
  format?: "wav" | "pcm";    // default wav
  name?: string;
  // future: source?: "glasses" | "phone"
}): Promise<{ recordingId: string; blobId: string }>
session.recorder.stop(recordingId: string): Promise<BlobMeta>   // finalizes header, returns blob
session.recorder.cancel(recordingId: string): Promise<void>
session.recorder.onProgress(handler: (e: { recordingId: string; ms: number; bytes: number; level?: number }) => void): UnsubscribeFn
session.recorder.active(): Promise<{ recordingId: string; blobId: string; ms: number } | null>
```

The Recorder miniapp becomes a thin UI over `recorder.start/stop/onProgress` +
`blob.list/get/delete/export` + `speaker.play(meta.uri)` for on-glasses playback.

---

## Wire protocol additions (`protocol.ts`)

`MiniappRequestType` (new):
```
BLOB_CREATE        = "miniapp_blob_create"     // → { id }
BLOB_WRITE         = "miniapp_blob_write"      // { id, seq, base64 } → { bytesWritten }
BLOB_COMMIT        = "miniapp_blob_commit"     // { id, meta? } → BlobMeta
BLOB_ABORT         = "miniapp_blob_abort"      // { id }
BLOB_GET           = "miniapp_blob_get"        // { id } → BlobMeta | null
BLOB_LIST          = "miniapp_blob_list"       // → BlobMeta[]
BLOB_STAT          = "miniapp_blob_stat"
BLOB_DELETE        = "miniapp_blob_delete"
BLOB_CLEAR         = "miniapp_blob_clear"
BLOB_USAGE         = "miniapp_blob_usage"       // → { bytes, count, quotaBytes }
BLOB_OPEN_READ     = "miniapp_blob_open_read"   // { id } → { handle, bytes }
BLOB_READ          = "miniapp_blob_read"        // { handle, maxBytes } → { base64, done }
BLOB_CLOSE_READ    = "miniapp_blob_close_read"
BLOB_EXPORT        = "miniapp_blob_export"       // { id, mode } → ShareResult  (host shares from disk)
// recorder companion
BLOB_RECORD_START  = "miniapp_blob_record_start" // → { recordingId, blobId }
BLOB_RECORD_STOP   = "miniapp_blob_record_stop"  // { recordingId } → BlobMeta
BLOB_RECORD_CANCEL = "miniapp_blob_record_cancel"
```

`MiniappStreamType` (new): `BLOB_RECORD_PROGRESS = "blob_record_progress"` (host
push for `recorder.onProgress`, subscriber-gated like other streams).

`MiniappErrorCode` (new): `BLOB_NOT_FOUND`, `BLOB_QUOTA_EXCEEDED`,
`BLOB_TOO_LARGE`, `BLOB_HANDLE_INVALID`, `BLOB_WRITE_FAILED`.

Chunking constant: `MAX_BLOB_CHUNK_BASE64 = 1.5 * 1024 * 1024` (≈ 1.1 MB raw).
Keeps any single `__deliver` eval well under the 5 s watchdog warn on low-end
Android. `put()`/`BlobWriter.write()` auto-split larger inputs and `await` each
chunk sequentially (per-context serial execution → no benefit to parallel).

---

## Host implementation (`LocalMiniappRuntime.ts`)

### Physical layout

- **Bytes:** `Paths.document/mentra_blobs/{userId}/{packageName}/{id}` (persistent;
  NOT `Paths.cache`, which the OS can evict). `userId` resolved exactly as the
  storage handlers do (`getRuntimeHooks().settings?.getSetting(coreToken) || "anonymous"`).
- **Index/metadata:** MMKV (mirror SimpleStorage), one key per blob:
  `mentraos_blobmeta_{userId}_{packageName}_{id}` → JSON `BlobMeta` (minus `uri`,
  which is derived on read). `list()`/`usage()` do a prefix scan, exactly like
  `STORAGE_LIST` (LocalMiniappRuntime.ts ~1890). Per-app isolation is automatic.

### Streaming write (the core)

`BLOB_CREATE` opens an `expo-file-system` write handle to `…/{id}.part` and
records an in-memory `ActiveUpload{ id, handle, bytes, pkg }` keyed by id.
`BLOB_WRITE` base64-decodes the chunk (`Buffer.from(b64,"base64")`) and appends
via the handle (`FileHandle.writeBytes`), bumping `bytes`. `BLOB_COMMIT` flushes,
**fsyncs**, **renames `{id}.part` → `{id}` atomically**, writes the MMKV meta
entry (so a half-written blob is never visible in the index), drops the
in-memory handle, and returns `BlobMeta`. `BLOB_ABORT` / session teardown closes
the handle and deletes `{id}.part`.

> Verification item: the new `expo-file-system` `File.open()` → `FileHandle`
> (append/seek `writeBytes`) must be available in the pinned Expo version on both
> platforms. Fallback if not: write sequential `{id}.partN` files and concatenate
> on commit via a single streamed pass (still O(n) disk, O(chunk) memory).
> **Pick this before 2a estimation.**

### Host-side recorder (no bridge for bytes)

`BLOB_RECORD_START`: gate on manifest `MICROPHONE`; create a blob writer to
`{blobId}.part`; write a **WAV header with placeholder sizes** (RIFF size + data
size = 0); subscribe to the same PCM source MantleManager forwards
(`event.pcm`, `event.sampleRate`) — at the **host**, before base64/bridge; append
raw PCM frames straight to the handle; emit `BLOB_RECORD_PROGRESS` every ~250 ms
with `{ms, bytes, level}`. `BLOB_RECORD_STOP`: stop the tap, **seek-patch the two
WAV size fields** to the real lengths, fsync, rename, write MMKV meta
(`meta.durationMs`, `meta.sampleRate`), return `BlobMeta`.

Crash/teardown safety: a `.part` left by a killed app is repairable on next
start — recompute WAV sizes from on-disk byte length (header is fixed 44 bytes)
and either finalize or discard per a `recoverPartialRecordings()` sweep. Orphan
`.part` files with no MMKV entry are GC'd at runtime init.

### Quota + GC

- Per-app quota `BLOB_QUOTA_BYTES_DEFAULT` (proposal: 256 MB; configurable per
  app later). Enforced on `BLOB_WRITE`/record append → reject with
  `BLOB_QUOTA_EXCEEDED` and abort the upload.
- Optional per-app auto-evict policy in meta (`keepLast: N` or `maxBytes`),
  oldest-first, applied on commit. Off by default (debug recorder wants durable).
- **Uninstall GC:** when a miniapp is removed/cleared, delete its blob dir +
  prefix-scan its MMKV meta keys. Hook the existing app-removal path.
- A startup sweep reconciles MMKV index ↔ disk (drop meta with no file, GC files
  with no meta).

### Export from disk (no round-trip)

`BLOB_EXPORT` resolves the blob's file path and calls the existing
`Share.open({url: file.uri, type: mimeType, filename: name})` used by
`handleShare`/`handleDownload` (LocalMiniappRuntime.ts:2079/2156) — but reads from
the persistent blob file, so the bytes never re-enter the JSContext. Cheap add;
big win for the recorder ("AirDrop to Mac" / "Save to Files").

---

## Platform notes (iOS vs Android — the parts that actually differ)

Most logic is shared TS. Genuinely platform-specific:

- **iOS backup exclusion.** `Paths.document` on iOS = the app's Documents dir,
  which is **backed up to iCloud by default**. Multi-hundred-MB debug audio must
  NOT bloat user iCloud backups — set `NSURLIsExcludedFromBackupKey` on the
  `mentra_blobs` dir (or place it under `Application Support` / a no-backup
  subdir). Android `Paths.document` = internal app files dir, not user-visible, no
  backup concern.
- **`FileHandle` append/seek parity.** Verify `expo-file-system` streaming write +
  seek-patch (for the WAV size fields) behaves identically on JSC-less Hermes host
  on both platforms (it's Expo native under the hood — RNFS-style). This is the #1
  thing to de-risk in 2a.
- **`file://` playback.** `speaker.play({audioUrl})` passes the URL unchanged to
  `getRuntimeHooks().audioPlayback?.play` (LocalMiniappRuntime.ts ~1399) with no
  scheme validation. iOS AVPlayer and Android ExoPlayer/MediaPlayer both accept
  file URLs, but the adapter may assume http. **Verify + add file:// handling in
  the audio adapter on each platform** (2c). Fallback: play via a local loopback
  is overkill — just fix the adapter.
- **Background writing.** The host-side recorder must keep writing while the phone
  is backgrounded. The audio pipeline already runs in background for transcription
  (iOS mic background entitlement is present), so the tap inherits it — but confirm
  the PCM forward in MantleManager isn't gated to foreground.
- **Watchdog is JSContext-only.** Host file I/O can't trip it; only the chunked
  bridge read/write can. `MAX_BLOB_CHUNK_BASE64` is the knob that keeps every
  `__deliver` eval < 5 s even on low-end Android QuickJS.

---

## Edge cases / invariants

- Handles (`BlobWriter`, `BlobReader`, recordings) are **scoped per-miniapp**;
  reject cross-app handle ids with `BLOB_HANDLE_INVALID`.
- **Session teardown mid-write/record:** `onBeforeDisconnect` aborts active
  uploads (delete `.part`) and finalizes or discards active recordings per policy
  — no orphans, no half-blobs in the index.
- **Atomicity:** index entry is written only after the `.part`→final rename, so a
  crash never surfaces a partial blob via `list()`.
- **Integrity:** `sha256` computed host-side during commit (streamed) so the debug
  tool can assert "bytes captured intact."
- **One active recording per miniapp** (v1); `start()` while active rejects.
- Concurrency: writes within a miniapp are serialized by the per-context bridge
  anyway; host guards against interleaved chunks for the same id by `seq`.

---

## Phasing / tickets

**2a — Blob core.** `session.blob` SDK module (`@mentra/miniapp/background`) +
protocol types + host handlers (create/write/commit/abort/get/list/stat/delete/
clear/usage/open-read/read/close-read) + streaming FileHandle write + MMKV index +
per-app quota + startup index↔disk reconcile. Unit tests on the chunk splitter +
host handlers. *Files:* `protocol.ts`, new `modules/blob.ts`, `session.ts`,
`background/index.ts`, `LocalMiniappRuntime.ts`. **De-risk first:** FileHandle
append/seek availability. No native engine work.

**2b — Export from disk.** `BLOB_EXPORT` + `blob.export()`; share/download read
the persistent file directly. *Files:* `modules/blob.ts`, `LocalMiniappRuntime.ts`.

**2c — On-device playback.** Verify + wire `file://` through the audio adapter on
iOS + Android so `speaker.play(meta.uri)` works. *Files:* audio playback adapter
(both platforms), small.

**2d — Host-side audio recorder.** `session.recorder` module + `BLOB_RECORD_*` +
`BLOB_RECORD_PROGRESS` stream + host PCM tap → streaming WAV (placeholder header,
seek-patch on stop) + `recoverPartialRecordings()`. *Files:* `modules/recorder.ts`,
`protocol.ts`, `LocalMiniappRuntime.ts`, MantleManager tap hook. This is the
Recorder's real engine.

**2e — Lifecycle hardening.** iOS no-backup flag; uninstall GC; orphan/`.part`
sweep; auto-evict policy; sha256; quota error surfacing. Cross-cutting.

**2f — Recorder miniapp.** Thin UI over recorder + blob (record/stop, list with
duration/size, play on glasses via uri, export, delete), light-default/dark via
`useColorScheme`, packed into `mobile/assets/miniapps/` + bundledMiniapps codegen.

**Sequencing for a usable recorder fast:** 2a-core (write/list/get/delete/usage) →
2d → 2f gives a durable on-device recordings library with host-side capture and
export. 2b/2c/2e harden and add playback. 2a's full read API can trail if nothing
needs in-JS bytes yet.

## Open decisions (need a call)

1. **Default per-app quota** — 256 MB proposed. Debug audio at PCM16/16k is
   ~112 MB/hour, so 256 MB ≈ ~2.3 h total retained. Higher for a debug build?
2. **Auto-evict default** — off (durable) vs keep-last-N. Recommend off; add a
   "clear all" in the recorder UI.
3. **Format** — WAV default (opens anywhere, carries sample rate). Offer raw
   `.pcm` export toggle for pipeline diffing?
4. **Cross-app/system read** — keep per-app isolation for v1 (no sharing). OK?
5. **expo-file-system FileHandle** present in our pinned version? (Gates 2a est.)
