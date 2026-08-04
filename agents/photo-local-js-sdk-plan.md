# Move local-miniapp photo capture to phone-orchestrated v2 flow

**Status:** Draft for review
**Scope:** Replace the never-shipped prototype (`/api/client/miniapp-sdk-photo/*` + `MiniappSdkPhotoManager`) with a clean phone-orchestrated path that mirrors the streaming v2 design.

## Why

The existing local-miniapp photo path is a prototype that was never used in production. It uses two cloud-WebSocket round trips (cloud-emits-PHOTO_REQUEST + cloud-emits-`phone_photo_ready`) even though the phone is already the orchestrator. The phone could mint a token itself and drive the glasses directly over BLE.

This is the same shape we fixed for streaming. Same fix here.

Cloud-app photo capture (third-party SDK developers, via `PhotoManager` / `CameraManager`) is a completely separate code path and stays untouched.

## What stays the same

Critical: this design needs **zero asg_client changes** and **zero changes to the BLE photo pipeline on the phone** (`BlePhotoUploadService.java`).

- `asg_client/.../PhotoCommandHandler.java` already accepts arbitrary `webhookUrl` and `authToken` in the BLE `take_photo` command. Glasses POST multipart to whatever URL the phone hands them, with whatever bearer token the phone hands them.
- `BlePhotoUploadService.java` already handles BLE-fallback uploads (glasses → BLE → phone → cloud) using the same webhook URL + token the phone already had on hand.

So the entire "capture and upload" mechanical pipeline is reusable as-is. What we're changing is **how the URL + token get minted, and how the result comes back to the miniapp.**

## Architecture

```
miniapp → session.camera.takePhoto(opts)
       → SDK → LocalMiniappRuntime → photo runtime hook
       → PhonePhotoCoordinator.takePhoto(packageName, opts)
            ├── POST /api/v2/client/photo/request
            │      cloud mints {requestId, uploadUrl, uploadToken (~120s JWT)}
            │      cloud records {requestId → userId} in in-memory map
            ├── CoreModule.photoRequest(requestId, packageName, size, uploadUrl, uploadToken, compress, flash, sound)
            │      glasses POST multipart to uploadUrl
            │      (or BLE-fallback: phone receives bytes, posts itself)
            └── GET /api/v2/client/photo/:requestId  (long-poll, 30s timeout)
                   resolves when /upload completes → returns {photoUrl, mimeType, size}
       → miniapp's Promise resolves with PhotoTaken
```

No WebSocket involvement. Cloud is a stateless three-endpoint surface: mint, upload, retrieve.

## Cloud changes

### New file: `cloud/packages/cloud/src/api/hono/client/v2/photo.api.ts`

Mounted at `/api/v2/client/photo`. Auth: `clientAuth` middleware (same coreToken JWT as v2 streams).

```
POST   /request              → mint upload token + URL
POST   /upload/:requestId    → glasses (or phone-fallback) post multipart here
GET    /:requestId           → long-poll for completion, return signed download URL
DELETE /:requestId           → optional, free R2 + map early
```

**In-memory state:**
```ts
type PhotoState =
  | {kind: "pending"; userId: string; createdAt: number}
  | {kind: "ready"; userId: string; photoUrl: string; mimeType: string; size: number; readyAt: number}
  | {kind: "error"; userId: string; code: string; message: string}

const photos: Map<string, PhotoState> = new Map()

// Long-poll resolvers waiting on a given requestId.
const waiters: Map<string, Array<(s: PhotoState) => void>> = new Map()
```

Best-effort, in-memory only — same pattern as v2 streams' `liveInputOwner`. Acceptable to lose across restarts (caller re-takes).

**Handlers (sketch):**

