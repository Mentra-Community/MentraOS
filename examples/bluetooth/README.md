# Mentra Bluetooth SDK Starter Kit

Documentation and example apps for connecting to smart glasses directly from mobile apps over Bluetooth, powered by MentraOS. This is the supported Mentra Bluetooth SDK for mobile apps and works with MentraOS compatible glasses, including Mentra Live, Even Realities, Vuzix Z100, NIMO, and more.

The SDK is available in three first-class forms:

| Platform | Package | Example |
| --- | --- | --- |
| Android | `com.mentra:bluetooth-sdk` | [`examples/android`](examples/android/README.md) |
| iOS | `MentraBluetoothSDK` CocoaPod | [`examples/ios`](examples/ios/README.md) |
| React Native / Expo | `@mentra/bluetooth-sdk` | [`examples/react-native`](examples/react-native/README.md) |

Use the latest SDK version published by Mentra for your app. This repo can be cloned and used without any local path to the MentraOS source tree.

## Start Here

1. Read [Getting Started](docs/getting-started.md) for install, permissions, and minimal connection flows.
2. Run the example that matches your app stack:
   - [Android Kotlin / Jetpack Compose](examples/android/README.md)
   - [iOS SwiftUI](examples/ios/README.md)
   - [React Native / Expo](examples/react-native/README.md)
3. Keep [API Reference](docs/api-reference.md), [Display Guide](docs/display-guide.md), [Audio Guide](docs/audio-guide.md), and [Hardware Integration Notes](docs/hardware-integration.md) nearby while building.
4. Use [Troubleshooting](docs/troubleshooting.md) and the [Production Checklist](docs/production-checklist.md) before shipping.

## What The Examples Demonstrate

- Scanning for supported Mentra glasses, connecting, disconnecting, and reconnecting to a saved/default device.
- Reading typed glasses and Bluetooth status snapshots.
- Displaying text, clearing the display, and opening the dashboard where supported.
- Handling button, touch, swipe, head-up, battery, Wi-Fi, hotspot, stream, photo, audio, and diagnostic events.
- Controlling brightness, dashboard position, head-up angle, gallery-button behavior, button photo/video settings, RGB LED patterns, Wi-Fi, hotspot, microphone, camera, and streaming.
- Running local photo upload and RTMP/SRT/WebRTC streaming demos from a fresh clone.

## Repository Map

- `docs/getting-started.md`: package install and first connection for Android, iOS, and React Native.
- `docs/api-reference.md`: public API shape, command/event lifecycle, and cross-platform model names.
- `docs/display-guide.md`: text, dashboard, and display-related settings.
- `docs/audio-guide.md`: microphone events, LC3/PCM, local transcription, playback route, and glasses media volume.
- `docs/hardware-integration.md`: model differences and capability gating.
- `docs/production-checklist.md`: release-readiness checklist.
- `docs/troubleshooting.md`: build, permission, scan, stream, and React Native issues.
- `examples/local-demo-cloud`: recommended local helper for photo upload and stream preview.
- `examples/photo-webhook-server`: focused photo webhook server.
- `examples/local-webrtc-server`: lower-level MediaMTX helper.

## Local SDK Development

Published package installs are the normal SDK path. Local overrides are only for SDK development before a release is published:

- Android: publish `com.mentra:bluetooth-sdk` and its companion artifacts to Maven local, then build the example with `mavenLocal()` enabled.
- iOS: set `MENTRA_BLUETOOTH_SDK_LOCAL_PATH` to a local SDK checkout before `pod install`.
- React Native: install a local `@mentra/bluetooth-sdk` package path and set `MENTRA_BLUETOOTH_SDK_PACKAGE_PATH` so Metro and native builds resolve the same package.

The example READMEs document each override explicitly. Do not bake machine-specific paths into committed app config.
