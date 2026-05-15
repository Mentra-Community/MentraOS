# React Native / Expo Example

Expo development-build reference app for the Mentra Bluetooth SDK.

This example installs the SDK as `@mentra/bluetooth-sdk` and is intended to run from a fresh clone once the npm package is available. It demonstrates the same Device, Camera, Stream, System, and Console flows as the native Android and iOS examples.

Expo Go cannot load the SDK because the package contains native Android and iOS code. Use `npx expo run:ios`, `npm run android:dev`, EAS development builds, or production native builds.

## Requirements

- Node.js 20+.
- Xcode 15+ and CocoaPods for iOS builds.
- Android Studio / Android SDK and Java 17 for Android builds.
- A physical phone for Bluetooth, camera, microphone, direct phone photo, and direct phone WebRTC testing.
- Mentra smart glasses with Bluetooth enabled.

## Install

```bash
cd examples/react-native
npm install
```

The example depends on:

```json
"@mentra/bluetooth-sdk": "0.1.2"
```

Use the latest SDK version published by Mentra.

## Run On iOS

```bash
cd examples/react-native
npx expo prebuild
npx expo run:ios
```

Run on a physical iPhone for Bluetooth testing. Simulators are useful only for UI and compile checks.

## Run On Android

```bash
cd examples/react-native
npx expo prebuild
npm run android:dev
```

Run on a physical Android phone for Bluetooth testing. Some Android devices require both Nearby Devices and Location permission before BLE scan callbacks are delivered.

`npm run android:dev` starts Metro first, waits for `localhost:8081`, installs the development build without starting a second bundler, forwards the Android device's `localhost:8081` to your computer, and explicitly opens the Expo dev-client URL. This avoids the first-run blank launcher state where you have to manually tap the `localhost:8081` session.

If multiple Android devices are connected, set `ANDROID_SERIAL` before running the command:

```bash
ANDROID_SERIAL=<device-serial> npm run android:dev
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

## Local SDK Override

Use this only when developing the SDK before an npm release is published:

```bash
cd examples/react-native
npm install --no-save /path/to/MentraOS/mobile/modules/bluetooth-sdk

MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk npx expo run:ios
# or
MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk npm run android:dev
```

`MENTRA_BLUETOOTH_SDK_PACKAGE_PATH` makes Metro and the generated native projects resolve the same local package. Keep it in your shell or CI environment, not in committed project settings.

## App Walkthrough

The example has five tabs:

- **Device**: scan for Mentra Live glasses, connect, disconnect, reconnect to the saved/default device, and inspect battery, firmware, Wi-Fi, RSSI, and discovered-device state.
- **Camera**: request photo upload to the local demo cloud or directly to this Android phone, then preview the received JPEG. Direct phone photo is implemented in the companion local native module.
- **Stream**: start RTMP, SRT, or WebRTC streams, send 15-second keep-alives, and preview HLS/WebRTC output. Android and iOS can receive WebRTC directly on the phone through the app-hosted GStreamer WHIP receiver.
- **System**: scan/connect/forget Wi-Fi, toggle hotspot, change save-in-gallery mode, receive microphone PCM, and send RGB LED controls.
- **Console**: watch button, touch, swipe, BLE, TX, STORE, hotspot, stream, photo, microphone, and raw SDK events.

## Local Photo And Streaming Helper

From the repo root:

```bash
python3 examples/local-demo-cloud/server.py
```

Paste the printed LAN `/upload` URL into the Camera screen. Paste the printed RTMP, SRT, or WHIP publish URL into the Stream screen. If Docker is not installed or not running, the helper still starts the photo webhook and skips streaming with a warning.

You can also prefill the photo webhook URL when starting a development build:

```bash
EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL=http://<computer-ip>:8787/upload npx expo run:ios
```

Do not use `localhost` in the app. The glasses, phone, and computer must be on a network where the glasses can reach the printed LAN address.

## Key Files

- `src/useMentraSdk.ts`: SDK lifecycle, event subscriptions, scan/connect, camera, stream, Wi-Fi, microphone, and LED commands.
- `src/screens/`: Device, Camera, Stream, System, and Console screens.
- `src/sdkFormat.ts`: shared status/event formatting.
- `app.json`: permissions, SDK plugin, and Android native-library packaging rules.
- `metro.config.js`: package resolution for published installs and local SDK overrides.
- `modules/mentra-direct-receiver`: local native module used by this example for Android direct phone photo demos and Android/iOS direct phone WebRTC demos.
