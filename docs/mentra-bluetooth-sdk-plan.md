# Mentra Bluetooth SDK Plan

## Overview

The **Mentra Bluetooth SDK** is a standalone SDK for communicating with smart glasses. It provides a unified API for Bluetooth communication, audio streaming, display control, and device management.

### Why Build This?

Enterprise customers want to integrate smart glasses into their own mobile apps without using MentraOS or our cloud infrastructure. They need a simple SDK that handles the complex BLE protocols, audio codecs, and device quirks - and that's it.

### What Is It?

Most of the device logic already lives in `mobile/modules/core`, but packaging, naming, autolinking, publishing, and MentraOS-specific cleanup are still substantial work. The main tasks are:

1. Rename it (`core` → `bluetooth-sdk`)
2. Remove MentraOS-specific code (move to `crust` module)
3. Delete duplicate cloud-formatting functions (handle in TypeScript instead)
4. Publish to npm, Maven Central, and CocoaPods
5. Write documentation
6. Create bare Android and bare iOS example apps in the Partner Kit

### Current Hardware Implementations

This is a descriptive list of what the module currently contains, not a restrictive compatibility matrix:

- **MentraLive** (K900/BES2800) - Camera/mic glasses
- **MentraNex** / **MentraDisplay** - Protobuf-based display glasses
- **G1** - Display glasses
- **G2** - Display glasses
- **Mach1** - Display glasses
- **Vuzix Z100** - Display glasses
- **Simulated** - For testing without hardware

### Key Distinction

**MentraOS** is an operating system and application that _uses_ the Mentra Bluetooth SDK. The target end state for the Bluetooth SDK is a mostly hardware-focused module: BLE, audio, display, camera, device management.

In practice, we have historically thrown some MentraOS-specific native helpers into `core` whenever we needed them quickly, especially Android-side app features like notification forwarding. This plan cleans that up by moving obvious app-layer/native MentraOS code into `crust`.

A few MentraLive-specific plumbing paths still stay in Bluetooth SDK because the hardware depends on them today, including `core_token`, `auth_email`, and incident context sent down to the device.

## Monorepo Approach

Everything stays in the existing monorepo structure. We rename `core` to `bluetooth-sdk` and move MentraOS-specific code to `crust`.

```
mobile/modules/
├── bluetooth-sdk/           # Renamed from core - publishes as SDK
│   ├── src/                 # TypeScript interface
│   ├── android/             # Android native (com.mentra.bluetoothsdk)
│   └── ios/                 # iOS native (MentraBluetoothSDK)
│
└── crust/                   # MentraOS-specific native code
    ├── src/                 # TypeScript interface
    ├── android/             # Android (com.mentra.crust)
    └── ios/                 # iOS (MentraCrust)
```

---

## What Stays in Bluetooth SDK vs Moves to Crust

### Bluetooth SDK (Hardware Communication)

Everything that talks directly to glasses hardware:

**State Keys (GlassesStore):**

```
# GLASSES STATE (hardware reported):
batteryLevel, charging, connected, connectionState, deviceModel
firmwareVersion, micEnabled, bluetoothClassicConnected, caseRemoved, caseOpen
caseCharging, caseBatteryLevel, headUp, serialNumber, style, color
wifiSsid, wifiConnected, wifiLocalIp, hotspotEnabled, hotspotSsid
hotspotPassword, hotspotGatewayIp, bluetoothName, fullyBooted

# BLUETOOTH SDK STATE:
systemMicUnavailable, searching, micEnabled, currentMic
searchResults, wifiScanResults, micRanking, lastLog

# DEVICE SETTINGS (sent to hardware):
default_wearable, pending_wearable, device_name, device_address
brightness, auto_brightness, dashboard_height, dashboard_depth
head_up_angle, preferred_mic, lc3_frame_size
button_photo_size, button_camera_led
button_max_recording_time, button_video_width, button_video_height
button_video_fps, gallery_mode, screen_disabled, sensing_enabled
```

**SGC Implementations:**

- MentraLive (K900/BES2800)
- MentraNex (Protobuf-based)
- G1
- G2
- Mach1
- Vuzix Z100
- Simulated

**Bluetooth SDK Functionality:**

- BLE connection management
- Audio streaming (LC3/PCM) - LC3 codec included
- Microphone capture
- Display rendering (text, images)
- Camera control (photo, video, RTMP)
- WiFi/Hotspot configuration
- Battery monitoring
- Button/gesture events
- IMU data
- Local STT (SherpaOnnx) - Optional, models not included by default
- ForegroundService for background BLE
- Protobuf support (for MentraNex/MentraDisplay protocol)

**Native Dependencies Included:**

- LC3 codec (required for audio)
- Protobuf (for MentraNex/MentraDisplay - naming is legacy but required)
- SherpaOnnx (optional - user supplies models)

**Bridge Events (notable device events surfaced to JS):**

- `head_up`, `button_press`, `touch_event`
- `mic_pcm`, `mic_lc3`, `local_transcription`
- `wifi_status_change`, `hotspot_status_change`, `gallery_status`
- `stream_status`, `imu_data_event`, `imu_gesture_event`
- `ota_update_available`, `ota_progress`

Battery/status cleanup is still part of Phase 3. There are a few older native helpers that still format MentraOS-specific payloads instead of exposing a clean typed event path.

**Local STT Control:**

The Bluetooth SDK includes optional local speech-to-text (SherpaOnnx). In this plan, leave the current offline STT control flow as-is:

```
offline_mode              # MentraOS TypeScript setting for offline behavior
offline_captions_running  # MentraOS TypeScript setting tracking offline captions state
```

Do not introduce a new STT control key in this workstream. The offline STT refactor is happening separately.

### Crust (MentraOS-Specific)

Everything that's about the MentraOS application layer.

**Note:** `contextual_dashboard` STAYS in Bluetooth SDK - it's actually used in `sendCurrentState()` and `displayEvent()` to control whether dashboard content shows when user looks up.

### Compatibility Credential Plumbing

`auth_email` and `core_token` stay in Bluetooth SDK for now, but they should be treated as legacy MentraOS compatibility plumbing rather than as the public Bluetooth SDK authentication model.

These values are not BLE transport credentials. They are MentraOS account/cloud values that current MentraLive / ASG companion paths still expect to receive through the device path:

- MentraOS TypeScript owns the user/session settings in `useSettingsStore`.
- `MantleManager` forwards the initial Bluetooth SDK setting subset and later setting diffs with `BluetoothSdk.updateBluetoothSettings(...)`.
- `RestComms.setCoreToken(...)` also syncs refreshed `core_token` values into Bluetooth SDK state.
- The native bridge writes these values into the native `DeviceStore` `bluetooth` category. Android also persists a non-empty `core_token` to SharedPreferences as a retry/backward-compatibility fallback.
- MentraLive reads `core_token` / `auth_email` from `DeviceStore` and sends the relevant values to the ASG client. `core_token` is also used by current incident-log relay paths.

External/native customer guidance:

- Apps that only use local BLE, display, camera, audio, and device-control APIs should leave these values empty.
- Partner apps that intentionally use Mentra-hosted cloud or ASG companion features may need to provide equivalent credentials through the current compatibility bridge until Phase 6 introduces an explicit native configuration API.
- Do not document `auth_email` or `core_token` as generally required Partner Kit setup fields.
- Do not add `DeviceStore.apply()` side-effect branches for these keys; the current hardware paths read the latest stored values directly.

Future cleanup:

- Replace this key/value path with an explicit optional native API, such as `configureCloudCredentials(...)` or a `MentraBluetoothSdkConfiguration.cloudCredentials` field.
- Make the Mentra-hosted-cloud dependency opt-in and clearly separate from local Bluetooth functionality.
- Clear persisted credentials on logout and remove Android SharedPreferences fallback once native authentication configuration is explicit.