```ts
// POST /request — body: {packageName?, size?, compress?, sound?, saveToGallery?}
// Returns: {requestId, uploadUrl, uploadToken}
async function handleRequest(c) {
  const email = c.get("email")!
  const requestId = uuid()
  // Photo-agnostic capability token: "this user may upload one photo within
  // 120s." The URL path identifies the slot; the in-memory map enforces
  // ownership. Keeping requestId OUT of the token keeps the cloud-2 port
  // simple — token is a tiny capability, not a slot identifier.
  const uploadToken = jwt.sign(
    {userId: email, purpose: "v2_photo_upload"},
    process.env.MENTRA_PHOTO_UPLOAD_SECRET ?? "mentra-photo-dev-secret",
    {expiresIn: "120s"},
  )
  const uploadUrl = `${publicBaseUrl(c)}/api/v2/client/photo/upload/${requestId}`
  photos.set(requestId, {kind: "pending", userId: email, createdAt: Date.now()})
  return c.json({requestId, uploadUrl, uploadToken})
}

// POST /upload/:requestId — multipart {photo: File}, Bearer uploadToken
// Glasses speak this verbatim per MediaCaptureService.performDirectUpload.
async function handleUpload(c) {
  const token = bearer(c)
  const payload = jwt.verify(token, secret) as {userId: string; purpose: string}
  if (payload.purpose !== "v2_photo_upload") return c.json({...}, 401)
  const requestId = c.req.param("requestId")
  const entry = photos.get(requestId)
  // Both checks fail with 404 (don't leak which requestIds exist):
  //   - missing slot
  //   - slot exists but belongs to a different user
  if (!entry || entry.userId !== payload.userId) return c.json({...}, 404)
  // Slot must be pending — reject re-uploads to a slot already ready/errored.
  if (entry.kind !== "pending") return c.json({...}, 409)

  const form = await c.req.formData()
  const photo = form.get("photo") as File | null
  if (!photo) return c.json({...}, 400)

  // Reuse the existing R2 service + bucket.
  const buf = Buffer.from(await photo.arrayBuffer())
  const mimeType = photo.type || "image/jpeg"
  const {key, sizeBytes} = await miniappSdkPhotoStorage.putPhoto({
    userId: payload.userId, requestId, buffer: buf, mimeType,
  })
  // 30-min signed URL per decision #6.
  const photoUrl = await miniappSdkPhotoStorage.getSignedDownloadUrl(key, 1800)

  const ready: PhotoState = {
    kind: "ready", userId: payload.userId, photoUrl, mimeType, size: sizeBytes,
    readyAt: Date.now(),
  }
  photos.set(requestId, ready)
  resolveWaiters(requestId, ready)
  return c.json({ok: true})
}

// GET /:requestId — long-poll, returns when ready or 30s timeout
// Returns ready PhotoState or 408 on timeout
async function handlePoll(c) {
  const email = c.get("email")!
  const requestId = c.req.param("requestId")
  const entry = photos.get(requestId)
  if (!entry || entry.userId !== email) return c.json({error: "not_found"}, 404)
  if (entry.kind !== "pending") return c.json(entry, entry.kind === "error" ? 502 : 200)

  // Hang up to 30s waiting for /upload to land.
  const result = await new Promise<PhotoState>((resolve) => {
    const timer = setTimeout(() => {
      removeWaiter(requestId, resolve)
      resolve({kind: "error", userId: email, code: "timeout", message: "Upload did not arrive within 30s"})
    }, 30_000)
    addWaiter(requestId, (s) => {
      clearTimeout(timer)
      resolve(s)
    })
  })
  return c.json(result, result.kind === "ready" ? 200 : 408)
}

// DELETE /:requestId — frees R2 + map (optional cleanup)
async function handleDelete(c) { ... }
```

**Cleanup janitor:** drop map entries older than ~1 hour to prevent unbounded growth. Single `setInterval` in the route module.

**Server `idleTimeout` bump.** Bun's `Bun.serve()` default HTTP idle timeout is 10s; a 30s long-poll would be killed early. One-line edit to `cloud/packages/cloud/src/index.ts`:

```ts
const _server = Bun.serve({
  port: PORT,
  idleTimeout: 30, // bumped from default 10s so the v2 photo long-poll can hang up to 30s
  websocket: websocketHandlers,
  ...
})
```

Server-wide, applies to all HTTP routes. Other routes complete in <1s so this is safe.

