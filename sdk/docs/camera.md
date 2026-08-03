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
  mode: "text",
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
  size?: "low" | "medium" | "high" | "max"
  mode?: "photo" | "text"
  transferMethod?: "auto" | "direct" | "ble"
  compress?: "none" | "low" | "medium" | "high"
  sound?: boolean
  saveToGallery?: boolean
}
```

Defaults (applied client-side before the request is sent):

| Field | Default |
| --- | --- |
| `size` | `"medium"` |
| `mode` | `"photo"` |
| `transferMethod` | `"auto"` |
| `compress` | `"none"` |
| `sound` | `true` |
| `saveToGallery` | `false` |

Use `transferMethod: "ble"` when you need to skip the glasses' direct Wi-Fi
upload attempt and always relay the image through the phone over Bluetooth.
Use `"direct"` to attempt only the direct upload, without BLE fallback.
`"auto"` tries direct upload first and falls back to BLE.
Unknown runtime values are rejected instead of being treated as `"auto"`.

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

### `startVideoRecording(options?)` — `Promise<VideoRecordingStarted>`

Start recording video on the glasses camera. Returns a `recordingId` to pass to
`stopVideoRecording()`. Requires `CAMERA` declared in `miniapp.json`. Check
`session.capabilities.hasCamera` before calling.

Resolution and frame rate are optional — omit them to use the device's saved
button-video settings. **Lowering `fps` keeps the glasses cooler and produces
smaller files**, which is ideal for long recordings fed to AI where smooth
motion isn't needed (e.g. `fps: 5` at 1080p runs markedly cooler than 30fps).

Unlike `takePhoto`, this is fire-and-forget start/stop — no media URL is
returned; the recording is saved/handled on the glasses.

**Parameters:** `StartVideoRecordingOptions` (optional)

```ts
interface StartVideoRecordingOptions {
  width?: number // omit → device default
  height?: number // omit → device default
  fps?: number // omit → device default (e.g. 30); lower = cooler
  sound?: boolean
  save?: boolean
}
```

Defaults (applied client-side before the request is sent):

| Field | Default |
| --- | --- |
| `width` / `height` / `fps` | device's saved button-video setting |
| `sound` | `true` |
| `save` | `false` |

**Returns:** `VideoRecordingStarted`

```ts
interface VideoRecordingStarted {
  recordingId: string
}
```

```ts
const {recordingId} = await session.camera.startVideoRecording({
  width: 1920,
  height: 1080,
  fps: 5, // cool, long-recording-friendly
})
// ...later...
await session.camera.stopVideoRecording(recordingId)
```

---

### `stopVideoRecording(recordingId)` — `Promise<void>`

Stop an in-progress recording started with `startVideoRecording()`. Pass the
`recordingId` returned from that call. Resolves once the stop command has been
dispatched to the glasses.

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
| `takePhoto` | `PHOTO` (`{size, mode, compress, sound, saveToGallery}`) | `REQUEST_RESULT` with `data: PhotoTaken` |
| `startVideoRecording` | `VIDEO_RECORDING_START` (`{width, height, fps, sound, save}`) | `REQUEST_RESULT` with `data: VideoRecordingStarted` |
| `stopVideoRecording` | `VIDEO_RECORDING_STOP` (`{recordingId}`) | `REQUEST_RESULT` |

This module subscribes to no streams. The `PHOTO_TAKEN` stream is
not surfaced through `CameraModule` in v1.

---

## Tests

_no integration tests yet_
