# iOS Example

Native iOS reference app for the Mentra Bluetooth SDK, built with SwiftUI and Swift Package Manager.

This example installs the SDK as the `MentraBluetoothSDK` Swift package. No path to a local MentraOS checkout is required for normal SDK use.

## Requirements

- macOS with Xcode 15 or newer.
- iOS deployment target `16.0` for this example app.
- A physical iPhone for Bluetooth, camera, microphone, direct phone photo, and direct phone WebRTC testing.
- Mentra smart glasses with Bluetooth enabled.

## SDK Version

The Xcode project pins the public Swift package to `0.1.12`:

```text
https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git
```

Use Xcode's package dependency editor to update the version when a newer SDK is published.

When validating unreleased SDK changes from a local MentraOS checkout, replace
that package dependency with a local package pointing at:

```text
/path/to/MentraOS/mobile/modules/bluetooth-sdk
```

The camera FOV controls in this example use the new `setCameraFov` result:
they disable repeated applies while the command is in flight, then re-enable
only after the glasses report that the hardware FOV/ROI setting was applied or
the SDK throws an error.

## Run

```bash
cd examples/ios
open MentraExample.xcodeproj
```

In Xcode, select the `MentraExample` scheme and run on a physical iPhone. Simulators are useful for UI and compile checks only.

The first build downloads the official GStreamer iOS SDK if it is not already present under `~/Library/Developer/GStreamer/iPhone.sdk`. The package is checksum-verified and not committed. To use an existing install:

```bash
export GSTREAMER_ROOT_IOS=/path/to/iPhone.sdk
open MentraExample.xcodeproj
```

For production iOS apps that need BLE or microphone behavior while backgrounded or locked, see [Background Operation On iOS](../../docs/getting-started.md#background-operation-on-ios).

## App Walkthrough

The example has five tabs:

- **Device**: scan for Mentra Live glasses, connect, disconnect, reconnect to the saved/default device, inspect battery, firmware, Wi-Fi, RSSI, and discovered-device state, and explicitly check/start OTA updates once the glasses are connected to Wi-Fi.
- **Camera**: request photo upload to the local demo cloud or directly to this iPhone, record and upload videos to the media webhook, tune manual exposure and ISO, enable **Scan Mode** for document/barcode capture presets (max resolution, AE divisor, ISO cap, edge/MFNR off), then preview received media.
- **Stream**: start RTMP, SRT, or WebRTC streams with SDK-managed keep-alives and preview HLS/WebRTC output. WebRTC can be received directly on the iPhone through the app-hosted GStreamer WHIP receiver.
- **System**: scan/connect/forget Wi-Fi, toggle hotspot, change gallery mode, receive microphone PCM, and send RGB LED controls.
- **Console**: watch button, touch, swipe, BLE, TX, STORE, hotspot, stream, photo, video upload, microphone, and SDK diagnostic events.

## Local Media And Streaming Helper

From the repo root:

```bash
python3 examples/local-demo-cloud/server.py
```

Paste the printed LAN `/upload` URL into the Camera screen. Paste the printed RTMP, SRT, or WHIP publish URL into the Stream screen. If Docker is not installed or not running, the helper still starts the media webhook and skips streaming with a warning.

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
- `project.yml`: optional XcodeGen spec for regenerating the SPM-based project.
