# API Reference

The Mentra Bluetooth SDK exposes the same core glasses lifecycle across Android, iOS, and React Native:

- Scan for a supported glasses model.
- Connect to a discovered `Device` or an app-restored default device.
- Read typed lifecycle state through the public surface for your platform.
- Subscribe to typed events.
- Send display, camera, stream, audio, Wi-Fi, hotspot, LED, and settings commands where supported by the connected model.

## Packages And Imports

| Platform | Install package | Import |
| --- | --- | --- |
| Android | `com.mentra:bluetooth-sdk` | `import com.mentra.bluetoothsdk.*` |
| iOS | `MentraBluetoothSDK` CocoaPod | `import MentraBluetoothSDK` |
| React Native / Expo | `@mentra/bluetooth-sdk` | `import BluetoothSdk, {DeviceModels} from '@mentra/bluetooth-sdk'` |
| React Native hooks | `@mentra/bluetooth-sdk` | `import {useMentraBluetooth} from '@mentra/bluetooth-sdk/react'` |

Only documented imports are part of the supported app developer API. Undocumented package subpaths or symbols with a leading underscore can change without notice.

## Lifecycle

Android:

```kotlin
val sdk = MentraBluetoothSdk.create(
    context = applicationContext,
    config = MentraBluetoothSdkConfig(),
    listener = listener,
)

sdk.close()
```

iOS:

```swift
let sdk = MentraBluetoothSDK(configuration: .default)
sdk.delegate = delegate

sdk.invalidate()
```

React Native:

```tsx
import {useBluetoothEvent, useMentraBluetooth} from '@mentra/bluetooth-sdk/react';

function DeviceScreen() {
  const mentra = useMentraBluetooth();
  useBluetoothEvent('button_press', (event) => {
    console.log(event.buttonId, event.pressType);
  });

  console.log(mentra.glasses.connection.state);
}
```

Keep one SDK instance per active app session. The SDK owns Bluetooth connection state, native event delivery, and cleanup. Your app owns user identity, UI state, and whether a default device record is persisted across app restarts.

## Permissions

Your app owns user-facing permission prompts and copy. Request Bluetooth permission before scanning and microphone permission before enabling audio or transcription features.

Android apps commonly need:

```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

Some Android 12+ devices still require runtime location permission and Location services before BLE scan callbacks arrive, even when Nearby Devices permissions are granted.

iOS apps commonly need:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>This app connects to your smart glasses over Bluetooth.</string>
<key>NSMicrophoneUsageDescription</key>
<string>This app uses the microphone when you enable audio features.</string>
```

Expo apps configure those permissions in `app.json`; see `examples/react-native/app.json`.

## Connection

Android:

```kotlin
val devices = mutableListOf<Device>()
val scanSession = sdk.scan(DeviceModel.MENTRA_LIVE, timeoutMs = 10_000) { nextDevices ->
    devices.clear()
    devices.addAll(nextDevices)
    renderDevicePicker(nextDevices)
}
scanSession.stop()

val device = chooseDevice(devices)
sdk.connect(device)
sdk.setDefaultDevice(device)
val defaultDevice = sdk.getDefaultDevice()
sdk.connectDefault()
sdk.clearDefaultDevice()

sdk.cancelConnectionAttempt()
sdk.disconnect()
sdk.forget()
```

iOS:

```swift
var devices: [Device] = []
let scanSession = try sdk.scan(model: .mentraLive, timeout: 10) { nextDevices in
    devices = nextDevices
    renderDevicePicker(nextDevices)
}
scanSession.stop()

let device = chooseDevice(devices)
try sdk.connect(to: device)
sdk.setDefaultDevice(device)
let defaultDevice = sdk.getDefaultDevice()
try sdk.connectDefault()
sdk.clearDefaultDevice()

sdk.cancelConnectionAttempt()
sdk.disconnect()
sdk.forget()
```

React Native:

```ts
import {DeviceModels} from '@mentra/bluetooth-sdk';

const devices = await BluetoothSdk.scan(DeviceModels.MentraLive, {
  timeoutMs: 10_000,
  onResults: (nextDevices) => renderDevicePicker(nextDevices),
});

const device = await chooseDevice(devices);
await BluetoothSdk.connect(device);

await BluetoothSdk.setDefaultDevice(device);
const defaultDevice = await BluetoothSdk.getDefaultDevice();
await BluetoothSdk.connectDefault();
await BluetoothSdk.clearDefaultDevice();

await BluetoothSdk.cancelConnectionAttempt();
await BluetoothSdk.disconnect();
await BluetoothSdk.forget();
```

