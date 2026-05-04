# Bare iOS Example

This example is a minimal native iOS SwiftUI app that calls the `MentraBluetoothSDK` API directly.

It is intentionally not a React Native or Expo app. It demonstrates scanning, connecting, receiving delegate events, showing a glasses preview card with model image, battery, Bluetooth/search state, and Wi-Fi state, displaying text, applying a simple setting, requesting photo webhook uploads, previewing uploaded photos, and invalidating the SDK.

## Configure SDK Version

Set the SDK version when installing pods:

```sh
MENTRA_BLUETOOTH_SDK_VERSION=<version supplied by Mentra> pod install
```

If your partner release uses a private CocoaPods spec repo, add the source supplied by Mentra at the top of `Podfile`.

For local validation before a release, point the example at a checked-out SDK podspec:

```sh
MENTRA_BLUETOOTH_SDK_LOCAL_PATH=/path/to/bluetooth-sdk/ios pod install
```

## Run

```sh
cd examples/ios
pod install
open MentraBareIosExample.xcworkspace
```

Run on a physical iPhone with Bluetooth enabled. The iOS simulator is useful for UI work, but Bluetooth glasses pairing requires hardware.

Before running on a physical iPhone, select your Apple development team in Xcode and change the bundle identifier if needed. The checked-in project keeps `DEVELOPMENT_TEAM` empty so this customer-facing example is not tied to Mentra's or any developer's Apple account.

## Local Photo Preview

For a local end-to-end photo upload demo, start the companion webhook server on your computer:

```sh
python3 examples/photo-webhook-server/server.py
```

Paste the printed LAN URL, for example `http://192.168.1.42:8787/upload`, into the iOS example's **Webhook Photo Preview** field. The URL shown in the empty field is only a placeholder; you must enter the URL printed by your local server. Do not use `localhost`; the Mentra Live glasses upload the photo directly to the computer.

When you tap **Take Photo + Upload**, the iOS app calls `sdk.requestPhoto(...)` with that URL. The glasses capture the photo, upload it to the server, and the iOS app polls `GET /uploads/<requestId>.json` until it can load the returned `photoUrl`.

For automated device checks, you can prefill the field at launch:

```sh
xcrun devicectl device process launch \
  --device <device-id> \
  --environment-variables '{"MENTRA_PHOTO_WEBHOOK_URL":"http://192.168.1.42:8787/upload"}' \
  com.mentra.examples.ios
```

## Files

- `MentraBareIosExample/BluetoothViewModel.swift`: native SDK usage
- `MentraBareIosExample/ContentView.swift`: minimal SwiftUI controls
- `MentraBareIosExample/Info.plist`: Bluetooth, microphone, and local-network permission copy
- `Podfile`: dependency on `MentraBluetoothSDK`
- `../photo-webhook-server/server.py`: local webhook receiver for photo upload previews
