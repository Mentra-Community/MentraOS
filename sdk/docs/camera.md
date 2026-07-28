# `session.camera`

Glasses camera control and photo capture for miniapps. `takePhoto()` captures
a frame on the glasses, transfers it to the phone over Bluetooth, and returns
the image inline as a data URL — no cloud request is involved. `setFov()` writes camera field-of-view tuning to the device.

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
  sound: true,
  saveToGallery: false,
})

console.log(photo.dataUrl?.slice(0, 32), photo.mimeType, photo.size)
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

Take a photo via the glasses camera and get the image back inline. Requires
`CAMERA` declared in `miniapp.json`.

The photo rides Bluetooth from the glasses to the phone — no cloud or network
request is in the path, so this also works air-gapped — and resolves with the
JPEG as `dataUrl` (`photoUrl` carries the same data URL, so code that renders
`photoUrl` keeps working; the background runtime's `fetch` does not accept data
URLs, so decode `dataUrl` with `base64ToBytes` when you need bytes). Large sizes
(`size: "max"`) transfer more slowly over Bluetooth, and final quality is
governed by the Bluetooth transport codec. If the glasses don't have a camera,
the phone-side handler rejects with an error. Check
`session.capabilities.hasCamera` before calling.

**Parameters:** `TakePhotoOptions` (optional)

```ts
interface TakePhotoOptions {
  size?: "low" | "medium" | "high" | "max"
  mode?: "photo" | "text"
  sound?: boolean
  saveToGallery?: boolean
  saveToCameraRoll?: boolean
  /** @deprecated ignored — delivery is always Bluetooth to the phone */
  transferMethod?: "auto" | "direct" | "ble"
  /** @deprecated ignored — the Bluetooth transport codec governs quality */
  compress?: "none" | "low" | "medium" | "high"
}
```

Defaults (applied client-side before the request is sent):

| Field | Default |
| --- | --- |
| `size` | `"medium"` |
| `mode` | `"photo"` |
| `sound` | `true` |
| `saveToGallery` | `false` |
| `saveToCameraRoll` | unset (no camera-roll export) |

`saveToGallery` keeps a copy in the glasses gallery; `saveToCameraRoll` also
exports the delivered photo to the phone's OS camera roll. `transferMethod`
and `compress` are still accepted for compatibility but no longer affect
delivery (an unknown `transferMethod` value is still rejected).

**Returns:** `PhotoTaken`

```ts
interface PhotoTaken {
  requestId: string
  dataUrl?: string // data:image/jpeg;base64,... — the image itself
  photoUrl: string // same data URL (older hosts: a short-lived download URL)
  mimeType: string
  size: number
}
```

`size` is the byte length of the delivered JPEG.

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
| `takePhoto` | `PHOTO` (`{size, mode, sound, saveToGallery, saveToCameraRoll?}`) | `REQUEST_RESULT` with `data: PhotoTaken` |
| `startVideoRecording` | `VIDEO_RECORDING_START` (`{width, height, fps, sound, save}`) | `REQUEST_RESULT` with `data: VideoRecordingStarted` |
| `stopVideoRecording` | `VIDEO_RECORDING_STOP` (`{recordingId}`) | `REQUEST_RESULT` |

This module subscribes to no streams. The `PHOTO_TAKEN` stream is
not surfaced through `CameraModule` in v1.

---

## Tests

_no integration tests yet_
