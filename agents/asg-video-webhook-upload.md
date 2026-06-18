# ASG Video Webhook Upload (Upload Recorded Video on Stop)

## Date: 2026-06-09

## Summary

Recorded videos can now be uploaded to a webhook (multipart/form-data) when a
recording is stopped, mirroring the existing photo snapshot upload flow. The
glasses-side implementation landed in commit `dc35cc1` ("feat: upload recorded
video to webhook on stop"). The phone side now threads the upload target
(`webhookUrl` / `authToken`) and the start-time `maxRecordingTimeMinutes` from
the cloud message, through the Bluetooth SDK, into the BLE command.

Status:

- **Glasses (ASG client):** done — commit `dc35cc1`.
- **Phone Bluetooth SDK (Android + iOS):** done — see "Phone Bluetooth SDK
  threading" below.
- **Phone message handler (`SocketComms.ts`):** done.
- **Cloud:** not done — no video API exists yet to send the fields (see
  "Remaining (cloud)").

This doc captures the design and the implementation, following the established
BLE command path documented in `notes/bluetooth-sdk-subsystem-tracing.md`
(`## BLE Command Path`).

## Background

Previously `MediaCaptureService.uploadVideo()` was a stub — videos were always
kept on device with a `TODO: Implement WiFi upload when needed`. Photos already
had a full webhook upload path (`performDirectUpload`), so video upload is
modeled directly on it.

### Why the upload target is supplied at STOP, not START

For photos, `webhookUrl` + `authToken` travel with the capture request. For
video this is deliberately different: a recording can last arbitrarily long, so
an auth token captured at start could be stale by the time the upload runs. The
webhook URL and auth token are therefore supplied at **stop** time, kept fresh.

`maxRecordingTimeMinutes` is the one video field that belongs on **start** (it is
an auto-stop timer, `0` = no limit).

## What's done (glasses side — commit `dc35cc1`)

ASG client (`asg_client/`) already accepts and uses the new fields:

### `VideoCommandHandler.java`

- `start_video_recording` now reads `maxRecordingTimeMinutes` (default `0`) and
  forwards it to `MediaCaptureService.handleStartVideoCommand(...)`. The value is
  **validated** like the nearby `width`/`height`/`fps`: a negative value is
  treated as "no limit" (`0`) and an out-of-range value is capped at
  `MAX_RECORDING_TIME_MINUTES` (24h), so the downstream `minutes * 60 * 1000L`
  timer math can't overflow to a negative duration and stop the recording
  immediately.
- `stop_video_recording` now reads optional `webhookUrl` and `authToken`
  (default `""`) and forwards them to `handleStopVideoCommand(requestId,
  webhookUrl, authToken)` (with-requestId path) or `stopVideoRecording(webhookUrl,
  authToken)` (backward-compat path). Empty webhook = no upload, video stays on
  device. The stop handler logs only the `requestId`, **never the full payload**,
  so the `authToken` isn't leaked to logcat (the phone-side `SocketComms` redacts
  it the same way).

### `MediaCaptureService.java`

- The upload decision is **bound to the recording's `captureId`** (its capture-dir
  name, unique per recording) via a `ConcurrentHashMap<String, UploadTarget>`,
  **not** shared mutable fields. It is registered in `stopVideoRecording` **only
  once the stop is actually dispatched to the recorder** (below the "not recording"
  guard, so an early-return can never orphan it) and consumed exactly once by that
  recording's `onRecordingStopped`.
- **First stop wins** (`putIfAbsent`): only a `USER_REQUESTED` stop registers a
  webhook target; any auto-stop (battery, max-duration, error) registers a
  "no upload" decision. Because the entry is keyed by `captureId` and set with
  `putIfAbsent`, a later or racing stop — e.g. a user stop that lands *after* an
  auto-stop already committed to "no upload", even once the stop-reason guard has
  reset — cannot flip the outcome, and a new recording can't overwrite a prior
  recording's still-pending target.
