# Camera service spec

**Status:** Spec. The camera runtime service: managed photo and managed stream.
Both are client-initiated REST on the runtime domain, with no coupling to the
audio session or its owner pod (any pod serves them). Auth is the access token.

Functionally this is what v1 already does, but **managed**: the cloud brokers
capture and storage and the mobile client drives the control plane over REST.

## Managed photo

The cloud is **not in the image byte path**. It brokers a presigned upload and
learns of completion from the storage provider's event, then notifies the phone.

### Flow

1. `POST /api/camera/photo`
   ```
   Authorization: Bearer <access token>
   { "size"?: "small|medium|large|full", "compress"?: "none|medium|heavy", "saveToGallery"?: bool, "sound"?: bool }
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
