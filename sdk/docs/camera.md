# `session.camera`

Glasses camera control and photo capture for miniapps. `takePhoto()` captures
a frame on the glasses and keeps it on the phone as one of the miniapp's own
files for 30 minutes; nothing is uploaded. `setFov()` writes camera
field-of-view tuning to the device.

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

const bytes = await session.blob.bytes(photo.key) // send these wherever the photo goes
console.log(photo.key, photo.url, photo.mimeType, photo.size)
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

Take a photo via the glasses camera. The photo comes to the phone over
Bluetooth and is kept as a `session.blob` entry of the miniapp's that the phone
deletes after 30 minutes. It doesn't count toward the miniapp's storage limit,
and it needs no internet connection. Requires `CAMERA` declared in
`miniapp.json`, and Mentra App 3.5.0 or later (`"minHostVersion": "3.5.0"`); an
older Mentra App makes the call reject.

If the glasses don't have a camera, the phone-side handler rejects with an
error. Check `session.capabilities.hasCamera` before calling.

**Parameters:** `TakePhotoOptions` (optional)

```ts
interface TakePhotoOptions {
  size?: "low" | "medium" | "high" | "max"
  mode?: "photo" | "text"
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
| `compress` | `"none"` |
| `sound` | `true` |
| `saveToGallery` | `false` |

A larger `size` takes longer to arrive, because Bluetooth carries the whole
photo.

**Returns:** `PhotoTaken`

```ts
interface PhotoTaken {
  requestId: string
  key: string
  url?: string
  mimeType: string
  size: number
  expiresAt: number
}
```

- `key` is the photo's key in `session.blob`. Read it with
  `session.blob.bytes(key)`, share it with `session.blob.share(key)`, and keep
  it past `expiresAt` by storing a copy under a key of your own.
- `url` loads in the miniapp's own screen, for example `<img src={url}>`, until
  the photo is deleted. Pass it to the screen as it is. It is absent when the
  screen loads from a development server and the photo is larger than 1 MB.
- `size` is the photo's byte length.
- `expiresAt` is when the phone deletes the photo, as a Unix time in
  milliseconds.

---

### `takeCloudPhoto(options?)` — `Promise<CloudPhotoTaken>` (deprecated)

What `takePhoto()` did before photos stayed on the phone: uploads the photo to
Mentra's cloud and resolves to `{requestId, photoUrl, mimeType, size}`, where
`photoUrl` is a signed download URL that lasts about 30 minutes. It takes the
same options plus `transferMethod` (`"auto"`, `"direct"` or `"ble"`). It exists
for full-size photos that are too slow over Bluetooth, and goes away once
photos can reach the phone over Wi-Fi. Use `takePhoto()` for everything else.

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
| `INTERNAL` | `takePhoto` (rejected Promise) | Phone-side capture failed (no camera, hardware error, transfer failure). Check `message`. |

---

## Wire-level reference

For host implementors — request/response message types this module emits:

| Method | Request type | Response |
| --- | --- | --- |
| `setFov` | `CAMERA_FOV` (`{horizontal, vertical}`, one-shot) | — |
| `takePhoto` | `PHOTO` (`{size, mode, compress, sound, saveToGallery, delivery: "local"}`) | `REQUEST_RESULT` with `data: PhotoTaken` |
| `takeCloudPhoto` | `PHOTO` (`{size, mode, compress, sound, saveToGallery, transferMethod?}`) | `REQUEST_RESULT` with `data: CloudPhotoTaken` |
| `startVideoRecording` | `VIDEO_RECORDING_START` (`{width, height, fps, sound, save}`) | `REQUEST_RESULT` with `data: VideoRecordingStarted` |
| `stopVideoRecording` | `VIDEO_RECORDING_STOP` (`{recordingId}`) | `REQUEST_RESULT` |

This module subscribes to no streams. The `PHOTO_TAKEN` stream is
not surfaced through `CameraModule` in v1.

---

## Tests

_no integration tests yet_

### Breaking change: photo compression

Photo compression now accepts exactly `none`, `low`, `medium`, and `high`, sent
unchanged across the Mentra Miniapp SDK, Bluetooth SDKs, and glasses.
The default is `none` everywhere. Glasses encode these as JPEG Q95, Q88, Q78,
and Q60 respectively; `size` controls dimensions separately. `none` still uses
lossy JPEG encoding. Unknown values are rejected.

Cloud only allocates upload/download URLs: it takes no photo options and ignores
any request body. Photo compression is handled by the phone and glasses.

The former `heavy` spelling is removed; callers must use `high`. Android's native
default changes from `medium` to `none`. Existing miniapps may therefore produce
different JPEG quality or payload sizes. There are no compatibility aliases or wire translations.