**Note:** Leave `offline_mode` and `offline_captions_running` unchanged in this plan. That STT control refactor is being handled separately.

**Note:** Do not spend time on dead native setting cleanup in this workstream unless it directly helps the rename/extraction.

**Services to Move:**

- `NotificationListener` - Phone notification forwarding (MentraOS feature)

**Services that STAY in Bluetooth SDK:**

- `ForegroundService` - Required for maintaining BLE connection in background (hardware need)

**Bridge Functions - DELETE (not move):**

These duplicate functions format data for MentraOS cloud protocol. They will be DELETED from native code entirely. The TypeScript layer will handle cloud formatting instead (see Phase 3).

- `sendVadStatus()` - DELETE (TypeScript will format)
- `sendBluetoothStatusUpdate()` - DELETE (TypeScript will format)
- Button press helper naming/path should be standardized, but keep the current typed event behavior on both platforms
- `sendPhotoResponse()` - DELETE (TypeScript will format)
- `sendHeadPosition()` - DELETE (use `sendHeadUp()` instead)
- `sendVideoStreamResponse()` - DELETE (TypeScript will format)
- `updateAsrConfig()` - DELETE (TypeScript will format)
- `sendPhoneNotification()` - Moves to Crust with NotificationListener
- `sendPhoneNotificationDismissed()` - Moves to Crust with NotificationListener

---

## Phase 1: Rename and Restructure

### 1.1 Rename core to bluetooth-sdk

```bash
# In mobile/modules/
mv core bluetooth-sdk

# Update all imports and references
```

**Files to update:**

- `bluetooth-sdk/package.json` - name: `@mentra/bluetooth-sdk`
- `bluetooth-sdk/android/` - package: `com.mentra.bluetoothsdk`
- `bluetooth-sdk/ios/` - module: `MentraBluetoothSDK`
- `bluetooth-sdk/expo-module.config.json`
- All imports in `mobile/src/` that reference `@mentra/core`

### 1.2 Update Namespaces

**Android:**

```kotlin
// Before: com.mentra.core
// After: com.mentra.bluetoothsdk

package com.mentra.bluetoothsdk

class BluetoothSdkModule : Module() { ... }
class DeviceManager { ... }  // renamed from CoreManager
class DeviceStore { ... }    // renamed from GlassesStore
```

**iOS:**

```swift
// Before: MentraCore module
// After: MentraBluetoothSDK module

public class BluetoothSdk { ... }
public class DeviceManager { ... }  // renamed from CoreManager
public class DeviceStore { ... }    // renamed from GlassesStore
```

**TypeScript:**

```typescript
// Before
import {CoreModule} from "@mentra/core"

// After
import {BluetoothSdk} from "@mentra/bluetooth-sdk"
```

---

## Phase 2: Extract MentraOS Code to Crust

### 2.1 Move NotificationListener

**From:** `bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/services/NotificationListener.kt`
**To:** `crust/android/src/main/java/com/mentra/crust/services/NotificationListener.kt`

**Also move from Bluetooth SDK's AndroidManifest.xml to Crust's AndroidManifest.xml:**

```xml
<service android:name="com.mentra.crust.services.NotificationListenerServiceImpl"
    android:label="@string/app_name"
    android:exported="false"
    android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
    <intent-filter>
        <action android:name="android.service.notification.NotificationListenerService"/>
    </intent-filter>
    ...
</service>
```

Crust handles listening to phone notifications and emits MentraOS events to the mobile TypeScript layer for cloud reporting. We intentionally are not adding a generic Bluetooth SDK "send notification to display" API in this phase.

### 2.2 Move OS-Specific State

Keep the state split practical in this branch:

- Move obvious MentraOS-only native features to Crust, especially notification listening / permission management
- Move app/build-environment native helpers such as beta-build detection to Crust
- Keep hardware-driven state and settings in Bluetooth SDK
- Keep `contextual_dashboard`, `auth_email`, `core_token`, and incident plumbing in Bluetooth SDK for now because current hardware paths still depend on them
- Leave offline STT control (`offline_mode` / `offline_captions_running`) unchanged in this workstream

### 2.3 Update GlassesStore.apply()

Remove MentraOS-specific side effects from Bluetooth SDK. The `apply()` function should only handle hardware-related side effects:

**Keep in Bluetooth SDK:**

```kotlin
// Hardware lifecycle/state side effects
"glasses" to "fullyBooted" -> handleDeviceReady()/handleDeviceDisconnected()
"glasses" to "controllerFullyBooted" -> handleControllerReady()/handleControllerDisconnected()
"glasses" to "controllerMacAddress" -> sgc?.connectController()
"glasses" to "headUp" -> sendCurrentState(); sendHeadUp(...)

// Hardware settings
"bluetooth" to "brightness" -> sgc?.setBrightness(...)
"bluetooth" to "auto_brightness" -> sgc?.setBrightness(...)
"bluetooth" to "dashboard_height" -> sgc?.setDashboardHeightOnly(...)
"bluetooth" to "dashboard_depth" -> sgc?.setDashboardDepthOnly(...)
"bluetooth" to "head_up_angle" -> sgc?.setHeadUpAngle(...)
"bluetooth" to "dashboard_menu_apps" -> sgc?.setDashboardMenu(...)
"bluetooth" to "gallery_mode" -> sgc?.sendGalleryMode()
"bluetooth" to "screen_disabled" -> sgc?.exit()/clearDisplay()
"bluetooth" to "button_photo_size" -> sgc?.sendButtonPhotoSettings()
"bluetooth" to "button_camera_led" -> sgc?.sendButtonCameraLedSetting()
"bluetooth" to "button_max_recording_time" -> sgc?.sendButtonMaxRecordingTime()
"bluetooth" to "camera_fov" -> sgc?.sendCameraFovSetting()
"bluetooth" to "button_video_width" -> sgc?.sendButtonVideoRecordingSettings()
"bluetooth" to "button_video_height" -> sgc?.sendButtonVideoRecordingSettings()
"bluetooth" to "button_video_fps" -> sgc?.sendButtonVideoRecordingSettings()
"bluetooth" to "preferred_mic" -> setMicState(...)
"bluetooth" to "default_wearable" -> initSGC(...)

// Explicit Phase 2 exceptions
"bluetooth" to "offline_captions_running" -> setMicState(...)
"bluetooth" to "should_send_pcm" -> setMicState(...)
"bluetooth" to "should_send_lc3" -> setMicState(...)
"bluetooth" to "should_send_transcript" -> setMicState(...)
```

`auth_email` and `core_token` remain Bluetooth SDK state for MentraLive plumbing, but they do not need `apply()` side-effect branches because hardware paths read the latest values directly from `DeviceStore`.

**Offline STT Note:**

Keep the existing offline STT settings and handlers as-is in this plan. Do not add `local_stt_active`, and do not remove the current `offline_mode` / `offline_captions_running` wiring here.

---

## Phase 3: Clean Up Bridge.kt

### 3.1 Keep (Hardware Events)

The important rule here is behavior, not perfect Android/iOS naming symmetry. Today:

- Android already uses `sendButtonPressEvent()` for the typed `button_press` event
- iOS still uses `sendButtonPress()`, but that helper already emits the typed `button_press` event rather than formatting a cloud payload
- `sendBatteryStatus()` is still inconsistent and should be normalized during this cleanup

