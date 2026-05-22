# React Native / Expo Example

Expo development-build reference app for the Mentra Bluetooth SDK.

This example installs the SDK as `@mentra/bluetooth-sdk` and is intended to run from a fresh clone once the package is available. It demonstrates the same Device, Camera, Stream, System, and Console flows as the native Android and iOS examples.

Expo Go cannot load the SDK because the package contains native Android and iOS code. Use `bunx expo run:ios`, `bun run android:dev`, EAS development builds, or production native builds.

## Requirements

- Node.js 20+.
- Xcode 15+ and CocoaPods for iOS builds.
- Android Studio / Android SDK and Java 17 for Android builds.
- A physical phone for Bluetooth, camera, microphone, direct phone photo, and direct phone WebRTC testing.
- Mentra smart glasses with Bluetooth enabled.

## Install

```bash
cd examples/react-native
bun install
```

The example depends on the SDK version pinned in `package.json`, for example:

```json
"@mentra/bluetooth-sdk": "0.1.7"
```

Use the latest SDK version published by Mentra.

## Run On iOS

```bash
cd examples/react-native
bun run ios:setup
bunx expo prebuild
bunx expo run:ios
```

Run on a physical iPhone for Bluetooth testing. Simulators are useful only for UI and compile checks.

The React Native example keeps direct phone receiving split into two local native modules:

- `@mentra/react-native-photo-receiver` starts a small phone-local photo upload server for direct JPEG uploads.
- `@mentra/react-native-video-stream-receiver` starts the phone-local WebRTC preview receiver.

Only the video stream receiver needs GStreamer. On iOS, `bun run ios:setup` downloads the GStreamer package from `gstreamer.freedesktop.org`, verifies the published SHA-256 checksum, and installs it to `~/Library/Developer/GStreamer/iPhone.sdk`. The video receiver CocoaPods podspec also runs the same setup automatically during `pod install` when the SDK is missing from the default location, so `bunx expo run:ios` can recover from a fresh clone.

If your GStreamer SDK is installed somewhere else, set `GSTREAMER_ROOT_IOS` before prebuild or run:

```bash
GSTREAMER_ROOT_IOS=/path/to/iPhone.sdk bunx expo run:ios
```

## Run On Android

```bash
cd examples/react-native
bunx expo prebuild
bun run android:dev
```

Run on a physical Android phone for Bluetooth testing. Some Android devices require both Nearby Devices and Location permission before BLE scan callbacks are delivered.

`bun run android:dev` starts Metro first, waits for `localhost:8081`, installs the development build without starting a second bundler, forwards the Android device's `localhost:8081` to your computer, and explicitly opens the Expo dev-client URL. This avoids the first-run blank launcher state where you have to manually tap the `localhost:8081` session.

If multiple Android devices are connected, set `ANDROID_SERIAL` before running the command:

```bash
ANDROID_SERIAL=<device-serial> bun run android:dev
```

## SDK Plugin Configuration

The example's `app.json` already includes the Mentra SDK plugin:

```json
[
  "@mentra/bluetooth-sdk",
  {
    "node": true
  }
]
```

The plugin configures the native project so Expo can register the SDK module. The example also uses `expo-build-properties` to set Android `minSdkVersion` to `28` and add native library `pickFirst` rules for `libc++_shared.so`, `libonnxruntime.so`, and `libonnxruntime4j_jni.so`.

For production Expo apps that need BLE or microphone behavior while iOS is backgrounded or locked, see [Background Operation On iOS](../../docs/getting-started.md#background-operation-on-ios).

## Local SDK Override

Use this only when developing the SDK before a package release is published:

```bash
cd examples/react-native
bun add --no-save /path/to/MentraOS/mobile/modules/bluetooth-sdk

MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk bunx expo run:ios
# or
MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk bun run android:dev
```

`MENTRA_BLUETOOTH_SDK_PACKAGE_PATH` makes Metro and the generated native projects resolve the same local package. Keep it in your shell or CI environment, not in committed project settings.

## App Walkthrough

The example has five tabs:

- **Device**: scan for Mentra Live glasses, connect, disconnect, reconnect to the saved/default device, and inspect battery, firmware, Wi-Fi, RSSI, and discovered-device state.
- **Camera**: request photo upload to the local demo cloud or directly to this phone, then preview the received JPEG. Direct phone photo is implemented in the companion local native module.
- **Stream**: start RTMP, SRT, or WebRTC streams, send 15-second keep-alives, and preview HLS/WebRTC output. Android and iOS can receive WebRTC directly on the phone through the app-hosted GStreamer WHIP receiver.
- **System**: scan/connect/forget Wi-Fi, toggle hotspot, change gallery mode, receive microphone PCM, and send RGB LED controls.
- **Console**: watch button, touch, swipe, BLE, TX, STORE, hotspot, stream, photo, microphone, and SDK diagnostic events.

## Local Photo And Streaming Helper

From the repo root:

```bash
python3 examples/local-demo-cloud/server.py
```

Paste the printed LAN `/upload` URL into the Camera screen. Paste the printed RTMP, SRT, or WHIP publish URL into the Stream screen. If Docker is not installed or not running, the helper still starts the photo webhook and skips streaming with a warning.

You can also prefill the photo webhook URL when starting a development build:

```bash
EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL=http://<computer-ip>:8787/upload bunx expo run:ios
```

Do not use `localhost` in the app. The glasses, phone, and computer must be on a network where the glasses can reach the printed LAN address.

## Key Files

- `src/useBluetoothSdkExample.ts`: example-app orchestration for SDK lifecycle, event subscriptions, scan/connect, camera, stream, Wi-Fi, microphone, and LED commands.
- `src/screens/`: Device, Camera, Stream, System, and Console screens.
- `src/sdkFormat.ts`: shared status/event formatting.
- `app.json`: permissions, SDK plugin, and Android native-library packaging rules.
- `metro.config.js`: package resolution for published installs and local SDK overrides.
- `modules/mentra-photo-receiver`: local native module used by this example for Android/iOS direct phone photo upload demos.
- `modules/mentra-video-stream-receiver`: local native module used by this example for Android/iOS direct phone WebRTC preview demos.
