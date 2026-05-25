# Mentra Bluetooth SDK: Android Native API Plan

## Goal

Make the Bluetooth SDK usable directly from bare Android Kotlin and Java apps, while MentraOS continues to use the same native implementation through a thin Expo adapter.

The customer-facing Android API should not expose Expo, React Native, `DeviceManager`, `DeviceStore`, `Bridge`, or raw `"bluetooth"` / `"glasses"` store categories.

## Current Android Lifecycle

The current Android entrypoint is `BluetoothSdkModule.kt`, which is an Expo module. On module creation it:

- Calls `Bridge.initialize(context) { eventName, data -> sendEvent(eventName, data) }`.
- Creates `DeviceManager.getInstance()` after `Bridge` has a context.
- Configures `DeviceStore.store.configure` so `"glasses"` updates become `glasses_status` events and `"bluetooth"` updates become `bluetooth_status` events.
- Exposes Expo functions such as `update`, scan/connect helpers, `connectDefault`, `disconnect`, `displayText`, media commands, Wi-Fi commands, version commands, and microphone/STT commands.

The real hardware lifecycle lives under the Expo module:

- `Bridge.kt` is a process-wide event sink and context holder. It emits logs, status events, hardware events, mic frames, local transcriptions, and save-setting events.
- `DeviceManager.kt` is a singleton. It owns permissions checks, Bluetooth adapter monitoring, foreground service startup, phone mic/audio handling, current glasses manager, current controller manager, connection methods, display commands, Wi-Fi commands, camera/media commands, and cleanup.
- `DeviceStore.kt` is both state and command routing. `apply(category, key, value)` updates observable state and triggers hardware side effects for settings like brightness, dashboard position, gallery mode, button settings, preferred mic, stream flags, and default wearable.
- `SGCManager.kt` is the per-device abstraction implemented by G1, G2, Mentra Live, Mentra Nex, Mach1/Z100, simulated glasses, and controller classes.
- `ForegroundService` is declared by the SDK manifest and started by `DeviceManager` to keep connected-device and microphone work alive.

This structure is good internal machinery, but not a good public SDK boundary.

## Native API Shape

Create a public facade in `com.mentra.bluetoothsdk`:

```kotlin
class MentraBluetoothSdk private constructor(
    context: Context,
    config: MentraBluetoothSdkConfig,
) : AutoCloseable {
    companion object {
        @JvmStatic
        fun create(
            context: Context,
            config: MentraBluetoothSdkConfig = MentraBluetoothSdkConfig(),
            listener: MentraBluetoothSdkListener,
        ): MentraBluetoothSdk
    }

    fun addListener(listener: MentraBluetoothSdkListener)
    fun removeListener(listener: MentraBluetoothSdkListener)

    fun getGlassesStatus(): MentraGlassesStatus
    fun getBluetoothStatus(): MentraBluetoothStatus

    fun startScan(model: MentraDeviceModel)
    fun stopScan()
    fun connect(device: MentraDiscoveredDevice)
    fun connectByName(model: MentraDeviceModel, deviceName: String)
    fun connectDefault()
    fun disconnect()
    fun forget()

    fun displayText(request: MentraDisplayTextRequest)
    fun clearDisplay()
    fun showDashboard()

    fun setDashboardPosition(request: MentraDashboardPositionRequest)
    fun setHeadUpAngle(angleDegrees: Int)
    fun setScreenDisabled(disabled: Boolean)
    fun setGalleryModeEnabled(enabled: Boolean)
    fun setButtonPhotoSettings(settings: MentraButtonPhotoSettings)
    fun setButtonVideoRecordingSettings(settings: MentraButtonVideoRecordingSettings)
    fun setButtonCameraLed(enabled: Boolean)
    fun setButtonMaxRecordingTime(minutes: Int)
    fun setCameraFov(fov: MentraCameraFov)

    fun setMicState(config: MentraMicConfig)
    fun setPreferredMic(preferredMic: MentraMicPreference)
    fun setOwnAppAudioPlaying(playing: Boolean)
    fun getGlassesMediaVolume(): MentraGlassesMediaVolumeGetResult
    fun setGlassesMediaVolume(level: Int): MentraGlassesMediaVolumeSetResult

    fun requestWifiScan()
    fun sendWifiCredentials(ssid: String, password: String)
    fun forgetWifiNetwork(ssid: String)
    fun setHotspotState(enabled: Boolean)

    fun requestPhoto(request: MentraPhotoRequest)
    fun queryGalleryStatus()
    fun startStream(request: MentraStreamRequest)
    fun keepStreamAlive(request: MentraStreamKeepAliveRequest)
    fun stopStream()
    fun startVideoRecording(request: MentraVideoRecordingRequest)
    fun stopVideoRecording(requestId: String)

    fun requestVersionInfo()

    override fun close()
}
```