```kotlin
// Raw hardware events - stay in Bluetooth SDK
fun sendHeadUp(isUp: Boolean)
fun sendButtonPressEvent(buttonId: String, pressType: String) // Android today
fun sendButtonPress(buttonId: String, pressType: String)      // iOS today; standardize naming later
fun sendTouchEvent(deviceModel: String, gestureName: String, timestamp: Long)
fun sendMicPcm(data: ByteArray)
fun sendMicLc3(data: ByteArray)
fun sendLocalTranscription(text: String, isFinal: Boolean, language: String)
fun sendBatteryStatus(level: Int, charging: Boolean) // currently inconsistent; normalize in cleanup
fun sendDiscoveredDevice(deviceModel: String, deviceName: String)
fun sendWifiStatusChange(connected: Boolean, ssid: String?, localIp: String?)
fun sendHotspotStatusChange(enabled: Boolean, ssid: String, password: String, gatewayIp: String)
fun sendGalleryStatus(...)
fun sendImuDataEvent(...)
fun sendImuGestureEvent(...)
fun sendOtaUpdateAvailable(...)
fun sendOtaProgress(...)
fun sendStreamStatus(...)
fun sendSwipeVolumeStatus(...)
fun sendSwitchStatus(...)
fun sendRgbLedControlResponse(...)
fun sendMtkUpdateComplete(...)
fun sendPairFailureEvent(...)
fun sendAudioConnected(...)
fun sendAudioDisconnected(...)
fun saveSetting(key: String, value: Any)
fun log(message: String)
```

### 3.2 Delete Duplicate Cloud-Formatting Functions (Technical Debt Cleanup)

These functions are duplicates that format data for MentraOS cloud protocol. They shouldn't exist in native code at all - the TypeScript layer already has the WebSocket connection and should handle all cloud protocol formatting.

**DELETE from Bridge.kt (and Bridge.swift):**

```kotlin
// These are redundant - raw events already go to JS, format in TypeScript instead
fun sendVadStatus(isSpeaking: Boolean)        // DELETE - use raw VAD event
fun sendBluetoothStatusUpdate(status: Map<String, Any>)  // DELETE - format in TS
fun sendPhotoResponse(...)                     // DELETE - format in TS
fun sendHeadPosition(...)                      // DELETE - sendHeadUp() exists
fun sendVideoStreamResponse(...)              // DELETE - format in TS
fun updateAsrConfig(...)                       // DELETE - format in TS
fun sendPhoneNotification(...)                // MOVE to Crust with NotificationListener
fun sendPhoneNotificationDismissed(...)       // MOVE to Crust with NotificationListener
```

**Button Press Cleanup:**

- Android already uses `sendButtonPressEvent()`
- iOS `sendButtonPress()` already behaves like a raw typed event emitter
- End state: one typed `button_press` path on both platforms, no cloud-formatting detour through `ws_text`

**Battery Cleanup:**

- `sendBatteryStatus()` emits the typed `battery_status` event on both platforms
- MentraOS app code formats the cloud `glasses_battery_update` payload in TypeScript

**KEEP typed/raw hardware event emitters:**

```kotlin
fun sendButtonPressEvent() // Android naming today
fun sendButtonPress()      // iOS naming today
fun sendHeadUp()           // Raw hardware event to app
// etc.
```

**Migration:**

1. Find all call sites of the duplicate functions in native code
2. Update them to use the raw event emitters instead
3. Handle cloud protocol formatting in MentraOS TypeScript layer
4. Delete the duplicate functions

**Exception - NotificationListener:**
`sendPhoneNotification()` and `sendPhoneNotificationDismissed()` are called from `NotificationListener` service. Since that service moves to Crust, these either:

- Move to Crust (if we want native notification formatting)
- Or NotificationListener emits raw events and TypeScript formats them

### 3.3 Keep Generic WebSocket Passthrough

```kotlin
// These stay but are just generic passthrough to JS
fun sendWSText(msg: String)
fun sendWSBinary(data: ByteArray)
```

### 3.4 Public API Surface After Phase 3

The Bluetooth SDK React Native/Expo partner surface is the root module exported by `@mentra/bluetooth-sdk`. App code using that adapter should interact with typed async methods and typed event subscriptions, not native `Bridge.kt` / `Bridge.swift` helpers or raw store categories.

MentraOS compatibility methods live behind the monorepo-only `@mentra/bluetooth-sdk-internal` alias. That alias resolves to SDK source from the MentraOS app config only; it is not exported by the published customer SDK package.

**Connection and status methods:**

```ts
await BluetoothSdk.getBluetoothStatus()
await BluetoothSdk.getGlassesStatus()
const devices = await BluetoothSdk.scan(model, options)
await BluetoothSdk.connect(device, options)
await BluetoothSdk.connectDefault()
await BluetoothSdk.cancelConnectionAttempt()
await BluetoothSdk.disconnect()
await BluetoothSdk.forget()
```

**Display, camera, WiFi, audio, and streaming commands:**

```ts
await BluetoothSdk.displayText(text, x, y, size)
await BluetoothSdk.clearDisplay()
await BluetoothSdk.showDashboard()
await BluetoothSdk.setDashboardPosition(height, depth)
await BluetoothSdk.setHeadUpAngle(angleDegrees)
await BluetoothSdk.setScreenDisabled(disabled)
await BluetoothSdk.requestPhoto(...)
await BluetoothSdk.queryGalleryStatus()
await BluetoothSdk.setGalleryModeEnabled(enabled)
await BluetoothSdk.setButtonPhotoSettings(size)
await BluetoothSdk.setButtonVideoRecordingSettings(width, height, fps)
await BluetoothSdk.setButtonCameraLed(enabled)
await BluetoothSdk.setButtonMaxRecordingTime(minutes)
await BluetoothSdk.setCameraFov(fov)
await BluetoothSdk.requestWifiScan()
await BluetoothSdk.sendWifiCredentials(ssid, password)
await BluetoothSdk.forgetWifiNetwork(ssid)
await BluetoothSdk.setHotspotState(enabled)
await BluetoothSdk.requestVersionInfo()
await BluetoothSdk.startVideoRecording(requestId, save, sound)
await BluetoothSdk.stopVideoRecording(requestId)
await BluetoothSdk.startStream(...)
await BluetoothSdk.stopStream()
await BluetoothSdk.keepStreamAlive(...)
await BluetoothSdk.setMicState(enabled, useGlassesMic, bypassVad, sendTranscript, sendLc3Data)
await BluetoothSdk.setPreferredMic(preferredMic)
await BluetoothSdk.setOwnAppAudioPlaying(playing)
await BluetoothSdk.getGlassesMediaVolume()
await BluetoothSdk.setGlassesMediaVolume(level)
await BluetoothSdk.rgbLedControl(...)
```

**MentraOS-internal compatibility helpers:**

```ts
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"

await BluetoothSdk.displayEvent(params)
await BluetoothSdk.sendIncidentId(incidentId, apiBaseUrl)
await BluetoothSdk.sendOtaStart()
await BluetoothSdk.sendOtaQueryStatus()
await BluetoothSdk.restartTranscriber()
await BluetoothSdk.setSttModelDetails(path, languageCode)
await BluetoothSdk.getSttModelPath()
await BluetoothSdk.checkSttModelAvailable()
await BluetoothSdk.validateSttModel(path)
await BluetoothSdk.extractTarBz2(sourcePath, destinationPath)
await BluetoothSdk.updateBluetoothSettings(values)
await BluetoothSdk.updateGlasses(values)
```

`BluetoothSdk.update(category, values)` remains the low-level native store bridge used by these typed helpers. React Native/Expo adapter callers should prefer `updateBluetoothSettings()` and `updateGlasses()` so the internal native store category names (`"bluetooth"` / `"glasses"`) do not become part of the adapter API. Native stores still accept `"core"` as a legacy alias for `"bluetooth"` to avoid silently splitting persisted state during the rename.

**Typed hardware/app events emitted to JavaScript:**

