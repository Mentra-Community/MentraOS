# Troubleshooting

## The SDK Does Not Work In Expo Go

The SDK contains native Android and iOS code. Use a development build:

```sh
npx expo run:ios
npx expo run:android
```

## iOS Pod Install Fails

Run:

```sh
cd ios
pod install --repo-update
```

Check that your iOS deployment target is at least `15.1`.

If your app also uses Firebase with static frameworks, Firebase modular header configuration belongs in your app config, not in the Bluetooth SDK plugin.

## Android Build Fails On Native Libraries

Make sure the SDK config plugin is installed and prebuild has been run. The plugin configures native packaging for SDK libraries.

```sh
npx expo prebuild
```

## No Devices Found

- Confirm the glasses are charged and in pairing mode.
- Confirm OS Bluetooth permissions are granted.
- Confirm the model name passed to `findCompatibleDevices(model)` matches the target glasses family.
- Try pairing from a clean Bluetooth state after forgetting the device.

## Connected But No Events

- Subscribe before connecting.
- Log `getGlassesStatus()` and `getBluetoothStatus()` after connection.
- Confirm the hardware feature is available on the connected model.
- Watch the `log` event for native diagnostics.
