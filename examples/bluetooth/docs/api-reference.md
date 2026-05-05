# Native API Reference

The Mentra Bluetooth SDK exposes typed native APIs for Android and iOS. Use these APIs as the primary integration path for native mobile apps. React Native and Expo integrations are optional for partners who have explicit access to that integration path.

## Package Names

| Platform | Package |
| --- | --- |
| Android | `com.mentra.core` |
| iOS | `MentraBluetoothSDK` |

## Base Lifecycle

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

Keep one SDK instance per app session. The SDK owns Bluetooth connection state, remembered/default device state, hardware event delivery, foreground-service coordination on Android, and cleanup.

## Permissions

Your app owns user-facing permission prompts and explanation copy. Request Bluetooth permissions before scanning and microphone permission before enabling audio or transcription features.

On Android, request the platform permissions required for your target SDK, such as `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `ACCESS_FINE_LOCATION`, `RECORD_AUDIO`, and `POST_NOTIFICATIONS` where applicable. Some Android 12+ devices still require runtime location permission and Location services before they deliver BLE scan callbacks, even when Nearby Devices permissions are granted.

On iOS, include the Bluetooth and microphone usage descriptions in your app `Info.plist`.

## Connection

Android:

```kotlin
sdk.startScan(MentraDeviceModel.MENTRA_LIVE)
sdk.stopScan()
sdk.connect(device)
sdk.connectByName(MentraDeviceModel.MENTRA_LIVE, "Mentra Live 1234")
sdk.connectDefault()
sdk.connectSimulated()
sdk.disconnect()
sdk.forget()
```

iOS:

```swift
sdk.startScan(model: .mentraLive)
sdk.stopScan()
sdk.connect(to: device)
sdk.connect(model: .mentraLive, name: "Mentra Live 1234")
sdk.connectDefault()
sdk.connectSimulated()
sdk.disconnect()
sdk.forget()
```

Prefer connecting to a `MentraDiscoveredDevice` returned by the SDK. Use name/default connection helpers for simple pairing UIs.

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

Status snapshots are safe to read at any time. Treat command success as "command accepted"; keep UI state derived from status callbacks.

## Optional Arguments And Defaults

When an SDK API exposes an optional argument, do not rely on absence meaning "best effort" or "auto" unless it is documented that way. The behavior is:

| API | Optional argument | If omitted |
| --- | --- | --- |
| Android `MentraBluetoothSdk.create` | `config` | Uses `MentraBluetoothSdkConfig()` with callbacks delivered on the Android main thread. |
| Android `MentraBluetoothSdkConfig` | `deliverCallbacksOnMainThread` | Defaults to `true`. Set `false` only if your app is prepared to receive listener callbacks on the SDK/event thread. |
| iOS `MentraBluetoothSDK` | `configuration` | Uses `.default`. |
| `MentraDisplayTextRequest` | `x`, `y` | Places the text at `0, 0`. |
| `MentraDisplayTextRequest` | `size` | Uses text size `24`. |
| `MentraDashboardMenuItem` | `values` | Sends only `title` and `packageName`. |
| `setBrightness` | `autoMode` | Leaves the current auto-brightness setting unchanged and applies only the brightness level. |
| `MentraMicConfig` / `MentraMicConfiguration` | `sendLc3Data` | Defaults to `false`; LC3 audio callbacks are not requested. |
| `MentraPhotoRequest` | `webhookUrl` | iOS and React Native allow `nil` / `null`; no webhook upload is requested. Android requires a URL. |
| `MentraPhotoRequest` | `authToken` | No bearer token is added to the webhook upload request. |
| `MentraPhotoRequest` | `compress` | Android defaults to `MentraPhotoCompression.MEDIUM`. iOS `nil` requests the device default, which is currently no extra compression on Mentra Live. React Native requires an explicit `"none"`, `"medium"`, or `"heavy"` value. Pass an explicit value for cross-platform consistency. |
| `MentraPhotoRequest` | `flash` | Android defaults to `false`. iOS and React Native require an explicit value. |
| `MentraPhotoRequest` | `sound` | Android defaults to `true`. iOS and React Native require an explicit value. |
| `MentraStreamRequest` | `streamId` | Sends an empty stream id. Provide your own id if you plan to manage keep-alives or correlate stream status. |
| `MentraStreamRequest` | `keepAlive` | Defaults to `true`. You still need to call `keepStreamAlive` every ~15 seconds while the stream is active. |
| `MentraStreamRequest` | `keepAliveIntervalSeconds` | Defaults to `15`, matching the recommended heartbeat cadence. |
| `MentraStreamRequest` | `flash`, `sound` | Default to `true`, enabling the camera indicator and start/stop sounds where supported. |
| `MentraStreamRequest` | `video`, `audio` | Omitted means the glasses use their streaming defaults. |
| `MentraRgbLedRequest` | `packageName` | Sends the LED command without app/package attribution. |
| `MentraRgbLedRequest` | `color` | Ignored for `OFF`. For `ON`, pass one of the valid colors; Mentra Live falls back to red if the color is omitted. |
| `MentraRgbLedRequest` | `brightness` | Sends no brightness field; the glasses use their current or firmware-default LED brightness. |
| `sendIncidentId` | `apiBaseUrl` | Uses `https://api.mentra.glass`. |

