# Mentra Example — Android (Jetpack Compose)

Native Android reference app for the Mentra Bluetooth SDK. It uses the same
Device, Camera, Stream, System, and Console design as the other examples, with
each visible control wired to the SDK where the current public Android API
supports it.

## Run

### Recommended: open in Android Studio

1. Android Studio Hedgehog or newer → Open → select this `android/` folder.
2. Let Studio sync Gradle and install missing Android SDK packages.
3. Select a physical Android phone or API 35 emulator and run `app`.

### CLI alternative

If your environment already has Gradle 9.0+ or a generated Gradle wrapper:

```bash
./gradlew installDebug
```

The first build downloads the official GStreamer Android SDK if it is not
already present under `.gstreamer/Android.sdk`. The SDK archive is verified with
the upstream `.sha256sum` and is not committed. To use an existing install,
either set `GSTREAMER_ROOT_ANDROID=/path/to/Android.sdk` or pass
`-PgstreamerRootAndroid=/path/to/Android.sdk`.

For local SDK development, publish the Android SDK artifact to Maven local from
the MentraOS repo before building this example:

```bash
cd /path/to/MentraOS/mobile/android
./gradlew :lc3Lib:publishToMavenLocal :mentra-bluetooth-sdk:publishToMavenLocal
```

## What It Demonstrates

- Scanning for Mentra Live glasses, connecting, and disconnecting.
- Displaying connection, battery, firmware, Wi-Fi, RSSI, discovered-device, and event status.
- Sending display text and clearing the display when the connected glasses support a display.
- Requesting photo capture plus webhook upload with size, compression, and flash controls, then polling the local webhook server for preview.
- Requesting photo capture directly to the Android phone with the app-hosted upload receiver.
- Starting and stopping RTMP/SRT/WebRTC stream requests with 15-second keep-alive calls and embedded previews.
- Receiving WebRTC directly on the Android phone with the app-hosted GStreamer WHIP receiver.
- Requesting Wi-Fi scans, opening a password prompt for secured networks, connecting to open networks directly, forgetting the current network, and toggling hotspot state.
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
detects the phone LAN IP, starts a local HTTP upload receiver, sends the
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

- Use a physical Android phone. The direct WebRTC native bridge is built for
  `arm64-v8a`.
- Connect Mentra Live through the Bluetooth SDK before capture or streaming.
- Keep the glasses Wi-Fi active.
- Keep the phone and glasses on a reachable local network. The app binds its
  receivers to `0.0.0.0`, but sends the detected phone LAN IP to the glasses.
- If the app cannot find a phone LAN IP, connect the phone to Wi-Fi or another
  network that the glasses can reach.

Useful logs while testing:

```bash
adb -s <phone-serial> logcat -v threadtime | rg -i "Mentra|GStreamer|GST|WHIP|webrtc|photo|upload|SDK|error"
adb -s <glasses-serial> logcat -v threadtime | rg -i "WhipStreamingService|WHIP|stream_status|PeerConnection|photo|upload|error"
```

## Files

- `app/src/main/java/com/mentra/examples/android/MentraExampleController.kt` — SDK integration and screen state.
- `app/src/main/java/com/mentra/examples/android/MainActivity.kt` — entry point and permission prompts.
- `app/src/main/java/com/mentra/examples/android/screens/` — one Compose screen per tab.
- `app/src/main/java/com/mentra/examples/android/ui/` — shared theme, header, and tab components.
- `app/build.gradle.kts` — SDK, Compose, Coil, GStreamer, and coroutine dependencies.
- `app/src/main/java/com/mentra/examples/android/media/` — direct phone photo and WebRTC receivers.
