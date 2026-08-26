# React Native / Expo Example

Expo development-build reference app for the Mentra Bluetooth SDK.

This example installs `@mentra/bluetooth-sdk` and `@mentra/engine`. App code imports the SDK through the curated `@mentra/engine/bluetooth-sdk` entry points, which omit the SDK's debug and devtools-only namespaces. The direct SDK dependency supplies its Expo config plugin and native modules. The example demonstrates the same Device, Camera, Stream, System, and Console flows as the native Android and iOS examples. Its full-page Mentra Live update UI is intentionally app-owned and uses `useMentraLiveOta`; Mentra Engine still owns the complete OTA coordinator underneath it.

Expo Go cannot load the SDK because the package contains native Android and iOS code. Use `bunx expo run:ios`, `bun run android:dev`, EAS development builds, or production native builds.

## Requirements

- Node.js 20+.
- Xcode 15+ for iOS builds.
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
"@mentra/bluetooth-sdk": "3.1.0-dev.27",
"@mentra/engine": "3.1.0-dev.27"
```

Use compatible SDK and Engine versions published by Mentra. When validating
unreleased SDK changes, use the local source override below so JavaScript,
Android, and iOS all resolve the same local package.

## Run On iOS

```bash
cd examples/react-native
bun run ios:setup
bunx expo prebuild
bunx expo run:ios
```

Run on a physical iPhone for Bluetooth testing. Simulators are useful only for UI and compile checks.

The React Native example uses the SDK photo receiver plus local native modules for direct phone receiving:

- `@mentra/react-native-barcode-scanner` scans the latest photo preview for barcodes.
- `@mentra/engine/bluetooth-sdk/photo-receiver` starts a small phone-local photo upload server for direct JPEG uploads.
- `@mentra/react-native-video-stream-receiver` starts the phone-local WebRTC preview receiver.

Only the video stream receiver needs GStreamer. On iOS, `bun run ios:setup` downloads the GStreamer package from `gstreamer.freedesktop.org`, verifies the published SHA-256 checksum, and installs it to `~/Library/Developer/GStreamer/iPhone.sdk`. Rerun this setup command after a fresh clone or whenever the local GStreamer SDK is missing from the default location.

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

Development builds do not install glasses updates unless an OTA manifest is
supplied explicitly. Set `EXPO_PUBLIC_ASG_OTA_VERSION_URL` when you intentionally
need to exercise OTA against a development manifest:

```bash
EXPO_PUBLIC_ASG_OTA_VERSION_URL=https://example.com/pinned-version.json bun run android:dev
```

`bun run android:dev` starts Metro first, waits for `localhost:8081`, installs the development build without starting a second bundler, forwards the Android device's `localhost:8081` to your computer, and explicitly opens the Expo dev-client URL. This avoids the first-run blank launcher state where you have to manually tap the `localhost:8081` session.

Android install scripts (`bun run android`, `bun run android:dev`) **never target Mentra Live glasses** — only a USB-connected phone. If glasses and a phone are both attached, the scripts pick the phone automatically.

If multiple phones are connected, set `ANDROID_SERIAL` before running:

```bash
ANDROID_SERIAL=<phone-serial> bun run android:dev
```

Do not use `expo run:android` directly; it may install on whatever device Expo picks (including Mentra Live).

### Faster Android installs

`bun run android` defaults to the fast path:

- Builds `arm64-v8a` only (physical phones). Override with `REACT_NATIVE_ARCHITECTURES=...` if you need emulators.
- Skips the old forced `:mentra-bluetooth-sdk:clean --rerun-tasks` Gradle pass. Use `SDK_CLEAN=1` only when you need a hard refresh of the SDK module.

Local on-device STT/TTS via Sherpa-ONNX is **not** bundled in the public Android SDK (no-op stubs). Cloud transcription still works. That also avoids the ~54MB GitHub AAR download during Gradle configure.

Day-to-day iteration: prefer `bun run android:dev` after the first successful install.

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

The plugins configure the native project so Expo can register the SDK modules. The example uses `expo-build-properties` to set Android `minSdkVersion` to `33` and add native library `pickFirst` rules for `libc++_shared.so`, `libonnxruntime.so`, and `libonnxruntime4j_jni.so`.

`@mentra/engine` declares `@mentra/crust` as a peer for its full runtime, but the
`@mentra/engine/ota` entry does not use Crust. This OTA-only host excludes Crust
from Expo autolinking so it does not package the unrelated navigation and
miniapp-runtime native libraries.

For production Expo apps that need BLE or microphone behavior while iOS is backgrounded or locked, see [Background Operation On iOS](../../docs/getting-started.md#background-operation-on-ios).

## Local SDK Override

Use this when developing SDK changes before the matching package release is
published. Keep the committed dependency pinned to the published version so a
clean checkout still works, then replace the installed package folder locally
with your SDK source checkout.

```bash
cd examples/react-native
SDK_PATH="/path/to/MentraOS-dev/mobile/modules/bluetooth-sdk"