```ts
BluetoothSdk.addListener("bluetooth_status", handler)
BluetoothSdk.addListener("glasses_status", handler)
BluetoothSdk.addListener("device_discovered", handler)
BluetoothSdk.addListener("default_device_changed", handler)
BluetoothSdk.addListener("glasses_not_ready", handler)
BluetoothSdk.addListener("button_press", handler)
BluetoothSdk.addListener("touch_event", handler)
BluetoothSdk.addListener("head_up", handler)
BluetoothSdk.addListener("voice_activity_detection_status", handler)
BluetoothSdk.addListener("battery_status", handler)
BluetoothSdk.addListener("local_transcription", handler)
BluetoothSdk.addListener("photo_response", handler)
BluetoothSdk.addListener("gallery_status", handler)
BluetoothSdk.addListener("wifi_status_change", handler)
BluetoothSdk.addListener("hotspot_status_change", handler)
BluetoothSdk.addListener("hotspot_error", handler)
BluetoothSdk.addListener("stream_status", handler)
BluetoothSdk.addListener("keep_alive_ack", handler)
BluetoothSdk.addListener("compatible_glasses_search_stop", handler)
BluetoothSdk.addListener("swipe_volume_status", handler)
BluetoothSdk.addListener("switch_status", handler)
BluetoothSdk.addListener("rgb_led_control_response", handler)
BluetoothSdk.addListener("pair_failure", handler)
BluetoothSdk.addListener("audio_pairing_needed", handler)
BluetoothSdk.addListener("audio_connected", handler)
BluetoothSdk.addListener("audio_disconnected", handler)
BluetoothSdk.addListener("mic_pcm", handler)
BluetoothSdk.addListener("mic_lc3", handler)
```

**MentraOS app-layer formatting:**

The SDK emits raw/typed events. MentraOS-specific cloud protocol messages stay in the app layer:

```ts
BluetoothSdk.addListener("head_up", (event) => socketComms.sendHeadPosition(event.up))
BluetoothSdk.addListener("voice_activity_detection_status", (event) => socketComms.sendVoiceActivityDetectionStatus(event.voiceActivityDetectionEnabled))
BluetoothSdk.addListener("battery_status", (event) =>
  socketComms.sendBatteryStatus(event.level, event.charging, event.timestamp),
)
BluetoothSdk.addListener("photo_response", (event) => restComms.sendPhotoResponse(event))
```

Internal adapter-only events such as `save_setting`, OTA events, `ws_text`, `ws_bin`, and raw BLE command traces remain available through the MentraOS-only `@mentra/bluetooth-sdk-internal` alias while MentraOS migrates. New customer-facing features should prefer dedicated typed events.

---

## Native SDK Architecture

The current codebase already has most of the device logic grouped in one module, which is a good starting point for a standalone SDK. The desired end state is now a **bare Android and bare iOS SDK first**, with React Native/Expo treated as a thin adapter used by MentraOS and only exposed externally later if needed.

The native SDK entry points should become the stable product API:

- Android: public Kotlin/Java API in `com.mentra.bluetoothsdk`
- iOS: public Swift API in `MentraBluetoothSDK`

The React Native / Expo entry points become adapters over that native API:

- `BluetoothSdkModule.kt` (Android entry point)
- `BluetoothSdkModule.swift` (iOS entry point)

**Architecture:**

```
com.mentra.bluetoothsdk (Android) / MentraBluetoothSDK (iOS)
├── DeviceManager          # Main orchestrator
├── DeviceStore            # State management
├── Bridge                 # Event emission
├── sgcs/                  # Device implementations
│   ├── MentraLive
│   ├── MentraNex / MentraDisplay
│   ├── G1 / G2
│   ├── Mach1 / Z100
│   └── Simulated
├── MentraBluetoothSdk     # Public native SDK facade
└── BluetoothSdkModule     # Expo wrapper / JS entry point over native facade
```

**For Native Apps:**

- Target end state: use the library directly via Maven/CocoaPods
- Native consumers should initialize a stable SDK facade, not call `DeviceManager` / `DeviceStore` directly
- Android and iOS should expose equivalent commands, state snapshots, and typed events/callbacks
- Pure native consumption is not done until sample bare Android and bare iOS apps build and run against the SDK

**For React Native Apps:**

- MentraOS can continue to use the Expo module
- The Expo module should call the native SDK facade instead of owning SDK behavior
- External React Native support becomes optional once the native APIs are stable

---

## Phase 4: Publishing Infrastructure

### 4.0 What Still Needs Cleanup Before Publishing

Publishing is not just opening registry accounts. Before release we still need to:

- Finish the rename from `core` / `device-bridge` to `bluetooth-sdk` across package names, namespaces, podspec/module names, and docs
- Replace template metadata and placeholder repository/package info with Mentra-owned values
- Remove or generalize monorepo-specific assumptions in Expo config plugins, Gradle paths, and Podfile modifications so the package installs cleanly outside MentraOS
- Verify the external install flow end-to-end for React Native, Maven Central, and CocoaPods before first release

Implemented in this phase:

- npm publish metadata now includes explicit files, public publish config, and peer dependency ranges.
- Android Gradle now has Maven publication metadata for `com.mentra:bluetooth-sdk`.
- CocoaPods metadata is package-driven, includes privacy resources, and no longer relies on monorepo user target paths.
- Expo config plugins no longer mutate host Podfiles with MentraOS-specific project names, Firebase pods, or privacy exclusions.

Still intentionally not done in-code:

- Registry/account setup, signing secrets, and automated release CI.
- Swift Package Manager support and pure native iOS/Android consumption. The current module still depends on React Native / Expo module packaging and bundled native assets, so this needs a separate design pass rather than a cosmetic `Package.swift`.

### 4.1 Package Configuration

**bluetooth-sdk/package.json:**

```json
{
  "name": "@mentra/bluetooth-sdk",
  "version": "0.1.0",
  "description": "SDK for communicating with smart glasses",
  "main": "build/index.js",
  "types": "build/index.d.ts",
  "react-native": "src/index.ts",
  "files": [
    "android",
    "app.plugin.js",
    "build",
    "expo-module.config.json",
    "ios",
    "plugin/build",
    "README.md",
    "src",
    "!src/__tests__"
  ],
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/Mentra-Community/MentraOS.git",
    "directory": "mobile/modules/bluetooth-sdk"
  },
  "keywords": ["react-native", "expo", "smart-glasses", "bluetooth", "ble", "ar-glasses"],
  "peerDependencies": {
    "expo": ">=49.0.0",
    "react": ">=18.0.0",
    "react-native": ">=0.72.0"
  }
}
```

### 4.2 Android Publishing (Maven Central)

Android publishing includes two Maven artifacts:

- `com.mentra:bluetooth-sdk` - primary Android SDK artifact
- `com.mentra:lc3Lib` - companion LC3 codec artifact required by the SDK

The monorepo/npm integration can keep using `implementation project(':lc3Lib')`
so local Expo prebuilds continue to work, but Maven release validation must
publish both artifacts with the same version before testing a fresh external
consumer project.

**bluetooth-sdk/android/build.gradle additions:**

```gradle
apply plugin: 'maven-publish'
apply plugin: 'signing'

group = 'com.mentra'
version = packageJson.version

android {
    namespace 'com.mentra.bluetoothsdk'

    publishing {
        singleVariant("release") {
            withSourcesJar()
            withJavadocJar()
        }
    }
}

publishing {
    publications {
        release(MavenPublication) {
            groupId = 'com.mentra'
            artifactId = 'bluetooth-sdk'
            version = project.version

            from components.release

            pom {
                name = 'Mentra Bluetooth SDK'
                description = 'SDK for communicating with smart glasses'
                url = 'https://github.com/Mentra-Community/MentraOS'
                licenses {
                    license {
                        name = 'MIT License'
                        url = 'https://opensource.org/licenses/MIT'
                    }
                }
            }
        }
    }
}
```