## Display

Android:

```kotlin
sdk.displayText(
    MentraDisplayTextRequest(
        text = "Pickup at gate B12",
        x = 0,
        y = 0,
        size = 24,
    )
)

sdk.clearDisplay()
sdk.showDashboard()
```

iOS:

```swift
try await sdk.displayText(
    MentraDisplayTextRequest(
        text: "Pickup at gate B12",
        x: 0,
        y: 0,
        size: 24
    )
)

try await sdk.clearDisplay()
sdk.showDashboard()
```

Use `displayText` for normal glanceable UI. Use `displayEvent` only for advanced display payloads that require lower-level rendering control.

## Core Hardware Settings

The SDK exposes typed settings methods for hardware configuration. Use these methods instead of custom key/value payloads.

Android:

```kotlin
sdk.setBrightness(level = 60)
sdk.setBrightness(level = 60, autoMode = false)
sdk.setAutoBrightness(enabled = true)
sdk.setDashboardPosition(
    MentraDashboardPositionRequest(height = 4, depth = 6)
)
sdk.setHeadUpAngle(angleDegrees = 20)
sdk.setScreenDisabled(false)
sdk.setGalleryMode(MentraGalleryMode.AUTO)
sdk.setButtonPhotoSettings(MentraButtonPhotoSettings(size = MentraButtonPhotoSize.MEDIUM))
sdk.setButtonVideoRecordingSettings(
    MentraButtonVideoRecordingSettings(width = 1280, height = 720, fps = 30)
)
sdk.setButtonCameraLed(enabled = true)
sdk.setButtonMaxRecordingTime(minutes = 3)
sdk.setCameraFov(MentraCameraFov.WIDE)
sdk.rgbLedControl(
    MentraRgbLedRequest(
        requestId = "led-${System.currentTimeMillis()}",
        packageName = "com.example.assistant",
        action = MentraRgbLedAction.ON,
        color = MentraRgbLedColor.GREEN,
        ontime = 500,
        offtime = 500,
        count = 3,
        brightness = 184, // optional, 0-255
    )
)
```

iOS:

