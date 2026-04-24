# Production Checklist

Use this checklist before shipping a partner app with the Mentra Bluetooth SDK.

## App Setup

- Bare Android and/or bare iOS native builds are configured.
- iOS deployment target is `15.1` or newer.
- Android min SDK is `24` or newer.
- Android builds use Java 17.
- Bluetooth permission copy is user-friendly and specific.
- Microphone, camera, local network, notification, and location permissions are requested only when needed.
- The app integrates through the documented typed Android or iOS SDK APIs.

## SDK Integration

- App subscribes to typed glasses and Bluetooth status callbacks.
- App handles disconnect, reconnect, scan stopped, and pair failure states.
- App does not assume every model supports every feature.
- App cleans up SDK listeners/delegates and calls `close()` / `invalidate()` when sessions end.
- App avoids sending rapid display updates without debouncing.
- App uses typed settings APIs for brightness, dashboard, button, camera, and microphone settings.
- Advanced controls are gated behind SDK capability/status checks.

## Privacy And Compliance

- Audio capture behavior is clearly disclosed.
- Camera capture behavior is clearly disclosed.
- Bluetooth and location permission copy explains device discovery.
- Cloud upload behavior is documented in the partner privacy policy.
- Logs avoid sensitive user data.

## Release Validation

- Fresh bare Android app install using the published Maven artifact.
- Fresh bare iOS app install using the published CocoaPod.
- Android sample app in this Partner Kit builds.
- iOS sample app in this Partner Kit runs `pod install` and builds.
- Fresh install test on iOS.
- Fresh install test on Android.
- Pairing test with each supported glasses model.
- Reconnect test after app restart.
- Reconnect test after Bluetooth toggle.
- Display command test.
- Core settings test for brightness, dashboard, and button behavior.
- Button/touch event test.
- Audio/transcription test if enabled.
- Camera/gallery/streaming test if enabled.
- OTA/status handling test if enabled.