Use `scan()` for user-facing device pickers. The progressive result callback is for UI: render the current nearby-device list every time it changes while Bluetooth is still scanning. The returned final result is for control flow: after the timeout/completion, choose a device from the last list and connect. In multi-device environments, do not auto-connect to the first nearby glasses; present an explicit picker.

Prefer connecting to a `Device` returned by SDK scan callbacks. If your app wants `connectDefault()` to work after restart, persist a small default-device record in app storage and restore it with `setDefaultDevice()` before calling `connectDefault()`.

`Device.id` is the stable app-facing key for a scan result, within the limits of the platform identifier available to the SDK. Use it as a list key, selected-device key, and persisted default-device key. Do not parse `id` for model, name, or address information; use the typed fields instead. Android commonly uses a Bluetooth address when available, iOS commonly uses a CoreBluetooth identifier when available, and the SDK falls back to `model:name` when no platform identifier is available.

`Device.rssi` is optional. A device can appear in scan results before the platform reports RSSI, so picker UI should handle `undefined` and avoid reordering rows just because RSSI metadata arrives later.

## Status

Android:

```kotlin
val state = sdk.getState()
val glasses = sdk.getGlasses()
val sdkState = sdk.getSdkState()
val scan = sdk.getScanState()
```

iOS:

```swift
let state = sdk.state
let glasses = sdk.glasses
let sdkState = sdk.sdkState
let scan = sdk.scanState
```

React Native:

```ts
import {useMentraBluetooth} from '@mentra/bluetooth-sdk/react';

const mentra = useMentraBluetooth();
```

Status snapshots are safe to read at any time. Treat command success as "command accepted"; keep UI state derived from status callbacks or hook state.

Public status is grouped the same way across platforms:

| Field | Meaning |
| --- | --- |
| `glasses` | Connected-glasses runtime state. Includes connection/readiness, connected device identity, battery, firmware, Wi-Fi, hotspot, and signal metadata when connected. |
| `sdk` | Phone-side SDK runtime state. Includes default device, gallery mode, microphone route, mic ranking, Wi-Fi scan results, scan activity, system mic availability, other Bluetooth audio status, and recent SDK log lines. |
| `scan` | User-facing scan state. Includes whether a scan is active, whether controller scanning is active, and the stable-order discovered `Device[]` list. |

Native Android exposes `GlassesRuntimeState` as `Connected` or `Disconnected`. Native iOS exposes `GlassesRuntimeState` as `.connected(...)` or `.disconnected(...)`. Use the grouped native state for app UI.

React Native exposes `mentra.glasses.connection` through `useMentraBluetooth()`:

```ts
type GlassesConnectionStatus =
  | {state: 'disconnected'}
  | {state: 'scanning'}
  | {state: 'connecting'}
  | {state: 'bonding'}
  | {state: 'connected'; fullyBooted: boolean};
```

Use `mentra.glasses.connection.state` for link-layer progress. `fullyBooted` only exists on the connected state, so impossible states like `{state: 'disconnected', fullyBooted: true}` are not representable in TypeScript. Use `isConnectedGlassesConnectionStatus()`, `isReadyGlassesConnectionStatus()`, and `isBusyGlassesConnectionStatus()` when you want named readiness checks.

Use `glasses.connected` / `mentra.glasses.connected` before reading connected-only fields. Native Android uses `GlassesRuntimeState.Connected`; native iOS uses `GlassesRuntimeState.connected(...)`; React Native exposes `mentra.glasses` with the same grouped concepts in React-friendly objects.

## React Native Public Surface

These are the supported React Native app developer entrypoints:

| Area | Methods |
| --- | --- |
| Status and subscriptions | `useMentraBluetooth`, `useBluetoothScan`, and `useBluetoothEvent` for React components; `addListener` is available as the lower-level non-React subscription API |
| Default device | `getDefaultDevice`, `setDefaultDevice`, `clearDefaultDevice` |
| Connection | `scan`, `startScan`, `stopScan`, `connect`, `connectDefault`, `cancelConnectionAttempt`, `disconnect`, `forget` |
| Display | `displayText`, `clearDisplay`, `showDashboard`, `setDashboardPosition`, `setHeadUpAngle`, `setScreenDisabled` |
| Wi-Fi and hotspot | `requestWifiScan`, `sendWifiCredentials`, `forgetWifiNetwork`, `setHotspotState` |
| Camera and gallery | `requestPhoto`, `queryGalleryStatus`, `setGalleryModeEnabled`, `setButtonPhotoSettings`, `setButtonVideoRecordingSettings`, `setButtonCameraLed`, `setButtonMaxRecordingTime`, `setCameraFov`, `startVideoRecording`, `stopVideoRecording` |
| Streaming | `startStream`, `keepStreamAlive`, `stopStream` |
| Audio | `setMicState`, `setPreferredMic`, `setVoiceActivityDetectionEnabled`, `setOwnAppAudioPlaying`, `getGlassesMediaVolume`, `setGlassesMediaVolume` |
| LED and version | `rgbLedControl`, `requestVersionInfo` |

React Native helper exports include `DeviceModels`, `isConnectedGlassesConnectionStatus`, `isReadyGlassesConnectionStatus`, `isBusyGlassesConnectionStatus`, `isConnectedWifiStatus`, and `isEnabledHotspotStatus`. The React subpath exports `useMentraBluetooth`, `useBluetoothScan`, and `useBluetoothEvent`.

For React Native status UI, use `useMentraBluetooth()` from `@mentra/bluetooth-sdk/react`. It returns `mentra.glasses`, `mentra.sdk`, and `mentra.scan` for connection, battery, Wi-Fi, hotspot, scan, and SDK runtime state.

### Version Fields

Call `requestVersionInfo()` after connection when your app wants the glasses to refresh version metadata. Updated values arrive through the normal status callback and are also available in the next status snapshot.

| Field | Meaning |
| --- | --- |
| `fwVersion` / `firmwareVersion` | Generic glasses firmware version when the connected model reports one. |
| `deviceFirmwareVersion` | Device firmware version for models that report device info as a structured payload. |
| `leftFirmwareVersion` / `rightFirmwareVersion` | Per-side firmware versions for glasses that report left/right firmware separately. |
| `besFirmwareVersion` | Mentra Live BES firmware version. |
| `mtkFirmwareVersion` | Mentra Live MTK/system OTA firmware version. |
| `appVersion` | Glasses-side companion app version. On Mentra Live this is the ASG client APK version, not firmware. |
| `androidVersion` | Android OS version on Android-based glasses. This is not firmware. |

Different glasses models expose different version fields, so apps should prefer the generic firmware field when present, then fall back to model-specific firmware fields. Keep app and OS versions visibly labeled as app/OS versions.

## Display

Mentra Live does not have a display. Use these APIs only on display-equipped models such as G2.

Android:

```kotlin
sdk.displayText(text = "Pickup at gate B12", x = 0, y = 0, size = 24)
sdk.clearDisplay()
sdk.showDashboard()
```

iOS:

```swift
try await sdk.displayText("Pickup at gate B12", x: 0, y: 0, size: 24)
try await sdk.clearDisplay()
sdk.showDashboard()
```

React Native:

```ts
await BluetoothSdk.displayText('Pickup at gate B12', 0, 0, 24);
await BluetoothSdk.clearDisplay();
await BluetoothSdk.showDashboard();
```

Use `displayText` for normal glanceable UI on display-equipped models. Use `displayEvent` only for advanced display payloads that require lower-level rendering control.

## Hardware Settings

Android:

```kotlin
sdk.setBrightness(level = 60)
sdk.setBrightness(level = 60, autoMode = false)
sdk.setAutoBrightness(enabled = true)
sdk.setDashboardPosition(height = 4, depth = 6)
sdk.setHeadUpAngle(angleDegrees = 20)
sdk.setScreenDisabled(false)
sdk.setGalleryModeEnabled(true)
sdk.setButtonPhotoSettings(size = ButtonPhotoSize.MEDIUM)
sdk.setButtonVideoRecordingSettings(width = 1280, height = 720, fps = 30)
sdk.setButtonCameraLed(enabled = true)
sdk.setButtonMaxRecordingTime(minutes = 3)
sdk.setCameraFov(CameraFov(fov = 102, roiPosition = 0))
```

