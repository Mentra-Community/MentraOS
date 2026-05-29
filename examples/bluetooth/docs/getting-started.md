# Getting Started

This guide shows how to add the Mentra Bluetooth SDK to Android, iOS, and React Native apps, then connect to Mentra Live and read glasses status.

Use the latest SDK version published by Mentra. The example apps in this repo are designed to work from a fresh clone with the Maven, SwiftPM, and JavaScript packages, without any local MentraOS checkout.

## Requirements

- A supported pair of Mentra smart glasses.
- A physical phone for real Bluetooth testing. Simulators and emulators are useful for UI/build checks only.
- Android: min SDK `28` or newer, Java 17, Android Studio or Gradle.
- iOS: deployment target `15.1` or newer, Xcode 15 or newer, Swift Package Manager.
- React Native / Expo: a development build or production native build. Expo Go cannot load the native SDK.
- Bluetooth permissions, and Android location permission where BLE scanning requires it, requested through your app's normal permission flow.

## Package Install

### Android

Depend on the Android artifact from your app module:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven("https://www.jitpack.io")
    }
}
```

```kotlin
// app/build.gradle.kts
android {
    defaultConfig {
        minSdk = 28
    }
    packaging {
        jniLibs {
            pickFirsts += "**/libc++_shared.so"
            pickFirsts += "**/libonnxruntime.so"
            pickFirsts += "**/libonnxruntime4j_jni.so"
        }
    }
}

dependencies {
    implementation("com.mentraglass:bluetooth-sdk:<version>")
}
```

The packaging rules avoid duplicate native library conflicts from the SDK audio and transcription stack.

For unreleased SDK development, publish the SDK to Maven local from the MentraOS checkout and keep `mavenLocal()` in your app repositories:

```bash
cd /path/to/MentraOS/mobile/android
./gradlew :lc3Lib:publishToMavenLocal :mentra-bluetooth-sdk:publishToMavenLocal
```

### iOS

Add the public Swift package in Xcode or `Package.swift`:

```text
https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git
```

Use version `0.1.7` or newer, then add the `MentraBluetoothSDK` product to your app target.

For `Package.swift` consumers:

```swift
.package(
  url: "https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git",
  from: "0.1.7"
)
```

For unreleased SDK development, point Xcode at a local Swift package checkout.

```text
/path/to/MentraOS/mobile/modules/bluetooth-sdk
```

Keep local package paths out of committed project files.

### React Native / Expo

Install the package with Bun and configure the Expo plugin:

```bash
bun add @mentra/bluetooth-sdk
bunx expo install expo-build-properties
```

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

Then generate and run a native build:

```bash
bunx expo prebuild
bunx expo run:ios
# or
bunx expo run:android
```

The React Native starter example also includes `bun run android:dev`, which starts Metro first, forwards the device's `localhost:8081` over USB, installs the native app, and opens the Expo dev-client URL so the first launch does not land on the blank launcher screen.

For unreleased SDK development, install a local package path and set the package path for Metro/native resolution:

```bash
bun add --no-save /path/to/MentraOS/mobile/modules/bluetooth-sdk
MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk bunx expo run:ios
```

## Permissions

Android apps should request the platform permissions required by the features they use:

```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

Some Android 12+ devices still require runtime location permission and Location services before they deliver BLE scan callbacks, even when Nearby Devices permissions are granted.

iOS apps should include permission copy in `Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>This app connects to your smart glasses over Bluetooth.</string>
<key>NSMicrophoneUsageDescription</key>
<string>This app uses the microphone when you enable audio or transcription features.</string>
<key>NSLocalNetworkUsageDescription</key>
<string>This app connects to local photo and streaming helpers during development.</string>
```

## Background Operation On iOS

If your iOS app needs BLE to keep running while the phone is locked or the app is backgrounded, enable Core Bluetooth background mode:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>bluetooth-central</string>
</array>
```

If your app also keeps microphone capture or an audio session active in the background, add `audio` too:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>bluetooth-central</string>
  <string>audio</string>
</array>
```

Configure your audio session before starting continuous microphone or playback work. For Expo / React Native apps, install `expo-audio` if needed and call `setAudioModeAsync` during startup or before enabling the microphone:

```ts
import {setAudioModeAsync} from 'expo-audio';

await setAudioModeAsync({
  allowsRecording: true,
  allowsBackgroundRecording: true,
  shouldPlayInBackground: true,
  playsInSilentMode: true,
  interruptionMode: 'duckOthers',
});
```

Start continuous microphone capture while the app is foregrounded. iOS background mode lets an active session continue, but the SDK does not start the phone microphone from the background.

This SDK version does not enable terminated-app Core Bluetooth state restoration with `CBCentralManagerOptionRestoreIdentifierKey`. If iOS terminates the app, relaunch the app and reconnect from your normal startup flow.

## Minimal Lifecycle

1. Request OS-level Bluetooth permissions before scanning.
2. Create one SDK instance for the active app session.
3. Subscribe to status and hardware events before connecting.
4. Start a scan for the user's glasses model.
5. Connect by discovered device, or restore your app-persisted default device and call `connectDefault()`.
6. Drive UI from SDK status callbacks and snapshots.
7. Send commands only when the connected device supports the feature.
8. Stop scans, remove listeners/delegates, and call `close()` / `invalidate()` when the app session ends.

## Android Basic Flow