### 4.3 iOS Publishing (CocoaPods + SPM)

**bluetooth-sdk/ios/MentraBluetoothSDK.podspec:**

```ruby
Pod::Spec.new do |s|
  s.name             = 'MentraBluetoothSDK'
  s.version          = package['version']
  s.summary          = 'SDK for communicating with smart glasses'
  s.homepage         = 'https://github.com/Mentra-Community/MentraOS'
  s.license          = 'MIT'
  s.author           = 'Mentra'
  s.source           = { :git => 'https://github.com/Mentra-Community/MentraOS.git', :tag => "bluetooth-sdk-v#{s.version}" }

  s.ios.deployment_target = '15.1'
  s.swift_version = '5.9'
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp,c}'
  s.frameworks = 'CoreBluetooth', 'AVFoundation'
  s.resource_bundles = {
    'MentraBluetoothSDKPrivacy' => ['Source/PrivacyInfo.xcprivacy']
  }
end
```

### 4.4 iOS Privacy Manifest (Required by Apple)

**bluetooth-sdk/ios/Source/PrivacyInfo.xcprivacy:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSPrivacyTracking</key>
    <false/>
    <key>NSPrivacyCollectedDataTypes</key>
    <array/>
    <key>NSPrivacyTrackingDomains</key>
    <array/>
    <key>NSPrivacyAccessedAPITypes</key>
    <array>
        <!-- UserDefaults for settings storage -->
        <dict>
            <key>NSPrivacyAccessedAPIType</key>
            <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
            <key>NSPrivacyAccessedAPITypeReasons</key>
            <array>
                <string>CA92.1</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
