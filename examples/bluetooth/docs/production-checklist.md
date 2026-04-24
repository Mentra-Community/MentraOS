# Production Checklist

Use this checklist before shipping a partner app with the Mentra Bluetooth SDK.

## App Setup

- Native development builds are configured for iOS and Android.
- iOS deployment target is `15.1` or newer.
- Android min SDK is `28` or newer.
- Bluetooth permission copy is user-friendly and specific.
- Microphone, camera, local network, and location permissions are requested only when needed.

## SDK Integration

- App subscribes to `glasses_status` and `bluetooth_status`.
- App handles disconnect, reconnect, and pair failure states.
- App does not assume every model supports every feature.
- App removes event listeners when screens unmount or sessions end.
- App avoids sending rapid display updates without debouncing.

## Privacy And Compliance

- Audio capture behavior is clearly disclosed.
- Camera capture behavior is clearly disclosed.
- Cloud upload behavior is documented in the partner privacy policy.
- Logs avoid sensitive user data.

## Release Validation

- Fresh third-party Expo/RN consumer app install using the published package.
- Fresh third-party iOS `prebuild` and `pod install`.
- Fresh third-party Android prebuild and native build.
- Fresh install test on iOS.
- Fresh install test on Android.
- Pairing test with each supported glasses model.
- Reconnect test after app restart.
- Reconnect test after Bluetooth toggle.
- Display command test.
- Button/touch event test.
- Audio/transcription test if enabled.
- Camera/gallery/streaming test if enabled.
- OTA/status handling test if enabled.
