---
status: draft
owner: philippe
---

# Glasses gallery: SDK primitives and engine sync controller

Fifth spec. It gives the gallery the same two-layer shape the other hotspot features have:
single-purpose primitives in the Bluetooth SDK, and a flow with policy, persistence and a
headless controller in the engine, mirroring the OTA controller pattern.

## What exists today

- **On the glasses**, `AsgCameraServer` serves the gallery over HTTP on port 8089 of the
  hotspot with no authentication and open CORS. Two API generations coexist: the legacy
  `/api/gallery`, `/api/photo`, `/api/download`, `/api/delete-files`, `/api/sync` set, and the
  v3 set built for reliable transfer: `/api/v3/capabilities`, a paginated, keyset-cursored
  `/api/v3/manifest` grouped by capture with per-file ETags, `/api/v3/hash` for SHA-256,
  `/api/download` with HTTP Range and If-Range, and an idempotent `/api/v3/ack` that moves a
  capture to recoverable trash, with `/api/v3/trash` and `/api/v3/restore`. Deleting is never a
  hard delete; `/api/cleanup` garbage-collects acknowledged trash after a retention floor.
- **In the Bluetooth SDK**, there is no gallery HTTP client at all. The SDK exposes only the BLE
  side: `setHotspotState`, `setGalleryModeEnabled`, `queryGalleryStatus` and the
  `gallery_status` event. Everything over HTTP is reimplemented by each consumer.
- **In the engine**, `gallerySyncService` owns the full flow: request the hotspot, join it,
  page the manifest, download each capture by segments with ETag and SHA-256 verification,
  index it, export it to the camera roll, acknowledge it on the glasses, all tracked in a
  persisted `galleryTransferLedger` with states from `DISCOVERED` to `TRASHED`; a persisted
  `SyncQueue` allows resume after an app restart within two minutes; a one-time join
  explanation notice; and the iOS SSID-unreadable tolerance. `asgCameraApi` is its HTTP client.
  The `engine.gallery` facade exposes status, notices, sync, cancel, refresh and queue edits;
  there is no headless controller, no hook and no stock component, and the only UI is the
  Mentra App's `GalleryScreen`.
- **In the Starter Kit**, the Camera tab hand-builds all of it: enable the hotspot, join with
  `react-native-wifi-reborn`, poll `/api/health`, GET `/api/gallery?limit=100`, download by
  `photo.url`. A second, weaker gallery client.

## Decisions

1. **Primitives in the SDK, policy in the engine.** `@mentra/bluetooth-sdk/gallery` is a typed
   client for the glasses gallery HTTP API over a hotspot session: list, capture detail, file
   download with resume, hash, acknowledge, restore, trash. It holds no queue, no ledger, no
   camera-roll export and no notion of "sync". `@mentra/engine/gallery` owns the sync flow and
   becomes the first caller of the SDK client; `asgCameraApi` is replaced by it.
2. **v3 only in the client.** The SDK client speaks the v3 API (`capabilities`, `manifest`,
   `hash`, `download` with Range, `ack`, `trash`, `restore`) and reads `/api/health`. The legacy
   list, sync and delete routes stay served by the glasses for older apps but the client does
   not expose them; a `capabilities()` check reports a glasses build that lacks v3 with a clear
   error instead of a silent fallback.
3. **Requests take a `NetworkRef`, never a base URL.** Every call is bound to the hotspot
   session generation through `session.fetch` and `session.download` from the hotspot spec, so a
   request can never ride a stale or replaced network and the glasses address comes from the
   binding, not from a constant like the `192.168.43.1` the Starter Kit falls back to today.
4. **Delete means acknowledge.** The client exposes `acknowledge(captureId, ackId)` and never a
   "delete"; the glasses move the capture to recoverable trash and the caller can `restore`
   within the retention window. This is the semantics the engine already relies on and the only
   safe default for an integrator.