iOS:

```swift
try await sdk.setBrightness(60)
try await sdk.setBrightness(60, autoMode: false)
try await sdk.setAutoBrightness(enabled: true)
try await sdk.setDashboardPosition(height: 4, depth: 6)
try await sdk.setHeadUpAngle(20)
try await sdk.setScreenDisabled(false)
try await sdk.setGalleryModeEnabled(true)
try await sdk.setButtonPhotoSettings(size: .medium)
try await sdk.setButtonVideoRecordingSettings(width: 1280, height: 720, fps: 30)
try await sdk.setButtonCameraLed(enabled: true)
try await sdk.setButtonMaxRecordingTime(minutes: 3)
try await sdk.setCameraFov(CameraFov(fov: 102, roiPosition: 0))
```

React Native:

```ts
await BluetoothSdk.setBrightness(60, false);
await BluetoothSdk.setAutoBrightness(true);
await BluetoothSdk.setDashboardPosition(4, 6);
await BluetoothSdk.setHeadUpAngle(20);
await BluetoothSdk.setScreenDisabled(false);
await BluetoothSdk.setGalleryModeEnabled(true);
await BluetoothSdk.setGalleryModeEnabled(false);
await BluetoothSdk.setButtonPhotoSettings('medium');
await BluetoothSdk.setButtonVideoRecordingSettings(1280, 720, 30);
await BluetoothSdk.setButtonCameraLed(true);
await BluetoothSdk.setButtonMaxRecordingTime(3);
await BluetoothSdk.setCameraFov({fov: 102, roiPosition: 0});
```

Mentra Live gallery mode controls right-action-button capture. When gallery mode is enabled, a short press takes a photo, a long press starts video recording, and a short press stops the active video recording. `setGalleryModeEnabled(true)` enables local button capture; `setGalleryModeEnabled(false)` reports button and touch events to the host app without triggering local gallery capture while the glasses are connected. Button presses are always reported as SDK events.

`setCameraFov` accepts FOV degrees from 82 to 118 and ROI position `0` center, `1` bottom, or `2` top. On Mentra Live, applying FOV/ROI restarts the camera for about 5 seconds; wait for that restart before requesting a photo.

## RGB LED

Android:

```kotlin
sdk.rgbLedControl(
    RgbLedRequest(
        requestId = "led-${System.currentTimeMillis()}",
        packageName = "com.example.assistant",
        action = RgbLedAction.ON,
        color = RgbLedColor.GREEN,
        ontime = 500,
        offtime = 500,
        count = 3,
    )
)
```

iOS:

```swift
sdk.rgbLedControl(
    RgbLedRequest(
        requestId: "led-\(Date().timeIntervalSince1970)",
        packageName: "com.example.assistant",
        action: .on,
        color: .green,
        ontime: 500,
        offtime: 500,
        count: 3
    )
)
```

React Native:

```ts
await BluetoothSdk.rgbLedControl(
  `led-${Date.now()}`,
  'com.example.assistant',
  'on',
  'green',
  500,
  500,
  3,
);
```

RGB LED support is hardware-dependent. Unsupported glasses should report an SDK error or capability status.

## Microphone And Audio

Android:

```kotlin
sdk.setPreferredMic(MicPreference.AUTO)
sdk.setOwnAppAudioPlaying(false)
sdk.setMicState(enabled = true)
```

iOS:

```swift
sdk.setPreferredMic(.auto)
sdk.setOwnAppAudioPlaying(false)
sdk.setMicState(enabled: true)
```

React Native:

```ts
await BluetoothSdk.setOwnAppAudioPlaying(false);
await BluetoothSdk.setMicState(true);
```

Microphone audio events and local transcription are advanced capabilities. Gate them behind explicit user permission and in-app controls.

`setMicState(enabled)` defaults to glasses microphone audio, transcript events off, and LC3 events off. Microphone audio events are continuous while capture is enabled; glasses-side Voice Activity Detection status is reported separately through `voice_activity_detection_status` and `speaking_status` events when supported.

