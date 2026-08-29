# @mentra/bluetooth-sdk

React Native and Expo SDK for connecting mobile apps directly to supported Mentra smart glasses over Bluetooth.

The package includes:

- A React Native / Expo module API exposed as `BluetoothSdk`.
- React hooks under `@mentra/bluetooth-sdk/react` for common scan,
  connection, status, and event lifecycles.
- Native Android code published as `com.mentraglass:bluetooth-sdk`.
- Native iOS code available as the `MentraBluetoothSDK` Swift package.
- An Expo config plugin that wires the native dependencies into generated Android and iOS projects.

Use a development build or production native build. Expo Go cannot load this package because the SDK contains native code.

## Requirements

- React Native `0.72+`.
- Expo `49+` when using Expo.
- Android min SDK `28+`.
- iOS deployment target `15.1+`.
- A physical phone for real Bluetooth testing.
- Bluetooth permissions, plus Android location permission where BLE scanning requires it.

## Install

```sh
bun add @mentra/bluetooth-sdk
bunx expo install expo-build-properties
```

For Expo apps, add the plugin to `app.json` or `app.config.ts`:

```json
{
  "expo": {
    "plugins": [
      [
        "@mentra/bluetooth-sdk",
        {
          "node": true
        }
      ],
      [
        "expo-build-properties",
        {
          "android": {
            "minSdkVersion": 28,
            "packagingOptions": {
              "pickFirst": [
                "**/libc++_shared.so",
                "**/libonnxruntime.so",
                "**/libonnxruntime4j_jni.so"
              ]
            }
          }
        }
      ]
    ]
  }
}
```

Then regenerate native projects and run a development build:

```sh
bunx expo prebuild
bunx expo run:ios
# or
bunx expo run:android
```

## Permissions

Android apps should request the permissions required by the features they use:

```json
{
  "android": {
    "permissions": [
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_ADMIN",
      "android.permission.BLUETOOTH_SCAN",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.RECORD_AUDIO",
      "android.permission.INTERNET",
      "android.permission.POST_NOTIFICATIONS"
    ]
  }
}
```

Some Android 12+ devices require Location permission and Location services before BLE scan callbacks are delivered.

iOS apps should include usage descriptions:

```json
{
  "ios": {
    "infoPlist": {
      "NSBluetoothAlwaysUsageDescription": "This app connects to your smart glasses over Bluetooth.",
      "NSMicrophoneUsageDescription": "This app uses the microphone when you enable audio features.",
      "NSLocalNetworkUsageDescription": "This app connects to local photo and streaming helpers during development."
    }
  }
}
```

## Minimal Usage

Use `scan()` when your app needs to show a picker. It calls `onResults` every time the discovered list changes, then resolves with the final list after the timeout.

```ts
import BluetoothSdk, {
  DeviceModels,
} from '@mentra/bluetooth-sdk'

const devices = await BluetoothSdk.scan(DeviceModels.MentraLive, {
  timeoutMs: 10_000,
  onResults: (nextDevices) => {
    console.log('Nearby glasses:', nextDevices)
  },
})

const device = await chooseDevice(devices)
if (!device) {
  throw new Error('No Mentra Live glasses selected')
}

await BluetoothSdk.connect(device)
const versionInfo = await BluetoothSdk.requestVersionInfo()
console.log(versionInfo.buildNumber)
```

In multi-device environments, present an explicit picker instead of
auto-connecting to the first nearby device.

Mentra Live does not have a display. Use display commands only after gating by
model capability.

Use `Device.id` as the stable app-facing key for scan rows, selected devices,
and persisted default devices. Do not parse it for model, name, or address
information; use the typed `model`, `name`, `address`, and `rssi` fields
instead. Android commonly uses a Bluetooth address when available, iOS commonly
uses a CoreBluetooth identifier when available, and the SDK falls back to
`model:name` when no platform identifier is available.

`Device.rssi` is optional. A device can appear in scan results before the
platform reports RSSI, so picker UI should handle `undefined` and avoid
reordering rows just because RSSI metadata arrives later.

