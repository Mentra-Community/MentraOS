# `session.camera`

Glasses camera control and photo capture for miniapps. `takePhoto()` captures
a frame on the glasses, uploads it to cloud storage (24h TTL), and returns
the URL. `setFov()` writes camera field-of-view tuning to the device.

Whether a connected pair of glasses actually has a camera is exposed
separately via `session.capabilities.hasCamera` — gate calls on that before
prompting users.

Source: [mobile/modules/miniapp/src/modules/camera.ts](../../mobile/modules/miniapp/src/modules/camera.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

if (!session.camera.hasPermission) {
  // CAMERA missing from manifest — feature unavailable
  return
}

if (!session.capabilities.hasCamera) {
  // Glasses have no camera — bail before calling takePhoto
  return
}

const photo = await session.camera.takePhoto({
  size: "medium",
  compress: "none",
  sound: true,
  saveToGallery: false,
})

console.log(photo.photoUrl, photo.mimeType, photo.size)
```

---

## Manifest

Photo capture requires `CAMERA` in the miniapp manifest:

```json
{
  "permissions": ["CAMERA"]
}
```

`hasPermission` reflects whether this is declared. The module does not
synchronously throw on missing permission — the host rejects the request.

---

## API

### `hasPermission` — `boolean`

True iff `CAMERA` is declared in the miniapp's manifest. Synchronous; reads
the cached manifest record populated at `CONNECT_ACK`.

```ts
if (!session.camera.hasPermission) {
  // camera features won't work — prompt the user to update the manifest
}
```

---

### `setFov(options)` — `void`

Write camera FOV settings. Fire-and-forget one-shot — no ack.

**Parameters:** `SetCameraFovOptions`

```ts
interface SetCameraFovOptions {
  /** Horizontal FOV, degrees. */
  horizontal?: number
  /** Vertical FOV, degrees. */
  vertical?: number
}
```

Either or both fields can be supplied; omitted fields are left untouched on
the host side.

---

### `takePhoto(options?)` — `Promise<PhotoTaken>`

Take a photo via the glasses camera. Returns a URL to the captured image.
Requires `CAMERA` declared in `miniapp.json`.

The photo is uploaded to cloud storage (24h TTL) and the URL is returned.
If the glasses don't have a camera, the phone-side handler rejects with an
error. Check `session.capabilities.hasCamera` before calling.

**Parameters:** `TakePhotoOptions` (optional)

```ts
interface TakePhotoOptions {
  size?: "small" | "medium" | "large"
  compress?: "none" | "low" | "medium" | "high"
  sound?: boolean
  saveToGallery?: boolean
}
```

Defaults (applied client-side before the request is sent):

| Field | Default |
| --- | --- |
| `size` | `"medium"` |
| `compress` | `"none"` |
| `sound` | `true` |
| `saveToGallery` | `false` |

**Returns:** `PhotoTaken`

```ts
interface PhotoTaken {
  photoUrl: string
  mimeType: string
  size: number
}
```

`size` is the byte length of the uploaded asset.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `PERMISSION_NOT_DECLARED` | `takePhoto` (rejected Promise) | `CAMERA` missing from miniapp manifest. Surfaced by the host, not as a sync throw. |
| `INTERNAL` | `takePhoto` (rejected Promise) | Phone-side capture failed (no camera, hardware error, upload failure). Check `message`. |

---

## Wire-level reference

For host implementors — request/response message types this module emits:

| Method | Request type | Response |
| --- | --- | --- |
| `setFov` | `CAMERA_FOV` (`{horizontal, vertical}`, one-shot) | — |
| `takePhoto` | `PHOTO` (`{size, compress, sound, saveToGallery}`) | `REQUEST_RESULT` with `data: PhotoTaken` |

This module subscribes to no streams. The Phase 5 `PHOTO_TAKEN` stream is
not surfaced through `CameraModule` in v1.

---

## Tests

_no integration tests yet_