Phone-originated playback is routed by the OS, not by the BLE command channel. On Android, Mentra Live initiates Bluetooth Classic bonding after BLE connects; accept the system pairing dialog so media audio can route to the glasses. On iOS, users must pair/connect the glasses from Settings > Bluetooth and select them as the audio output because apps cannot initiate Bluetooth Classic audio pairing.

Mentra Live and G2 both have microphones. Mentra Live has a speaker; G2 does not. Gate speaker playback UI by the connected model.

Mentra Live also supports a BLE-controlled media step volume. This controls the glasses volume, not the phone output route:

```kotlin
val volume = sdk.getGlassesMediaVolume()
sdk.setGlassesMediaVolume(8)
```

```ts
const volume = await BluetoothSdk.getGlassesMediaVolume();
await BluetoothSdk.setGlassesMediaVolume(8);
```

Volume values are in the `0..15` range.

## Camera Photo Upload

Use photo requests when your app needs the glasses to capture a photo and upload it to your backend. Mentra Live has a camera; G2 does not. The phone sends the command over Bluetooth, then the photo is delivered to the `webhookUrl`.

Android:

```kotlin
sdk.requestPhoto(
    PhotoRequest(
        requestId = "assistant-${System.currentTimeMillis()}",
        appId = "com.example.assistant",
        size = PhotoSize.MEDIUM,
        webhookUrl = "https://api.example.com/mentra/photo",
        authToken = "optional-token",
        compress = PhotoCompression.MEDIUM,
        sound = true,
        exposureTimeNs = null,
    )
)
```

iOS:

```swift
sdk.requestPhoto(
    PhotoRequest(
        requestId: "assistant-\(Date().timeIntervalSince1970)",
        appId: "com.example.assistant",
        size: .medium,
        webhookUrl: "https://api.example.com/mentra/photo",
        authToken: "optional-token",
        compress: .medium,
        sound: true,
        exposureTimeNs: nil
    )
)
```

React Native:

```ts
await BluetoothSdk.requestPhoto({
  requestId: `assistant-${Date.now()}`,
  appId: 'com.example.assistant',
  size: 'medium',
  webhookUrl: 'https://api.example.com/mentra/photo',
  authToken: 'optional-token',
  compress: 'medium',
  sound: true,
  exposureTimeNs: null,
});
```

Omit `exposureTimeNs` or pass `null` for auto exposure. Pass a positive nanosecond value for one-shot manual exposure, for example `8_333_333` for about 1/120s. The camera light is always enabled for photo capture and streaming as a privacy indicator.

Your webhook should accept multipart form data with a `photo` file and `requestId`. If you include `authToken`, the uploader adds `Authorization: Bearer <token>` on the webhook request.

For local development, run `python3 examples/local-demo-cloud/server.py` from the repo root and use the printed LAN `/upload` URL. Do not use `localhost`.

## Streaming

Use streaming requests when your app needs Mentra Live to stream camera video to an RTMP, SRT, or WHIP endpoint. G2 does not have a camera. The SDK selects the protocol from the URL prefix.

| URL prefix | Protocol |
| --- | --- |
| `rtmp://` or `rtmps://` | RTMP |
| `srt://` | SRT |
| `http://` or `https://` | WHIP / WebRTC ingest |

Android:

```kotlin
val streamId = "stream-${System.currentTimeMillis()}"

sdk.startStream(StreamRequest(streamUrl = streamUrl, streamId = streamId))
sdk.keepStreamAlive(StreamKeepAliveRequest(streamId = streamId, ackId = "ack-${System.currentTimeMillis()}"))
sdk.stopStream()
```

iOS:

```swift
let streamId = "stream-\(Int(Date().timeIntervalSince1970 * 1000))"

sdk.startStream(StreamRequest(streamUrl: streamUrl, streamId: streamId))
sdk.keepStreamAlive(StreamKeepAliveRequest(streamId: streamId, ackId: "ack-\(Int(Date().timeIntervalSince1970 * 1000))"))
sdk.stopStream()
```

React Native:

```ts
const streamId = `stream-${Date.now()}`;

await BluetoothSdk.startStream({type: 'start_stream', streamUrl, streamId});
await BluetoothSdk.keepStreamAlive({type: 'keep_stream_alive', streamId, ackId: `ack-${Date.now()}`});
await BluetoothSdk.stopStream();
```