```kotlin
import android.content.Context
import com.mentra.bluetoothsdk.Device
import com.mentra.bluetoothsdk.DeviceModel
import com.mentra.bluetoothsdk.GlassesRuntimeState
import com.mentra.bluetoothsdk.MentraBluetoothSdk
import com.mentra.bluetoothsdk.MentraBluetoothSdkCallback

class GlassesController(context: Context) : MentraBluetoothSdkCallback() {
    private val sdk = MentraBluetoothSdk.create(
        context = context.applicationContext,
        listener = this,
    )
    private var selectedDevice: Device? = null

    fun scan() {
        sdk.scan(DeviceModel.MENTRA_LIVE, timeoutMs = 10_000) { devices ->
            renderDevicePicker(devices, onSelect = { selectedDevice = it })
        }
    }

    fun connect() {
        selectedDevice?.let { sdk.connect(it) }
    }

    fun refreshStatus() {
        sdk.requestVersionInfo()
        val glasses = sdk.getGlasses()
        if (glasses is GlassesRuntimeState.Connected) {
            val model = glasses.device.deviceModel?.deviceType ?: "glasses"
            val battery = glasses.battery.level?.toString() ?: "unknown"
            println("Connected to $model, battery=$battery%")
        }
    }

    override fun onGlassesChanged(glasses: GlassesRuntimeState) {
        // Keep app UI derived from SDK status.
        println("Glasses changed: $glasses")
    }

    private fun renderDevicePicker(devices: List<Device>, onSelect: (Device) -> Unit) {
        // Render devices in SDK-provided order and call onSelect with the user's choice.
    }

    fun close() {
        sdk.close()
    }
}
```

## iOS Basic Flow

```swift
import MentraBluetoothSDK

@MainActor
final class GlassesController: NSObject, MentraBluetoothSDKDelegate {
    private let sdk = MentraBluetoothSDK()
    private var selectedDevice: Device?

    override init() {
        super.init()
        sdk.delegate = self
    }

    func scan() throws {
        try sdk.scan(model: .mentraLive, timeout: 10) { [weak self] devices in
            self?.renderDevicePicker(devices) { device in
                self?.selectedDevice = device
            }
        }
    }

    func connect() throws {
        guard let selectedDevice else { return }
        try sdk.connect(to: selectedDevice)
    }

    func refreshStatus() {
        sdk.requestVersionInfo()
        let glasses = sdk.glasses
        if let device = glasses.device {
            let battery = glasses.battery?.level.map(String.init) ?? "unknown"
            print("Connected to \(device.deviceModel?.deviceType ?? "glasses"), battery=\(battery)%")
        }
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlasses glasses: GlassesRuntimeState) {
        // Keep app UI derived from SDK status.
        print("Glasses changed: \(glasses)")
    }

    private func renderDevicePicker(_ devices: [Device], onSelect: @escaping (Device) -> Void) {
        // Render devices in SDK-provided order and call onSelect with the user's choice.
    }

    deinit {
        sdk.invalidate()
    }
}
```

## React Native Basic Flow

```ts
import BluetoothSdk, {DeviceModels} from '@mentra/bluetooth-sdk';
import {useMentraBluetooth} from '@mentra/bluetooth-sdk/react';

const devices = await BluetoothSdk.scan(DeviceModels.MentraLive, {
  timeoutMs: 10_000,
  onResults: (nextDevices) => renderDevicePicker(nextDevices),
});
const device = await chooseDevice(devices);
await BluetoothSdk.connect(device);
await BluetoothSdk.requestVersionInfo();

function DeviceStatus() {
  const mentra = useMentraBluetooth();
  console.log('Connection:', mentra.glasses.connection.state);
  console.log('Battery:', mentra.glasses.connected ? mentra.glasses.battery.level : null);
}
```

React Native status uses `mentra.glasses.connection.state` for link progress. `fullyBooted` only exists when `state === 'connected'`.

`scan()` has two result paths on purpose: `onResults` is for live picker updates while scanning is still in progress, and the returned `devices` array is the final list after the scan timeout/completion. Use the final list for "pick one and connect" logic. In rooms with multiple pairs of glasses, present an explicit picker instead of auto-connecting to the first nearby device.

Use `Device.id` as the stable app-facing key for scan rows, selected devices, and persisted default devices. Do not parse it for model, name, or address information; use the typed `model`, `name`, `address` / `identifier`, and `rssi` fields instead. Android commonly uses a Bluetooth address when available, iOS commonly uses a CoreBluetooth identifier when available, and the SDK falls back to `model:name` when no platform identifier is available.

`Device.rssi` is optional. A device can appear in scan results before the platform reports RSSI, so picker UI should handle `undefined` and avoid reordering rows just because RSSI metadata arrives later.

React Native apps should persist their own default-device record if they want `connectDefault()` to work after restart:

```ts
const savedDevice = await loadSavedDevice();
if (savedDevice) {
  await BluetoothSdk.setDefaultDevice(savedDevice);
  await BluetoothSdk.connectDefault();
}
```

## Run The Examples

From a fresh clone:

```bash
git clone <starter-kit-repo-url>
cd <starter-kit-directory>
```

Run one of:

```bash
cd examples/android
./gradlew installDebug
```

```bash
cd examples/ios
open MentraExample.xcodeproj
```

```bash
cd examples/react-native
bun install
bun run ios:setup
bunx expo prebuild
bunx expo run:ios
# or
bun run android:dev
```

`bun run ios:setup` installs the GStreamer iOS SDK used by the React Native example's direct phone WebRTC preview.

For photo upload and RTMP/SRT/WebRTC demos, start the local helper from the repo root:

```bash
python3 examples/local-demo-cloud/server.py
```

Paste the printed LAN URLs into the example apps. Do not use `localhost`; the glasses and phone need a reachable LAN address.

## Next Steps

- See [API Reference](api-reference.md) for supported commands and events.
- See [Display Guide](display-guide.md) for display examples.
- See [Audio Guide](audio-guide.md) for microphone and local transcription flows.
- See [Hardware Integration Notes](hardware-integration.md) for model capability guidance.
- See [Troubleshooting](troubleshooting.md) if native build or pairing fails.
