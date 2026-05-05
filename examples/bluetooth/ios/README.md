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
default sibling checkout path `../MentraOS/mobile/modules/bluetooth-sdk/ios`.

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

For local photo preview and RTMP/WebRTC testing, run the local demo cloud from the
repo root:

```bash
python3 examples/local-demo-cloud/server.py
```

Paste the printed LAN `/upload` URL into the Camera screen. Paste the printed
RTMP publish URL into the Stream screen's RTMP field, or the printed WHIP URL
into the WebRTC field. If Docker is not installed or not running, the command
still starts the photo webhook and skips streaming with a
warning.

The Stream screen embeds the derived RTMP/HLS preview and WebRTC preview while
the stream is live. You can also open the printed HLS or WebRTC browser preview
URL on your computer.
See [`examples/local-demo-cloud`](../local-demo-cloud/README.md) for details.

## Files

- `MentraExample/BluetoothViewModel.swift` — SDK integration and screen state.
- `MentraExample/RootView.swift` — tab container.
- `MentraExample/DeviceScreen.swift`, `CameraScreen.swift`, `StreamScreen.swift`, `SystemScreen.swift`, `ConsoleScreen.swift` — one SwiftUI screen per tab.
- `MentraExample/Theme.swift` — shared colors, glass cards, status/header pieces.
- `Podfile` — local SDK pod integration.
- `project.yml` — optional XcodeGen spec for regenerating the project.