```swift
try await sdk.setBrightness(60)
try await sdk.setBrightness(60, autoMode: false)
try await sdk.setAutoBrightness(enabled: true)
try await sdk.setDashboardPosition(
    MentraDashboardPositionRequest(height: 4, depth: 6)
)
try await sdk.setHeadUpAngle(20)
try await sdk.setScreenDisabled(false)
try await sdk.setGalleryMode(.auto)
try await sdk.setButtonPhotoSettings(
    MentraButtonPhotoSettings(size: .medium)
)
try await sdk.setButtonVideoRecordingSettings(
    MentraButtonVideoRecordingSettings(width: 1280, height: 720, fps: 30)
)
try await sdk.setButtonCameraLed(enabled: true)
try await sdk.setButtonMaxRecordingTime(minutes: 3)
try await sdk.setCameraFov(.wide)
sdk.rgbLedControl(
    MentraRgbLedRequest(
        requestId: "led-\(Date().timeIntervalSince1970)",
        packageName: "com.example.assistant",
        action: .on,
        color: .green,
        ontime: 500,
        offtime: 500,
        count: 3,
        brightness: 184 // optional, 0-255
    )
)
```

RGB LED parameters:

| Parameter | Valid values | Meaning |
| --- | --- | --- |
| `action` | Android: `MentraRgbLedAction.ON` / `MentraRgbLedAction.OFF`; iOS: `.on` / `.off`; React Native: `"on"` / `"off"` | Turns the LED command on or off. When the action is off, `color`, `ontime`, `offtime`, `count`, and `brightness` are ignored. |
| `color` | Android: `MentraRgbLedColor.RED` / `GREEN` / `BLUE` / `ORANGE` / `WHITE`; iOS: `.red` / `.green` / `.blue` / `.orange` / `.white`; React Native: `"red"` / `"green"` / `"blue"` / `"orange"` / `"white"` | Named LED color. This is not a hex color. Required for `ON`; use `null` / `nil` for `OFF`. |
| `ontime` | Non-negative integer milliseconds | How long the LED stays on during each cycle. For a solid light, use a long `ontime`, `offtime = 0`, and `count = 1`. |
| `offtime` | Non-negative integer milliseconds | How long the LED stays off between cycles. Use `0` for a solid light; use a positive value for blink or pulse patterns. |
| `count` | Positive integer for `ON`; `0` for `OFF` | Number of on/off cycles to run. For example, `count = 3`, `ontime = 500`, `offtime = 500` blinks three times. |
| `brightness` | Optional integer `0-255` | Raw device brightness. If omitted, no brightness field is sent and the glasses use their current or firmware-default LED brightness. The example apps expose this as a `0-100%` slider and round it to the raw device value. |

RGB LEDs are hardware-dependent; unsupported glasses should report an SDK error or capability status.

Unsupported settings should fail through a typed error or capability status, not silently succeed.

`setGalleryMode` controls whether hardware-button presses also capture locally on Mentra Live. Button presses are always reported as SDK events; when local capture is enabled, a short press captures a photo and a long press starts or stops video recording. Use `setButtonPhotoSettings` and `setButtonVideoRecordingSettings` to configure those captures.

## Microphone And Audio

Android:

```kotlin
sdk.setPreferredMic(MentraMicPreference.AUTO)
sdk.setOwnAppAudioPlaying(false)
sdk.setMicState(
    MentraMicConfig(
        sendPcmData = true,
        sendTranscript = true,
        bypassVad = false,
    )
)
```

iOS:

```swift
sdk.setPreferredMic(.auto)
sdk.setOwnAppAudioPlaying(false)
sdk.setMicState(
    MentraMicConfiguration(
        sendPcmData: true,
        sendTranscript: true,
        bypassVad: false
    )
)
```

Raw audio and local transcription are advanced capabilities. Gate them behind explicit user permission and in-app controls.

## Camera Photo Upload

Use `requestPhoto` when your app needs the glasses to capture a photo and upload it to your backend. The phone sends the command to the glasses over Bluetooth, then the photo is delivered to the `webhookUrl` you provide. Depending on device connectivity and firmware, delivery may happen directly from the glasses or through a supported SDK relay path.

Android:

```kotlin
val requestId = "assistant-${System.currentTimeMillis()}"

sdk.requestPhoto(
    MentraPhotoRequest(
        requestId = requestId,
        appId = "com.example.assistant",
        size = MentraPhotoSize.MEDIUM,
        webhookUrl = "https://api.example.com/mentra/photo",
        authToken = "optional-token",
        compress = MentraPhotoCompression.MEDIUM,
        flash = false,
        sound = true,
    )
)
```

iOS:

```swift
let requestId = "assistant-\(Date().timeIntervalSince1970)"

sdk.requestPhoto(
    MentraPhotoRequest(
        requestId: requestId,
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

Your webhook should accept multipart form data. Mentra Live sends:

| Field | Description |
| --- | --- |
| `photo` | JPEG image file |
| `requestId` | Your request identifier |
| `source` | Optional source hint, such as `ble_transfer` |
| `type` | Optional upload type, such as `photo_upload` |
| `success` | Optional success marker |

If you include `authToken`, the uploader adds it as `Authorization: Bearer <token>` on the webhook request. If you omit it, no `Authorization` header is added.

Photo size values are typed because app-requested photos and button-gallery photos do not expose exactly the same tiers on Mentra Live. `MentraPhotoSize` supports `SMALL`, `MEDIUM`, `LARGE`, and `FULL` for app-requested uploads. `MentraButtonPhotoSize` supports `SMALL`, `MEDIUM`, and `LARGE` for hardware-button captures saved to gallery. Compression is also typed: `NONE` uploads the captured JPEG as-is, `MEDIUM` applies the balanced compression path, and `HEAVY` applies stronger downscaling/compression.

For local development, run the companion server in `examples/photo-webhook-server` and use the printed LAN URL, such as `http://192.168.1.42:8787/upload`. Do not use `localhost`: keep the glasses, phone, and computer on a network where the uploader can reach the computer. The Android, iOS, and React Native examples demonstrate this by polling `GET /uploads/<requestId>.json` and displaying the returned `photoUrl`.

## Streaming

Use `startStream` when your app needs Mentra Live to stream camera video to an RTMP, SRT, or WHIP endpoint. The SDK selects the protocol from the URL prefix.

| URL prefix | Protocol |
| --- | --- |
| `rtmp://` or `rtmps://` | RTMP |
| `srt://` | SRT |
| `http://` or `https://` | WHIP / WebRTC ingest |

Android:

```kotlin
val streamUrl = "http://192.168.1.42:8889/mentra-live/whip"
val streamId = "stream-${System.currentTimeMillis()}"

sdk.startStream(
    MentraStreamRequest(
        streamUrl = streamUrl,
        streamId = streamId,
        keepAlive = true,
        keepAliveIntervalSeconds = 15,
    )
)

// Call while streaming if you manage the lifecycle yourself.
sdk.keepStreamAlive(
    MentraStreamKeepAliveRequest(
        streamId = streamId,
        ackId = "ack-${System.currentTimeMillis()}",
    )
)

sdk.stopStream()
```

iOS:

```swift
let streamUrl = "http://192.168.1.42:8889/mentra-live/whip"
let streamId = "stream-\(Int(Date().timeIntervalSince1970 * 1000))"

sdk.startStream(
    MentraStreamRequest(
        streamUrl: streamUrl,
        streamId: streamId,
        keepAlive: true,
        keepAliveIntervalSeconds: 15
    )
)

// Call while streaming if you manage the lifecycle yourself.
sdk.keepStreamAlive(
    MentraStreamKeepAliveRequest(
        streamId: streamId,
        ackId: "ack-\(Int(Date().timeIntervalSince1970 * 1000))"
    )
)

sdk.stopStream()
```