- **Cleanup is guaranteed on every terminal path**: the entry is dropped by
  `onRecordingStopped` (removed up front, covering its null-file-path /
  cleanup-in-progress / integrity-failure exits), by `onRecordingError` (the
  mutually-exclusive alternative to `onRecordingStopped`), by the `stopVideoRecording`
  catch (failed dispatch → no callback fires), and by `cleanup()` (`clear()` on
  teardown). So a pending target — including its auth token — can never leak into a
  later recording or survive service teardown. `currentVideoPath` is `volatile`
  because the stop prologue reads it (to derive the `captureId` key) on a different
  thread than the start/callback writers.
- `uploadVideo(...)` is no longer a stub. With no webhook (null/empty/whitespace,
  trimmed) it keeps the file on device (legacy behavior); with a webhook it calls
  `performDirectVideoUpload(...)`.
- `performDirectVideoUpload(...)` does a background multipart POST mirroring the
  photo path. Multipart body: `video` (the `.mp4`), `requestId`,
  `type=video_upload`, `success=true`, plus optional `Authorization: Bearer
  <authToken>`. Timeouts are generous for large files (write 120s/idle, read
  30s/idle, `callTimeout` 300s end-to-end). **No BLE fallback** — video is far too
  large for BLE, so a failed upload is terminal. On success, the file is deleted
  unless `save` is `true`.

### Tests

- `VideoCommandHandlerStopUploadTest.java` verifies `stop_video_recording`
  routes the upload target to the correct `MediaCaptureService` entry point
  across the requestId / no-requestId / empty-webhook / not-recording cases, each
  asserting the *other* stop path is never taken.
- `VideoCommandHandlerStartValidationTest.java` verifies `maxRecordingTimeMinutes`
  is clamped (negative → `0`, over-cap → `MAX_RECORDING_TIME_MINUTES`, in-range
  passed through) before reaching `MediaCaptureService`.

## Phone Bluetooth SDK threading (done)

The fields are now threaded through every layer of the BLE command path,
**mirrored on both Android and iOS**, following the `requestPhoto` pattern below.
`stopVideoRecording` carries `webhookUrl` + `authToken`; `startVideoRecording`
carries `maxRecordingTimeMinutes` (inside its `settings`). The file list below
records exactly what changed.

### Reference: how `requestPhoto` already does it

`requestPhoto` already threads `webhookUrl` + `authToken` end-to-end and is the
canonical example to copy. On Android the chain is:

```
src/index.ts                         requestPhoto bound to native module
src/_private/BluetoothSdkModule.ts   requestPhoto(params: PhotoRequestParams)
──────── Expo native bridge ────────
BluetoothSdkModule.kt   AsyncFunction("requestPhoto") { params -> ... }
MentraBluetoothSdk.kt   fun requestPhoto(request) -> deviceManager.requestPhoto(...)
DeviceManager.kt        activeSgc.requestPhoto(requestId, appId, size, webhookUrl, authToken, ...)
SGCManager.kt           abstract fun requestPhoto(...)        ← interface
MentraLive.java         builds the BLE JSON command           ← only real impl
```

iOS mirrors this 1:1: `BluetoothSdkModule.swift` → `MentraBluetoothSDK.swift` →
`DeviceManager.swift` → `SGCManager.swift` → `MentraLive.swift`.

### Files changed for video

Implemented via **overloads with a delegating default** (not by widening the
existing abstract methods), so only `MentraLive` needed real changes — every
other glasses impl (G1, G2, Mach1, MentraNex, Simulated, Frame) inherits the
no-op default and was left untouched. `SGCManager` gained an
`open`/extension-default `stopVideoRecording(requestId, webhookUrl, authToken)`
that delegates to `stopVideoRecording(requestId)`, and `maxRecordingTimeMinutes`
was added to the existing rich `startVideoRecording` overload.

**TypeScript (public API + types):**

- `src/BluetoothSdk.types.ts`
  - `VideoRecordingSettings` (~L407): add `maxRecordingTimeMinutes?: number`.
  - `stopVideoRecording(...)` (~L890): add `webhookUrl?: string`,
    `authToken?: string`.
- `src/_private/BluetoothSdkModule.ts` (~L144-150): mirror the same signatures.
- `src/index.ts` (~L84-85): no signature change, just the existing binds.

**Android (Kotlin/Java):**