5. **The engine controller mirrors OTA exactly.** `createGallerySyncController(options)` is a
   non-React controller over `gallerySyncService`, exposing a semantic state and idempotent
   actions; `useGallerySync(options)` is a thin subscription over it; `GallerySyncFlow` is the
   stock component with the same theming and translation props as `MentraLiveOtaFlow`. The
   `engineHotspot.gallerySync` facade delegates to the same controller instance, as its `ota`
   half delegates to the OTA controller. No second gallery lifecycle is introduced.
6. **The sync service moves onto the hotspot session without changing its policy.** Its
   `startSync`, `resumeSync` and `cancelSync` semantics, the two-minute queue age guard, the
   ledger transitions, camera-roll export and the join explanation are unchanged; only the
   transport underneath (hotspot enable, join, address, loss handling, HTTP) becomes the SDK
   hotspot session plus the SDK gallery client. `resumeSync` reuses a session that is still
   `ready` instead of re-running the whole setup, which is what the hotspot spec's consumer row
   already says.
7. **The Starter Kit Camera tab moves onto the SDK client.** Its hotspot join, health polling and
   ad hoc gallery calls are replaced by a hotspot session and `glassesGallery`; the "Glasses
   hotspot" panel it shows stays and is driven by `useGlassesHotspot()`, the same panel the
   Stream tab gains in the public surface spec.

## Bluetooth SDK: `@mentra/bluetooth-sdk/gallery`

```ts
import {glassesGallery} from "@mentra/bluetooth-sdk/gallery"
import type {HotspotSession, NetworkRef} from "@mentra/bluetooth-sdk/hotspot"

export type GalleryCapabilities = {
  apiVersion: 3
  rangeDownloads: boolean
  etag: boolean
  sha256: boolean
  recoverableTrash: boolean
  idempotentAck: boolean
  recommendedSegmentBytes: number
  maxManifestPageSize: number
  serverTime: number
}

export type GalleryFileRole = "primary" | "thumbnail" | "imu" | (string & {})
export type GalleryFile = {name: string; size: number; modified: number; mimeType: string; role: GalleryFileRole; etag: string}
export type GalleryCapture = {
  captureId: string
  requestId?: string
  type: "photo" | "video"
  timestamp: number
  totalSize: number
  files: GalleryFile[]
  thumbnailUrl?: string
  cursor: string
}
export type GalleryPage = {captures: GalleryCapture[]; hasMore: boolean; nextCursor: string | null; totalCount: number; serverTime: number}

export type GalleryDownloadOptions = {
  destination: string                       // local file path; resumed if a partial file with a matching ETag exists
  segmentBytes?: number                     // default: capabilities.recommendedSegmentBytes
  verify?: "sha256" | "etag" | "none"       // default "sha256": compare against /api/v3/hash after assembly
  signal?: AbortSignal
  onProgress?: (p: {bytesWritten: number; totalBytes: number}) => void
}
export type GalleryDownloadResult = {path: string; bytes: number; etag: string; sha256?: string}

export type GalleryErrorCode =
  | "unsupported_api"        // glasses build without v3
  | "unreachable"            // /api/health not answering on the binding
  | "stale_generation"       // ref is no longer the session's current generation
  | "not_found"              // capture or file gone (trashed or garbage collected)
  | "capture_busy"           // active recording or zero-byte primary; retry later
  | "integrity_mismatch"     // hash or ETag did not match after download
  | "cancelled"
  | "http"                   // details.status carries the code

export interface GlassesGalleryClient {
  capabilities(ref: NetworkRef): Promise<GalleryCapabilities>
  health(ref: NetworkRef): Promise<boolean>
  /** Newest first, keyset paginated; pass the previous page's nextCursor. */
  listCaptures(ref: NetworkRef, opts?: {limit?: number; cursor?: string}): Promise<GalleryPage>
  getCapture(ref: NetworkRef, captureId: string): Promise<GalleryCapture>
  /** Range-resumable segmented download of one file, with the verification the options ask for. */
  downloadFile(ref: NetworkRef, file: GalleryFile, opts: GalleryDownloadOptions): Promise<GalleryDownloadResult>
  hash(ref: NetworkRef, fileName: string): Promise<{size: number; etag: string; sha256: string}>
  /** Idempotent: moves the capture to recoverable trash on the glasses. ackId must be stable per capture per client. */
  acknowledge(ref: NetworkRef, captureId: string, ackId: string): Promise<{alreadyTrashed: boolean; fileCount: number; totalSize: number}>
  listTrash(ref: NetworkRef): Promise<Array<{captureId: string; fileCount: number; totalSize: number; trashedAt: number}>>
  restore(ref: NetworkRef, captureId: string): Promise<void>
  /** Thumbnail bytes or a photo's bytes for display; videos return their generated thumbnail. */
  fetchPreview(ref: NetworkRef, fileName: string): Promise<Blob>
}

/** Bound to a session: every call uses the session's current binding and fails with stale_generation after a loss. */
export const glassesGallery: {
  for(session: HotspotSession): GlassesGalleryClient
}
```

