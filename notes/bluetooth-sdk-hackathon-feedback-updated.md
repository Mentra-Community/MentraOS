# Updated Feedback on `@mentra/bluetooth-sdk` - Hackathon Follow-Up

Current as of May 19, 2026. This refreshes the older hackathon feedback against the current SDK and starter-kit worktrees. It separates issues that are fixed or mostly addressed from items that still need product or engineering follow-up.

## Executive Summary

The SDK is in a much better place than the original feedback implied:

- The React Native starter kit now documents Bun-based setup and the iOS GStreamer requirement.
- The starter kit includes `setup-gstreamer-ios.sh`, and the iOS podspec attempts to install GStreamer automatically when missing from the default path.
- `connectFirst` is no longer the relevant API shape. The SDK now exposes `scan(model, {onResults, timeoutMs})`, and the React layer exposes `useBluetoothScan` / `useMentraBluetooth` for picker-oriented flows.
- `searchResults` now has an explicit stable-order contract in the SDK types.
- The React Native public surface now directs apps to shaped hook state instead of manual status plumbing.

The main remaining problems are less about "does the demo run at all?" and more about API clarity and production readiness:

- The React Native direct receiver still makes GStreamer a default native dependency for the example app, even for developers who only want phone photo upload.
- `setMicState(...)` no longer exposes `bypassVad`; app-facing microphone audio events are continuous while capture is enabled.
- `MicPcmEvent` and `MicLc3Event` now include payload metadata in the current worktree.
- Photo request rate limiting / queue overflow still appears silent from the app-facing API.
- iOS background BLE and audio requirements are now documented in the Mintlify iOS and React Native setup pages.

## Open Issues

### 1. Direct Receiver GStreamer Is Documented Now, But Still Too Heavy As A Default

Status: partially addressed.

The original "fresh clone cannot build iOS because GStreamer is missing" report is no longer accurate in its strict form. The React Native README now tells developers to run `bun run ios:setup`, explains that the companion direct receiver needs the GStreamer iOS SDK, and documents `GSTREAMER_ROOT_IOS`. The starter kit also has `modules/mentra-direct-receiver/scripts/setup-gstreamer-ios.sh`, and the iOS podspec attempts to run it during pod install when GStreamer is absent from the default location.

What remains open:

- `MentraDirectReceiver.podspec` still links `GStreamer.framework` and includes all Objective-C/Swift sources by default.
- A developer who only wants direct phone photo upload still pays the GStreamer install/build cost because the photo receiver and WebRTC receiver live in the same native module/podspec.
- GStreamer-iOS is still a large, unusual dependency for a starter app. It may be fine as an advanced demo, but it should not be unavoidable for the common photo-only path.

Recommended follow-up:

- Split the direct receiver into photo-only and WebRTC-capable variants, or add a build flag that excludes `GStreamerWhipReceiver.*`, `gst_ios_init.*`, and `WhipHeaderProxy.swift`.
- Make the default React Native starter path photo-only unless the developer opts into direct WebRTC preview.
- Keep GStreamer docs, but frame it as optional advanced setup rather than baseline starter-kit setup.

### 2. Phone-Side VAD Gating Is Removed From App-Facing PCM

Status: addressed in the current worktree.

The public APIs no longer expose `bypassVad`:

- React Native wrapper: `setMicState(enabled, useGlassesMic = true, sendTranscript = false, sendLc3Data = false)`
- Android native SDK: `setMicState(enabled = true, useGlassesMic = true, sendTranscript = false, sendLc3Data = false)`
- iOS native SDK: `setMicState(enabled: true, useGlassesMic: true, sendTranscript: false, sendLc3Data: false)`

The SDK no longer applies phone-side Voice Activity Detection gating to app-facing PCM or LC3 events. That keeps external STT, WAV writing, recording, and playback on a continuous microphone stream. Glasses-side Voice Activity Detection can be configured separately and reports both its enabled setting and live speaking state when supported.

Current behavior:

- Turn microphone capture on or off with `setMicState(enabled, ...)`.
- Use `setVoiceActivityDetectionEnabled(...)` for the glasses-side Voice Activity Detection setting.
- Use `speaking_status` as a speech/activity signal, not as a phone-side audio gate.

### 3. `MicPcmEvent` And `MicLc3Event` Now Include Metadata

Status: addressed in the current worktree.

The SDK now exposes:

```ts
export type MicPcmEvent = {
  type: "mic_pcm"
  pcm: ArrayBuffer
  sampleRate: 16000
  bitsPerSample: 16
  channels: 1
  encoding: "pcm_s16le"
  voiceActivityDetectionEnabled: boolean
}

export type MicLc3Event = {
  type: "mic_lc3"
  lc3: ArrayBuffer
  sampleRate: 16000
  channels: 1
  encoding: "lc3"
  frameDurationMs: 10
  frameSizeBytes: number
  bitrate: number
  packetizedFromGlasses: boolean
  voiceActivityDetectionEnabled: boolean
}
```

The event payload now says whether PCM is 16 kHz, 16-bit, mono, signed little-endian, and whether Voice Activity Detection is currently enabled. Native Android and iOS callbacks now receive `MicPcmEvent` and `MicLc3Event` objects instead of raw bytes. LC3 events now include the SDK's canonical sample rate, frame duration, frame size, derived bitrate, and whether the emitted frame is packetized exactly as received from glasses.

Remaining follow-up: verify the emitted metadata on both iOS and Android hardware while recording PCM and LC3, especially the current `lc3_frame_size` value.

### 4. Scan Progress Is Much Better; Keep `connectFirst` Out Of The Happy Path

Status: addressed in the current worktree.

The old feedback criticized `connectFirst(DeviceModels.MentraLive)` because it hid scan progress and could connect to the wrong glasses in a room full of devices. That API is not present in the current React Native SDK surface.

Current good state:

- `BluetoothSdk.scan(DeviceModels.MentraLive, {onResults, timeoutMs})` supports progressive picker updates.
- Native Android and iOS scan APIs also expose progressive results callbacks.
- `useBluetoothScan` and `useMentraBluetooth` give React apps a higher-level path without manually wiring status listeners.
- Docs now explicitly say `onResults` is for live UI updates and the returned list is the final scan result.

Documented behavior:

- Docs steer app developers toward explicit device pickers in multi-device environments.
- The primary getting-started snippets no longer auto-connect to the first nearby glasses.
- Picker guidance keeps the SDK-provided stable order as the default display order and treats RSSI as optional supplemental metadata.

### 5. RSSI Is Optional And Should Be Documented That Way

Status: addressed in the current worktree.

The SDK type correctly has `Device.rssi?: number`, and `searchResults` now documents stable discovery order. The old report that an item can appear first with `rssi=?` and update later is still plausible because scan results may be discovered before RSSI is available or before platform-specific scan metadata has settled.

Documented behavior:

- `Device.rssi` may be undefined at first discovery.
- Apps should use the SDK-provided stable discovery order by default and treat RSSI as supplemental signal-strength metadata when present.
- Picker UI should handle undefined RSSI without row jumping.

### 6. Photo Request Queue / Rate Limit Failures Still Need App-Facing Feedback

Status: still open.

The previous feedback described rapid `requestPhoto` calls eventually producing no shutter, no `photo_response`, and no app-facing error. The current SDK does not appear to expose an explicit queue-depth or rate-limit error for this path.

Recommended follow-up:

- Add an SDK-side in-flight guard or documented minimum interval for Mentra Live photo requests.
- Emit `photo_response` with an error code such as `rate_limited`, `queue_full`, `busy`, or `timeout` when the request cannot be accepted or does not complete in time.
- Document the recommended app behavior: one photo request at a time, user-visible busy state, and retry/backoff on rate-limit or timeout.

### 7. iOS Background BLE And Mic Requirements Need Dedicated Docs

Status: addressed in the current worktree.