## Mentra SDK Usage Analytics

The SDK sends three usage events to Mentra's PostHog project by default so
Mentra can understand SDK adoption, successful glasses connections, and
enterprise device deployments:

- `bluetooth_sdk_started`: sent once per app runtime after the native SDK starts.
- `bluetooth_sdk_glasses_connected`: sent when SDK status transitions from not connected to connected.
- `bluetooth_sdk_glasses_identified`: sent once per connection after the SDK receives a valid manufacturing serial from the glasses. This fires for every supported model that reports a serial. G1 and Ar99 decode the serial from the glasses' BLE advertisement. Mentra Live reports the product serial provisioned by its Android firmware through `asg_client`.

Analytics delivery is fire-and-forget: events are submitted asynchronously, do
not block Bluetooth SDK behavior, and are not retried if delivery fails.

React Native / Expo apps can disable these events before SDK startup through
the config plugin:

```json
{
  "expo": {
    "plugins": [
      [
        "@mentra/bluetooth-sdk",
        {
          "analytics": false
        }
      ]
    ]
  }
}
```

Native Android apps can pass `BluetoothSdkAnalyticsConfig.disabled()` in
`MentraBluetoothSdkConfig` or add
`com.mentra.bluetoothsdk.analytics.disabled=true` as application metadata.
Native iOS apps can pass `.disabled` in `MentraBluetoothSDKConfiguration` or set
`MentraBluetoothSdkAnalyticsDisabled` to `true` in `Info.plist`.

Mentra's PostHog project API key is embedded in the SDK as a public analytics
write token, not a private PostHog personal API key. Apps do not configure the
analytics destination; these SDK usage events are always sent to Mentra's
PostHog project unless analytics are disabled.

Captured properties include `event_source`, `sdk_platform`, `sdk_surface`,
`sdk_version`, `app_identifier` (the Android package or iOS bundle identifier),
the platform-specific `app_package` or `app_bundle_identifier`, OS
platform/version, and `event_kind`. Connection events also include
`fully_booted` and a glasses model value when known. The identification event
intentionally includes the glasses manufacturing serial as `glasses_device_id`,
with `glasses_device_id_type=manufacturing_serial`, so Mentra can correlate
fleet deployments across supported models. This serial identifies the glasses
hardware, not the user or the host phone. Its source depends on the model:
Mentra Live reports the serial provisioned in BES NV storage, while G1 and Ar99
decode it from the glasses' BLE advertisement / manufacturer data.

Apart from that glasses serial, the SDK does not upload BLE MAC addresses,
CoreBluetooth identifiers, the host phone's Android device serial, Bluetooth
device names, user ids, tokens, Wi-Fi credentials, microphone data, photos, or
transcripts. PostHog receives a locally generated anonymous SDK install id as
`distinct_id`, and events include `$process_person_profile: false`.

## React Hooks

React Native apps can import optional lifecycle helpers from the `react`
subpath for common lifecycle plumbing. Use the root `BluetoothSdk` object for
commands such as `requestPhoto()`, `startStream()`, and `setMicState()`.

```tsx
import {Button, Text, View} from 'react-native'
import {DeviceModels} from '@mentra/bluetooth-sdk'
import {useBluetoothEvent, useMentraBluetooth} from '@mentra/bluetooth-sdk/react'

export function DeviceScreen() {
  const mentra = useMentraBluetooth({
    defaultModel: DeviceModels.MentraLive,
    scanTimeoutMs: 10_000,
  })

  useBluetoothEvent('button_press', (event) => {
    console.log('Glasses button:', event.buttonId, event.pressType)
  })

  return (
    <View>
      <Text>{mentra.glasses.connected ? 'Connected' : 'Disconnected'}</Text>
      <Button disabled={mentra.busy} title="Scan" onPress={() => mentra.scan.start()} />
      {mentra.scan.devices.map((device) => (
        <Button key={device.id} title={device.name} onPress={() => mentra.connect(device)} />
      ))}
      <Button disabled={!mentra.glasses.connected} title="Disconnect" onPress={mentra.disconnect} />
    </View>
  )
}
```