Usage for an integrator:

```ts
const session = await glassesHotspot.acquire({purpose: "my_app_gallery", operationId: "gallery:1", uplink: "none", recovery: {mode: "auto", ...}})
const binding = await session.start(client)
const gallery = glassesGallery.for(session)
const page = await gallery.listCaptures(binding, {limit: 50})
for (const capture of page.captures) {
  const primary = capture.files.find(f => f.role === "primary")!
  await gallery.downloadFile(binding, primary, {destination: pathFor(primary), verify: "sha256"})
  await gallery.acknowledge(binding, capture.captureId, `my-app:${capture.captureId}`)
}
await session.release()
```

The BLE side is unchanged and stays where it is: `setGalleryModeEnabled`, `queryGalleryStatus`
and the `gallery_status` event on the SDK root.

Native, same shape: `GlassesGallery.forSession(session)` in Kotlin and Swift with suspend and
async equivalents of the methods above, using the hotspot lease's bound network.

## Engine: `@mentra/engine/gallery`

```ts
export type GallerySyncScreen =
  | "idle"                // nothing to sync or not started; state.glasses tells whether there is content
  | "requesting_hotspot"
  | "joining"             // includes the one-time explanation notice
  | "syncing"
  | "complete"
  | "error"
  | "cancelled"

export type GallerySyncState = {
  screen: GallerySyncScreen
  connected: boolean
  glasses: {photos: number; videos: number; total: number; totalSize?: number; hasContent: boolean; cameraBusy: boolean}
  hotspot: HotspotState | null            // from the SDK session while the flow holds it
  queue: {total: number; completed: number; failed: string[]; current: {captureId: string; fileName: string; percent: number} | null}
  resumable: boolean                      // a persisted queue younger than the age guard exists
  error: {code: string; message: string} | null
  canSync: boolean
  canResume: boolean
  canCancel: boolean
  canRetry: boolean
}

export type GallerySyncController = {
  state: GallerySyncState
  refreshStatus: () => void              // queryGlassesGalleryStatus over BLE
  sync: () => void                        // startSync
  resume: () => void                      // resumeSync; no-op when not resumable
  cancel: () => void                      // cancelSync; the ledger keeps verified files
  retry: () => void                       // sync again after error; failed captures are retried first
  removeFromQueue: (fileNames: string[]) => void
  subscribe: (listener: (state: GallerySyncState) => void) => () => void
}

export type CreateGallerySyncControllerOptions = {
  onFinished?: () => void
  onNotice?: (notice: GalleryNotice) => void   // the connect_to_glasses explanation and later notices, for custom UI
}

export function createGallerySyncController(options?: CreateGallerySyncControllerOptions): GallerySyncController
export function useGallerySync(options?: CreateGallerySyncControllerOptions): GallerySyncController

export type GallerySyncFlowProps = {
  onFinished: () => void
  translate?: (key: string, options?: Record<string, string>) => string
  theme?: Partial<MentraLiveOtaFlowTheme>   // the same theme type as the OTA flow, so one theme skins both
  style?: StyleProp<ViewStyle>
}
export function GallerySyncFlow(props: GallerySyncFlowProps): JSX.Element
```

The controller is a projection over `gallerySyncService` and its store, plus the hotspot
session snapshot; its actions call the service's existing methods. `engineHotspot.gallerySync`
in the public surface spec becomes `Pick<GallerySyncController, ...>` over the same instance,
as the OTA half is over the OTA controller. The `engine.gallery` facade's existing members keep
working as aliases for one release, then point at the controller.