- `BluetoothSdkModule.kt`
  - `AsyncFunction("startVideoRecording")` (~L485): include
    `maxRecordingTimeMinutes` in the request.
  - `AsyncFunction("stopVideoRecording")` (~L506): currently takes only
    `requestId: String`; accept `webhookUrl` + `authToken` too.
- `MentraBluetoothSdk.kt`
  - `startVideoRecording(request: VideoRecordingRequest)` (~L772): add
    `maxRecordingTimeMinutes` to `VideoRecordingRequest`.
  - `stopVideoRecording(requestId)` (~L797): thread `webhookUrl` + `authToken`.
- `DeviceManager.kt`
  - `startVideoRecording(...)` (~L1464): add `maxRecordingTimeMinutes`, pass to
    `sgc?.startVideoRecording(...)`. (Note: `flash` is hardcoded `true` here.)
  - `stopVideoRecording(requestId)` (~L1479): add `webhookUrl` + `authToken`,
    pass to `sgc?.stopVideoRecording(...)`.
- `sgcs/SGCManager.kt`
  - `stopVideoRecording(requestId)` abstract (~L55): add `webhookUrl`,
    `authToken`. For start, add `maxRecordingTimeMinutes` to the rich
    `startVideoRecording` overload (~L43).
- `sgcs/MentraLive.java`
  - `startVideoRecording(...)` (~L7014): put `maxRecordingTimeMinutes` into the
    JSON when `> 0`.
  - `stopVideoRecording(...)` (~L7050): put `webhookUrl` / `authToken` into the
    JSON when present.
- **Other SGC impls** (`G1.java`, `G2.kt`, `Mach1.java`, `MentraNex.kt`,
  `Simulated.kt`, controllers): signature must compile, but they can no-op — only
  `MentraLive` records video.

**iOS (Swift) — mirror every Android change:**

- `BluetoothSdkModule.swift`, `MentraBluetoothSDK.swift`, `DeviceManager.swift`,
  `sgcs/SGCManager.swift`, `sgcs/MentraLive.swift` (JSON build at ~L5282 start /
  ~L5316 stop), and the other SGC impls (`G1`, `G2`, `Mach1`, `MentraNex`,
  `Simulated`, `Frame`).

### Pattern gotchas

- **Abstract interface + overloads.** `SGCManager` is abstract and implemented by
  every glasses class. Prefer adding a richer overload that delegates to the
  basic one (see the existing `startVideoRecording` overload in `SGCManager.kt`)
  so non-camera devices don't all need real implementations.
- **Always mirror iOS and Android.** Forgetting one platform is the classic bug
  in this module — every command exists twice.
- **Empty webhook = keep on device.** Match the glasses contract: an empty/absent
  `webhookUrl` must mean "no upload", not an error.

## Phone message handler (done)

`mobile/src/services/SocketComms.ts` now extracts the new fields from the cloud
message and forwards them into the SDK calls (mirroring `handle_photo_request`):

- `handle_stop_video_recording`: reads `webhookUrl` + `authToken` and calls
  `BluetoothSdk.stopVideoRecording(requestId, webhookUrl, authToken)`. Empty
  webhook = keep on device.
- `handle_start_video_recording`: reads `maxRecordingTimeMinutes` from either the
  canonical nested location (`settings.maxRecordingTimeMinutes`, per
  `VideoRecordingSettings`) or the legacy top-level `msg`, preferring nested
  (`??`, so an explicit `0` = "record until stopped" is preserved), and includes it
  in the `settings` object passed to `BluetoothSdk.startVideoRecording(...)`.

## Remaining (cloud — out of scope here, required for end-to-end)

The phone is now ready to receive and forward these fields, but nothing populates
them for video yet:

- The cloud has **no** video recording API and does not send `webhookUrl` /
  `authToken` in `stop_video_recording` (grep of `cloud/packages/` finds nothing).
  The cloud must expose a video API and populate the upload target on stop
  (mirroring how it does for `photo_request`).

This is tracked separately; this doc covers the glasses, Bluetooth SDK, and phone
message-handler layers.

## Related

- Glasses commit: `dc35cc1` (feat: upload recorded video to webhook on stop)
- BLE command path reference: `notes/bluetooth-sdk-subsystem-tracing.md`
- Photo upload reference: `requestPhoto` path + `MediaCaptureService.performDirectUpload`
