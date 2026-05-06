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

For local photo preview and RTMP/WebRTC testing, run the local demo cloud from the
repo root:

```sh
python3 examples/local-demo-cloud/server.py
```

Paste the printed LAN `/upload` URL into the Camera screen. Paste the printed
RTMP publish URL into the Stream screen's RTMP field, or the printed WHIP URL
into the WebRTC field. If Docker is not installed or not running, the command
still starts the photo webhook and skips streaming with a
warning.

You can also prefill the field when starting the Expo development build:

```sh
EXPO_PUBLIC_MENTRA_PHOTO_WEBHOOK_URL=http://<computer-ip>:8787/upload npx expo run:ios
```

Open the printed HLS or WebRTC browser preview URL on your computer to watch a stream.
See [`examples/local-demo-cloud`](../local-demo-cloud/README.md) for details.

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

- Showing the same Device, Camera, Stream, System, and Console design as the native examples
- Subscribing to glasses and Bluetooth status
- Scanning for compatible glasses
- Connecting to discovered or saved/default glasses
- Displaying text and clearing the display when the connected glasses support a display
- Requesting a Mentra Live photo upload to a local webhook server with size, compression, and flash controls
- Polling the local server with cache-busted status requests and displaying the uploaded photo preview
- Starting and stopping RTMP/SRT/WebRTC stream requests with 15-second keep-alive calls
- Requesting Wi-Fi scans, opening a password modal for secured networks, connecting to open networks directly, forgetting the current network, and toggling hotspot state
- Enabling microphone PCM delivery and showing received frame and byte counts
- Sending RGB LED color and pattern requests
- Showing button, touch, swipe, BLE, TX, STORE, hotspot, and raw status events in the console
- Changing save-in-gallery mode, which controls whether the glasses button saves photos/videos locally or only reports button/touch events to the host app
