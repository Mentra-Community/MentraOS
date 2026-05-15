# Miniapp SDK Photo Cleanup Plan

Cleanup of the camera SDK's `takePhoto()` photo-capture path on the `mentra-miniapp-sdk` branch. Two problems to fix together:

1. **Security**: photos currently have no working storage destination — the live code writes to ephemeral local disk at a URL nothing serves (404s), and dead code in `R2StorageService.uploadMiniappPhoto()` writes to the **public** `mentra-store` CDN bucket. User-captured photos must land in a **private** bucket with signed-URL download.
2. **Naming**: `miniapp photo` is ambiguous — reads like "photos of miniapps" or "miniapp store photos." Camera SDK's photo-capture path should be unambiguously named `miniappSdkPhoto` / `miniapp-sdk-photo` / `miniapp_sdk_photos` everywhere it appears.

Out of scope: `takePhoto()` SDK API surface, the V2 wiring generally (which was validated as end-to-end in a prior audit — see `agents/miniapp-store-backend-plan.md` context). This doc is strictly about the storage destination + naming.

---

## Current state (all added on this branch, commit `e7436808a6` "first pass")

**Live path** (broken):

- SDK → `LocalMiniappRuntime.handlePhoto()` → POST `/api/client/miniapp-photo/request` → `PhonePhotoManager.requestPhoto()` mints signed upload URL → glasses POST to `/api/client/miniapp-photo/upload/:requestId` → handler writes to `packages/uploads/miniapp-photos/` on local disk → constructs URL `/api/photos/miniapp/:filename` which **nothing serves** (404) → `phone_photo_ready` fires back to phone carrying the dead URL.

**Dead code** (never called):

- `R2StorageService.uploadMiniappPhoto()` at `cloud/packages/cloud/src/services/storage/r2-storage.service.ts:224-262` writes to `miniapp_photos/{userId}/{requestId}-{timestamp}.{ext}` under the **public** `mentra-store` bucket (CDN `mentra-store-cdn.mentraglass.com`). Returns a public URL. Not integrated into the upload endpoint.

So today, `takePhoto()` returns a broken URL. Nobody's noticed because V2 (camera SDK) hasn't been end-to-end tested with a real consumer miniapp yet.

---

## Target state