The hooks do not request Android permissions or choose a persistence package for
you. Ask for permissions in your app before calling scan/connect actions, and
pass a `defaultDeviceStorage` adapter to `useMentraBluetooth` if you want a
default device to survive app restarts.

Use `useMentraBluetooth()` as the React status API for connection, battery,
Wi-Fi, hotspot, scan, and SDK runtime state.

The React hook exposes `glasses.connection` as a discriminated union:

```ts
type GlassesConnectionStatus =
  | {state: 'disconnected'}
  | {state: 'scanning'}
  | {state: 'connecting'}
  | {state: 'bonding'}
  | {state: 'connected'; fullyBooted: boolean}
```

Use `connection.state` for link progress. `fullyBooted` only exists when `state === 'connected'`. Android and iOS native APIs also keep `connectionState`, `connected`, and `fullyBooted` as native status properties for Kotlin and Swift callers.

## Default Device

`connectDefault()` connects to the default glasses target stored in SDK state. Apps that want this target to survive app restarts should persist the scanned `Device` in app storage and restore it with `setDefaultDevice()` before calling `connectDefault()`.

```ts
const savedDevice = await loadSavedDeviceFromYourAppStorage()
if (savedDevice) {
  await BluetoothSdk.setDefaultDevice(savedDevice)
  await BluetoothSdk.connectDefault()
}

const discoveredDevice = await scanAndChooseDevice()
await BluetoothSdk.connect(discoveredDevice)
await saveDeviceToYourAppStorage(discoveredDevice)

await BluetoothSdk.clearDefaultDevice()
await saveDeviceToYourAppStorage(null)
```

## Common Commands

```ts
await BluetoothSdk.clearDisplay()
await BluetoothSdk.showDashboard()
await BluetoothSdk.setDashboardPosition(4, 2)

const networks = await BluetoothSdk.requestWifiScan()
console.log(networks.map((network) => network.ssid))

const wifiStatus = await BluetoothSdk.sendWifiCredentials('Office WiFi', 'secret')
console.log(wifiStatus.state)

const forgetStatus = await BluetoothSdk.forgetWifiNetwork('Office WiFi')
console.log(forgetStatus.state)

const hotspotStatus = await BluetoothSdk.setHotspotState(true)
console.log(hotspotStatus.state)

await BluetoothSdk.setWifiAdbState(true) // Mentra Live Wi-Fi ADB (wireless debugging)

const galleryAck = await BluetoothSdk.setGalleryModeEnabled(true)
console.log(galleryAck.status)
await BluetoothSdk.setGalleryModeEnabled(false)

await BluetoothSdk.setPreferredMic('auto')
await BluetoothSdk.setMicState(true)
await BluetoothSdk.setOwnAppAudioPlaying(false)

const ledAck = await BluetoothSdk.rgbLedControl(
  `led-${Date.now()}`,
  'com.example.app',
  'on',
  'green',
  500,
  500,
  3,
)
console.log(ledAck.state)
```

Settings commands that return `SettingsAckSuccessEvent` reject when the ASG reports an error ack. The SDK updates its local settings store only after that ASG ack resolves successfully, so observed SDK state reflects the acknowledged glasses state rather than a queued request. Raw `settings_ack` listener events still use `SettingsAckEvent` because they can include both success and failure statuses. `rgbLedControl(...)` resolves from a successful ASG `rgb_led_control_response` and rejects when the ASG reports `state: "error"`; raw `settings_ack` and `rgb_led_control_response` events remain available through listeners.

