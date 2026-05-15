# API Reference

The Mentra Bluetooth SDK exposes the same core glasses lifecycle across Android, iOS, and React Native:

- Scan for a supported glasses model.
- Connect to a discovered `Device` or an app-restored default device.
- Read typed glasses/Bluetooth status.
- Subscribe to typed events.
- Send display, camera, stream, audio, Wi-Fi, LED, settings, OTA, and diagnostic commands where supported by the connected model.

## Packages And Imports

| Platform | Install package | Import |
| --- | --- | --- |
| Android | `com.mentra:bluetooth-sdk` | `import com.mentra.core.*` |
| iOS | `MentraBluetoothSDK` CocoaPod | `import MentraBluetoothSDK` |
| React Native / Expo | `@mentra/bluetooth-sdk` | `import BluetoothSdk from '@mentra/bluetooth-sdk'` |

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

```ts
import {useState} from 'react';
import BluetoothSdk, {
  createDisconnectedGlassesStatus,
  type GlassesStatus,
} from '@mentra/bluetooth-sdk';

const [glassesStatus, setGlassesStatus] = useState<Partial<GlassesStatus>>(
  () => createDisconnectedGlassesStatus(),
);

const removeGlasses = BluetoothSdk.onGlassesStatus((changed) => {
  setGlassesStatus((current) => ({...current, ...changed}));
});

const removeCore = BluetoothSdk.onCoreStatus((status) => {
  console.log(status);
});

removeGlasses();
removeCore();
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
sdk.startScan(DeviceModel.MENTRA_LIVE)
sdk.stopScan()

sdk.connect(device)
sdk.setDefaultDevice(Device(model = DeviceModel.MENTRA_LIVE, name = "Mentra_Live_E7FA"))
val defaultDevice = sdk.getDefaultDevice()
sdk.connectDefault()
sdk.clearDefaultDevice()

sdk.cancelConnectionAttempt()
sdk.disconnect()
sdk.forget()
sdk.connectSimulated()
```

iOS:

```swift
try sdk.startScan(model: .mentraLive)
sdk.stopScan()

try sdk.connect(to: device)
sdk.setDefaultDevice(Device(model: .mentraLive, name: "Mentra_Live_E7FA"))
let defaultDevice = sdk.getDefaultDevice()
try sdk.connectDefault()
sdk.clearDefaultDevice()

sdk.cancelConnectionAttempt()
sdk.disconnect()
sdk.forget()
sdk.connectSimulated()
```

React Native:

```ts
await BluetoothSdk.startScan({model: 'Mentra Live'});

await BluetoothSdk.connect(device);
await BluetoothSdk.setDefaultDevice({
  id: 'Mentra Live:Mentra_Live_E7FA',
  model: 'Mentra Live',
  name: 'Mentra_Live_E7FA',
});
const defaultDevice = await BluetoothSdk.getDefaultDevice();
await BluetoothSdk.connectDefault();
await BluetoothSdk.clearDefaultDevice();

await BluetoothSdk.cancelConnectionAttempt();
await BluetoothSdk.disconnect();
await BluetoothSdk.forget();
await BluetoothSdk.connectSimulated();
```

Prefer connecting to a `Device` returned by SDK scan callbacks. If your app wants `connectDefault()` to work after restart, persist a small default-device record in app storage and restore it with `setDefaultDevice()` before calling `connectDefault()`.

## Status

Android:

```kotlin
val glasses = sdk.getGlassesStatus()
val bluetooth = sdk.getBluetoothStatus()
```

iOS:

```swift
let glasses = sdk.glassesStatus
let bluetooth = sdk.bluetoothStatus
```

React Native:

```ts
const glasses = await BluetoothSdk.getGlassesStatus();
const core = await BluetoothSdk.getCoreStatus();
```

Status snapshots are safe to read at any time. Treat command success as "command accepted"; keep UI state derived from status callbacks.

`GlassesStatus.connectionState` is typed as `GlassesConnectionState` on Android and iOS, and as the `GlassesConnectionState` string union in React Native. Valid values are `DISCONNECTED`, `SCANNING`, `CONNECTING`, `BONDING`, and `CONNECTED`. Use this field for link-layer progress, and use `connected` / `fullyBooted` for whether the glasses are ready for feature commands.

### Version Fields

Call `requestVersionInfo()` after connection when your app wants the glasses to refresh version metadata. Updated values arrive through the normal glasses-status callback and are also available in the next status snapshot.

| Field | Meaning |
| --- | --- |
| `fwVersion` / `firmwareVersion` | Generic glasses firmware version when the connected model reports one. |
| `deviceFirmwareVersion` | Device firmware version for models that report device info as a structured payload. |
| `leftFirmwareVersion` / `rightFirmwareVersion` | Per-side firmware versions for glasses that report left/right firmware separately. |
| `besFwVersion` | Mentra Live BES firmware version. |
| `mtkFwVersion` | Mentra Live MTK/system OTA firmware version. |
| `appVersion` | Glasses-side companion app version. On Mentra Live this is the ASG client APK version, not firmware. |
| `androidVersion` | Android OS version on Android-based glasses. This is not firmware. |