The core API should be Java-friendly. Avoid requiring coroutines, Flow, or AndroidX lifecycle owners in the base artifact. A later `mentra-bluetooth-sdk-ktx` artifact can add suspend functions and Flow wrappers.

## Capability Shape

The facade can be implemented as one class initially, but the customer-facing docs should not imply every feature is part of the minimum SDK contract.

Base v1 should include:

- Initialization, cleanup, permission helpers, scan, connect, disconnect, forget, default-device handling, and status snapshots.
- Display primitives: display text, clear display, and show dashboard.
- Core hardware settings: brightness, auto brightness, dashboard height/depth, head-up angle, screen disable, gallery mode, button/camera settings, preferred mic, mic routing, and own-app-audio state.
- Common device events: status, discovered devices, button/touch/head-up, battery, Wi-Fi status, logs, and errors.

Advanced or capability-gated APIs should include:

- Camera/gallery commands and media transfer state.
- RTMP/video streaming and saved video recording.
- Version info commands. MentraOS-only OTA, shutdown, reboot, incident, and diagnostic commands stay behind the adapter boundary.
- Local STT, VAD/model management, and raw mic frame delivery.
- Controller pairing and RGB LED controls.

The SDK should expose capability state per connected device so customers can disable unsupported UI without relying on no-op behavior. Unsupported operations should either return a typed failure or emit a typed error, not silently appear to succeed.

## Listener API

Use typed listener callbacks for ongoing events:

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
    fun onWifiStatusChanged(event: WifiStatusEvent) {}
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

Callbacks should be delivered on the Android main thread by default. If we need background delivery later, add `callbackExecutor` to `MentraBluetoothSdkConfig`.

Java consumers should be able to extend `MentraBluetoothSdkCallback`, a no-op base class implementing `MentraBluetoothSdkListener`, and override only the callbacks they use.

## Public Models

Add typed public models before exposing the facade:

- `MentraDeviceModel`: `G1`, `G2`, `MENTRA_LIVE`, `MENTRA_NEX`, `MACH1`, `Z100`, `FRAME`, `SIMULATED`, `R1`.
- `MentraDiscoveredDevice`: `model`, `name`, optional `address`, optional `rssi`.
- `MentraGlassesStatus`: current snapshot of connected, fully booted, battery, charging, model, firmware, serial, Wi-Fi, hotspot, head-up, controller, and signal state.
- `MentraBluetoothStatus`: current snapshot of searching, mic, current mic, search results, Wi-Fi scan results, permission availability, and audio availability.
- `MentraDisplayTextRequest`, `MentraDisplayEventRequest`, `MentraDashboardPositionRequest`, `MentraDashboardMenuItem`, `MentraPhotoRequest`, `MentraStreamRequest`, `MentraStreamKeepAliveRequest`, `MentraVideoRecordingRequest`, `MentraMicConfig`, `MentraBluetoothError`.
- Settings models/enums for values currently routed through `DeviceStore.apply()`: `MentraButtonPhotoSettings`, `MentraButtonPhotoSize`, `MentraButtonVideoRecordingSettings`, `MentraCameraFov`, and `MentraMicPreference`.
- Typed value enums should reflect device-specific capability boundaries rather than raw string payloads: `MentraPhotoSize` includes `FULL` for app-requested uploads, `MentraButtonPhotoSize` intentionally does not; `MentraPhotoCompression` is `NONE` / `MEDIUM` / `HEAVY`; `MentraRgbLedAction` and `MentraRgbLedColor` represent the Mentra Live/K900 RGB ring surface; stream request fields are typed while the actual streaming protocol is selected from the URL prefix.

For Java ergonomics, models with many optional fields should have builders instead of huge constructors.

## Store Sync Boundary

The current MentraOS integration has two stores:

