# Camera service (managed photo, managed stream)

**Status:** Specced + first implementation. See [`spec.md`](./spec.md) for the
endpoints and the presigned-upload + storage-event model. The runtime serves the
endpoints (`src/api/camera.api.ts`) behind a **mock provider** for now; the real
blob/stream provider lands behind `CAMERA_PROVIDER`. The push events
(`photo.ready` / `photo.error`) are in `@mentra/cloud-runtime/protocol`, and
`@mentra/cloud-client`'s `camera` module drives the whole flow (proven e2e).

A service within Mentra Runtime Services (`@mentra/cloud-runtime`). It covers the
two camera-side cloud capabilities, both client-initiated:

- **Managed photo request.** The client asks the cloud to coordinate a photo
  capture, with durable blob storage (Cloudflare R2 or Alibaba OSS per region)
  and a signed URL returned to the client.
- **Managed stream.** The client asks the cloud to provision a live video stream
  (Cloudflare Stream per region) and gets back the ingest and playback details.

Both are built on the runtime transport ([`../protocol.md`](../protocol.md)):
standard `Authorization: Bearer` auth, the shared envelope for any push events.

Unlike audio subscriptions, neither has any coupling to the audio session or its
owner pod. They create their own request records and talk to providers, so they
are **plain stateless REST that any pod can serve** with no Redis rendezvous.

**Storage boundary.** Photo blob storage follows the same provider-wrapper
pattern as Cloud Core's [`storage-service`](../../001-cloud-core/storage-service/),
but instantiated within this product, not shared across the product boundary:
since Mentra Runtime Services is self-hostable, a self-hosted Runtime points at
the OEM's own blob config, independent of Cloud Core's instance.

## Endpoints

```
POST   /api/camera/photo      # managed photo request -> { requestId, uploadUrl, readUrl }
POST   /api/camera/stream     # managed stream provisioning -> { streamId, ingest, playback }
DELETE /api/camera/stream/:id # stop a managed stream -> { streamId, status }
```

Full request/response shapes and the push events (`photo.ready` / `photo.error`)
are in [`spec.md`](./spec.md). Provider selection (mock vs real R2/Stream/OSS) and
lifecycle (expiry, cleanup) firm up as the real provider lands; `GET
/api/camera/stream/:id` (status) is specced and lands when a consumer needs it.
