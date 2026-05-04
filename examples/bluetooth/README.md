# Mentra Bluetooth SDK Partner Kit

Private documentation and partner enablement materials for the Mentra Bluetooth SDK.

This repo is for licensed partners building native mobile apps that connect directly to supported Mentra smart glasses over Bluetooth. It contains Android and iOS integration guides, API reference material, production checklists, hardware notes, and example apps.

## SDK Access

Use the SDK version, Maven repository, CocoaPods source, and release notes supplied by Mentra for your partner program.

The public SDK API exposes typed native commands and typed native events. Partner apps should integrate through those documented Android and iOS APIs.

## Start Here

1. Read [Getting Started](docs/getting-started.md).
2. Review [API Reference](docs/api-reference.md).
3. Run the [Android example](examples/android/README.md).
4. Run the [iOS example](examples/ios/README.md).
5. Use the [Production Checklist](docs/production-checklist.md) before shipping.

## What This Repo Covers

- Installing the SDK in bare Android Kotlin or Java apps
- Installing the SDK in bare iOS Swift apps
- Scanning for compatible glasses
- Connecting, disconnecting, and tracking connection state
- Displaying text and clearing the display
- Applying core hardware settings such as brightness, dashboard position, button behavior, and microphone routing
- Handling hardware events such as button presses, touch gestures, head-up state, battery, Wi-Fi, and audio events
- Using microphone, PCM, LC3, local transcription, camera, gallery, streaming, OTA, and diagnostic features where supported
- Production validation and troubleshooting

## Examples

- `examples/android`: bare Android Kotlin app using `com.mentra:bluetooth-sdk`
- `examples/ios`: bare iOS SwiftUI app using the `MentraBluetoothSDK` CocoaPod
- `examples/react-native`: optional React Native/Expo example for partners who have explicit access to that integration path
- `examples/photo-webhook-server`: local photo upload receiver for camera demos
- `examples/local-webrtc-server`: local WHIP/WHEP server for WebRTC streaming demos

## Access Model

This repository is private because it contains partner-facing implementation guidance, integration playbooks, and production support material. Do not copy these docs into public repos or public package READMEs without product approval.