When `keepAlive` is enabled, call `keepStreamAlive` about every 15 seconds while the stream is active. For local streaming development, use `examples/local-demo-cloud` and paste the printed RTMP, SRT, or WHIP publish URL into the example app.

## Wi-Fi And Hotspot

Android:

```kotlin
sdk.requestWifiScan()
sdk.sendWifiCredentials(ssid = "Office WiFi", password = "secret")
sdk.forgetWifiNetwork("Office WiFi")
sdk.setHotspotState(enabled = true)
```

iOS:

```swift
sdk.requestWifiScan()
sdk.sendWifiCredentials(ssid: "Office WiFi", password: "secret")
sdk.forgetWifiNetwork(ssid: "Office WiFi")
sdk.setHotspotState(enabled: true)
```

React Native:

```ts
await BluetoothSdk.requestWifiScan();
await BluetoothSdk.sendWifiCredentials('Office WiFi', 'secret');
await BluetoothSdk.forgetWifiNetwork('Office WiFi');
await BluetoothSdk.setHotspotState(true);
```

## Version, Maintenance, And Diagnostics

| Area | Android | iOS | React Native |
| --- | --- | --- | --- |
| Version info | `requestVersionInfo()` | `requestVersionInfo()` | `requestVersionInfo()` |
| Stream status | `onStreamStatus` | `BluetoothEvent.streamStatus` | `stream_status` listener |
| SDK diagnostics | `onLog`, `onError` | `didLog`, `didFail` | `log` events and rejected promises |

Expose advanced controls only when SDK status/capability signals say the connected device supports them.

## Android Listener

```kotlin
interface MentraBluetoothSdkListener {
    fun onStateChanged(state: MentraBluetoothState) {}
    fun onGlassesChanged(glasses: GlassesRuntimeState) {}
    fun onSdkStateChanged(sdk: PhoneSdkRuntimeState) {}
    fun onScanChanged(scan: BluetoothScanState) {}
    fun onDeviceDiscovered(device: Device) {}
    fun onScanStopped(reason: ScanStopReason) {}
    fun onButtonPress(event: ButtonPressEvent) {}
    fun onTouch(event: TouchEvent) {}
    fun onSwipe(event: SwipeEvent) {}
    fun onHeadUpChanged(headUp: Boolean) {}
    fun onBatteryStatus(event: BatteryStatusEvent) {}
    fun onWifiStatusChanged(event: WifiStatusEvent) {}
    fun onHotspotStatusChanged(event: HotspotStatusEvent) {}
    fun onHotspotError(event: HotspotErrorEvent) {}
    fun onGalleryStatus(event: GalleryStatusEvent) {}
    fun onPhotoResponse(event: PhotoResponseEvent) {}
    fun onStreamStatus(event: StreamStatusEvent) {}
    fun onKeepAliveAck(event: KeepAliveAckEvent) {}
    fun onMicPcm(event: MicPcmEvent) {}
    fun onMicLc3(event: MicLc3Event) {}
    fun onLocalTranscription(event: LocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: Device?) {}
    fun onLog(message: String) {}
    fun onError(error: BluetoothError) {}
    fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}
```

Callbacks are delivered on the Android main thread by default. Set `MentraBluetoothSdkConfig(deliverCallbacksOnMainThread = false)` only if your app is prepared to receive callbacks on the SDK/event thread.

## iOS Delegate

```swift
@MainActor
public protocol MentraBluetoothSDKDelegate: AnyObject {
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdate state: MentraBluetoothState)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlasses glasses: GlassesRuntimeState)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateSdkState sdkState: PhoneSdkRuntimeState)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateScan scan: BluetoothScanState)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: Device)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: ScanStopReason)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: BluetoothEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm event: MicPcmEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 event: MicLc3Event)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: Device?)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: BluetoothError)
}
```

Delegate methods have default empty implementations, so Swift apps can implement only the callbacks they need.

## React Native Events

React Native components should use `useBluetoothEvent()` for SDK events. The hook keeps the callback typed and removes the native subscription when the component unmounts:

