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
- Starting and stopping RTMP/SRT/WebRTC stream requests with 15-second keep-alive calls and embedded previews.
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

The Stream screen embeds the derived RTMP/SRT HLS playlist preview and WebRTC
preview while the stream is live. You can also open the printed HLS or WebRTC
browser preview URL on your computer.
See [`examples/local-demo-cloud`](../local-demo-cloud/README.md) for details.

## Files

- `app/src/main/java/com/mentra/examples/android/MentraExampleController.kt` — SDK integration and screen state.
- `app/src/main/java/com/mentra/examples/android/MainActivity.kt` — entry point and permission prompts.
- `app/src/main/java/com/mentra/examples/android/screens/` — one Compose screen per tab.
- `app/src/main/java/com/mentra/examples/android/ui/` — shared theme, header, and tab components.
- `app/build.gradle.kts` — SDK, Compose, Coil, and coroutine dependencies.
