# Android Example

Native Android reference app for the Mentra Bluetooth SDK, built with Kotlin and Jetpack Compose.

This example installs the SDK as `com.mentra:bluetooth-sdk` and is intended to run from a fresh clone once the Mentra Maven package is available. No path to a local MentraOS checkout is required for normal SDK use.

## Requirements

- Android Studio Hedgehog or newer, or Gradle from the command line.
- Java 17.
- Android SDK with API 35+ installed.
- A physical Android phone for Bluetooth, camera, microphone, direct phone photo, and direct phone WebRTC testing.
- Mentra smart glasses with Bluetooth enabled.

## SDK Version

The example reads the SDK version from `gradle.properties`:

```properties
mentraSdkVersion=0.1.6
```

Use the latest SDK version published by Mentra. If a future release note lists an additional Maven repository, add it to `settings.gradle.kts` beside `google()` and `mavenCentral()`.

## Run

### Android Studio

1. Open this `examples/android` folder in Android Studio.
2. Let Gradle sync and install any missing Android SDK packages.
3. Select a physical Android phone.
4. Run the `app` configuration.

### Command Line

```bash
cd examples/android
./gradlew installDebug
```

The first build downloads the official GStreamer Android SDK when it is not already present under `.gstreamer/Android.sdk`. The archive is checksum-verified and not committed. To use an existing install, set one of:

```bash
export GSTREAMER_ROOT_ANDROID=/path/to/Android.sdk
./gradlew installDebug
```

```bash
./gradlew installDebug -PgstreamerRootAndroid=/path/to/Android.sdk
```

## Local SDK Override

Use this only when developing the SDK before a Maven release is published:

```bash
cd /path/to/MentraOS/mobile/android
./gradlew :lc3Lib:publishToMavenLocal :mentra-bluetooth-sdk:publishToMavenLocal

cd /path/to/mentra-bluetooth-sdk-starter-kit/examples/android
./gradlew installDebug
```

`settings.gradle.kts` already includes `mavenLocal()` so the local artifact overrides the published version when the version numbers match.

## App Walkthrough

The example has five tabs:

- **Device**: scan for Mentra Live glasses, connect, disconnect, reconnect to the saved/default device, and inspect battery, firmware, Wi-Fi, RSSI, and discovered-device state.
- **Camera**: request photo upload to the local demo cloud or directly to this phone, then preview the received JPEG.
- **Stream**: start RTMP, SRT, or WebRTC streams, send 15-second keep-alives, and preview HLS/WebRTC output. WebRTC can be received directly on the phone through the app-hosted GStreamer WHIP receiver.
- **System**: scan/connect/forget Wi-Fi, toggle hotspot, change gallery mode, receive microphone PCM, and send RGB LED controls.
- **Console**: watch button, touch, swipe, BLE, TX, STORE, hotspot, stream, photo, microphone, and SDK diagnostic events.

## Local Photo And Streaming Helper

From the repo root:

```bash
python3 examples/local-demo-cloud/server.py
```

Paste the printed LAN `/upload` URL into the Camera screen. Paste the printed RTMP, SRT, or WHIP publish URL into the Stream screen. If Docker is not installed or not running, the helper still starts the photo webhook and skips streaming with a warning.

Do not use `localhost` in the app. The glasses, phone, and computer must be on a network where the glasses can reach the printed LAN address.

## Direct Phone Capture And Streaming

Direct phone photo and WebRTC require real hardware:

- Use a physical Android phone. The direct WebRTC native bridge is built for `arm64-v8a`.
- Connect Mentra Live through the SDK before capture or streaming.
- Keep the glasses Wi-Fi active.
- Keep the phone and glasses on a reachable local network.
- If the app cannot find a phone LAN IP, connect the phone to Wi-Fi or another network the glasses can reach.

## Useful Logs

```bash
adb -s <phone-serial> logcat -v threadtime | rg -i "Mentra|GStreamer|GST|WHIP|webrtc|photo|upload|SDK|error"
adb -s <glasses-serial> logcat -v threadtime | rg -i "WhipStreamingService|WHIP|stream_status|PeerConnection|photo|upload|error"
```

## Key Files

- `app/src/main/java/com/mentra/examples/android/MentraExampleController.kt`: SDK integration and screen state.
- `app/src/main/java/com/mentra/examples/android/MainActivity.kt`: entry point and permission prompts.
- `app/src/main/java/com/mentra/examples/android/screens/`: Compose screens for the five tabs.
- `app/src/main/java/com/mentra/examples/android/media/`: direct phone photo and WebRTC receivers.
- `app/build.gradle.kts`: SDK, Compose, Media3, Coil, GStreamer, and coroutine dependencies.
- `settings.gradle.kts`: Maven repositories, including `mavenLocal()` for SDK development.