### Sync service changes

| Today | After |
|---|---|
| `setHotspotState`, `connectToHotspotWifi` with `react-native-wifi-reborn`, `waitForGalleryServer`, `HOTSPOT_CONNECT_DELAY_MS`, the iOS SSID verification loop | a hotspot session with `consumer: "gallery_sync"`, `beforeJoin` carrying the one-time explanation; SSID verification and its permission tolerance move into the SDK's iOS driver where the hotspot spec already requires them |
| `asgCameraApi` (list, manifest, hash, segmented download, ack, restore, delete, health) | `glassesGallery.for(session)`; the legacy `deleteFilesFromServer` and `/api/sync` paths are deleted |
| `resumeSync` re-running `startSync` because "stale hotspot credentials are unreliable" | reuse the session when it is still `ready`; otherwise acquire again; the queue age guard stays |
| loss handling by aborting downloads and disconnecting | the session client's `quiesce` cancels transfers and keeps the ledger, `restore` continues the queue from the ledger |
| ledger, media processing queue, camera-roll export, ack after export | unchanged |

## Starter Kit: Camera tab

- `prepareGlassesPhotoPreviewConnection` and its Wi-Fi join, health polling and base URL
  fallback are replaced by a hotspot session and `glassesGallery.for(session)`.
- `downloadGlassesPhotoPreview` lists captures by `requestId` through `listCaptures` and
  downloads with `downloadFile` and `verify: "sha256"`; the saved-photo preview uses
  `fetchPreview`.
- The "Glasses hotspot" panel stays and is driven by `useGlassesHotspot()`; a busy hotspot,
  for example a Stream tab preview, shows the owner instead of failing the join.
- The Kotlin and Swift examples get the same through the native client.

## Documentation

- `mintlify-docs/bluetooth-sdk/camera-streaming.mdx` gains a "Reading the glasses gallery over
  the hotspot" section: session, list, download with verification, acknowledge and restore,
  with the note that acknowledge is recoverable trash.
- `mintlify-docs/bluetooth-sdk/api-reference.mdx` gains the `gallery` subpath.
- Engine docs gain `@mentra/engine/gallery` next to `@mentra/engine/ota`, with the same
  "customize the pages with the hook" section the OTA page has.

## Migration

Depends on hotspot spec steps 1 and 2.

1. **SDK gallery client** over a hotspot session, v3 only, with tests against a recorded set of
   glasses responses: pagination cursors, resumed download with a matching ETag, hash mismatch,
   busy capture, idempotent acknowledge, restore, and `stale_generation` after a loss.
2. **Sync service onto the session and the client** behind the existing `engine.gallery`
   facade, keeping the ledger and media processing queue untouched; hardware qualification on
   Mentra Live for photos and videos, loss mid-download with resume, app restart within the
   queue window, and acknowledge after camera-roll export.
3. **Controller, hook and stock component**; `GalleryScreen` in the Mentra App moves onto the
   hook; `engineHotspot.gallerySync` delegates to the controller.
4. **Starter Kit Camera tab** onto the SDK client, after the SDK release that carries it.
5. Delete `asgCameraApi`'s gallery half and the legacy delete and sync paths.

## Risks

- **v3-only client against older glasses.** A glasses build without v3 gets `unsupported_api`;
  the engine's sync must keep working for those until the firmware floor catches up, so step 2
  keeps the legacy manifest path alive behind the capabilities check until the release notes
  say the floor is past, then step 5 removes it.
- **Ack idempotency across clients.** Two apps acknowledging the same capture with different
  ack ids is fine on the glasses, but a stale ack id from a wiped app can trash a capture the
  user re-downloaded elsewhere; the client requires a per-client stable ack id and the docs
  say why.
- **Camera-roll export permission** stays the engine's concern; the SDK client never touches
  the OS photo library.
- **One theme type for two flows** couples the gallery component to the OTA theme; acceptable
  because both are Mentra Live device flows, revisit if a third device flow appears.