```tsx
import {useBluetoothEvent} from '@mentra/bluetooth-sdk/react';

export function HardwareEventLogger() {
  useBluetoothEvent('button_press', (event) => console.log(event));
  useBluetoothEvent('touch_event', (event) => console.log(event));
  useBluetoothEvent('photo_response', (event) => console.log(event));
  useBluetoothEvent('stream_status', (event) => console.log(event));
  useBluetoothEvent('mic_pcm', (event) => {
    console.log(event.sampleRate, event.bitsPerSample, event.channels, event.encoding);
    console.log(event.pcm);
  });

  return null;
}
```

For non-React modules, `BluetoothSdk.addListener(...)` is the low-level subscription API. Keep the returned subscription and call `remove()` when the listener is no longer needed.

The React Native event surface is typed through `BluetoothSdkEventMap`. These are the public event names accepted by `useBluetoothEvent()` and `BluetoothSdk.addListener()`:

| Event name | Payload type | When it fires |
| --- | --- | --- |
| `log` | `LogEvent` | SDK diagnostic log line. |
| `device_discovered` | `Device` | A supported glasses device is discovered during scan. |
| `default_device_changed` | `{device?: Device}` | The SDK default device changes. |
| `glasses_not_ready` | `GlassesNotReadyEvent` | A command needs ready glasses but the connected device is not ready. |
| `button_press` | `ButtonPressEvent` | Glasses button press. |
| `touch_event` | `TouchEvent` | Glasses touch or swipe gesture. |
| `head_up` | `HeadUpEvent` | Head-up state changes. |
| `voice_activity_detection_status` | `VoiceActivityDetectionStatusEvent` | Voice Activity Detection on/off state changes. |
| `speaking_status` | `SpeakingStatusEvent` | Glasses-side speech activity changes. |
| `battery_status` | `BatteryStatusEvent` | Battery update from glasses. |
| `local_transcription` | `LocalTranscriptionEvent` | SDK local transcription text update. |
| `wifi_status_change` | `WifiStatusChangeEvent` | Glasses Wi-Fi connection state changes. |
| `hotspot_status_change` | `HotspotStatusChangeEvent` | Glasses hotspot state changes. |
| `hotspot_error` | `HotspotErrorEvent` | Hotspot operation fails. |
| `photo_response` | `PhotoResponseEvent` | Photo request succeeds or fails. |
| `gallery_status` | `GalleryStatusEvent` | Gallery content/camera-busy status changes. |
| `compatible_glasses_search_stop` | `CompatibleGlassesSearchStopEvent` | Compatible-glasses search stops for a model. |
| `swipe_volume_status` | `SwipeVolumeStatusEvent` | Swipe-volume setting changes. |
| `switch_status` | `SwitchStatusEvent` | Glasses switch status changes. |
| `rgb_led_control_response` | `RgbLedControlResponseEvent` | RGB LED command succeeds or fails. |
| `pair_failure` | `PairFailureEvent` | Bluetooth pairing fails. |
| `audio_pairing_needed` | `AudioPairingNeededEvent` | The phone needs Bluetooth audio pairing for the device. |
| `audio_connected` | `AudioConnectedEvent` | Bluetooth audio connects. |
| `audio_disconnected` | `AudioDisconnectedEvent` | Bluetooth audio disconnects. |
| `mic_pcm` | `MicPcmEvent` | PCM microphone frame arrives. |
| `mic_lc3` | `MicLc3Event` | LC3 microphone frame arrives. |
| `stream_status` | `StreamStatusEvent` | Camera stream lifecycle, reconnect, or error state changes. |
| `keep_alive_ack` | `KeepAliveAckEvent` | Glasses acknowledge a stream keep-alive request. |

React Native event payload fields use camelCase. For example, `touch_event` includes `deviceModel` and `gestureName`, successful `photo_response` events include `uploadUrl`, hotspot errors include `errorMessage`, and `gallery_status` includes `hasContent` and `cameraBusy`. `mic_pcm` includes `sampleRate`, `bitsPerSample`, `channels`, and `encoding`; `mic_lc3` includes `sampleRate`, `channels`, `encoding`, `frameDurationMs`, `frameSizeBytes`, `bitrate`, and `packetizedFromGlasses`.