- **New private bucket** `mentra-miniapp-sdk-photos` on the existing Cloudflare R2 account. No CDN mapping.
- Upload endpoint writes to the new private bucket via the existing `R2StorageService` s3 client (reuse existing creds).
- `phone_photo_ready` message carries a **signed download URL** with 15-minute TTL, minted via `@aws-sdk/s3-request-presigner` (same pattern as the store-plan's bundle downloads).
- Miniapp SDK receives the signed URL and can `fetch()` it. If the app needs the photo long-term, it downloads the bytes and persists them via the storage API — the signed URL is ephemeral.
- All naming disambiguated: `miniappSdkPhoto` everywhere the camera SDK's photo path appears.
- R2 lifecycle policy: auto-delete objects after 1 day. Photos are transient by design; cloud isn't responsible for long-term storage.

Rationale for separate bucket (not sharing with the `mentra-miniapp-bundles` bucket from the store plan):

- **Different lifecycles.** Bundles are small + persistent. Photos are large + ephemeral with TTL.
- **Different access patterns.** Bundles get one sign per install (5 min). Photos get one sign per capture (15 min). TTLs shouldn't bleed across concerns.
- **Lifecycle rules scope.** An R2 lifecycle rule auto-deleting objects at 30d is fine for photos, destructive for bundles. Bucket-scope rules avoid accidents.
- **Symmetry with existing precedent**: the codebase already has `mentra-incidents` as a dedicated private bucket for a specific use. Same approach here.

---

## Rename table (comprehensive)

Apply across `cloud/`, `mobile/`, and `sdk/` (sdk is untouched — see "wire protocol" note below).

### Cloud code

| Current | New |
|---|---|
| `cloud/packages/cloud/src/api/hono/client/miniapp-photo.api.ts` | `miniapp-sdk-photo.api.ts` |
| `miniappPhotoApi` (export in `api/hono/client/index.ts`) | `miniappSdkPhotoApi` |
| Route mount `app.route("/api/client/miniapp-photo", ...)` in `hono-app.ts:317` | `/api/client/miniapp-sdk-photo` |
| `cloud/packages/cloud/src/services/session/PhonePhotoManager.ts` | `MiniappSdkPhotoManager.ts` |
| Class `PhonePhotoManager` | `MiniappSdkPhotoManager` |
| `userSession.phonePhotoManager` (`UserSession.ts:141,198,812`) | `userSession.miniappSdkPhotoManager` |
| `R2StorageService.uploadMiniappPhoto()` | **delete** — replaced with method on new `MiniappSdkPhotoStorageService` (see below) |
| R2 key prefix `miniapp_photos/` | `sdk_photos/` (in the new bucket; bucket name is the disambiguator) |
| Env var `MINIAPP_PHOTO_UPLOAD_SECRET` | `MINIAPP_SDK_PHOTO_UPLOAD_SECRET` |
| JWT `purpose` claim `"miniapp_photo_upload"` | `"miniapp_sdk_photo_upload"` |
| Local upload dir `packages/uploads/miniapp-photos/` | **delete** — moving to R2, no local fallback |
| Constructed URL `${cloudHost}/api/photos/miniapp/${filename}` | **delete** — replaced by signed R2 URL |
| Upload URL base `${cloudHost}/api/client/miniapp-photo/upload/...` (`PhonePhotoManager.ts:84`) | `${cloudHost}/api/client/miniapp-sdk-photo/upload/...` |

### Mobile code

| Current | New |
|---|---|
| `mobile/src/services/miniapp/MiniappPhotoHandler.ts:26` — `fetch('${backendUrl}/api/client/miniapp-photo/request', ...)` | `/api/client/miniapp-sdk-photo/request` |

No other mobile changes needed. File name `MiniappPhotoHandler.ts` can stay — it's the phone's handler for the SDK `takePhoto()` request, and the ambiguity is less loaded on the phone side. Or rename to `MiniappSdkPhotoHandler.ts` for symmetry with cloud; matter of taste, I'd rename it for consistency.

### Wire protocol — leave unchanged

| Identifier | Why it stays |
|---|---|
| `phone_photo_ready` (cloud-to-phone WS message type, `SocketComms.ts:828`, `LocalMiniappRuntime.ts:217`) | Wire protocol. Renaming would require coordinated deploy on both cloud and mobile. Low reward — the name is unambiguous in context (cloud → phone message carrying a photo). |
| `MiniappRequestType.PHOTO = "miniapp_photo"` (`sdk/miniapp/src/protocol.ts:69`) | Miniapp → phone runtime envelope request type. Not a cloud-facing identifier. Already ambiguous (`miniapp_photo` not `miniapp_sdk_photo`), but it's locked into the SDK's public wire format. Leave for now; if we do a breaking SDK rev later, bundle this rename in. |
| `PhotoTaken` response type, event names, anything inside the SDK package | Out of scope. |

### Shared collection

New env var `R2_MINIAPP_SDK_PHOTOS_BUCKET=mentra-miniapp-sdk-photos` in `cloud/.env.example`.

---

## New service

New file `cloud/packages/cloud/src/services/storage/miniapp-sdk-photo-storage.service.ts` — mirrors the `IncidentStorageService` private-bucket pattern (lazy-init S3 client, graceful degradation when creds missing, no CDN URLs).

```ts
class MiniappSdkPhotoStorageService {
  constructor(logger)
  
  async putPhoto({ userId, requestId, buffer, mimeType }): Promise<{ key: string; sizeBytes: number }>
  async getSignedDownloadUrl(key: string, ttlSeconds: number = 900): Promise<string>
  async deletePhoto(key: string): Promise<void>
}
```

Object key: `sdk_photos/{userId}/{requestId}-{timestamp}.{ext}`.

Signed URL signing uses `@aws-sdk/s3-request-presigner` `getSignedUrl(s3Client, new GetObjectCommand({...}), { expiresIn })`.

---

## Endpoint handler flow (new)

`POST /api/client/miniapp-sdk-photo/upload/:requestId`:

1. Verify upload token (unchanged — JWT purpose claim just renamed)
2. Parse multipart; extract photo buffer + mime type
3. Call `miniappSdkPhotoStorage.putPhoto(...)` → returns object key
4. Mint 15-min signed download URL via `miniappSdkPhotoStorage.getSignedDownloadUrl(key, 900)`
5. Call `matchedSession.miniappSdkPhotoManager.handleUploadComplete(requestId, signedUrl, mimeType, sizeBytes)`
6. `handleUploadComplete` fires `phone_photo_ready` with the signed URL, same as today

The phone SDK and miniapp see the signed URL exactly where they see the current (broken) URL — no phone-side logic change needed beyond the endpoint-path rename.

**Lifecycle rule** on the new bucket: `Expiration: 30 days after creation`. Set once at bucket-provision time via R2 console or CLI. Not a code concern.

---

## Rollout order

1. Create `mentra-miniapp-sdk-photos` bucket on Cloudflare R2. Set 30-day expiration lifecycle rule. Add `R2_MINIAPP_SDK_PHOTOS_BUCKET` env var.
2. Build `MiniappSdkPhotoStorageService` (new file).
3. Rename file + class + field + env var across cloud code. Update all call sites.
4. Replace local-disk write in the upload handler with `miniappSdkPhotoStorage.putPhoto()`. Replace constructed URL with signed download URL.
5. Delete `R2StorageService.uploadMiniappPhoto()` (the dead method). Delete any references to `miniapp_photos/` as a public-bucket prefix.
6. Rename mobile handler path (`MiniappPhotoHandler.ts:26`).
7. Test end-to-end: real glasses → real upload → signed URL download → photo displays in a miniapp. Verify signed URL 403s after 15 min and 404s after 30 days.
8. Delete `packages/uploads/miniapp-photos/` if it exists on any dev machine or server (stale from the broken local-disk path).

---

## What this unblocks / validates

V2 (camera glasses) was previously described as "wired but untested." This cleanup is part of proving the camera path actually works. Once a miniapp can successfully `takePhoto()` and display the returned image, V2 graduates from "framework" to "functional."

---

## Notes

- **Long-term storage is the developer's problem.** The miniapp gets a 15-min signed URL — what they do with it is up to them (fetch + store locally, upload to their own backend, display once and drop). Cloud is not responsible for long-term photo storage.
- **One photo, one URL.** Every `takePhoto()` call produces a fresh signed URL. No batching, no reuse across captures.
- **No cloud-side rate limits.** Photo capture is rate-limited by glasses hardware; no software throttle needed at the cloud layer.
