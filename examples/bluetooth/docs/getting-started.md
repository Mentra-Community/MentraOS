# Getting Started

This guide shows how to add the Mentra Bluetooth SDK to Android, iOS, and React Native apps, then connect to glasses and send the first command.

Use the SDK version and package repository access supplied by Mentra. The example apps in this repo are designed to work from a fresh clone once the Maven, CocoaPods, and npm packages are available.

## Requirements

- A supported pair of Mentra smart glasses.
- A physical phone for real Bluetooth testing. Simulators and emulators are useful for UI/build checks only.
- Android: min SDK `28` or newer, Java 17, Android Studio or Gradle.
- iOS: deployment target `15.1` or newer, Xcode 15 or newer, CocoaPods.
- React Native / Expo: a development build or production native build. Expo Go cannot load the native SDK.
- Bluetooth permissions, and Android location permission where BLE scanning requires it, requested through your app's normal permission flow.

## Package Install

### Android

Add the Mentra Maven repository supplied for your release and depend on the Android artifact:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven("https://www.jitpack.io")
        maven("https://<mentra-maven-repository>")
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
    implementation("com.mentra:bluetooth-sdk:<version>")
}
```

The packaging rules avoid duplicate native library conflicts from the SDK audio and transcription stack.

For unreleased SDK development, publish the SDK to Maven local from the MentraOS checkout and keep `mavenLocal()` in your app repositories:

```bash
cd /path/to/MentraOS/mobile/android
./gradlew :lc3Lib:publishToMavenLocal :mentra-bluetooth-sdk:publishToMavenLocal
```

### iOS

Add the Mentra CocoaPods source supplied for your release when required by your access model, then depend on the pod:

```ruby
platform :ios, '15.1'

target 'YourApp' do
  use_frameworks!

  pod 'MentraBluetoothSDK', '<version>'
end
```

For unreleased SDK development, point CocoaPods at a local checkout during `pod install`:

```bash
export MENTRA_BLUETOOTH_SDK_LOCAL_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk/ios
pod install
```

Keep that environment variable out of committed project files.

### React Native / Expo

Install the npm package and configure the Expo plugin:

```bash
npm install @mentra/bluetooth-sdk
npx expo install expo-build-properties
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
npx expo prebuild
npx expo run:ios
# or
npx expo run:android
```

For unreleased SDK development, install a local package path and set the package path for Metro/native resolution:

```bash
npm install --no-save /path/to/MentraOS/mobile/modules/bluetooth-sdk
MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk npx expo run:ios
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
import com.mentra.core.Device
import com.mentra.core.DeviceModel
import com.mentra.core.DisplayTextRequest
import com.mentra.core.GlassesStatusUpdate
import com.mentra.core.MentraBluetoothSdk
import com.mentra.core.MentraBluetoothSdkCallback

class GlassesController(context: Context) : MentraBluetoothSdkCallback() {
    private val sdk = MentraBluetoothSdk.create(
        context = context.applicationContext,
        listener = this,
    )
    private var discoveredDevice: Device? = null

    fun scan() {
        sdk.startScan(DeviceModel.MENTRA_LIVE)
    }

    fun connect() {
        discoveredDevice?.let { sdk.connect(it) }
    }

    fun showHello() {
        sdk.displayText(DisplayTextRequest(text = "Hello from Android"))
    }

    override fun onDeviceDiscovered(device: Device) {
        discoveredDevice = device
    }

    override fun onGlassesStatusChanged(status: GlassesStatusUpdate) {
        // Keep app UI derived from SDK status.
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
    private var discoveredDevice: Device?

    override init() {
        super.init()
        sdk.delegate = self
    }

    func scan() throws {
        try sdk.startScan(model: .mentraLive)
    }

    func connect() throws {
        guard let discoveredDevice else { return }
        try sdk.connect(to: discoveredDevice)
    }

    func showHello() async throws {
        try await sdk.displayText(DisplayTextRequest(text: "Hello from iOS"))
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: Device) {
        discoveredDevice = device
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: GlassesStatusUpdate) {
        // Keep app UI derived from SDK status.
    }

    deinit {
        sdk.invalidate()
    }
}
```

## React Native Basic Flow

```ts
import BluetoothSdk, {
  createDisconnectedGlassesStatus,
  isReadyGlassesConnectionStatus,
  type Device,
  type GlassesStatus,
} from '@mentra/bluetooth-sdk';

let glassesStatus: Partial<GlassesStatus> = createDisconnectedGlassesStatus();

const firstDevice = new Promise<Device>((resolve) => {
  let removeCore = () => {};
  removeCore = BluetoothSdk.onCoreStatus((status) => {
    const device = status.searchResults?.[0];
    if (device) {
      removeCore();
      resolve(device);
    }
  });
});

const removeGlasses = BluetoothSdk.onGlassesStatus((status) => {
  glassesStatus = {...glassesStatus, ...status};
  console.log('Glasses status changed', status);
});

await BluetoothSdk.startScan({model: 'Mentra Live'});

await BluetoothSdk.connect(await firstDevice);
glassesStatus = await BluetoothSdk.getGlassesStatus();
if (glassesStatus.connection && isReadyGlassesConnectionStatus(glassesStatus.connection)) {
  await BluetoothSdk.displayText({text: 'Hello from React Native', x: 0, y: 0, size: 24});
}

removeGlasses();
```

React Native status uses `glassesStatus.connection.state` for link progress. `fullyBooted` only exists when `state === 'connected'`.

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
git clone <partner-kit-repo-url>
cd Mentra-Bluetooth-SDK-Partner-Kit
```

Run one of:

```bash
cd examples/android
./gradlew installDebug
```

```bash
cd examples/ios
pod install
open MentraExample.xcworkspace
```

```bash
cd examples/react-native
npm install
npx expo prebuild
npx expo run:ios
# or
npx expo run:android
```

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
