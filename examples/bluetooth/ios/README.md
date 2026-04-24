# Bare iOS Example

This example is a minimal native iOS SwiftUI app that calls the `MentraBluetoothSDK` API directly.

It is intentionally not a React Native or Expo app. It demonstrates scanning, connecting, receiving delegate events, displaying text, applying a simple setting, and invalidating the SDK.

## Configure SDK Version

Set the SDK version when installing pods:

```sh
MENTRA_BLUETOOTH_SDK_VERSION=<version supplied by Mentra> pod install
```

If your partner release uses a private CocoaPods spec repo, add the source supplied by Mentra at the top of `Podfile`.

## Run

```sh
cd examples/ios
pod install
open MentraBareIosExample.xcworkspace
```

Run on a physical iPhone with Bluetooth enabled. The iOS simulator is useful for UI work, but Bluetooth glasses pairing requires hardware.

## Files

- `MentraBareIosExample/BluetoothViewModel.swift`: native SDK usage
- `MentraBareIosExample/ContentView.swift`: minimal SwiftUI controls
- `MentraBareIosExample/Info.plist`: Bluetooth and microphone permission copy
- `Podfile`: dependency on `MentraBluetoothSDK`
