# Native macOS Example

An AppKit app using the same `MentraBluetoothSDK` Swift package as the iOS
example. Requires macOS 13+, Xcode/Swift 5.9+, and Bluetooth hardware.

This is a native Mac application, not the iOS TestFlight app running on Apple
silicon. It demonstrates scan/connect/disconnect, photo upload with preview, and
OTA availability checking. The complete update UI remains in the phone example.

## Run

Native macOS support is new on MentraOS `dev`. Until the SDK with that support
is released, build against the matching SDK source:

```bash
cd examples/macos
export MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/absolute/path/to/MentraOS/mobile/modules/bluetooth-sdk
bash run.sh
```

Once a supporting SDK is published and synchronized into this example, omit the
environment variable to use the exact SwiftPM version in `Package.swift`.
Use `bash run.sh --build-only` to build without launching.

The script creates `build/Mentra SDK Mac.app` and ad-hoc signs it with the
sandbox entitlements. Launch the app bundle, not `.build/debug/MentraMacExample`,
so macOS reads the Bluetooth and microphone usage descriptions.

## Photos

Enter a webhook that returns `photoUrl` in its successful upload response. The
example displays that URL after the request completes. A webhook without a
preview URL still receives the photo, but cannot supply an image preview.
The repository's `examples/photo-webhook-server` is suitable for local testing.
Keep glasses and Mac on a network that can reach the server.

## Integration Notes

- The Swift connection and command API is unchanged from iOS; own the SDK on
  the main actor and invalidate it when the session ends.
- `Info.plist` contains Bluetooth, microphone, and local-network usage text.
  `MentraMacExample.entitlements` enables sandbox Bluetooth, audio input, and
  outbound networking. Add `com.apple.security.network.server` to a host that
  also starts an SDK local receiver or OTA server.
- Request microphone access in your app before enabling Mac microphone input.
  The SDK checks authorization and does not open a permission dialog itself.
- There is no `AVAudioSession` on macOS. Select Bluetooth output in System
  Settings; the SDK does not change the global audio route.
- Source builds have no released OTA manifest pin. An explicit developer
  manifest override is required for source-built OTA tests.
- Mac sleep may interrupt BLE. Use the usual SDK reconnect lifecycle after wake.
- Optional local STT/TTS and iOS-only glasses integrations are not included.

These source examples are not signed/notarized Mac release artifacts. The
coordinated version sync updates their SDK dependencies, but does not publish a
Mac app to TestFlight or a download channel.

## Pull Request CI

The `Native macOS example` job builds the AppKit app without launching it.
Until the macOS-capable SDK is published, CI uses the exact MentraOS commit in
`MACOS_SDK_SOURCE_REF` in `.github/workflows/example-app-builds.yml`, not a moving
branch. Remove that temporary source checkout and override once this example
pins a published SDK containing native macOS support.
