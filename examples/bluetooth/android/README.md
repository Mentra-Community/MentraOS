# Android Example

Native Android reference app for the Mentra Bluetooth SDK, built with Kotlin and Jetpack Compose.

The app depends on the SDK as `com.mentraglass:bluetooth-sdk`. In MentraOS,
Gradle builds that dependency from the SDK source in
`mobile/modules/bluetooth-sdk/android` (see [SDK Source](#sdk-source)). The
standalone Starter Kit pins the published Maven Central version instead.

## Requirements

- Android Studio Hedgehog or newer, or Gradle from the command line.
- Java 17.
- Android SDK with API 35+ installed, and NDK `27.1.12297006` (the SDK's
  `lc3Lib` and the example's WebRTC receiver build native code).
- A physical Android phone for Bluetooth, camera, microphone, direct phone photo, and direct phone WebRTC testing.
- Mentra smart glasses with Bluetooth enabled.

## SDK Source

[`settings.gradle.kts`](./settings.gradle.kts) includes the SDK as a Gradle
composite build and substitutes the app's `com.mentraglass:bluetooth-sdk`
dependency with it:

```kotlin
includeBuild("../../../mobile/modules/bluetooth-sdk/android") {
    dependencySubstitution {
        substitute(module("com.mentraglass:bluetooth-sdk")).using(project(":"))
    }
}
```

SDK source changes are picked up by the next build; there is nothing to publish
or copy. The included build uses the Android Gradle Plugin version declared in
this app's root `build.gradle.kts`. To use a published SDK instead, remove the
`includeBuild` block and add a version to the dependency in
`app/build.gradle.kts`, for example
`com.mentraglass:bluetooth-sdk:<version>`.

## Run

### Foreground Service Lifetime

The host manifest excludes `dataSync` from the SDK service and removes its
typed permission. SDK `3.2.0-dev.200` or newer honors this override and starts
with `connectedDevice`, using the existing `CHANGE_WIFI_STATE` permission
before Bluetooth runtime permission is granted. Microphone, location and media
playback types remain available under their existing permission checks.

This removes the Android 15 data-sync six-hour timeout path; it does not prove
the cause of a historical background crash or prevent other Android service
restrictions. Rebuild and install the native APK for this change to take effect.
Before release, test a fresh install with permissions denied, granted-permission
background sessions, reconnect, and service restart on Android 15+.

CI checks the merged manifest, including the SDK's declarations:

```bash
python3 scripts/check-foreground-service.py app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml
```

### Android Studio

1. Open this `android` folder in Android Studio.
2. Let Gradle sync and install any missing Android SDK packages.
3. Select a physical Android phone.
4. Run the `app` configuration.

### Command Line

```bash
cd android
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

The Camera tab disables FOV/ROI controls while `setCameraFov` is in flight,
then re-enables them only after the glasses report that the hardware setting was
applied or the SDK returns an error.

## App Walkthrough

The example has five tabs:

- **Device**: scan for Mentra Live glasses, connect, disconnect, reconnect to the saved/default device, inspect battery, firmware, Wi-Fi, RSSI, and discovered-device state, and explicitly check/start OTA updates once the glasses are connected to Wi-Fi.
- **Camera**: request photo upload to the local demo cloud or directly to this phone, record and upload videos to the media webhook, tune manual exposure and ISO, enable **Scan Mode** for document/barcode capture presets (max resolution, AE divisor, ISO cap, edge/MFNR off), then preview received media.
- **Stream**: start RTMP, SRT, or WebRTC streams with SDK-managed keep-alives and preview HLS/WebRTC output. WebRTC can be received directly on the phone through the app-hosted GStreamer WHIP receiver.
- **System**: scan/connect/forget Wi-Fi, toggle hotspot, change gallery mode, receive microphone PCM, and send RGB LED controls.
- **Console**: watch button, touch, swipe, BLE, TX, STORE, hotspot, stream, photo, video upload, microphone, and SDK diagnostic events.

## Local Media And Streaming Helper

From the Starter Kit root:

```bash
python3 local-demo-cloud/server.py
```

Paste the printed LAN `/upload` URL into the Camera screen. Paste the printed RTMP, SRT, or WHIP publish URL into the Stream screen. If Docker is not installed or not running, the helper still starts the media webhook and skips streaming with a warning.

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
- `settings.gradle.kts`: Maven repositories and the SDK source composite build.