For local streaming development, run the companion local demo cloud in `examples/local-demo-cloud`. For RTMP, use the printed RTMP publish URL, such as `rtmp://192.168.1.42:1935/live/mentra-live`, in the example app. The RTMP path must include both the application and stream key segments, for example `/live/mentra-live`; a single path segment such as `/mentra-live` is rejected by the Mentra Live RTMP client. The native iOS example derives the HLS preview URL, such as `http://192.168.1.42:8888/live/mentra-live`, and embeds it while RTMP is live; you can also open the printed HLS URL on your computer. For WebRTC, use the printed WHIP URL, such as `http://192.168.1.42:8889/mentra-live/whip`, in the example app and open the printed WebRTC preview URL, such as `http://192.168.1.42:8889/mentra-live`. Do not use `localhost`: keep the glasses, phone, and computer on a network where the glasses and phone can reach the computer.

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

## Advanced Capabilities

Advanced APIs are capability-gated because support differs by glasses model and firmware.

| Area | Examples |
| --- | --- |
| Camera/gallery | `requestPhoto`, `queryGalleryStatus`, `photo_response`, `gallery_status` |
| Streaming | `startStream`, `keepStreamAlive`, `stopStream`, `stream_status` |
| Video | `startVideoRecording`, `stopVideoRecording` |
| Maintenance | `requestVersionInfo`, `sendOtaStart`, `sendShutdown`, `sendReboot` |
| Local STT | model validation, transcription restart, `local_transcription` |
| Diagnostics | partner-approved device diagnostic context |

Expose advanced controls only when SDK status/capabilities say the connected device supports them.

## Android Listener

```kotlin
interface MentraBluetoothSdkListener {
    fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {}
    fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {}
    fun onDeviceDiscovered(device: MentraDiscoveredDevice) {}
    fun onScanStopped(reason: MentraScanStopReason) {}
    fun onButtonPress(event: MentraButtonPressEvent) {}
    fun onTouch(event: MentraTouchEvent) {}
    fun onHeadUpChanged(headUp: Boolean) {}
    fun onBatteryStatus(event: MentraBatteryStatusEvent) {}
    fun onWifiStatusChanged(event: MentraWifiStatusEvent) {}
    fun onGalleryStatus(event: MentraGalleryStatusEvent) {}
    fun onPhotoResponse(event: MentraPhotoResponseEvent) {}
    fun onStreamStatus(event: MentraStreamStatusEvent) {}
    fun onMicPcm(frame: ByteArray) {}
    fun onMicLc3(frame: ByteArray) {}
    fun onLocalTranscription(event: MentraLocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: MentraPairedDevice?) {}
    fun onLog(message: String) {}
    fun onError(error: MentraBluetoothError) {}
}
```

Callbacks are delivered on the Android main thread by default.

## iOS Delegate

```swift
@MainActor
public protocol MentraBluetoothSDKDelegate: AnyObject {
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: MentraGlassesStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateBluetoothStatus status: MentraBluetoothStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: MentraDiscoveredDevice)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: MentraScanStopReason)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: MentraBluetoothEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: MentraPairedDevice?)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: MentraBluetoothError)
}
```

Delegates are the primary v1 integration path for Swift apps.

## Core Models

| Model | Purpose |
| --- | --- |
| `MentraDeviceModel` | Supported glasses family such as Mentra Live, Mentra Nex, G1, G2, Mach1, Z100, simulated, or R1 |
| `MentraDiscoveredDevice` | Scan result containing model, name, identifier/address, and RSSI |
| `MentraGlassesStatus` | Connected device snapshot: model, firmware, serial, battery, Wi-Fi, hotspot, head-up, controller, and readiness |
| `MentraBluetoothStatus` | Bluetooth subsystem snapshot: scanning state, discovered devices, Wi-Fi scan results, mic state, permissions, and logs |
| `MentraBluetoothError` | Typed command, permission, connection, unsupported-capability, or native failure |

## Error Handling

Use SDK errors for user-recoverable behavior:

- Permission missing
- Bluetooth off or unavailable
- Device not discovered
- Device disconnected
- Capability unsupported on the connected model
- Command rejected by glasses
- Native subsystem failed

Do not infer connected state from exceptions alone. Always reconcile with status callbacks.
