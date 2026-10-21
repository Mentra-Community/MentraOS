# Troubleshooting

## Android Dependency Resolution Fails

- Confirm your app has the required Maven repositories configured, including `mavenCentral()` and `maven("https://www.jitpack.io")`.
- Confirm `com.mentraglass:bluetooth-sdk:<version>` matches the version in your release notes.
- If you are testing an unreleased SDK, publish the SDK and companion artifacts to `mavenLocal()` and include `mavenLocal()` in the example app repositories.

## Android Build Fails On Native Libraries

- Confirm Android min SDK is at least `28`.
- Confirm Java 17 is used by Gradle.
- Confirm your app includes `pickFirsts += "**/libonnxruntime.so"` under `android.packaging.jniLibs`.
- Confirm no app-level packaging rule excludes `libc++_shared.so`, ONNX runtime, or SDK native libraries.
- Clean only the example build output first. Do not delete SDK source artifacts unless you are intentionally resetting your workspace.

## iOS Swift Package Resolution Fails

Check that your iOS deployment target is at least `15.1`, that the package URL is `https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git`, and that Xcode resolves version `0.1.20` or newer. If Xcode has stale package state, reset package caches and resolve packages again from Xcode.

If your app also uses Firebase with static frameworks, Firebase modular header configuration belongs in your app, not in the Bluetooth SDK.

## iOS Device Build Fails With Provisioning Profile Or App ID Errors

Symptoms when building an example app to a physical iPhone with automatic signing:

- `Provisioning Profile "iOS Team Provisioning Profile: *" does not support the Access Wi-Fi Information capability` (and the same for Hotspot).
- `Provisioning profile "iOS Team Provisioning Profile: *" doesn't include the com.apple.developer.networking.HotspotConfiguration, and com.apple.developer.networking.wifi-info entitlements`.
- Registering the App ID manually in the Apple Developer portal fails with `An App ID with Identifier '...' is not available`.

Cause:

The committed bundle identifiers (`com.mentra.bluetoothsdk.example.reactnative` and `com.mentra.bluetoothsdk.example.ios`) are registered to Mentra's Apple Developer team. Apple App IDs are globally unique, so no other team can register them. The example needs Wi-Fi entitlements that a wildcard profile cannot carry, so Xcode must register an explicit App ID under your team, and that step fails. This is not a local provisioning problem, and a fully enrolled paid membership does not change it. Simulator builds are unaffected because they are not signed.

Fix:

- React Native / Expo example: set `MENTRA_IOS_BUNDLE_ID` to your own reverse-DNS identifier and regenerate the native project:

  ```bash
  cd examples/react-native
  MENTRA_IOS_BUNDLE_ID=com.yourname.mentrasdkrn bunx expo prebuild --clean --platform ios
  bunx expo run:ios --device
  ```

- Native iOS example: open `examples/ios/MentraExample.xcodeproj` in Xcode, select the `MentraExample` target, and change the Bundle Identifier under **Signing & Capabilities** before selecting your team.

If the error also lists a Push Notifications capability, that entitlement is not part of the examples. Remove the capability from the target in Xcode or regenerate the native project.

## React Native Native Module Is Missing

- Confirm you are running a development build or production native build. Expo Go cannot load `@mentra/bluetooth-sdk`.
- Run `bunx expo prebuild` after adding the SDK plugin to `app.json`.
- Confirm `@mentra/bluetooth-sdk` is installed in the app that is being prebuilt.
- On iOS, rerun `bunx expo run:ios` after changing native module dependencies.
- If you are testing a local SDK package, symlink
  `node_modules/@mentra/bluetooth-sdk` to the local source checkout and set
  `MENTRA_BLUETOOTH_SDK_PACKAGE_PATH` to that same path. The symlink is for Expo
  native autolinking; the environment variable is for Metro JavaScript
  resolution.

## Bluetooth Permission Problems

- Android 12+ requires runtime Bluetooth scan/connect permissions.
- Android scanning may require location permission or location services depending on OS version and device policy.
- On some Android 12+ devices, scans can start successfully but return zero callbacks until `ACCESS_FINE_LOCATION` is granted.
- iOS requires `NSBluetoothAlwaysUsageDescription`.
- Microphone/audio features require `RECORD_AUDIO` on Android and `NSMicrophoneUsageDescription` on iOS.

## No Devices Found

- Confirm the glasses are charged and in pairing mode.
- Confirm OS Bluetooth permissions are granted.
- On Android, confirm location permission is granted and device Location services are enabled.
- Confirm the selected `DeviceModel` matches the target glasses family.
- Stop and restart scanning from the UI instead of scanning indefinitely.
- Try pairing from a clean Bluetooth state after forgetting the device.

## Connected But No Events

- Subscribe before connecting.
- In React Native, render `useMentraBluetooth()` state for connection, battery, Wi-Fi, hotspot, scan, and SDK state. In native Android/iOS apps, log the native status snapshots.
- Confirm the hardware feature is available on the connected model.
- Watch SDK log callbacks for native diagnostics.

## Mentra Live Glasses Stuck "Not Ready"

Symptoms:

- Connect succeeds but commands fail with "not ready yet" or similar.
- Native logs show impossible K900 lengths (for example `Extracted length=9472`) during boot.
- `glasses_ready` never arrives after pairing.

Common cause:

- **SDK/firmware endian mismatch** on the UART path between the phone-side ASG client and BES firmware when using an older SDK against newer glasses stacks (or vice versa) without negotiated `wire_caps`.

Fix:

1. Upgrade to Mentra Bluetooth SDK `0.1.20` or newer, which includes BLE wire v2 and K900 endian negotiation.
2. Update glasses firmware through the normal Mentra Live OTA path when available.
3. If testing unreleased SDK source, symlink `mobile/modules/bluetooth-sdk` from MentraOS and rebuild the native app (see [Getting Started](getting-started.md) local override section).
4. Power-cycle glasses and forget/re-pair after upgrading either side.

No app-level framing changes are required; negotiation is internal to the SDK. See [Mentra Live BLE Wire Protocol Notes](mentra-live-ble-wire-protocol.md) for background.

## Local Stream Preview Does Not Show Video

- Confirm the local demo cloud or MediaMTX helper is still running.
- Use the printed LAN URL, not `localhost`, in the example app's RTMP or WebRTC field.
- Confirm the glasses, phone, and computer are on a network where local device-to-device traffic is allowed.
- Confirm Mentra Live is connected to Wi-Fi before starting the stream.
- For RTMP, the native iOS example embeds the derived HLS preview URL while live. You can also open or refresh the printed HLS preview URL on your computer after tapping **Start stream**.
- If Docker is running in bridge mode, confirm UDP ports `8890` and `8189` are published.
- If the helper picked the wrong network interface, restart it with `python3 examples/local-demo-cloud/server.py --host-ip <computer-lan-ip>`.

## React Native Or Expo Apps

React Native and Expo apps use the `@mentra/bluetooth-sdk` package and must run as development builds or production native builds. Expo Go cannot load the native SDK. Start from `examples/react-native` for Expo, `examples/android` for bare Android, or `examples/ios` for bare iOS.

If Android prebuild succeeds but native linking fails, confirm the generated project includes `:lc3Lib` in `android/settings.gradle`. The SDK plugin adds this module automatically during prebuild.

If iOS builds fail with missing Expo adapter symbols, rerun `bunx expo prebuild` so the SDK plugin can refresh native Expo module registration.