**URL construction.** The upload URL handed to glasses must be reachable from glasses' WiFi (not just from inside the cluster). Reuse the existing convention from `MiniappSdkPhotoManager.ts:83-85`:

```ts
const cloudHost = process.env.CLOUD_PUBLIC_HOST_NAME || "localhost:8002"
const protocol = cloudHost.includes("localhost") ? "http" : "https"
const uploadUrl = `${protocol}://${cloudHost}/api/v2/client/photo/upload/${requestId}`
```

**R2-not-configured surface.** `miniappSdkPhotoStorage.putPhoto` throws `"R2 not configured — miniapp SDK photo storage unavailable"` if `R2_*` env vars are missing. Catch this in `handleUpload`'s try/catch and return `503 {code: "storage_unavailable"}` so the phone surfaces a useful error to the miniapp instead of a generic 500.

**Honor `AbortSignal` in `handlePoll`.** If the phone aborts the long-poll (e.g., miniapp got closed), release the waiter immediately rather than holding the slot for 30s:

```ts
c.req.raw.signal.addEventListener("abort", () => {
  removeWaiter(requestId, resolve)
  resolve({kind: "error", userId: email, code: "client_aborted", message: "Client closed connection"})
})
```

### Reused from existing cloud code (no changes)

- `miniappSdkPhotoStorage` (R2 wrapper) — re-export and use as-is. Same R2 bucket (`mentra-miniapp-sdk-photos`) per decision #5.
- The HMAC secret env var becomes `MENTRA_PHOTO_UPLOAD_SECRET` (renamed from `MINIAPP_SDK_PHOTO_UPLOAD_SECRET`). One deployment-config update.

### Deletions (decision #3 — never used in prod, delete now)

- `cloud/packages/cloud/src/api/hono/client/miniapp-sdk-photo.api.ts` — DELETE
- `cloud/packages/cloud/src/services/session/MiniappSdkPhotoManager.ts` — DELETE
- `cloud/packages/cloud/src/services/session/UserSession.ts` — remove `miniappSdkPhotoManager` field + construction + cleanup
- `cloud/packages/cloud/src/api/hono/client/index.ts` — remove `miniappSdkPhotoApi` export
- `cloud/packages/cloud/src/hono-app.ts` — remove the `/api/client/miniapp-sdk-photo` mount + import
- `phone_photo_ready` message type — only emitted by `MiniappSdkPhotoManager.handleUploadComplete`; nothing else sends it. Delete the type if defined anywhere.
- `cloud/.env.example` — replace `MINIAPP_SDK_PHOTO_UPLOAD_SECRET=...` with `MENTRA_PHOTO_UPLOAD_SECRET=...`.

## Phone changes

### New file: `mobile/src/services/photo/PhonePhotoCoordinator.ts`

Parallel to `PhoneStreamCoordinator`. Single-purpose: take one photo end-to-end.

```ts
export interface PhotoOpts {
  size?: "small" | "medium" | "large"
  compress?: "none" | "low" | "medium" | "high"
  sound?: boolean
  saveToGallery?: boolean
}

export interface PhotoTaken {
  photoUrl: string
  mimeType: string
  size: number
  requestId: string
}

interface ActiveRequest {
  packageName: string
  reject: (err: Error) => void
}

export class PhonePhotoCoordinator {
  // Tracks in-flight requestIds → reject-handle so MantleManager can
  // short-circuit the long-poll when glasses emit a photo_response error.
  private readonly activeRequests = new Map<string, ActiveRequest>()