- MentraOS TypeScript uses Zustand stores for app settings, Bluetooth status, and glasses status.
- Native Android uses `DeviceStore` / `ObservableStore` for hardware state and setting side effects.

This two-store setup can remain internally, but it should not become the public Android SDK paradigm. External Android customers should not call `update("bluetooth", values)`, listen for `save_setting`, or know which raw keys cause hardware side effects.

The target boundary is:

- Public SDK callers use typed methods such as `setPreferredMic`, `startScan`, `connect`, `displayText`, and `setMicState`.
- Public SDK callers receive typed callbacks such as `onGlassesStatusChanged`, `onBluetoothStatusChanged`, `onDeviceDiscovered`, and `onButtonPress`.
- All hardware side effects currently hidden inside `DeviceStore.apply()` should have a typed public or adapter-only entrypoint before MentraOS removes blob sync.
- `DeviceStore` remains an implementation detail behind `MentraBluetoothSdk`.
- SDK-owned persistence should use a typed storage/config abstraction or default SharedPreferences storage. It should not ask external apps to persist arbitrary MentraOS setting keys.
- `onDefaultDeviceChanged` can notify apps that the remembered device changed, but the SDK should own the default storage path unless the app provides a custom storage implementation.

## Permissions And Host Lifecycle

The host app should own runtime permission prompts. The SDK can help with permission discovery and state:

```kotlin
object MentraBluetoothPermissions {
    @JvmStatic
    fun requiredPermissions(features: Set<MentraSdkFeature>): Array<String>

    @JvmStatic
    fun check(context: Context, features: Set<MentraSdkFeature>): MentraPermissionStatus
}
```

The SDK artifact can still merge manifest permissions and the foreground service declaration, but external apps need clear setup docs for:

- Bluetooth scan/connect permissions.
- Location permission when Android requires it for BLE scanning.
- Microphone permission for phone mic and transcription features.
- Foreground service permissions and notification-channel behavior.
- Notification icon/title customization through `MentraBluetoothSdkConfig`.

The facade must retain an application context internally, not an Activity context. `close()` should unregister receivers, stop scan/reconnect loops where appropriate, stop mic capture, stop/settle the foreground service, and release listener references.

## Packaging Plan

The bare Android SDK should publish as a normal Android library artifact:

- `com.mentra:bluetooth-sdk`: bare Android artifact with no Expo Gradle plugin, no `expo-modules-core` dependency, and no React Native lifecycle assumptions.
- Expo adapter artifact/module: owns `BluetoothSdkModule.kt`, depends on `com.mentra:bluetooth-sdk`, and forwards native events to Expo event names.
- `com.mentra:lc3Lib`: companion artifact required by audio paths; the Bluetooth SDK POM must resolve it as a Maven dependency rather than as `project(':lc3Lib')`.

The current Maven artifact no longer exposes Expo as a runtime dependency, and the bare Android sample in `Mentra-Bluetooth-SDK-Partner-Kit` builds against the locally published artifacts. The source module still contains the Expo adapter compiled with an Expo `compileOnly` dependency, so a cleaner final split should still move `BluetoothSdkModule.kt` into a dedicated Expo adapter module before public release.

Heavy dependencies should be audited before release. Local STT, ONNX/VAD, Vuzix support, and media streaming may remain in the initial artifact if that is fastest, but the plan should keep a path open for optional feature artifacts if binary size or transitive dependency conflicts become a customer problem. The Android sample currently documents the required `lib/**/libonnxruntime.so` packaging `pickFirst` rule for the local audio stack.

## MentraOS Adapter

MentraOS should keep its TypeScript API stable. `BluetoothSdkModule.kt` becomes an adapter that:

- Creates `MentraBluetoothSdk` in `OnCreate`.
- Maps `MentraBluetoothSdkListener` callbacks back to existing Expo event names such as `glasses_status`, `bluetooth_status`, `button_press`, `mic_pcm`, and `save_setting`.
- Translates existing stringly typed `update("core" | "bluetooth", values)` calls into typed facade calls or internal settings updates while MentraOS migrates.
- Lets `mobile/src/services/bluetooth/MentraBluetoothSdkAdapter.ts` watch Zustand settings and call typed SDK methods directly over time, with `BluetoothSettingsSync.ts` and `BluetoothEventBridge.ts` extracted as helpers if the adapter grows.
- Keeps legacy `"core"` category normalization inside the adapter/store compatibility layer, not in the public native API.
- Keeps MentraOS cloud formatting in TypeScript services such as `SocketComms.ts`, `RestComms.ts`, and `DisplayProcessor.ts`; Android should emit typed hardware events, not MentraOS websocket or REST payloads.

