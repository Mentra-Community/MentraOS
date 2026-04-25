# Getting Started

This guide walks through adding the Mentra Bluetooth SDK to a bare Android or bare iOS app.

Use the SDK version and package repository supplied by Mentra. The snippets below show the native API and example project shape.

## Requirements

- A supported pair of Mentra smart glasses
- Android min SDK `28` or newer for Android apps
- Java 17 for Android builds
- iOS deployment target `15.1` or newer for iOS apps
- Xcode 15 or newer for iOS builds
- Bluetooth permissions requested through your app's normal permission flow

## Android Installation

Add the Mentra Maven repository supplied by Mentra and depend on the native Android artifact:

```kotlin
// settings.gradle.kts or dependencyResolutionManagement block
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven("https://www.jitpack.io")
        maven("https://<mentra-maven-repository>") {
            credentials {
                username = providers.gradleProperty("mentraRepoUser").orNull
                password = providers.gradleProperty("mentraRepoToken").orNull
            }
        }
    }
}
```

```kotlin
// app/build.gradle.kts
android {
    packaging {
        jniLibs {
            pickFirsts += "lib/**/libonnxruntime.so"
        }
    }
}

dependencies {
    implementation("com.mentra:bluetooth-sdk:<version>")
}
```

The packaging rule resolves the SDK native audio stack's shared ONNX Runtime library during Android app packaging.

The SDK manifest contributes the service and baseline Bluetooth declarations, but your app still owns runtime permission prompts.

```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

See [Android example](../examples/android/README.md) for a complete app skeleton.

## Android Basic Flow

```kotlin
class GlassesController(
    private val context: Context,
) : MentraBluetoothSdkListener {
    private val sdk = MentraBluetoothSdk.create(
        context = context.applicationContext,
        listener = this,
    )

    fun scan() {
        sdk.startScan(MentraDeviceModel.MENTRA_LIVE)
    }

    fun connect(device: MentraDiscoveredDevice) {
        sdk.connect(device)
    }

    fun showHello() {
        sdk.displayText(
            MentraDisplayTextRequest(
                text = "Hello from Android",
                x = 0,
                y = 0,
                size = 24,
            )
        )
    }

    override fun onDeviceDiscovered(device: MentraDiscoveredDevice) {
        // Update your UI with the discovered device.
    }

    override fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {
        // Keep app UI derived from SDK status.
    }

    fun close() {
        sdk.close()
    }
}
```

## iOS Installation

Add the Mentra CocoaPods source supplied by Mentra and depend on the native iOS pod:

```ruby
platform :ios, '15.1'

target 'YourApp' do
  use_frameworks!

  pod 'MentraBluetoothSDK', '<version>'
end
```

Add required permission copy to `Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>This app connects to your smart glasses over Bluetooth.</string>
<key>NSMicrophoneUsageDescription</key>
<string>This app uses the microphone when you enable audio or transcription features.</string>
```

See [iOS example](../examples/ios/README.md) for a complete app skeleton.

## iOS Basic Flow

```swift
@MainActor
final class GlassesController: NSObject, MentraBluetoothSDKDelegate {
    private let sdk = MentraBluetoothSDK()
    private var discoveredDevice: MentraDiscoveredDevice?

    override init() {
        super.init()
        sdk.delegate = self
    }

    func scan() {
        sdk.startScan(model: .mentraLive)
    }

    func connect() {
        guard let discoveredDevice else { return }
        sdk.connect(to: discoveredDevice)
    }

    func showHello() async throws {
        try await sdk.displayText(
            MentraDisplayTextRequest(
                text: "Hello from iOS",
                x: 0,
                y: 0,
                size: 24
            )
        )
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: MentraDiscoveredDevice) {
        discoveredDevice = device
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: MentraGlassesStatusUpdate) {
        // Keep app UI derived from SDK status.
    }

    deinit {
        sdk.invalidate()
    }
}
```

## Minimal App Lifecycle

1. Request OS-level Bluetooth permissions through your app permission flow.
2. Create one SDK instance for the signed-in user/session.
3. Subscribe to typed status and hardware events.
4. Scan for the selected glasses model.
5. Connect by discovered device or default device.
6. Drive your UI from SDK status snapshots and callbacks.
7. Send display, settings, audio, camera, or maintenance commands only when the connected device supports them.
8. Stop scans, remove listeners/delegates, and call `close()` / `invalidate()` when the user signs out or disables glasses features.

## Next Steps

- See [API Reference](api-reference.md) for supported commands and events.
- See [Display Guide](display-guide.md) for display examples.
- See [Audio Guide](audio-guide.md) for microphone and local transcription flows.
- See [Hardware Integration Notes](hardware-integration.md) for model capability guidance.
- See [Troubleshooting](troubleshooting.md) if native build or pairing fails.