  async takePhoto(packageName: string, opts: PhotoOpts): Promise<PhotoTaken> {
    // Optional pre-check: short-circuit if glasses lack a camera. Otherwise
    // the BLE photo command would be sent and silently time out, since
    // cameraless glasses (G1/G2) have no PhotoCommandHandler to respond.
    const glasses = getRuntimeHooks().glassesStatus?.get()
    if (glasses?.connected && glasses?.capabilities?.hasCamera === false) {
      throw new PhotoError("NO_CAMERA", "Connected glasses do not have a camera")
    }
    if (!glasses?.connected) {
      throw new PhotoError("GLASSES_NOT_CONNECTED", "Glasses are not connected")
    }

    // 1. Mint token + URL.
    const {requestId, uploadUrl, uploadToken} = await photoV2.request()

    // Track this requestId so MantleManager's photo_response listener knows
    // glasses-side errors belong to us and short-circuits the long-poll.
    this.activeRequests.set(requestId, {
      packageName,
      reject: (err) => {/* set by the long-poll Promise below */},
    })

    // 2. Drive glasses over BLE. The native layer auto-injects
    //    transferMethod: "auto" (WiFi-direct with BLE fallback) — see
    //    mobile/modules/bluetooth-sdk/ios/Source/sgcs/MentraLive.swift:1328.
    try {
      await CoreModule.photoRequest(
        requestId,
        packageName,
        opts.size ?? "medium",
        uploadUrl,
        uploadToken,
        opts.compress ?? "none",
        true, // flash (forwarded to glasses; no-op on non-flash hardware)
        opts.sound ?? true,
      )
    } catch (err) {
      this.activeRequests.delete(requestId)
      throw new PhotoError("BLE_SEND_FAILED", err instanceof Error ? err.message : String(err))
    }

    // 3. Long-poll the URL — server resolves when /upload lands or 30s
    //    timeout. Race against the BLE photo_response error path: if glasses
    //    emit a photo_response error first, MantleManager's gated forwarder
    //    calls handlePhotoError() which rejects the same Promise.
    try {
      const result = await this.waitForResult(requestId)
      return {
        photoUrl: result.photoUrl,
        mimeType: result.mimeType,
        size: result.size,
        requestId,
      }
    } finally {
      this.activeRequests.delete(requestId)
    }
  }

  /** True iff this requestId is one we're currently waiting on. */
  owns(requestId: string): boolean {
    return this.activeRequests.has(requestId)
  }

  /** Called by MantleManager's gated photo_response listener on errors. */
  handlePhotoError(requestId: string, errorCode: string, errorMessage: string): void {
    const entry = this.activeRequests.get(requestId)
    if (!entry) return
    entry.reject(new PhotoError(errorCode, errorMessage))
  }

  private async waitForResult(requestId: string): Promise<PhotoTaken> {
    // Combines two race paths:
    //  - Long-poll GET on /api/v2/client/photo/:requestId resolves on upload
    //    or rejects on 408 timeout.
    //  - handlePhotoError can reject the same Promise on BLE error.
    return new Promise<PhotoTaken>((resolve, reject) => {
      const entry = this.activeRequests.get(requestId)
      if (!entry) {
        reject(new PhotoError("INTERNAL", "request slot missing"))
        return
      }
      entry.reject = reject
      photoV2.pollUntilReady(requestId)
        .then((result) => {
          if (result.kind === "error") reject(new PhotoError(result.code, result.message))
          else resolve(result)
        })
        .catch(reject)
    })
  }
}

export const phonePhotoCoordinator = new PhonePhotoCoordinator()
```

No transition lock needed — photos are independent, multiple concurrent in-flight `takePhoto`s are fine (each has its own `requestId`).

### New file: `mobile/src/services/photo/v2PhotoApi.ts`

Thin fetch client, parallel to `v2StreamApi.ts`. Three functions: `request()`, `pollUntilReady(requestId)`, `freePhoto(requestId)`. Reads `backendUrl` + `coreToken` from island runtime settings hook (same as v2StreamApi).

### Edit: `mobile/modules/engine/src/runtime/config.ts`

Replace the existing `requestMiniappSdkPhoto` adapter with a cleaner one:

```ts
// REMOVE: requestMiniappSdkPhoto?: (params: {...}) => Promise<{accepted, requestId}>