```

### 4.5 Versioning

Bluetooth SDK and Crust versions will be kept in sync for simplicity. When either changes, both get a version bump. This avoids compatibility matrix headaches.

---

## Phase 5: Documentation

Phase 5 documentation should be split by audience:

- The public package README stays intentionally thin: install, minimal usage, and partner support pointer.
- Detailed getting started material, API reference, production checklist, troubleshooting, and example apps live in a new private partner repo so they can be bundled with partner/commercial SDK access.

Private repo name: `Mentra-Bluetooth-SDK-Partner-Kit`.

### 5.1 Public README for Bluetooth SDK

The npm/package README should not become the full customer playbook. Keep it short:

- Package purpose
- Development-build requirement
- Install commands
- Minimal connect/display snippet
- Pointer to private partner docs for full onboarding and support

### 5.2 Private Partner Documentation Repo

Initial contents:

- `README.md`
- `docs/getting-started.md`
- `docs/api-reference.md`
- `docs/display-guide.md`
- `docs/audio-guide.md`
- `docs/hardware-integration.md`
- `docs/troubleshooting.md`
- `docs/production-checklist.md`
- `examples/android`
- `examples/ios`
- `examples/react-native` only if React Native becomes a customer-facing target again

The private repo should be the customer-facing source of truth for:

- Bare Android setup
- Bare iOS setup
- Device scanning/discovery
- Connection management
- Display text/images
- Audio streaming and local transcription
- Button/gesture/head-up events
- Camera/gallery/streaming APIs
- OTA and production release validation

### 5.3 Example App

The private repo should include bare native examples demonstrating the first-principles customer contract:

- Device scanning/discovery
- Connection management
- Display text
- Display clearing
- Status subscriptions
- Button/battery event handling

These examples live in `Mentra-Bluetooth-SDK-Partner-Kit`, not this monorepo. This repo owns SDK implementation, native artifact publishing, and MentraOS adapter/regression tests. If this repo needs local sample projects for CI mechanics, they should mirror the Partner Kit examples rather than becoming the customer-facing source of truth.

React Native / Expo docs can remain a small MentraOS adapter note unless/until React Native becomes an external product requirement.

---

## Phase 6: Native SDK API Extraction

Goal: make the Bluetooth SDK a true bare Android and bare iOS SDK. React Native/Expo should be a wrapper over this API, not the core customer-facing integration path.

Detailed platform plans:

- Android: [Mentra Bluetooth SDK Android Native API Plan](./mentra-bluetooth-sdk-android-native-api-plan.md)
- iOS: [Mentra Bluetooth SDK iOS Native API Plan](./mentra-bluetooth-sdk-ios-native-api-plan.md)

The platform-specific docs are the authoritative source for native API shape. The main plan should describe boundaries, migration order, and validation requirements so we do not accidentally maintain three drifting method lists.

### 6.0 Store Sync Decision

Today there are two state layers:

- MentraOS TypeScript uses Zustand stores such as `useSettingsStore`, `useBluetoothStore`, and `useGlassesStore`.
- The native Bluetooth SDK uses `DeviceStore` / `ObservableStore` for native hardware state and settings side effects.

The current bridge syncs blobs between those layers:

- MentraOS settings -> native through `BluetoothSdk.updateBluetoothSettings(...)`.
- Native `glasses_status` / `bluetooth_status` -> MentraOS Zustand stores.
- Native `save_setting` -> MentraOS `useSettingsStore.setSetting(...)`.

That is acceptable as a temporary MentraOS compatibility layer, but it should not be the public SDK paradigm. External native customers should use typed commands and typed events, not key/value store categories or MentraOS setting names.

Phase 6 should move toward this boundary:

- Keep Zustand as the MentraOS app state layer.
- Keep native `DeviceStore` as an internal SDK implementation detail for now.
- Add public native facades that expose typed commands/events and hide native store sync.
- Let MentraOS have an adapter/service that watches Zustand and calls typed SDK methods.
- Keep `updateBluetoothSettings(...)`, `"core"` category normalization, and `save_setting` only as compatibility plumbing while MentraOS migrates.
- Do not document store blob syncing in the Partner Kit or customer-facing native API docs.

### 6.0.1 Native Packaging Boundary

The native SDK must be packaged as native artifacts first, with React Native / Expo as an adapter:

- Android bare artifact: `com.mentra:bluetooth-sdk`, with no Expo Gradle plugin, no `expo-modules-core` project dependency, and no React Native lifecycle assumptions.
- Android Expo adapter: an Expo module / npm package that depends on the bare artifact and forwards events to MentraOS.
- iOS bare artifact: `MentraBluetoothSDK` CocoaPod, with no `ExpoModulesCore` dependency and source globs that exclude Expo module files.
- iOS Expo adapter: a pod/subspec/module that includes `BluetoothSdkModule.swift`, depends on `MentraBluetoothSDK`, and owns Expo event forwarding.
- React Native / Expo docs stay internal to MentraOS unless React Native becomes a customer-facing SDK target again.

Packaging validation must use fresh bare apps that consume the native artifacts, not only monorepo project references.

### 6.1 Public Android API

Create a stable Kotlin/Java facade, as detailed in the Android native API plan. At this level, the contract is:

- Native apps initialize a `MentraBluetoothSdk` facade with an Android application context and listener.
- Public callers use typed commands and typed callbacks, not `DeviceManager`, `DeviceStore`, `Bridge`, raw categories, or `update("bluetooth", ...)`.
- The base v1 API should cover scan/connect/disconnect/forget, status snapshots, display text/event/clear/dashboard, core display settings, mic state, and permission helpers.
- Advanced features such as camera/gallery, media streaming, OTA, local STT, RGB LEDs, controller pairing, and diagnostics should be clearly grouped behind capability APIs or advanced methods.
- Settings currently driven by `DeviceStore.apply()` need typed methods or typed settings objects before blob sync can be removed: brightness, auto brightness, dashboard height/depth/menu, head-up angle, screen disabled, gallery mode, button photo settings, button video settings, button camera LED, button max recording time, camera FOV, preferred mic, mic routing, and offline caption/STT flags.

Android extraction tasks:

- Add public Kotlin data classes for status, search results, display requests, and events.
- Add an internal event sink abstraction before changing behavior so native listeners and the Expo adapter can share the same event stream.
- Move SDK initialization out of `BluetoothSdkModule` and into the native facade with explicit application-context ownership.
- Remove process-wide `Bridge.getContext()` dependencies where practical by passing context through SDK-owned lifecycle objects.
- Ensure `DeviceManager` is controlled through the facade, not exposed as public API.
- Remove Android Gradle dependency on Expo module build plugins from the bare SDK artifact.
- Keep an Expo/RN adapter module that depends on the native SDK facade.
- Ensure the published Maven POM resolves SDK dependencies, including `lc3Lib`, without monorepo `project(...)` dependencies.
- Create a tiny bare Android sample app in `Mentra-Bluetooth-SDK-Partner-Kit` that uses Maven/local Gradle dependency and the public facade.

### 6.2 Public iOS API

Create a stable Swift facade, as detailed in the iOS native API plan. At this level, the contract is:

- Native apps initialize `MentraBluetoothSDK`, set a delegate, and optionally consume an async event stream.
- Public callers use Swift structs/enums and delegate callbacks, not `DeviceManager`, `DeviceStore`, `Bridge`, raw categories, or `update("bluetooth", ...)`.
- The base v1 API should cover scan/connect/disconnect/forget, status snapshots, display text/event/clear/dashboard, core display settings, mic state, and permission/capability helpers.
- Advanced features such as camera/gallery, media streaming, OTA, local STT, RGB LEDs, controller pairing, and diagnostics should be clearly grouped behind capability APIs or advanced methods.
- Settings currently driven by `DeviceStore.apply()` need typed methods or typed settings objects before blob sync can be removed: brightness, auto brightness, dashboard height/depth/menu, head-up angle, screen disabled, gallery mode, button photo settings, button video settings, button camera LED, button max recording time, camera FOV, preferred mic, mic routing, and offline caption/STT flags.

iOS extraction tasks:

- Add public Swift structs/enums for status, search results, display requests, and events.
- Add an internal event sink abstraction before changing behavior so the Swift facade and Expo adapter can share the same event stream.
- Make the public facade the only supported external API; keep `DeviceManager` internal.
- Make event emission work through delegate/closure callbacks without Expo/React Native.
- Remove `ExpoModulesCore` from the bare SDK podspec.
- Split pod source globs so the bare pod excludes `BluetoothSdkModule.swift` and any Expo-only files.
- Keep an Expo/RN adapter pod/module that depends on the native SDK facade.
- Add or defer SPM support based on dependency feasibility; CocoaPods is the first native target.
- Create a tiny bare iOS sample app in `Mentra-Bluetooth-SDK-Partner-Kit` that uses the CocoaPod and public facade.

### 6.3 MentraOS Adapter

MentraOS should continue to work, but it should use the native SDK through a thin adapter/service:

- `BluetoothSdkModule.kt` calls `MentraBluetoothSdk`.
- `BluetoothSdkModule.swift` calls `MentraBluetoothSDK`.
- A MentraOS TypeScript service watches relevant Zustand settings and calls typed SDK methods such as `setPreferredMic`, `connectDefault`, and `setMicState`; brightness remains an internal MentraOS setting path until the hardware command is reliable.
- Native status callbacks update `useBluetoothStore` / `useGlassesStore`; MentraOS TypeScript remains responsible for cloud/websocket formatting.
- The legacy TypeScript API can remain stable during migration while native customers use the native facade.
- Generic store blob syncing should be deprecated once MentraOS has moved to typed calls.
- Existing regression tests should continue to pass with little/no changes.

#### 6.3.1 Current MentraOS Owners

These are the files to preserve behavior from while extracting the adapter:

- `mobile/src/services/MantleManager.ts` currently owns Bluetooth SDK startup, initial settings sync, Zustand setting subscriptions, native status callbacks, `save_setting`, hardware event subscriptions, and most native-event-to-MentraOS routing.
- `mobile/src/stores/settings.ts` owns MentraOS setting definitions and the `getBluetoothSdkSettings()` selector that feeds the current native store blob.
- `mobile/src/stores/bluetooth.ts` and `mobile/src/stores/glasses.ts` own MentraOS state snapshots that UI and cloud reporting read.
- `mobile/src/services/SocketComms.ts` owns MentraOS websocket protocol formatting and cloud-command handling, including VAD, battery, touch, switch, RGB LED, audio frames, stream status, display events, camera/video commands, and mic-state commands.
- `mobile/src/services/RestComms.ts` owns MentraOS REST protocol formatting, including glasses status updates, photo responses, phone notifications, calendar/location data, token refresh, and incident/reporting endpoints.
- `mobile/src/services/DisplayProcessor.ts` owns MentraOS cloud display payload normalization before payloads reach Bluetooth SDK display APIs.
- Feature-level files such as pairing screens, Wi-Fi screens, OTA screens, `gallerySyncService`, `AudioPlaybackService`, and settings screens currently call `BluetoothSdk` directly for hardware commands.

#### 6.3.2 Target TypeScript Adapter Files

Create the adapter under a Bluetooth-specific services folder so MentraOS can migrate direct SDK usage gradually without exposing native store plumbing:

- `mobile/src/services/bluetooth/MentraBluetoothSdkAdapter.ts`
  - Owns MentraOS initialization/cleanup for the Bluetooth SDK.
  - Owns the native facade instance or the Expo adapter module.
  - Provides typed MentraOS-facing command wrappers for common hardware operations.
  - Owns compatibility calls to `updateBluetoothSettings(...)` until each setting group has a typed native method.
- `mobile/src/services/bluetooth/BluetoothSettingsSync.ts`
  - Extracts the current `useSettingsStore.getBluetoothSdkSettings()` subscription from `MantleManager`.
  - Translates setting diffs into typed calls in phases.
  - Keeps compatibility handling for `auth_email`, `core_token`, offline STT settings, and `"core"` category normalization until their explicit removal phases.
- `mobile/src/services/bluetooth/BluetoothEventBridge.ts`
  - Owns typed native hardware event subscriptions.
  - Updates `useBluetoothStore` / `useGlassesStore`.
  - Calls MentraOS cloud services where needed, but does not build native SDK payloads.
- `mobile/src/services/bluetooth/MentraBluetoothSdkAdapter.test.ts`
  - Covers initial setting sync, setting diffs, ignored non-SDK settings, status callback routing, event routing, cleanup, and compatibility keys.

If the implementation stays small, `BluetoothSettingsSync.ts` and `BluetoothEventBridge.ts` can start as private helpers inside `MentraBluetoothSdkAdapter.ts`; the important boundary is that `MantleManager.ts` stops owning generic native store sync directly.

#### 6.3.3 Migration Order

1. Extract the current `MantleManager` Bluetooth initialization, status listeners, `save_setting`, and settings subscription into `MentraBluetoothSdkAdapter` without changing behavior.
2. Replace `BluetoothSdk.updateBluetoothSettings(...)` by typed adapter calls setting group by setting group: display settings, camera/button settings, mic/audio flags, default wearable, dashboard menu, then compatibility-only credentials.
3. Move native hardware event subscriptions into `BluetoothEventBridge`, keeping the same calls into `SocketComms`, `RestComms`, Zustand stores, and `GlobalEventEmitter`.
4. Migrate feature-level direct `BluetoothSdk` imports to `MentraBluetoothSdkAdapter` wrappers when MentraOS state, compatibility settings, or cloud side effects are involved. Pure hardware-only feature calls can later call the typed SDK facade directly if that stays clearer.
5. Once no MentraOS TypeScript caller needs blob sync, remove `updateBluetoothSettings(...)`, `"core"` category normalization, and `save_setting` from customer-facing docs and eventually from the adapter compatibility layer.

#### 6.3.4 Cloud Formatting Boundary

Phase 6 must not move MentraOS cloud protocol formatting back into native SDK code:

- Native Android/iOS Bluetooth SDK emits typed hardware events and accepts typed hardware commands only.
- `SocketComms.ts` remains the owner for websocket JSON sent to MentraOS cloud.
- `RestComms.ts` remains the owner for REST payloads sent to MentraOS cloud.
- `DisplayProcessor.ts` remains the owner for MentraOS display payload normalization before display commands reach the SDK.
- `MentraBluetoothSdkAdapter` may route events to those services, but it should not introduce native-formatted MentraOS cloud payloads.
- Partner Kit/native SDK docs should describe typed hardware events, not MentraOS websocket message formats.

### 6.4 Native API Documentation

Update `Mentra-Bluetooth-SDK-Partner-Kit` to lead with:

- Bare Android getting started
- Bare iOS getting started
- Native API reference
- Permission setup by platform
- Native sample apps under `examples/android` and `examples/ios`
- React Native/Expo adapter note for MentraOS only

#### 6.4.1 Partner Kit Example App Coverage

The Partner Kit native examples are customer-facing examples, but they should also act as early integration smoke tests for the public native API shape. They should stay intentionally small and verify the base SDK path before advanced features:

- Initialize the native SDK from a normal bare Android or bare iOS app.
- Declare platform permissions and request runtime permissions where the OS requires it.
- Subscribe to typed status, discovery, log, and error callbacks.
- Scan for Mentra Live glasses.
- Connect to a discovered device or fall back to the saved/default device.
- Display a simple text payload.
- Apply at least one typed core hardware setting, currently brightness and dashboard position.
- Clear the display.
- Disconnect and release SDK resources through `close()` / `invalidate()`.
- Avoid React Native / Expo APIs and avoid raw native store sync.

Until the native facades exist, validation is limited to static project checks such as Android XML parsing, iOS plist/project parsing, Podfile syntax, and Xcode project discovery. Now that the native facades and local Android artifacts exist, the Android example is a real build gate:

- Android: publish `com.mentra:bluetooth-sdk` and `com.mentra:lc3Lib` to Maven local, then run the Partner Kit Android example `assembleDebug`.
- iOS: point the Partner Kit Podfile at the local `MentraBluetoothSDK` podspec, run `pod install`, then run `xcodebuild` for the iOS example.

### 6.5 Validation

Phase 6 is not complete until:

- Bare Android sample app in `Mentra-Bluetooth-SDK-Partner-Kit` builds and can initialize the SDK.
- Bare iOS sample app in `Mentra-Bluetooth-SDK-Partner-Kit` runs `pod install`, builds, and can initialize the SDK.
- MentraOS still builds and uses the SDK through the Expo adapter.
- `podspec` and Gradle publication no longer require Expo modules for native consumers.
- Published/local Android artifacts resolve without monorepo-only `project(...)` dependencies.
- The bare iOS pod source list excludes Expo adapter files.
- Advanced/heavy features are either explicitly part of v1 or documented as optional capability surfaces.
- Partner Kit docs match the native-first integration path.

---

## Cross-Phase Testing Strategy

The SDK split should be tested as an API boundary change, not just a package rename. Each phase should keep the affected regression tests close to the behavior being moved so later native extraction can change implementation details without rewriting the test intent.

### Unit Tests

- TypeScript adapter tests should cover MentraOS store-to-SDK sync, including initial setting sync, setting diffs, ignored non-SDK settings, typed status callbacks, and cloud-formatting ownership in TypeScript.
- Native store/manager tests should cover `DeviceStore` defaults, `apply()` side effects, event serialization, device manager lifecycle, and hardware command dispatch where platform test infrastructure exists.
- Mock SDK utilities should be reset between tests that mount/unmount screens or services so listener leakage does not hide regressions.
- Compatibility tests should keep `auth_email`, `core_token`, offline STT settings, and `"core"` category normalization behavior stable until their explicit migration phases remove them.

### Integration Tests

- Bridge tests should verify native events reach TypeScript as typed hardware events, including `glasses_status`, `bluetooth_status`, `button_press`, `head_up`, audio frames, display/gallery events, OTA events, and `save_setting`.
- BLE connection tests should cover scan, connect, reconnect, forget, default wearable selection, and failure routing for the main supported device families.
- Native package integration should validate fresh external installs: Maven local publication for Android, CocoaPods install for iOS, and MentraOS Expo adapter autolinking.
- Crust integration tests should cover MentraOS-only phone notification listening/permission behavior separately from Bluetooth SDK hardware tests.

### Regression Suites

Keep focused regressions for the flows most likely to break during the refactor:

- Pairing screens: scan, loading, success, failure, BT classic transition, and automatic incident filing.
- Audio: LC3/PCM streaming, mic state toggles, playback volume bump/restore, local transcription, and offline STT compatibility settings.
- Display: dashboard rendering, display text/images, clear display, head-up state, dashboard menu sync, and contextual dashboard behavior.
- Camera/gallery: photo response, video/RTMP status, gallery mode, gallery sync, and BLE transfer completion.
- Cloud ownership: typed hardware events should be formatted for MentraOS websocket/rest protocols in TypeScript, not in the native Bluetooth SDK.

### CI Gates

- Refactor PRs should run the touched focused suites with `cd mobile && bun run test -- <paths> --runInBand`, plus `git diff --check`.
- Native Android changes should run the relevant Gradle compile/test tasks and, for publishing changes, local Maven publication for both `com.mentra:bluetooth-sdk` and `com.mentra:lc3Lib`.
- Native iOS changes should validate podspec syntax / CocoaPods install behavior and a MentraOS iOS build when the bridge, podspec, or native Swift/Obj-C files change.
- Full `bun lint` should become a required gate once the repo lint baseline is clean. Until then, lint-staged and focused lint checks should be required for touched files.
- Publishing/release PRs should additionally test a fresh bare Android app and bare iOS app consuming the SDK artifact, not only the monorepo MentraOS app.

### Device And OS Matrix

- Always keep the simulated device path useful for CI and local smoke tests.
- Hardware validation before release should include MentraLive plus at least one display-only family such as MentraNex/MentraDisplay, G1/G2, Mach1, or Vuzix Z100.
- Android validation should include the minimum supported Android version, the current common production version, and at least one OEM/device with stricter background BLE behavior.
- iOS validation should include the minimum deployment target and the current App Store-supported iOS version.
- Record device model, OS version, firmware version, and whether the run used MentraOS cloud features or local-only SDK features.

---

## Implementation Checklist

### Phase 1: Rename (Week 1)

- [x] Create phase branch stack for the Bluetooth SDK rollout
- [x] Rename `mobile/modules/core` to `mobile/modules/bluetooth-sdk`
- [x] Update package.json name to `@mentra/bluetooth-sdk`
- [x] Update Android package: `com.mentra.core` -> `com.mentra.bluetoothsdk`
- [x] Update iOS module name
- [x] Update MentraOS imports to consume `@mentra/bluetooth-sdk`
- [x] Update expo-module.config.json
- [x] Verify build works on the covered Android/iOS validation paths

### Phase 2: Extract to Crust (Week 2)

- [x] Move NotificationListener service to Crust
- [x] Move NotificationListener manifest entry to Crust
- [x] Keep the state split practical instead of redesigning it:
  - [x] Move obvious MentraOS-only native features to Crust
  - [x] Keep `contextual_dashboard`, `auth_email`, `core_token`, and incident plumbing in Bluetooth SDK where hardware still depends on them
- [x] Leave offline STT control (`offline_mode` / `offline_captions_running`) unchanged in this branch
- [x] Update DeviceStore.apply() to remove handlers for deleted keys
- [x] Create Crust TypeScript interface
- [x] Wire up Crust to MentraOS app layer
- [x] Verify MentraOS still works on the covered Android/iOS validation paths

### Phase 3: Clean Up Bridge - Delete Duplicates (Week 2-3)

- [x] Audit all Bridge functions for duplicates
- [x] Find call sites of cloud-formatting functions in native code
- [x] Update call sites to use raw event emitters
- [x] Move cloud protocol formatting to TypeScript layer
- [x] Delete duplicate functions from Bridge.kt and Bridge.swift
- [x] Keep only raw hardware event emitters in Bluetooth SDK
- [x] Document public API surface

### Phase 4: Publishing Setup (Week 3)

- [ ] Set up Sonatype OSSRH account
- [x] Configure Gradle for Maven Central publishing metadata
- [x] Update CocoaPods podspec for external publishing
- [ ] Create Swift Package Manager manifest
- [x] Create iOS PrivacyInfo.xcprivacy manifest
- [x] Configure npm publishing metadata
- [ ] Set up CI/CD for automated publishing
- [x] Ensure native library is usable without Expo through local Maven/CocoaPods validation

### Phase 5: Documentation & Example (Week 4)

- [x] Create private GitHub partner docs repo and push scaffold
- [x] Draft private partner docs repo scaffold locally
- [x] Write thin public package README
- [x] Write private repo main README
- [x] Create initial private getting started guide
- [x] Document initial private API reference
- [x] Document cross-phase SDK testing strategy
- [x] Rewrite Partner Kit docs around bare Android and bare iOS first
- [x] Replace React Native example focus with bare Android and bare iOS samples
- [x] Create initial private native example apps demonstrating the public facade path:
  - Device scanning/discovery
  - Connection management
  - Display text
  - Display clearing
  - Status subscriptions
  - Button/battery events
- [x] Expand private example apps with camera/photo upload preview flows
- [ ] Expand private example apps with:
  - Display images
  - Audio streaming
- [ ] Validate a fresh third-party Expo/RN consumer app can install the published package, prebuild iOS/Android, and run `pod install` if React Native becomes customer-facing again

### Phase 6: Native SDK API Extraction

- [x] Define public Android facade and listener/event types
- [x] Define public iOS facade and delegate/event types
- [x] Define base vs advanced native capability surfaces
- [x] Define typed settings APIs for current `DeviceStore.apply()` side effects
- [x] Document native `DeviceStore` as internal-only and keep it out of public API docs
- [x] Add internal native event sink abstractions before changing bridge behavior
- [x] Move Expo module initialization/event forwarding behind native facades
- [ ] Add `mobile/src/services/bluetooth/MentraBluetoothSdkAdapter.ts`
- [ ] Add/extract `mobile/src/services/bluetooth/BluetoothSettingsSync.ts`
- [ ] Add/extract `mobile/src/services/bluetooth/BluetoothEventBridge.ts`
- [ ] Translate Zustand settings into typed SDK calls while preserving compatibility keys
- [ ] Keep `updateBluetoothSettings` as temporary compatibility plumbing only
- [ ] Keep `DeviceManager` / `DeviceStore` internal implementation details
- [x] Remove Expo module dependency from bare Android publication artifact
- [x] Remove `ExpoModulesCore` dependency from bare iOS podspec
- [x] Gate the iOS pod source list so the bare pod excludes Expo adapter files
- [x] Ensure Android Maven publication resolves `lc3Lib` without monorepo project dependencies
- [x] Keep MentraOS Expo adapter working on top of native facades
- [x] Create bare Android sample app in `Mentra-Bluetooth-SDK-Partner-Kit`
- [x] Create bare iOS sample app in `Mentra-Bluetooth-SDK-Partner-Kit`
- [x] Update Partner Kit docs for native-first setup
- [x] Validate bare Android sample build
- [x] Validate bare iOS `pod install` and build
- [x] Validate MentraOS mobile app still passes relevant regression tests

Current Phase 6 validation status:

- Android `:mentra-bluetooth-sdk:compileReleaseKotlin` passes with the new native facade and event/store fanout.
- Android `:mentra-bluetooth-sdk:compileDebugKotlin` passes with the Expo module now owning `MentraBluetoothSdk` for shared commands and event forwarding.
- Android `:app:processDebugMainManifest` passes after moving the Vuzix min-SDK override to the Bluetooth SDK manifest and stripping unrelated permissions/dependencies from the LC3 companion artifact.
- MentraOS Android `:app:assembleDebug` passes with the cleaned Android publication/manifest setup.
- iOS `MentraBluetoothSDK` scheme builds for iOS simulator with the new Swift facade and event/store fanout.
- iOS `BluetoothSdkModule.swift` now owns a `MentraBluetoothSDK` instance, forwards delegate callbacks to the existing Expo event names, and keeps adapter-only calls direct until those APIs are added to the public facade.
- Local Maven publication succeeds for `com.mentra:bluetooth-sdk` and `com.mentra:lc3Lib`; the Bluetooth SDK POM resolves `lc3Lib` as `com.mentra:lc3Lib:0.1.0`, no longer exposes `host.exp.exponent:expo-modules-core`, and the LC3 POM no longer publishes legacy app/cloud dependencies.
- The Partner Kit Android example builds against Maven local with the public facade and the documented ONNX Runtime native packaging `pickFirst` rule.
- The bare iOS podspec defaults to the native SDK only: no `ExpoModulesCore` dependency and no `BluetoothSdkModule.swift` adapter source unless `MENTRA_BLUETOOTH_SDK_INCLUDE_EXPO_ADAPTER=1` is set.
- MentraOS opts into the Expo adapter from `mobile/ios/Podfile`, preserving the current Expo module path while bare CocoaPods consumers get the native SDK surface.
- The Partner Kit iOS example installs the local podspec with CocoaPods and builds for iOS Simulator against the public Swift facade.
- Mobile `bun run test` passes with the adapter migration in place.

### Phase 7: MentraOS Migration

When we delete the duplicate cloud-formatting functions from Bridge, the MentraOS TypeScript layer needs to handle that formatting instead.

**Current flow:**

```
Android today: button pressed → Bridge.sendButtonPressEvent() emits typed event → TS handles / forwards as needed
iOS today: button pressed → Bridge.sendButtonPress() emits typed event → TS handles / forwards as needed

