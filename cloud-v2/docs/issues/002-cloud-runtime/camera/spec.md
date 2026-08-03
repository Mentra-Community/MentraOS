# Camera service spec

**Status:** Spec. The camera runtime service: managed photo and managed stream.
Both are client-initiated REST on the runtime domain, with no coupling to the
audio session or its owner pod (any pod serves them). Auth is the `cloud-runtime`
token.

Functionally this is what v1 already does, but **managed**: the cloud brokers
capture and storage and the mobile client drives the control plane over REST.

## Managed photo

The cloud is **not in the image byte path**. It brokers a presigned upload and
learns of completion from the storage provider's event, then notifies the phone.

### Flow

1. `POST /api/camera/photo`
   ```
   Authorization: Bearer <cloud-runtime token>
   { "size"?: "low|medium|high|max", "compress"?: "none|medium|heavy", "saveToGallery"?: bool, "sound"?: bool }
   Legacy aliases are also accepted on input and normalized server-side:
   `small→low`, `large→high`, `full→max`. Compression aliases `low`/`high`
   normalize to `medium`/`heavy`.
   -> { "requestId": string, "uploadUrl": string, "readUrl": string }
   ```
   The cloud records a pending request keyed by `requestId`, generates a
   **presigned PUT** `uploadUrl` to the blob key `photos/{requestId}`, and a
   **presigned GET** `readUrl` for the same key.
2. The cloud tells the glasses to capture (the existing capture path). The glasses
   PUT the encoded image directly to `uploadUrl` (the blob store), then forget.
3. The blob provider fires an **object-created** event for `photos/{requestId}`
   (R2 Event Notifications, S3 events, OSS events). The cloud maps the key back to
   `requestId` and marks it complete. No glasses ping in the happy path.
4. The cloud pushes a **`photo.ready`** WS event to the phone:
   `{ requestId, readUrl }`. The local SDK resolves the miniapp's `takePhoto()`
   with `readUrl`.
5. **Failure:** if no object-created event arrives within a TTL, the cloud marks
   the request failed and pushes **`photo.error`** `{ requestId, reason }`. The
   pending request is also cleaned up on TTL so abandoned requests do not linger.

### Notes

- The completion source is provider-specific (R2 vs OSS events), so it lives
  behind the storage/provider wrapper. A self-hosted Runtime wires its own
  provider's events.
- Observability comes from the request lifecycle: pending -> complete (with upload
  latency) or pending -> failed. The cloud sees both without handling image bytes.
- Storage follows the runtime's own provider wrapper (self-hostable Runtime points
  at the OEM's blob config), see [`README.md`](./README.md).

## Storage providers

Photo blobs go through a small storage abstraction (`services/storage/`) so the
camera service is provider-agnostic. Provider is chosen by `STORAGE_PROVIDER`:

- **`local`** (default): real temp-fs storage, but the runtime serves the bytes
  itself. The presigned upload/read URLs point back at the runtime's own
  `PUT/GET /api/camera/blob/:key`. Because the runtime is the upload endpoint, it
  knows the instant an upload lands (no polling, no webhook). For local dev, CI,
  and as a reference custom implementation, with no third-party dependency.
- **`r2` / `s3`**: Cloudflare R2 via Bun's native S3 client (the same provider
  targets AWS, MinIO, and Alibaba OSS's S3-compatible endpoint by config). The
  byte path goes straight to the provider; completion arrives at the webhook.

```
POST /api/camera/storage-events   # object-created event -> marks the photo complete
```

The webhook is how an `r2`/`s3` object-created event (R2 event notifications via
a Cloudflare Queue + Worker, or an S3 event) reaches the runtime. It is
authenticated by a shared secret (`CAMERA_WEBHOOK_SECRET`), since the caller is
the storage provider, not the device.

A dev `CAMERA_AUTOCAPTURE` flag (off in production) simulates the glasses by
self-storing a placeholder, so the managed-photo flow completes without hardware
in tests and local dev.

## Managed stream

Same as v1's live stream but managed, with the **control plane on the mobile
client**: the client provisions, then manages the lifecycle over REST.

```
POST   /api/camera/stream        -> { streamId, ingest{...}, playback{...} }   // provision (Cloudflare Stream per region)
GET    /api/camera/stream/:id    -> { streamId, status, ingest, playback }     // status
DELETE /api/camera/stream/:id    -> { streamId, status: "stopped" }            // stop
```

- The cloud creates the stream on the provider and returns ingest (where the
  glasses/phone push) and playback (where viewers watch) details plus a
  `streamId`.
- The mobile client owns the lifecycle from there: poll status, stop when done.
- Provider is swappable per region (Cloudflare Stream by default), behind the same
  provider-wrapper pattern.

Detailed request/response field shapes and provider provisioning specifics are
filled in when this service is built; this spec fixes the model (presigned-upload
photo, client-controlled managed stream) and the endpoints.

## Push events (cloud to client)

WebSocket envelope messages (see [`../protocol.md`](../protocol.md#envelope)):

| type           | payload                       |
| -------------- | ----------------------------- |
| `photo.ready`  | `{ requestId, readUrl }`      |
| `photo.error`  | `{ requestId, reason }`       |