// ADD:
photo?: {
  takePhoto: (packageName: string, opts: PhotoOpts) => Promise<PhotoTaken>
}
```

### Edit: `mobile/modules/engine/src/services/LocalMiniappRuntime.ts`

The current `handlePhoto` registers a pending cloud request and waits for `phone_photo_ready` via WS. Replace with a direct call to the new hook:

```ts
private async handlePhoto(packageName, payload, requestId?) {
  // CAMERA permission check (existing, keep).
  const hasCameraPermission = app?.installedManifest?.permissions?.some((p) => p.type === "CAMERA")
  if (!hasCameraPermission) {
    this.sendResult(...PERMISSION_NOT_DECLARED...)
    return
  }
  const photo = getRuntimeHooks().photo
  if (!photo) {
    this.sendResult(packageName, requestId, false, undefined, {
      code: MiniappErrorCode.NOT_IMPLEMENTED,
      message: "Camera is not configured on this host",
    })
    return
  }
  try {
    const result = await photo.takePhoto(packageName, {
      size: payload.size, compress: payload.compress,
      sound: payload.sound, saveToGallery: payload.saveToGallery,
    })
    this.sendResult(packageName, requestId, true, result)
  } catch (err) {
    this.sendResult(packageName, requestId, false, undefined, {
      code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
      message: err instanceof Error ? err.message : "takePhoto failed",
    })
  }
}
```

Also remove the `phone_photo_ready` case from `handleCloudMessage` (only the old path ever set up a pending cloud request for photos; with this change there are none). The doc-comment above `handleCloudMessage` listing `phone_photo_ready, phone_stream_status, phone_managed_stream_status` should drop `phone_photo_ready`.

### Edit: `mobile/src/services/SocketComms.ts`

Drop the `phone_photo_ready` case from `handleCloudMessage` (line ~818). Currently:

```ts
case "phone_photo_ready":
case "phone_stream_status":
case "phone_managed_stream_status":
  localMiniappRuntime.handleCloudMessage(msg)
  break
```

Becomes:

```ts
case "phone_stream_status":
case "phone_managed_stream_status":
  localMiniappRuntime.handleCloudMessage(msg)
  break
```

(Stream cases stay — they still flow from cloud-1 for cloud-SDK app streams.)

### Edit: `mobile/src/services/MantleManager.ts`

**Two changes here:**

1. **Swap the hook wire-up** from the old `requestMiniappSdkPhoto` to the new `photo.takePhoto`:

```ts
// REMOVE:
import {requestMiniappSdkPhoto} from "@/services/miniapp/MiniappSdkPhotoHandler"
...
requestMiniappSdkPhoto: (params) => requestMiniappSdkPhoto(params),

