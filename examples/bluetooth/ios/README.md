# iOS Example

Native iOS reference app for the Mentra Bluetooth SDK, built with SwiftUI and CocoaPods.

This example installs the SDK as the `MentraBluetoothSDK` CocoaPod and is intended to run from a fresh clone once the Mentra pod is available. No path to a local MentraOS checkout is required for normal SDK use.

## Requirements

- macOS with Xcode 15 or newer.
- CocoaPods.
- iOS deployment target `16.0` for this example app.
- A physical iPhone for Bluetooth, camera, microphone, direct phone photo, and direct phone WebRTC testing.
- Mentra smart glasses with Bluetooth enabled.

## SDK Version

The Podfile defaults to SDK version `0.1.5`:

```ruby
mentra_sdk_version = ENV['MENTRA_BLUETOOTH_SDK_VERSION'] || '0.1.5'
```

Use the latest SDK version published by Mentra:

```bash
MENTRA_BLUETOOTH_SDK_VERSION=<version> pod install
```

If a dedicated Mentra CocoaPods source is required, add that source to `Podfile` above `https://cdn.cocoapods.org/`.

## Run

```bash
cd examples/ios
pod install
open MentraExample.xcworkspace
```

In Xcode, select the `MentraExample` scheme and run on a physical iPhone. Simulators are useful for UI and compile checks only.

The first build downloads the official GStreamer iOS SDK if it is not already present under `~/Library/Developer/GStreamer/iPhone.sdk`. The package is checksum-verified and not committed. To use an existing install:

```bash
export GSTREAMER_ROOT_IOS=/path/to/iPhone.sdk
open MentraExample.xcworkspace
```

For production iOS apps that need BLE or microphone behavior while backgrounded or locked, see [Background Operation On iOS](../../docs/getting-started.md#background-operation-on-ios).

## Local SDK Override

Use this only when developing the SDK before a CocoaPods release is published:

```bash
cd examples/ios
export MENTRA_BLUETOOTH_SDK_LOCAL_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk/ios
pod install
```

Keep `MENTRA_BLUETOOTH_SDK_LOCAL_PATH` in your shell or CI environment, not in committed project settings.

## App Walkthrough

The example has five tabs:

- **Device**: scan for Mentra Live glasses, connect, disconnect, reconnect to the saved/default device, and inspect battery, firmware, Wi-Fi, RSSI, and discovered-device state.
- **Camera**: request photo upload to the local demo cloud or directly to this iPhone, then preview the received JPEG.
- **Stream**: start RTMP, SRT, or WebRTC streams, send 15-second keep-alives, and preview HLS/WebRTC output. WebRTC can be received directly on the iPhone through the app-hosted GStreamer WHIP receiver.
- **System**: scan/connect/forget Wi-Fi, toggle hotspot, change save-in-gallery mode, receive microphone PCM, and send RGB LED controls.
- **Console**: watch button, touch, swipe, BLE, TX, STORE, hotspot, stream, photo, microphone, and SDK diagnostic events.

## Local Photo And Streaming Helper

From the repo root:

```bash
python3 examples/local-demo-cloud/server.py
```

Paste the printed LAN `/upload` URL into the Camera screen. Paste the printed RTMP, SRT, or WHIP publish URL into the Stream screen. If Docker is not installed or not running, the helper still starts the photo webhook and skips streaming with a warning.

Do not use `localhost` in the app. The glasses, iPhone, and computer must be on a network where the glasses can reach the printed LAN address.

## Direct Phone Capture And Streaming

Direct phone photo and WebRTC require real hardware:

- Use a physical iPhone. Simulators are useful only for UI and compile checks.
- Connect Mentra Live through the SDK before capture or streaming.
- Keep the glasses Wi-Fi active.
- Keep the iPhone and glasses on a reachable local network.
- If the app cannot find an iPhone LAN IP, connect the phone to Wi-Fi or another network the glasses can reach.
- Direct phone streaming currently covers WebRTC. RTMP and SRT use the local demo cloud flow.

## Key Files

- `MentraExample/BluetoothViewModel.swift`: SDK integration and screen state.
- `MentraExample/DeviceScreen.swift`, `CameraScreen.swift`, `StreamScreen.swift`, `SystemScreen.swift`, `ConsoleScreen.swift`: SwiftUI screens for the five tabs.
- `MentraExample/LocalPhotoUploadServer.swift`: direct phone HTTP photo upload receiver.
- `MentraExample/GStreamerWhipReceiver.*`, `WhipHeaderProxy.swift`, `gst_ios_init.*`: direct phone WebRTC receiver.
- `MentraExample/Theme.swift`: shared colors, cards, status/header pieces.
- `Podfile`: CocoaPods SDK integration.
- `project.yml`: optional XcodeGen spec for regenerating the project.
