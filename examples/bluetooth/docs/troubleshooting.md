# Troubleshooting

## Android Dependency Resolution Fails

- Confirm your app has the Mentra Maven repository supplied for your partner program.
- Confirm `com.mentra:bluetooth-sdk:<version>` matches the version in your release notes.
- Confirm your Gradle credentials are available through `gradle.properties`, environment variables, or your CI secret store.
- If you are testing an unreleased SDK, publish the SDK and companion artifacts to `mavenLocal()` and include `mavenLocal()` in the example app repositories.

## Android Build Fails On Native Libraries

- Confirm Android min SDK is at least `24`.
- Confirm Java 17 is used by Gradle.
- Confirm no app-level packaging rule excludes `libc++_shared.so`, ONNX runtime, or SDK native libraries.
- Clean only the example build output first. Do not delete SDK source artifacts unless you are intentionally resetting your workspace.

## iOS Pod Install Fails

Run:

```sh
pod repo update
pod install --repo-update
```

Check that your iOS deployment target is at least `15.1` and that your Podfile includes the Mentra pod source supplied for your partner program.

If your app also uses Firebase with static frameworks, Firebase modular header configuration belongs in your app, not in the Bluetooth SDK.

## Bluetooth Permission Problems

- Android 12+ requires runtime Bluetooth scan/connect permissions.
- Android scanning may require location permission or location services depending on OS version and device policy.
- iOS requires `NSBluetoothAlwaysUsageDescription`.
- Microphone/audio features require `RECORD_AUDIO` on Android and `NSMicrophoneUsageDescription` on iOS.

## No Devices Found

- Confirm the glasses are charged and in pairing mode.
- Confirm OS Bluetooth permissions are granted.
- Confirm the selected `MentraDeviceModel` matches the target glasses family.
- Stop and restart scanning from the UI instead of scanning indefinitely.
- Try pairing from a clean Bluetooth state after forgetting the device.

## Connected But No Events

- Subscribe before connecting.
- Log `getGlassesStatus()` / `glassesStatus` and `getBluetoothStatus()` / `bluetoothStatus` after connection.
- Confirm the hardware feature is available on the connected model.
- Watch SDK log callbacks for native diagnostics.

## React Native Or Expo Apps

React Native and Expo integrations are available only for partners who have explicit access to that integration path. If you are integrating the SDK into React Native, use the React Native package and development builds. For native apps, start with the Android and iOS examples in this repo.