// ADD:
import {phonePhotoCoordinator} from "@/services/photo/PhonePhotoCoordinator"
...
photo: {
  takePhoto: (pkg, opts) => phonePhotoCoordinator.takePhoto(pkg, opts),
},
```

2. **Gate the existing `photo_response` BLE listener** so glasses-side errors for phone-owned photos short-circuit the long-poll instead of being forwarded to cloud's cloud-app path. Mirror of how I gated `stream_status` + `keep_alive_ack` in the streaming PR.

Current code at `MantleManager.ts:501-505`:

```ts
CoreModule.addListener("photo_response", (event) => {
  restComms.sendPhotoResponse(event)
})
```

Becomes:

```ts
CoreModule.addListener("photo_response", (event) => {
  const requestId = event?.requestId
  // Local miniapp photos: short-circuit the v2 long-poll with a typed error.
  // Cloud-app photos still flow to cloud's PhotoManager.
  if (requestId && phonePhotoCoordinator.owns(requestId)) {
    if (event.success === false) {
      phonePhotoCoordinator.handlePhotoError(
        requestId,
        event.errorCode ?? "GLASSES_ERROR",
        event.errorMessage ?? "Glasses reported an error",
      )
    }
    // Successful photo_response for owned requestId is unexpected — glasses
    // would have uploaded directly to our v2 /upload route, no need to
    // double-report. Drop silently.
    return
  }
  restComms.sendPhotoResponse(event)
})
```

### Deletion

- `mobile/src/services/miniapp/MiniappSdkPhotoHandler.ts` — DELETE. (Only caller was MantleManager, replaced above.)

## SDK surface

**Unchanged** (decision: byte-identical to today).

```ts
session.camera.takePhoto(opts?: TakePhotoOptions): Promise<PhotoTaken>
```

Internally the request type stays `MiniappRequestType.PHOTO`, the response shape stays `PhotoTaken = {photoUrl, mimeType, size}`. Miniapp authors notice nothing.

(Optional: surface `requestId` on PhotoTaken so it could be re-fetched later, but per decision #6 we're going ephemeral 30-min URLs only — no re-sign endpoint. Skip.)

## Auth model summary

| Hop | Auth |
|---|---|
| Miniapp → phone SDK | (in-process) |
| Phone → cloud `POST /request` | `Authorization: Bearer <coreToken>` (existing clientAuth middleware) |
| Glasses or phone → cloud `POST /upload/:requestId` | `Authorization: Bearer <uploadToken>` (photo-agnostic capability JWT, ~120s TTL, HMAC-signed with `MENTRA_PHOTO_UPLOAD_SECRET`). The token payload is `{userId, purpose}` only — the `requestId` lives in the URL path, and cloud's in-memory map provides ownership-check against the slot. |
| Phone → cloud `GET /:requestId` | `Authorization: Bearer <coreToken>`; cloud verifies `userId == photos[requestId].userId` |

Glasses never see `coreToken`. They only hold the single-use opaque `uploadToken`.

## Test plan

### Cloud (new)

`cloud/packages/cloud/src/api/hono/client/v2/photo.api.test.ts` — bun:test, mock `miniappSdkPhotoStorage`:

- POST /request returns `{requestId, uploadUrl, uploadToken}`; uploadToken is a valid signed JWT containing `{userId, purpose}` only (no `requestId`).
- POST /upload happy path stores via R2 + returns `{ok: true}`.
- POST /upload rejects expired JWT (401).
- POST /upload rejects JWT with wrong purpose (401).
- POST /upload rejects when no entry exists for the URL requestId (404).
- POST /upload rejects when the JWT's userId doesn't own the URL requestId's slot (404 — same response shape; don't leak existence).
- POST /upload rejects re-upload to an already-ready slot (409).
- POST /upload rejects multipart without `photo` field (400).
- GET /:requestId returns the ready entry immediately when present.
- GET /:requestId hangs and resolves when an upload arrives (use shorter timeout in test).
- GET /:requestId returns 408 on timeout.
- GET /:requestId returns 404 for someone else's requestId.
- Janitor drops stale pending entries.
- AbortSignal: closing the client connection releases the waiter and returns `client_aborted`.
- Storage misconfigured (mocked putPhoto throws "R2 not configured") → POST /upload returns 503 `{code: "storage_unavailable"}`.

### Phone (new)

`mobile/src/services/photo/PhonePhotoCoordinator.test.ts` — mocked `CoreModule.photoRequest` + mocked v2PhotoApi:

- Happy path: request → BLE send → poll resolves → returns PhotoTaken.
- Glasses-not-connected precheck → throws `PhotoError("GLASSES_NOT_CONNECTED")` before any BLE/cloud calls.
- Glasses-without-camera precheck → throws `PhotoError("NO_CAMERA")` before any BLE/cloud calls.
- BLE send failure surfaces as `PhotoError("BLE_SEND_FAILED", ...)`.
- Poll timeout surfaces as `PhotoError("timeout", ...)`.
- `handlePhotoError(requestId, "BATTERY_LOW", "...")` short-circuits the in-flight long-poll with the typed error.
- handlePhotoError for an unknown requestId is a no-op (doesn't throw).
- `owns(requestId)` returns true while in-flight, false after completion or error.
- Concurrent takePhoto calls each get their own requestId, no cross-talk.

### Manual on-device

- Mentra Live miniapp tester page → "takePhoto(medium)" → confirm photo appears in `<img>` thumbnail within ~5s on WiFi.
- Same test on a phone with glasses connected but glasses' WiFi disabled → confirm BLE-fallback path still works (uses `BlePhotoUploadService` unchanged).
- Disconnect glasses entirely → confirm clear error to miniapp.
- Take two photos back-to-back → both succeed.

## What this PR does NOT change

- **asg_client**: zero changes. The BLE `take_photo` command, `MediaCaptureService.performDirectUpload`, `MediaCaptureService.compressAndSendViaBle` — all unchanged.
- **Phone's BLE photo upload service** (`BlePhotoUploadService.java`) — unchanged.
- **Phone's BLE camera transport** (`CoreModule.photoRequest`) — unchanged.
- **Cloud-app photo flow** (`PhotoManager`, `CameraManager`, `/api/photos/upload`, third-party SDK developers' apps) — untouched. Entirely separate code path.
- **Cloud `/api/photos/upload`** (the legacy direct-upload endpoint cloud-app path falls back to) — untouched.

## Files touched (final tally)

| Action | File | Notes |
|---|---|---|
| NEW | `cloud/packages/cloud/src/api/hono/client/v2/photo.api.ts` | ~180 LOC, three handlers + janitor + abort handling |
| NEW | `cloud/packages/cloud/src/api/hono/client/v2/photo.api.test.ts` | bun:test |
| NEW | `mobile/src/services/photo/PhonePhotoCoordinator.ts` | ~120 LOC (incl. activeRequests map + handlePhotoError + waitForResult) |
| NEW | `mobile/src/services/photo/PhonePhotoCoordinator.test.ts` | bun:test |
| NEW | `mobile/src/services/photo/v2PhotoApi.ts` | ~60 LOC |
| EDIT | `cloud/packages/cloud/src/index.ts` | bump `Bun.serve({idleTimeout: 30})` so 30s long-poll isn't killed by default 10s |
| EDIT | `cloud/packages/cloud/src/api/hono/client/index.ts` | drop `miniappSdkPhotoApi` export, add `v2PhotoApi` |
| EDIT | `cloud/packages/cloud/src/hono-app.ts` | drop old mount, add `/api/v2/client/photo` |
| EDIT | `cloud/packages/cloud/src/services/session/UserSession.ts` | drop `miniappSdkPhotoManager` field + ctor call + cleanup |
| EDIT | `cloud/.env.example` | rename `MINIAPP_SDK_PHOTO_UPLOAD_SECRET` → `MENTRA_PHOTO_UPLOAD_SECRET` |
| EDIT | `mobile/modules/engine/src/runtime/config.ts` | swap `requestMiniappSdkPhoto` → `photo` hook |
| EDIT | `mobile/modules/engine/src/services/LocalMiniappRuntime.ts` | rewrite `handlePhoto`; drop `phone_photo_ready` case from `handleCloudMessage` + its doc-comment mention |
| EDIT | `mobile/src/services/SocketComms.ts` | drop `phone_photo_ready` case from `handleCloudMessage` |
| EDIT | `mobile/src/services/MantleManager.ts` | (1) swap hook registration; (2) gate the `photo_response` BLE listener by `phonePhotoCoordinator.owns(requestId)` so local-miniapp errors short-circuit instead of going to `restComms.sendPhotoResponse` |
| DELETE | `cloud/packages/cloud/src/api/hono/client/miniapp-sdk-photo.api.ts` | dead |
| DELETE | `cloud/packages/cloud/src/services/session/MiniappSdkPhotoManager.ts` | dead |
| DELETE | `mobile/src/services/miniapp/MiniappSdkPhotoHandler.ts` | replaced |

Total: ~5 new files, ~8 edits, 3 deletes. ~450 LOC net new, ~250 LOC deleted. Zero asg_client changes. Zero changes to BLE photo plumbing on phone (`BlePhotoUploadService.java`).

## Cloud-2 port story

The new route file is self-contained:
- Reads only `MENTRA_PHOTO_UPLOAD_SECRET` env + the public base URL.
- Uses `miniappSdkPhotoStorage` (also self-contained — R2 wrapper).
- In-memory `Map` for ownership + waiters.
- No `UserSession`, no WS, no DB.

Copy `photo.api.ts` + `miniappSdkPhotoStorage` into cloud-2. Done. Phone code keeps working as long as cloud-2 serves `/api/v2/client/photo/*` with the same shape.
