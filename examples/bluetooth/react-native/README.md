# React Native Example

This example is a minimal Expo development-build app for partners who have explicit access to the React Native integration path.

Start with `examples/android` or `examples/ios` unless your partner agreement explicitly includes React Native support.

## Run

```sh
npm install
MENTRA_BLUETOOTH_SDK_INCLUDE_EXPO_ADAPTER=1 npx expo prebuild
MENTRA_BLUETOOTH_SDK_INCLUDE_EXPO_ADAPTER=1 npx expo run:ios
```

or:

```sh
npm install
MENTRA_BLUETOOTH_SDK_INCLUDE_EXPO_ADAPTER=1 npx expo prebuild
MENTRA_BLUETOOTH_SDK_INCLUDE_EXPO_ADAPTER=1 npx expo run:android
```

For local photo preview testing, run the companion webhook server from the repo
root and paste the printed LAN `/upload` URL into the app:

```sh
python3 examples/photo-webhook-server/server.py
```

You can also prefill the field when starting the Expo development build:

```sh
EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL=http://<computer-ip>:8787/upload npx expo run:ios
```

When testing from a local SDK package before the npm package is published,
install that package path and let Metro know where it lives:

```sh
npm install --no-save /path/to/local/bluetooth-sdk-package
MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/local/bluetooth-sdk-package \
  EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL=http://<computer-ip>:8787/upload \
  MENTRA_BLUETOOTH_SDK_INCLUDE_EXPO_ADAPTER=1 \
  npx expo run:ios
```

Use `npx expo run:android` instead of `npx expo run:ios` for the Android development build.

## Android Permissions

The example requests Nearby Devices, Bluetooth, camera, microphone, and fine
location permissions before scanning. Some Android 12+ devices still require
runtime location permission before they deliver BLE scan results, even when
`BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` are already granted.

If scanning starts but finds no devices, confirm that location permission is
granted for the app and that device Location services are enabled.

## What It Demonstrates

- Subscribing to glasses and Bluetooth status
- Scanning for compatible glasses
- Connecting to discovered or saved/default glasses
- Connecting to simulated glasses
- Displaying text
- Applying display settings
- Clearing the display
- Listening for button and battery events
- Requesting a Mentra Live photo upload to a local webhook server
- Polling the local server with cache-busted status requests and displaying the uploaded photo preview