WiFi, hotspot, and version-info commands resolve from the ASG response path, not local dispatch:
`requestWifiScan()` resolves from the ASG `wifi_scan_result` completion response with the updated scan list, including `[]` when no networks are found. Intermediate `wifi_scan_result` events can arrive with `scanComplete: false` while the glasses stream discovered networks; the final event uses `scanComplete: true`. If older glasses stream non-empty scan results but never send the completion event, the request resolves with the accumulated scan list when the request times out. `sendWifiCredentials()` resolves when the requested SSID is connected, `forgetWifiNetwork()` resolves when that SSID is no longer connected, `setHotspotState()` resolves when the requested hotspot state is reported, and `requestVersionInfo()` resolves from the ASG `version_info` response instead of local store changes.

The SDK automatically sends the phone wall clock once shortly after a glasses connection becomes ready. It waits for the initial command burst to drain before timestamping the command so startup queue delay does not become clock skew. The once-per-connection guard resets after disconnect, so every successful reconnect synchronizes again. The SDK does not periodically verify or correct clock skew during a long-lived connection; apps that require periodic reconciliation can compare `requestVersionInfo().systemTimeMs` with the phone clock.

React Native narrows returned values to success shapes where the raw listener event can also report errors:

| API | Returned Value After `await` | Error Path |
| --- | --- | --- |
| `requestPhoto(...)` | Terminal `PhotoSuccessResponseEvent` with `state: "success"` after capture and delivery finish. `uploadUrl` is always present; webhook JSON metadata such as `photoUrl`, `statusUrl`, `contentType`, or `fileSizeBytes` is included when the receiver returns it. | Rejects when raw `photo_response.state === "error"`, the SDK cannot send the command, or the terminal photo response times out. |
| `startVideoRecording(...)` | `VideoRecordingStartedStatusEvent` with `success: true` and `status: "recording_started"`. | Rejects on `success: false` statuses such as `already_recording`, send failure, or timeout. |
| `stopVideoRecording(...)` | `VideoRecordingStoppedStatusEvent` with `success: true` and `status: "recording_stopped"`. When a webhook URL is supplied, resolves after the video upload succeeds. | Rejects on `success: false` statuses such as `not_recording`, webhook upload failure, send failure, or timeout. |
| `queryVideoRecordingStatus(requestId)` | `VideoRecordingStatusEvent` with the current `recording` state and elapsed `duration_ms` when available. | Rejects when disconnected, another video command uses the same request ID, or the response times out. |
| `rgbLedControl(...)` | `RgbLedControlSuccessResponseEvent` with `state: "success"`. | Rejects when raw `rgb_led_control_response.state === "error"` or the response times out. |
| `checkForOtaUpdate()` | `boolean`, true when the configured OTA manifest has an ASG APK, MTK, or BES update for the connected glasses; false only when the manifest was checked successfully and no update is available. | Rejects when the glasses are disconnected, version info is unavailable, the manifest cannot be fetched, or the manifest response is invalid/missing required ASG app version fields. |

Android and iOS async APIs use `BluetoothSdkException` / `BluetoothSdkError` for the same error paths. Their returned event structs are the successful response in normal `try`/`await` code, while raw listener/delegate events still include both success and error payloads.

`setMicState(true)` defaults to continuous microphone PCM from the glasses. The SDK does not apply phone-side Voice Activity Detection gating to microphone audio events. Glasses-side Voice Activity Detection is disabled by default for public SDK consumers; use `setVoiceActivityDetectionEnabled(true)` when you want supported glasses to gate microphone audio and emit live speaking status. `voice_activity_detection_status` reports whether glasses-side Voice Activity Detection is enabled, and `speaking_status` reports speaking/not-speaking when supported. Microphone events include the latest `voiceActivityDetectionEnabled` value.

## OTA Updates

