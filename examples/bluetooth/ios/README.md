# Mentra Example — iOS (SwiftUI)

Native iOS reference app for the Mentra Bluetooth SDK. It uses the same Device,
Camera, Stream, System, and Console design as the other examples, with each
visible control wired to the SDK where the current public Swift API supports it.

## Run

Install pods, then open the workspace:

```bash
cd examples/ios
pod install
open MentraExample.xcworkspace
```

In Xcode, select the `MentraExample` scheme and run on a physical iPhone. The
example needs Bluetooth access for real glasses; simulators are useful only for
UI and compile checks.

For local SDK development, the `Podfile` reads
`MENTRA_BLUETOOTH_SDK_LOCAL_PATH` when present. If it is unset, it uses the
local MentraOS checkout path used by this repo while the SDK is under active
development.

```bash
export MENTRA_BLUETOOTH_SDK_LOCAL_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk/ios
pod install
```

## What It Demonstrates

- Scanning for Mentra Live glasses, connecting, and disconnecting.
- Displaying connection, battery, firmware, Wi-Fi, RSSI, discovered-device, and event status.
- Sending display text, clearing the display, and applying basic hardware settings.
- Requesting photo capture plus webhook upload, then polling the local webhook server for preview.
- Starting and stopping RTMP/SRT/WebRTC stream requests with 15-second keep-alive calls.
- Requesting Wi-Fi scans, sending selected SSIDs with an empty password, and toggling hotspot state.
- Enabling microphone PCM delivery and showing received frame and byte counts.
- Sending RGB LED mode requests.
- Showing button, touch, BLE, TX, STORE, and raw status events in the console.

For local photo preview testing, run the webhook server from the repo root and
paste the printed LAN `/upload` URL into the Camera screen:

```bash
python3 examples/photo-webhook-server/server.py
```

For local WebRTC streaming, run the MediaMTX helper from the repo root and
paste the printed WHIP URL into the Stream screen's WebRTC field:

```bash
examples/local-webrtc-server/run-mediamtx.sh
```

Open the printed browser preview URL on your computer to watch the stream. See
[`examples/local-webrtc-server`](../local-webrtc-server/README.md) for details.

## Files

- `MentraExample/BluetoothViewModel.swift` — SDK integration and screen state.
- `MentraExample/RootView.swift` — tab container.
- `MentraExample/DeviceScreen.swift`, `CameraScreen.swift`, `StreamScreen.swift`, `SystemScreen.swift`, `ConsoleScreen.swift` — one SwiftUI screen per tab.
- `MentraExample/Theme.swift` — shared colors, glass cards, status/header pieces.
- `Podfile` — local SDK pod integration.
- `project.yml` — optional XcodeGen spec for regenerating the project.