Some other helpers (battery / VAD / video / ws_text passthroughs) still format MentraOS cloud payloads in native and should move to TypeScript.
```

**New flow:**

```
Native: hardware emits typed/raw device events only → TypeScript formats any MentraOS cloud payloads that are still needed → TypeScript sends to WebSocket
```

**Files to update in MentraOS TypeScript:**

- Find where `ws_text` events are being listened to
- Make typed hardware events the source of truth (`button_press`, `head_up`, `touch_event`, etc.)
- Format the cloud protocol JSON in TypeScript
- Send via WebSocket from TypeScript

This is cleaner anyway - all cloud protocol logic lives in one place (TypeScript) instead of being split between native and TS.

### Phase 8: Release

- [ ] Final testing
- [ ] Publish v1.0.0 to all registries
- [ ] Announce release
- [ ] Update MentraOS to use published package (optional - can continue using monorepo)

---

## Success Criteria

1. **Published Packages**
   - `@mentra/bluetooth-sdk` on npm
   - `com.mentra:bluetooth-sdk` on Maven Central
   - `MentraBluetoothSDK` on CocoaPods

2. **Clean Separation**
   - Bluetooth SDK has no MentraOS-specific code
   - Crust contains all OS-specific native code
   - Enterprise customers can use Bluetooth SDK standalone

3. **Working Examples**
   - Example apps demonstrating standalone usage
   - Documentation for all platforms

4. **MentraOS Compatibility**
   - MentraOS app continues to work
   - Uses Bluetooth SDK + Crust together
   - No regression in functionality