The Mintlify iOS and React Native setup pages now document what developers must configure for BLE and microphone behavior while the phone is locked or the app backgrounds.

Updated docs now cover:

- `UIBackgroundModes` with `bluetooth-central` for BLE central behavior.
- `UIBackgroundModes` with `audio` when the app intentionally keeps microphone capture or audio playback active in the background.
- Expo / React Native `app.json` configuration under `ios.infoPlist`.
- `expo-audio` `setAudioModeAsync` setup for background recording/playback.
- The current SDK limitation: iOS `CBCentralManager` instances are not created with `CBCentralManagerOptionRestoreIdentifierKey`, so terminated-app Core Bluetooth state restoration is not supported yet.

### 8. `Device.id` Semantics Should Be Documented

Status: addressed in the current worktree.

The native SDKs now consistently derive `Device.id` from the platform address/identifier when available, otherwise from `model:name`.

Documented behavior:

- `id` is the stable app-facing key for a scan result within the limits of the platform data available.
- Android commonly uses a Bluetooth address when available, while iOS commonly uses a CoreBluetooth identifier when available.
- Apps should not parse `id` for model/name/address; use the typed fields.

### 9. React Native Status Shape Is Improving; Native Status Is Still Broad

Status: addressed for React Native in the current worktree. Native Android/iOS status grouping remains a later docs/API cleanup.

The current React Native direction is good: public docs are moving developers toward `useMentraBluetooth()` with shaped state:

- `mentra.glasses`
- `mentra.sdk`
- `mentra.scan`

This is better than asking apps to assemble their own status model from lower-level events.

Current React Native boundary:

- The root `@mentra/bluetooth-sdk` export is now an explicit app-facing command and event facade.
- React app status is documented through `useMentraBluetooth()` and its `mentra.glasses`, `mentra.sdk`, and `mentra.scan` state.
- For native Android/iOS, grouped status docs/API cleanup can wait; the current pass intentionally does not change those SDKs.

### 10. Native SDK Source Organization Needed The React Native Shape

Status: addressed in the current worktree.

The React Native SDK is the clearest reference shape: a small public facade, typed models, React hooks, and private native bridge details. Native iOS and Android now follow that direction more closely:

- iOS keeps `MentraBluetoothSDK.swift` as the public facade and moves models/callbacks/helpers into focused `Audio`, `Camera`, `Connection`, `Errors`, `Events`, `Internal`, `Requests`, `Status`, `Streaming`, and `Types` files.
- Android keeps `MentraBluetoothSdk.kt` as the facade and splits the former broad model file into the same domain groups.

Recommended follow-up:

- Continue using the React Native SDK as the API-shape reference when future native-only functionality is added.
- Keep raw store parsing and bridge helpers internal to the domain files rather than rebuilding a broad catch-all model file.

## Items That Are Now Outdated

These should not be repeated as current blockers:

- "React Native iOS example has no GStreamer setup script." It now has one.
- "README does not mention GStreamer." It now does.
- "`connectFirst` blocks the UI without scan progress." The current API direction is `scan(..., {onResults})` plus React hooks.
- "Search result list can reorder on every update." The SDK type now explicitly requires stable order for `searchResults`.
- "Camera flash/light can be disabled." The public React Native photo API no longer exposes a flash toggle, and docs say the camera light is always enabled for photo capture and streaming.

## What Is Working Well

- The starter-kit direct photo receiver has the right ergonomics: start a phone-local receiver, pass the upload URL to `requestPhoto`, and receive an on-disk JPEG URI.
- `scan(..., {onResults})` is the right primitive for user-facing pickers.
- `useMentraBluetooth()` is a strong React Native direction because it gives app developers shaped state instead of native-store snapshots.
- Stable scan-result ordering avoids UI churn when devices refresh.
- The Expo plugin continues to hide most Android/iOS permission plumbing from React Native apps.
- Continuous PCM is a good signal source for external STT.

## Suggested Next Priority Order

1. Split or gate GStreamer in the React Native direct receiver.
2. Add photo request timeout/rate-limit errors.