Different glasses models expose different version fields, so partner apps should prefer the generic firmware field when present, then fall back to model-specific firmware fields. Keep app and OS versions visibly labeled as app/OS versions.

## Display

Android:

```kotlin
sdk.displayText(DisplayTextRequest(text = "Pickup at gate B12", x = 0, y = 0, size = 24))
sdk.clearDisplay()
sdk.showDashboard()
```

iOS:

```swift
try await sdk.displayText(DisplayTextRequest(text: "Pickup at gate B12", x: 0, y: 0, size: 24))
try await sdk.clearDisplay()
sdk.showDashboard()
```

React Native:

```ts
await BluetoothSdk.displayText({text: 'Pickup at gate B12', x: 0, y: 0, size: 24});
await BluetoothSdk.clearDisplay();
await BluetoothSdk.showDashboard();
```

Use `displayText` for normal glanceable UI. Use `displayEvent` only for advanced display payloads that require lower-level rendering control.

## Hardware Settings

Android:

```kotlin
sdk.setBrightness(level = 60)
sdk.setBrightness(level = 60, autoMode = false)
sdk.setAutoBrightness(enabled = true)
sdk.setDashboardPosition(DashboardPositionRequest(height = 4, depth = 6))
sdk.setHeadUpAngle(angleDegrees = 20)
sdk.setScreenDisabled(false)
sdk.setGalleryMode(GalleryMode.AUTO)
sdk.setButtonPhotoSettings(ButtonPhotoSettings(size = ButtonPhotoSize.MEDIUM))
sdk.setButtonVideoRecordingSettings(ButtonVideoRecordingSettings(width = 1280, height = 720, fps = 30))
sdk.setButtonCameraLed(enabled = true)
sdk.setButtonMaxRecordingTime(minutes = 3)
sdk.setCameraFov(CameraFov.WIDE)
```

iOS:

```swift
try await sdk.setBrightness(60)
try await sdk.setBrightness(60, autoMode: false)
try await sdk.setAutoBrightness(enabled: true)
try await sdk.setDashboardPosition(DashboardPositionRequest(height: 4, depth: 6))
try await sdk.setHeadUpAngle(20)
try await sdk.setScreenDisabled(false)
try await sdk.setGalleryMode(.auto)
try await sdk.setButtonPhotoSettings(ButtonPhotoSettings(size: .medium))
try await sdk.setButtonVideoRecordingSettings(ButtonVideoRecordingSettings(width: 1280, height: 720, fps: 30))
try await sdk.setButtonCameraLed(enabled: true)
try await sdk.setButtonMaxRecordingTime(minutes: 3)
try await sdk.setCameraFov(.wide)
```

React Native:

```ts
await BluetoothSdk.setGalleryMode('auto');
await BluetoothSdk.setGalleryMode('manual');
```

`setGalleryMode('auto')` lets the glasses button save photos/videos locally. `setGalleryMode('manual')` reports button and touch events to the host app without triggering local gallery capture. Button presses are always reported as SDK events.

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
sdk.setMicState(MicConfig(sendPcmData = true, sendTranscript = true, bypassVad = false))
```

iOS:

```swift
sdk.setPreferredMic(.auto)
sdk.setOwnAppAudioPlaying(false)
sdk.setMicState(MicConfiguration(sendPcmData: true, sendTranscript: true, bypassVad: false))
```

React Native:

```ts
await BluetoothSdk.setOwnAppAudioPlaying(false);
await BluetoothSdk.setMicState(true, true, false);
```

Raw audio and local transcription are advanced capabilities. Gate them behind explicit user permission and in-app controls.

Phone-originated playback is routed by the OS, not by the BLE command channel. On Android, Mentra Live initiates Bluetooth Classic bonding after BLE connects; accept the system pairing dialog so media audio can route to the glasses. On iOS, users must pair/connect the glasses from Settings > Bluetooth and select them as the audio output because apps cannot initiate Bluetooth Classic audio pairing.

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

Use photo requests when your app needs the glasses to capture a photo and upload it to your backend. The phone sends the command over Bluetooth, then the photo is delivered to the `webhookUrl`.

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
        flash = false,
        sound = true,
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
        flash: false,
        sound: true
    )
)
```

React Native:

```ts
await BluetoothSdk.photoRequest(
  `assistant-${Date.now()}`,
  'com.example.assistant',
  'medium',
  'https://api.example.com/mentra/photo',
  'optional-token',
  'medium',
  false,
  true,
);
```

Your webhook should accept multipart form data with a `photo` file and `requestId`. If you include `authToken`, the uploader adds `Authorization: Bearer <token>` on the webhook request.

For local development, run `python3 examples/local-demo-cloud/server.py` from the repo root and use the printed LAN `/upload` URL. Do not use `localhost`.

## Streaming

Use streaming requests when your app needs Mentra Live to stream camera video to an RTMP, SRT, or WHIP endpoint. The SDK selects the protocol from the URL prefix.

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

## OTA, Maintenance, And Diagnostics