This lets MentraOS keep using the SDK while external customers use the native Android facade.

Current implementation status:

- `MentraBluetoothSdk` owns native event/store fanout through `Bridge.addEventSink` and `DeviceStore.store.addListener`.
- `BluetoothSdkModule.kt` now owns a `MentraBluetoothSdk` instance and maps listener callbacks back to the existing Expo event names.
- The Android facade exposes a raw-event fallback for MentraOS compatibility so legacy events such as `save_setting`, OTA progress, BLE command traces, and other adapter-only events are still delivered while typed callbacks are added incrementally.
- Adapter-only commands such as controller pairing, debug helpers, STT utilities, permission/settings intents, and raw `update(...)` compatibility still call the current internals until the public facade grows those APIs.
- `:mentra-bluetooth-sdk:compileDebugKotlin` passes with the Expo adapter using the facade for shared commands and event forwarding.

## Extraction Plan

1. Add an internal `MentraEventSink` behind the current `Bridge` behavior so events can fan out to native listeners and the Expo adapter without changing emitted event names.
2. Move `Bridge.getContext()` dependencies behind constructor or initializer injection so the native facade controls lifecycle through an application context.
3. Add the public model package, settings models, listener interfaces, and error types without changing behavior.
4. Add `MentraBluetoothSdk` facade that delegates to the existing `DeviceManager`, `DeviceStore`, and SGC internals.
5. Keep `DeviceManager`, `DeviceStore`, `ObservableStore`, and `SGCManager` internal implementation details.
6. Keep `updateBluetoothSettings`, `"core"` normalization, and `save_setting` as MentraOS compatibility plumbing only.
7. Add `mobile/src/services/bluetooth/MentraBluetoothSdkAdapter.ts` and translate Zustand changes into typed SDK calls setting group by setting group.
8. Split packaging so the bare Android artifact does not depend on Expo module Gradle plugins.
9. Keep a separate Expo adapter artifact/module that depends on the bare SDK artifact.
10. Resolve `lc3Lib` publication so an external Gradle project can consume the SDK without monorepo project dependencies.
11. Add a bare Android sample app in `Mentra-Bluetooth-SDK-Partner-Kit` that initializes the SDK, scans, connects, displays text, clears display, applies a core setting, and logs status events.
12. Keep the existing mobile regression tests passing with little or no TypeScript test changes.

## Acceptance Criteria

- A new bare Android app can depend on the SDK artifact without Expo or React Native.
- Kotlin and Java callers can initialize the SDK, subscribe to events, scan, connect, display text, and disconnect.
- Kotlin and Java callers can apply the core hardware settings currently handled by `DeviceStore.apply()` without using raw setting keys.
- MentraOS still builds and uses the same implementation through `BluetoothSdkModule.kt`.
- Public docs never tell customers to call `DeviceManager`, `DeviceStore`, `Bridge`, `update("bluetooth", ...)`, or handle `save_setting`.
- The Android sample app in `Mentra-Bluetooth-SDK-Partner-Kit` builds from a clean checkout and exercises the public facade.
- The Android sample app covers SDK initialization, permission declarations/prompts, scan, discovery callback, connect discovered/default, status/log/error callbacks, display text, brightness/dashboard settings, clear display, disconnect, and `close()`.
- Local Maven publication verifies both `com.mentra:bluetooth-sdk` and `com.mentra:lc3Lib` can be consumed without monorepo project references, without an Expo runtime dependency, and with `lc3Lib` published as a minimal codec companion artifact.
- The foreground service, runtime permissions, audio capture, and BLE receiver lifecycle have explicit cleanup coverage.

## Open Questions

- Whether the first version should expose controller pairing publicly or keep it as an advanced/internal API.
- Whether media, streaming, and local transcription should ship in the base SDK facade or be grouped behind capability interfaces.
- Whether callbacks should always be main-thread or configurable through `Executor`.
- Whether we want a Kotlin `Flow` wrapper in v1 or as a later `-ktx` package.
