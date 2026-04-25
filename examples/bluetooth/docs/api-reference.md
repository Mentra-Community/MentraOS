# Native API Reference

The Mentra Bluetooth SDK exposes typed native APIs for Android and iOS. Use these APIs as the primary integration path for native mobile apps. React Native and Expo integrations are optional for partners who have explicit access to that integration path.

## Package Names

| Platform | Package |
| --- | --- |
| Android | `com.mentra.bluetoothsdk` |
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

On Android, request the platform permissions required for your target SDK, such as `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `ACCESS_FINE_LOCATION`, `RECORD_AUDIO`, and `POST_NOTIFICATIONS` where applicable.

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
sdk.setButtonMode(MentraButtonMode.PHOTO)
sdk.setButtonPhotoSettings(MentraButtonPhotoSettings(size = MentraPhotoSize.MEDIUM))
sdk.setButtonVideoRecordingSettings(
    MentraButtonVideoRecordingSettings(width = 1280, height = 720, fps = 30)
)
sdk.setButtonCameraLed(enabled = true)
sdk.setButtonMaxRecordingTime(minutes = 3)
sdk.setCameraFov(MentraCameraFov.WIDE)
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
try await sdk.setButtonMode(.photo)
try await sdk.setButtonPhotoSettings(
    MentraButtonPhotoSettings(size: .medium)
)
try await sdk.setButtonVideoRecordingSettings(
    MentraButtonVideoRecordingSettings(width: 1280, height: 720, fps: 30)
)
try await sdk.setButtonCameraLed(enabled: true)
try await sdk.setButtonMaxRecordingTime(minutes: 3)
try await sdk.setCameraFov(.wide)
```

Unsupported settings should fail through a typed error or capability status, not silently succeed.

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

Use `requestPhoto` when your app needs the glasses to capture a photo and upload it to your backend. The phone sends the command to the glasses over Bluetooth, but the image upload is performed by the glasses over Wi-Fi to the `webhookUrl` you provide.

Android:

```kotlin
val requestId = "assistant-${System.currentTimeMillis()}"

sdk.requestPhoto(
    MentraPhotoRequest(
        requestId = requestId,
        appId = "com.example.assistant",
        size = "medium",
        webhookUrl = "https://api.example.com/mentra/photo",
        authToken = "optional-token",
        compress = "medium",
        flash = false,
        sound = true,
    )
)
```

iOS:

```swift
let requestId = "assistant-\(Date().timeIntervalSince1970)"

try await sdk.requestPhoto(
    MentraPhotoRequest(
        requestId: requestId,
        appId: "com.example.assistant",
        size: "medium",
        webhookUrl: "https://api.example.com/mentra/photo",
        authToken: "optional-token",
        compress: "medium",
        flash: false,
        sound: true
    )
)
```

Your webhook should accept multipart form data. Mentra Live currently sends:

| Field | Description |
| --- | --- |
| `photo` | JPEG image file |
| `requestId` | Your request identifier |
| `type` | `photo_upload` |
| `success` | `true` for a successful upload |

If you include `authToken`, the glasses add it as `Authorization: Bearer <token>` on the webhook request.

For local development, run the companion server in `examples/photo-webhook-server` and use the printed LAN URL, such as `http://192.168.1.42:8787/upload`. Do not use `localhost`: the glasses, not the phone, make the upload request. The Android example demonstrates this by polling `GET /uploads/<requestId>.json` and displaying the returned `photoUrl`.

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
| Video | `startVideoRecording`, `stopVideoRecording`, `startBufferRecording`, `saveBufferVideo` |
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