| Area | Android | iOS | React Native |
| --- | --- | --- | --- |
| Version info | `requestVersionInfo()` | `requestVersionInfo()` | `requestVersionInfo()` |
| OTA start/status | `sendOtaStart()`, `sendOtaQueryStatus()` | `sendOtaStart()`, `sendOtaQueryStatus()` | `sendOtaStart()`, `sendOtaQueryStatus()` |
| Stream status | `onStreamStatus` | `BluetoothEvent.streamStatus` | `stream_status` listener |
| Incident id | `sendIncidentId(id, apiBaseUrl)` | `sendIncidentId(id, apiBaseUrl:)` | `sendIncidentId(id, apiBaseUrl)` |
| Shutdown/reboot | `sendShutdown()`, `sendReboot()` | `sendShutdown()`, `sendReboot()` | Not exposed in the React Native API |

Expose advanced controls only when SDK status/capability signals say the connected device supports them.

## Android Listener

```kotlin
interface MentraBluetoothSdkListener {
    fun onGlassesStatusChanged(status: GlassesStatusUpdate) {}
    fun onBluetoothStatusChanged(status: BluetoothStatusUpdate) {}
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
    fun onMicPcm(frame: ByteArray) {}
    fun onMicLc3(frame: ByteArray) {}
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
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: GlassesStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateBluetoothStatus status: BluetoothStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: Device)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: ScanStopReason)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: BluetoothEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: Device?)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: BluetoothError)
}
```

Delegate methods have default empty implementations, so Swift apps can implement only the callbacks they need.

## React Native Events

React Native uses Expo module event listeners:

```ts
const subscriptions = [
  BluetoothSdk.addListener('button_press', (event) => console.log(event)),
  BluetoothSdk.addListener('touch_event', (event) => console.log(event)),
  BluetoothSdk.addListener('photo_response', (event) => console.log(event)),
  BluetoothSdk.addListener('stream_status', (event) => console.log(event)),
  BluetoothSdk.addListener('mic_pcm', (event) => console.log(event.pcm)),
];

subscriptions.forEach((subscription) => subscription.remove());
```

Common event names include `button_press`, `touch_event`, `head_up`, `battery_status`, `wifi_status_change`, `hotspot_status_change`, `photo_response`, `gallery_status`, `stream_status`, `keep_alive_ack`, `mic_pcm`, `mic_lc3`, `local_transcription`, `rgb_led_control_response`, `audio_connected`, `audio_disconnected`, `log`, `send_command_to_ble`, and `receive_command_from_ble`.

## Core Models

| Model | Android | iOS | React Native | Purpose |
| --- | --- | --- | --- | --- |
| Device model | `DeviceModel` | `DeviceModel` | `model: string` | Supported family such as Mentra Live, Mentra Nex, G1, G2, Mach1, Z100, Frame, simulated, or R1. |
| Discovered device | `Device` | `Device` | `Device` | Scan result containing model, name, address/identifier, RSSI, and id. |
| Connection state | `GlassesConnectionState` | `GlassesConnectionState` | `GlassesConnectionStatus` | Link-layer state: disconnected, scanning, connecting, bonding, or connected. React Native uses a discriminated union where `fullyBooted` only exists on the connected state. |
| Glasses status | `GlassesStatus` / `GlassesStatusUpdate` | `GlassesStatus` / `GlassesStatusUpdate` | `GlassesStatus` | Connected device snapshot: model, firmware, serial, battery, Wi-Fi, hotspot, head-up, controller, and readiness. |
| Bluetooth/core status | `BluetoothStatus` / `BluetoothStatusUpdate` | `BluetoothStatus` / `BluetoothStatusUpdate` | `CoreStatus` | Scanning state, discovered devices, Wi-Fi scan results, mic state, settings, and logs. |
| SDK error | `BluetoothException` / `BluetoothError` | `BluetoothError` | rejected promise or `log`/typed event | Permission, connection, unsupported-capability, command, or native failure. |

## Defaults

| API | Default behavior |
| --- | --- |
| Android `MentraBluetoothSdk.create` | Uses `MentraBluetoothSdkConfig()` with callbacks delivered on the Android main thread. |
| iOS `MentraBluetoothSDK()` | Uses `.default` configuration. |
| `connect` / `connectDefault` | `connect` saves connected glasses as default and cancels existing connection attempts unless options override that behavior. `connectDefault` uses the app-restored default device. |
| `DisplayTextRequest` / `displayText` | Defaults to `x = 0`, `y = 0`, `size = 24` when supported by the platform call. |
| `MicConfig` / `MicConfiguration` | `sendLc3Data` defaults to `false`. |
| `PhotoRequest` / `photoRequest` | Pass explicit size, compression, flash, and sound for cross-platform consistency. |
| `StreamRequest` / `startStream` | `keepAlive = true`, `keepAliveIntervalSeconds = 15`, `flash = true`, and `sound = true` by default in native SDK calls. |
| `sendIncidentId` | Uses `https://api.mentra.glass` if `apiBaseUrl` is omitted. |

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