mkdir -p node_modules/@mentra
rm -rf node_modules/@mentra/bluetooth-sdk
ln -s "$SDK_PATH" node_modules/@mentra/bluetooth-sdk

export MENTRA_BLUETOOTH_SDK_PACKAGE_PATH="$SDK_PATH"
bunx expo run:ios
# or
bun run android:dev
```

The symlink makes Expo native autolinking and prebuild consume the local SDK
package. `MENTRA_BLUETOOTH_SDK_PACKAGE_PATH` makes Metro resolve JavaScript from
that same source folder. The local source package can have a different version
than the published dependency in `package.json`; the override is path-based.

Do not use `bun add --no-save` for this workflow. Because the local package is
also named `@mentra/bluetooth-sdk`, Bun can report a dependency loop when it
tries to resolve the override against the published dependency. If `bun install`
restores `node_modules` from the lockfile, recreate the symlink. To go back to
the published package, remove the symlink and run `bun install`.

## App Walkthrough

The example has five tabs:

- **Device**: scan for Mentra Live glasses, connect, disconnect, reconnect to the saved/default device, inspect battery, firmware, Wi-Fi, RSSI, and discovered-device state. Connecting Mentra Live opens the custom full-page OTA presentation in `src/ota` automatically; the Software Update action opens the same flow manually. The presentation calls only `useMentraLiveOta` actions, while Engine retains hotspot/Wi-Fi transport, APK/MTK/BES sequencing, retries, restarts, and verification. Legacy glasses without hotspot OTA support can return to the System tab for Wi-Fi setup and resume the flow afterward.
- **Camera**: request photo upload to the local demo cloud or directly to this phone, choose automatic or BLE-only photo transfer, record and upload videos to the media webhook, tune manual exposure and ISO, enable **Text Capture Mode** for glasses-side max-resolution capture and text-region cropping, preview received media, or separately scan standard photo previews for barcodes. Text capture and barcode scanning are mutually exclusive; enabling either turns the other off. Direct phone photo is provided by the SDK, while barcode scanning is implemented in a companion local native module.
- **Stream**: start RTMP, SRT, or WebRTC streams with SDK-managed keep-alives and preview HLS/WebRTC output. Android and iOS can receive WebRTC directly on the phone through the app-hosted GStreamer WHIP receiver.
- **System**: scan/connect/forget Wi-Fi, toggle hotspot, change gallery mode, receive microphone PCM, and send RGB LED controls.
- **Console**: watch button, touch, swipe, BLE, TX, STORE, hotspot, stream, photo, video upload, microphone, and SDK diagnostic events.

## Local Media And Streaming Helper

From the repo root:

```bash
python3 examples/local-demo-cloud/server.py
```

Paste the printed LAN `/upload` URL into the Camera screen. Paste the printed RTMP, SRT, or WHIP publish URL into the Stream screen. If Docker is not installed or not running, the helper still starts the media webhook and skips streaming with a warning.

You can also prefill the media upload URL when starting a development build:

```bash
EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL=http://<computer-ip>:8787/upload bunx expo run:ios
```

Do not use `localhost` in the app. The glasses, phone, and computer must be on a network where the glasses can reach the printed LAN address.

## Key Files

- `src/useBluetoothSdkExample.ts`: example-app orchestration for SDK lifecycle, event subscriptions, scan/connect, camera, stream, Wi-Fi, microphone, and LED commands.
- `src/ota/`: custom update pages driven only by the public `useMentraLiveOta` controller.
- `src/screens/`: Device, Camera, Stream, System, and Console screens.
- `src/sdkFormat.ts`: shared status/event formatting.
- `app.json`: permissions, SDK plugin, and Android native-library packaging rules.
- `metro.config.js`: package resolution for published installs and local SDK overrides.
- `modules/mentra-barcode-scanner`: local native module used by this example to scan received photo previews for barcodes.
- `modules/mentra-video-stream-receiver`: local native module used by this example for Android/iOS direct phone WebRTC preview demos.