Android and iOS expose typed callbacks/delegate methods instead of the React Native string event API. Android uses `MentraBluetoothSdkListener` methods such as `onStateChanged`, `onGlassesChanged`, `onSdkStateChanged`, `onScanChanged`, `onDeviceDiscovered`, `onButtonPress`, `onVoiceActivityDetectionStatus`, `onSpeakingStatus`, `onPhotoResponse`, `onMicPcm`, and `onStreamStatus`. iOS uses `MentraBluetoothSDKDelegate` methods such as `mentraBluetoothSDK(_:didUpdate:)`, `mentraBluetoothSDK(_:didUpdateGlasses:)`, `mentraBluetoothSDK(_:didUpdateSdkState:)`, `mentraBluetoothSDK(_:didUpdateScan:)`, `mentraBluetoothSDK(_:didDiscover:)`, `mentraBluetoothSDK(_:didReceive:)`, `mentraBluetoothSDK(_:didReceiveMicPcm:)`, and `mentraBluetoothSDK(_:didReceiveMicLc3:)`. Microphone audio callbacks use `MicPcmEvent` and `MicLc3Event` objects with the same metadata as React Native.

## SDK Models

| Model | Android | iOS | React Native | Purpose |
| --- | --- | --- | --- | --- |
| Device model | `DeviceModel` | `DeviceModel` | `DeviceModel` / `DeviceModels` | Supported family such as Mentra Live, Mentra Nex, G1, G2, Mach1, Z100, Frame, simulated, or R1. |
| Discovered device | `Device` | `Device` | `Device` | Scan result containing typed model, name, platform address/identifier, optional RSSI, and stable id. RSSI may be undefined at first discovery. Do not parse `id`; use the typed fields. |
| Connection state | `GlassesConnectionState` | `GlassesConnectionState` | `GlassesConnectionStatus` | Link-layer state: disconnected, scanning, connecting, bonding, or connected. React Native uses a discriminated union where `fullyBooted` only exists on the connected state. |
| Full runtime state | `MentraBluetoothState` | `MentraBluetoothState` | `useMentraBluetooth()` | Grouped app-facing state with `glasses`, `sdk`, and `scan`. |
| Glasses runtime state | `GlassesRuntimeState` | `GlassesRuntimeState` | `useMentraBluetooth().glasses` | Connected device snapshot: connection/readiness, model, firmware, battery, Wi-Fi, hotspot, and signal metadata when connected. |
| Phone SDK runtime state | `PhoneSdkRuntimeState` | `PhoneSdkRuntimeState` | `useMentraBluetooth().sdk` | Default device, gallery mode, microphone route, Wi-Fi scan results, scan activity, system mic availability, other Bluetooth audio status, and logs. |
| Scan state | `BluetoothScanState` | `BluetoothScanState` | `useMentraBluetooth().scan` | Stable-order discovered devices and active scan state. |
| SDK error | `BluetoothException` / `BluetoothError` | `BluetoothError` | rejected promise or `log`/typed event | Permission, connection, unsupported-capability, command, or native failure. |

## Defaults

| API | Default behavior |
| --- | --- |
| Android `MentraBluetoothSdk.create` | Uses `MentraBluetoothSdkConfig()` with callbacks delivered on the Android main thread. |
| iOS `MentraBluetoothSDK()` | Uses `.default` configuration. |
| `connect` / `connectDefault` | `connect` saves connected glasses as default and cancels existing connection attempts unless options override that behavior. `connectDefault` uses the app-restored default device. |
| `displayText` | Defaults to `x = 0`, `y = 0`, `size = 24` when supported by the platform call. |
| `setMicState` | `useGlassesMic = true`, `sendTranscript = false`, and `sendLc3Data = false` unless explicitly set. |
| `PhotoRequest` / `requestPhoto` | Pass explicit size, compression, and sound. `exposureTimeNs` is optional; omitted or `null` means auto exposure. The camera light is always enabled by the SDK. |
| `StreamRequest` / `startStream` | `keepAlive = true`, `keepAliveIntervalSeconds = 15`, and `sound = true` by default in native SDK calls. The camera light is always enabled by the SDK. |

## Error Handling

Use SDK errors for user-recoverable behavior:

- Permission missing.
- Bluetooth off or unavailable.
- Device not discovered.
- Device disconnected.
- Capability unsupported on the connected model.
- Command rejected by glasses.
- Native subsystem failed.

Do not infer connected state from exceptions alone. Always reconcile with the latest status callback or snapshot.