React Native apps should use `MentraLiveOtaFlow` or `useMentraLiveOta` from
`@mentra/engine/ota`. They provide the same tested Wi-Fi/hotspot,
APK/MTK/BES, restart, retry, and verification flow as the Mentra App. See
[Update Mentra Live](https://docs.mentraglass.com/bluetooth-sdk/software-update).

The Bluetooth SDK exposes the lower-level commands and transport capabilities
that Mentra Engine and native apps build on. They are not a replacement for the
Engine coordinator:

- `setOtaVersionUrl(url)` selects the manifest used by subsequent checks and installs. Use this
  for a customer-controlled internal update server.
- `getOtaVersionUrl()` returns the selected manifest, or the SDK-version-pinned Mentra manifest
  when no override was supplied.
- `checkForOtaUpdate()` fetches the configured manifest and resolves with `true` when an ASG APK, MTK, or BES update is available.
- `startOtaUpdate()` sends `ota_start` with the same configured manifest URL and resolves with the ASG start ack after your app presents the update and the user accepts it.
- `queryOtaStatus()` returns the correlated status for the active session.
- `@mentra/bluetooth-sdk/ota-transport` exposes scoped hotspot networking and
  the local OTA artifact server without exposing native module internals.

Release CI embeds an immutable manifest URL and checksum into every published
SDK distribution. The completed coordinated release record correlates the SDK
package with its exact manifest and OTA bundle. A completed release is available at
`https://github.com/Mentra-Community/MentraOS/releases/tag/mentra-v<releaseIdentity>`
and contains `mentra-release-<releaseIdentity>.json`, which records the exact
package coordinates, asset URLs, sizes, checksums, and build provenance.

Pre-wall-clock ASG builds that ignore `ota_start.ota_version_url` are checked
against the URL they advertise, or the production default if they do not
advertise one, so the app does not prompt for an update the glasses cannot
install.

Use these primitives directly only when implementing the documented native
Android/iOS OTA contract or infrastructure beneath a coordinator. React Native
application pages should render Mentra Engine's semantic controller state
instead of sequencing raw events.

Each coordinated prerelease publishes a portable OTA bundle. Stable releases
promote the exact beta-tested OTA bytes, so always resolve the bundle coordinate
and URL from `mentra-release-<releaseIdentity>.json` rather than constructing a
filename. The selected archive contains
`version.template.json`, every referenced ASG/MTK/BES artifact, `SHA256SUMS`,
and a dependency-free configuration script. After unpacking it, generate the
final manifest for its exact hosting URL:

```sh
node configure.mjs https://updates.example.internal/mentra-live/version.json
```

Host the entire directory at that location, then pass the same URL to `setOtaVersionUrl(...)`.
The generated `version.json` contains absolute internal artifact URLs, so it works with Mentra Live
ASG build 39 and newer as well as future firmware. Re-run the command if the hosted directory moves.

Firmware before ASG build 39 ignores `ota_start.ota_version_url` and must first be updated through
its legacy or factory-supported path. OTA remains host-driven: the SDK does not check or install
automatically.

OTA requires Mentra Live glasses firmware that supports the ASG OTA protocol and network access from the glasses. During install, normal BLE traffic can be interrupted and the glasses may restart; keep the app connected and avoid sending unrelated commands until `ota_status.status` is `complete` or `failed`.

For release selection, bundle verification, analytics opt-out, internal server
requirements, and disconnected validation, see the
[air-gapped deployment guide](https://docs.mentraglass.com/bluetooth-sdk/air-gapped-deployment).

Mentra Live also rejects `ota_start` before acknowledgement when its known battery level is below 5%, emitting a failed `ota_status` with `error_message: "battery_low"`. Unknown battery state remains fail-open, so apps should keep their own (typically stricter) user-facing battery policy.

## Photo Upload

```ts
const photo = await BluetoothSdk.requestPhoto({
  size: 'medium',
  webhookUrl: 'https://api.example.com/mentra/photo',
  authToken: 'optional-token',
  compress: 'medium',
  sound: true,
  exposureTimeNs: null, // auto exposure; pass a positive nanosecond value for manual exposure
  iso: null, // auto ISO; pass a positive ISO only with manual exposureTimeNs
})
console.log('photo delivered', photo.photoUrl ?? photo.uploadUrl, photo.fileSizeBytes)
```

`requestPhoto(...)` resolves only after the full photo action reaches terminal success: capture completed and the photo was delivered to the webhook, either directly from the glasses over Wi-Fi or through the phone's Bluetooth fallback relay. If you omit `requestId`, the SDK generates one and the terminal response includes it. It rejects if the ASG reports `state: "error"`, if phone-side fallback upload fails, if the SDK cannot send the command, or if no terminal `photo_response` arrives within 30 seconds. Photo requests use this longer operation-specific deadline because max-quality BLE fallback can legitimately exceed the 15-second deadline used by ordinary commands. Use `photo_status` for intermediate stages such as `accepted`, `configuring`, `capturing`, `captured`, `uploading`, `ble_fallback_compression`, `ready_for_transfer`, and `transferring`; `photo_status` is progress, while `photo_response` is terminal success/error. The raw `photo_response` event stream still includes both success and error events for subscribers. The webhook should accept multipart form data with a `photo` file and `requestId`. If `authToken` is provided, the uploader adds `Authorization: Bearer <token>`. The camera light is always enabled for photo capture.

For one-shot manual capture tuning, pass `exposureTimeNs` and `iso` together. `exposureTimeNs` is sensor exposure time in nanoseconds; `iso` is sensor ISO. If `exposureTimeNs` is omitted, `null`, invalid, or unsupported by the connected glasses, the camera uses auto exposure and ignores `iso`.

To own and explicitly release a warm camera, pass a request ID to `warmUpCamera({requestId, ...})`, then call `stopCameraWarmUp(requestId)` when the foreground UI closes. Warm holds default to 15 seconds and are capped at 60 seconds. Stopping while the camera is opening rejects the pending warm-up with `camera_warm_up_cancelled`; stopping after `ready` emits `stopped`. Compatible ready leases share the camera and expire independently.

Use `setCameraFov({fov, roiPosition})` to configure Mentra Live camera field of view and crop position. FOV is clamped to 62-118 degrees; ROI position is `"center"`, `"bottom"`, or `"top"`. You can also call `setCameraFov({preset: "narrow" | "standard" | "wide"})`; presets map to 82, 102, and 118 degrees with center ROI. The returned `CameraFovResult` resolves only after the ASG client reports that the setting was applied to camera hardware after the restart cooldown, and the promise rejects if the glasses report an error, persist the setting without hardware application, or time out. Raw `settings_ack` events remain available through `addListener("settings_ack", ...)` for diagnostic fields such as `hardwareApplied`. Treat FOV as a framing/ROI control; output resolution and effective detail can vary by capture path, firmware, and camera mode.

The missing/factory persistent FOV base is 102 degrees with centered ROI; existing saved values are not migrated. Use `setCameraFovOverride({leaseId, fov, roiPosition, ttlMs})` for a memory-only crop and `releaseCameraFovOverride(leaseId)` to restore the persistent base. A stale release is a safe no-op, and refreshing the same lease/config extends its TTL without another HAL restart.

`startVideoRecording(...)` resolves from the ASG `video_recording_status` event whose status is `recording_started`. `stopVideoRecording(...)` without a webhook resolves from `recording_stopped`; with a webhook it waits for `recording_stopped` plus a video `media_success`, and rejects on `media_error`. Use `queryVideoRecordingStatus(requestId)` after a timeout, reconnect, or app resume to fetch the glasses' current `recording` state and elapsed `duration_ms`. Raw `video_recording_status`, `media_success`, and `media_error` events remain available through listeners.

## Streaming

```ts
const streamId = `stream-${Date.now()}`

await BluetoothSdk.startStream({
  type: 'start_stream',
  streamUrl: 'http://192.168.1.42:8889/mentra-live/whip',
  streamId,
  video: {fps: 15},
})

await BluetoothSdk.stopStream()
```

Use `rtmp://` or `rtmps://` for RTMP, `srt://` for SRT, and `http://` or `https://` for WHIP/WebRTC ingest. `startStream()` resolves with the correlated `stream_status` event once the glasses report `status: "streaming"`; `stopStream()` resolves when the glasses report `status: "stopped"` or confirms the stream was already stopped / not streaming. `stopStream()` returns a normalized stopped event for that already-stopped case. Stream starts reject if the glasses report an error before streaming; stream stops reject for real stop errors, send failure, another stop in flight, or timeout. Stream video input fields are `width`, `height`, `bitrate`, and `fps`. The SDK sends stream keep-alives automatically while streaming and reports keep-alive failures through `stream_status`. The camera light is always enabled while streaming.
`stream_status` events may include `resolvedConfig`, which reports the effective transport, video, and audio settings after glasses defaults, clamps, and camera preflight. The resolved effective frame rate is reported as `resolvedConfig.video.fps`. While live, supported firmware emits periodic `streaming` events whose `stats` object contains `bitrate` (bits per second), `fps`, `droppedFrames`, `duration` (seconds), and `temperatureC` when the CPU sensor is available.

## Events

React Native components should use `useBluetoothEvent()` for hardware events:

```tsx
import {useBluetoothEvent} from '@mentra/bluetooth-sdk/react'

export function HardwareEventLogger() {
  useBluetoothEvent('button_press', (event) => console.log(event))
  useBluetoothEvent('touch_event', (event) => console.log(event))
  useBluetoothEvent('photo_status', (event) => console.log(event.status, event.resolvedConfig, event.captureMetadata))
  useBluetoothEvent('stream_status', (event) => console.log(event))
  useBluetoothEvent('speaking_status', (event) => console.log(event.speaking))
  useBluetoothEvent('mic_pcm', (event) => {
    console.log(event.sampleRate, event.bitsPerSample, event.channels, event.encoding)
    console.log(event.pcm)
  })
  useBluetoothEvent('mic_health', (event) => {
    console.log(event.reason, event.sequenceGapEvents, event.decodeFailures)
  })

  return null
}
```

For non-React modules, `BluetoothSdk.addListener(...)` is the low-level subscription API. Keep the returned subscription and call `remove()` when the listener is no longer needed.

Common event names include `button_press`, `touch_event`, `head_up`, `battery_status`, `wifi_status_change`, `wifi_scan_result`, `hotspot_status_change`, `photo_status`, `photo_response`, `gallery_status`, `settings_ack`, `version_info`, `stream_status`, `ota_start_ack`, `ota_status`, `mic_pcm`, `mic_lc3`, `mic_health`, `local_transcription`, `rgb_led_control_response`, `audio_connected`, `audio_disconnected`, and `log`.

React Native event payload fields usually use camelCase. OTA events intentionally mirror the glasses firmware field names, such as `overall_percent` and `version_name`. For example, `touch_event` includes `gestureName`, `wifi_scan_result` includes `networks` and `scanComplete`, `version_info` matches the `requestVersionInfo()` result shape, `photo_response` success includes `uploadUrl` and may include webhook-returned `photoUrl`, `statusUrl`, `contentType`, and `fileSizeBytes`, and `gallery_status` includes `hasContent`, `cameraBusy`, and optional `cameraBusyReason`. `photo_status` reports intermediate photo states such as `accepted`, `queued`, `configuring`, `capturing`, `captured`, `compressing`, `ble_fallback_compression`, `uploading`, `ready_for_transfer`, `transferring`, and `failed`; the `configuring` event includes `resolvedConfig` with the effective JPEG dimensions, quality, requested size, transfer method, compression, and manual exposure fields when present. The `capturing` event may include `requestedCaptureConfig` and `meteredPreview`; the `captured` event may include `captureMetadata` with the HAL-applied exposure, ISO, frame duration, and AE state. `mic_pcm` includes `sampleRate`, `bitsPerSample`, `channels`, and `encoding`; `mic_lc3` includes `sampleRate`, `channels`, `encoding`, `frameDurationMs`, `frameSizeBytes`, `bitrate`, and `packetizedFromGlasses`.

`mic_health` emits a snapshot when native code detects a glasses LC3 `sequence_gap` or `decode_failure`. Each event includes cumulative `sequenceGapEvents` and `decodeFailures` counters for the current connection plus `lastLc3ReceivedAt`, `lastPcmProducedAt`, and `timestamp` in Unix milliseconds when available. These failures occur before React Native receives PCM and cannot be reconstructed from `mic_pcm` alone. The existing `mic_pcm` and `mic_lc3` streams remain unchanged.

Photo status metadata is tied to the capture stage where the glasses know it:

| Status | Optional metadata | Meaning |
| --- | --- | --- |
| `configuring` | `resolvedConfig` | Effective JPEG size, quality, requested size, source, transfer method, compression, and manual capture settings when present. |
| `capturing` | `requestedCaptureConfig`, `meteredPreview` | Camera2 still request about to be submitted, plus the latest auto-exposure preview estimate before capture. |
| `captured` | `captureMetadata` | HAL-applied still capture result, including actual exposure, ISO, frame duration, AE state, and related camera modes when available. |

Upload and transfer statuses such as `uploading`, `compressing`, `ble_fallback_compression`, `ready_for_transfer`, and `transferring` describe transport progress only and do not carry capture metadata. `ble_fallback_compression` means the direct Wi-Fi/webhook upload failed and the glasses are compressing the already-captured photo for Bluetooth fallback delivery. Local action-button photos emitted by the glasses use the same `photo_status` event shape when the phone SDK is connected; those events use `resolvedConfig.source: "button"` and `resolvedConfig.transferMethod: "local"`.

Only documented imports are supported for app developers. Undocumented package subpaths or symbols with a leading underscore can change without notice.

## Local SDK Development

For normal app development, install the JavaScript package from npm. For SDK source development or release testing, install a local checkout and point Metro/native resolution at the same path:

```sh
bun add --no-save /path/to/MentraOS/mobile/modules/bluetooth-sdk
MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk bunx expo run:ios
```

Use `bunx expo run:android` for Android. Keep local paths in your shell or CI environment, not in committed app config.

For local Android source compile checks inside this monorepo, run from the
MentraOS repo root:

```sh
./scripts/check-android-compile.sh bluetooth-sdk
```

The `android/` folder in this package is source for the generated Expo Android
project, not the local Gradle entrypoint. The check script prepares
`mobile/android` and uses its Gradle wrapper with `-PmentraPublicSdk=true`,
matching the CI release workflow's public SDK dependency mode.

For bare native iOS apps, use the public SwiftPM repository:

```text
https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git
```

Select version `0.1.20`, then add the `MentraBluetoothSDK` product to your app target.

For local SDK development, add this package folder directly in Xcode:

```text
/path/to/MentraOS/mobile/modules/bluetooth-sdk
```

The core Swift package intentionally excludes optional local STT, Nex/SwiftProtobuf, Vuzix/Ultralite, and tar.bz2 extraction code paths.

Maintainers publishing the public SwiftPM mirror should follow
[RELEASING_IOS_SPM.md](./RELEASING_IOS_SPM.md).

## Android Maven Publishing

Maintainers publishing the native Android artifacts to Maven Central should
follow [RELEASING_ANDROID_MAVEN.md](./RELEASING_ANDROID_MAVEN.md).

Public Maven publishing uses a public SDK mode that omits MentraOS-only Android
integrations from the artifact metadata while normal MentraOS app builds keep
those integrations enabled.

Use `android/gradle.properties.example` as the template for Sonatype Central and
GPG signing properties. Put real values in `~/.gradle/gradle.properties` or CI
secrets, not in the repository.

## Starter Example App

The [Mentra Bluetooth SDK Starter Kit](https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit) includes starter example apps for Android, iOS, and React Native / Expo. The React Native starter demonstrates scan/connect, display, camera photo upload, RTMP/SRT/WebRTC streaming, Wi-Fi/hotspot, microphone PCM, RGB LED, gallery mode, and console event inspection.
