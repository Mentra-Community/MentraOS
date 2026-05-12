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

The example installs `MentraBluetoothSDK` from CocoaPods. By default it uses SDK
version `0.1.0`; set `MENTRA_BLUETOOTH_SDK_VERSION` if your release notes
specify a different version.

The first build downloads the official GStreamer iOS SDK if it is not already
present under `~/Library/Developer/GStreamer/iPhone.sdk`. The SDK package is
verified with the upstream `.sha256sum` and is not committed. To use an
existing install, set `GSTREAMER_ROOT_IOS=/path/to/iPhone.sdk` before building.

For local SDK development before a release is published, point CocoaPods at a
local SDK checkout:

```bash
export MENTRA_BLUETOOTH_SDK_LOCAL_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk/ios
pod install
```

## What It Demonstrates

- Scanning for Mentra Live glasses, connecting, and disconnecting.
- Displaying connection, battery, firmware, Wi-Fi, RSSI, discovered-device, and event status.
- Sending display text and clearing the display when the connected glasses support a display.
- Requesting photo capture plus webhook upload with size, compression, and flash controls, then polling the local webhook server for preview.
- Requesting photo capture directly to the iPhone with the app-hosted upload receiver.
- Starting and stopping RTMP/SRT/WebRTC stream requests with 15-second keep-alive calls and embedded previews.
- Receiving WebRTC directly on the iPhone with the app-hosted GStreamer WHIP receiver.
- Requesting Wi-Fi scans, opening a password sheet for secured networks, connecting to open networks directly, forgetting the current network, and toggling hotspot state.
- Enabling microphone PCM delivery and showing received frame and byte counts.
- Sending RGB LED color and pattern requests.
- Showing button, touch, swipe, BLE, TX, STORE, hotspot, and raw status events in the console.
- Changing save-in-gallery mode, which controls whether the glasses button saves photos/videos locally or only reports button/touch events to the host app.

For local photo preview and RTMP/SRT/WebRTC testing, run the local demo cloud from the
repo root:

```bash
python3 examples/local-demo-cloud/server.py
```

Paste the printed LAN `/upload` URL into the Camera screen. Paste the printed
RTMP publish URL into the Stream screen's RTMP field, the printed SRT publish
URL into the SRT field, or the printed WHIP URL into the WebRTC field. If Docker
is not installed or not running, the command
still starts the photo webhook and skips streaming with a
warning.

The Camera screen can also send photos to **This phone**. In that mode the app
detects the iPhone LAN IP, starts a local HTTP upload receiver, sends the
generated `http://<phone-ip>:8787/upload` URL to the glasses, and previews the
received JPEG from app cache.

The Stream screen embeds the derived RTMP/SRT HLS playlist preview and WebRTC
preview while the stream is live. For WebRTC, choose **MacBook** to keep using
the local demo cloud/MediaMTX flow, or **This phone** to start the app-hosted
GStreamer WHIP receiver. The phone mode generates a
`http://<phone-ip>:8190/whip/endpoint` URL and renders decoded frames in the app.
You can also open the printed HLS or WebRTC browser preview URL on your
computer when using MacBook mode.
See [`examples/local-demo-cloud`](../local-demo-cloud/README.md) for details.

## Direct Phone Hardware Requirements

Direct phone photo and WebRTC require real hardware:

- Use a physical iPhone. Simulators are useful only for UI and compile checks.
- Connect Mentra Live through the Bluetooth SDK before capture or streaming.
- Keep the glasses Wi-Fi active.
- Keep the iPhone and glasses on a reachable local network. The app binds its
  receivers to `0.0.0.0`, but sends the detected iPhone LAN IP to the glasses.
- If the app cannot find an iPhone LAN IP, connect the phone to Wi-Fi or another
  network that the glasses can reach.
- Direct phone streaming only covers WebRTC. RTMP and SRT still use the MacBook
  local demo cloud flow.

## Files

- `MentraExample/BluetoothViewModel.swift` — SDK integration and screen state.
- `MentraExample/RootView.swift` — tab container.
- `MentraExample/DeviceScreen.swift`, `CameraScreen.swift`, `StreamScreen.swift`, `SystemScreen.swift`, `ConsoleScreen.swift` — one SwiftUI screen per tab.
- `MentraExample/LocalPhotoUploadServer.swift` — direct phone HTTP photo upload receiver.
- `MentraExample/GStreamerWhipReceiver.*`, `WhipHeaderProxy.swift`, `gst_ios_init.*` — direct phone WebRTC receiver.
- `MentraExample/Theme.swift` — shared colors, glass cards, status/header pieces.
- `Podfile` — CocoaPods SDK integration.
- `project.yml` — optional XcodeGen spec for regenerating the project.
