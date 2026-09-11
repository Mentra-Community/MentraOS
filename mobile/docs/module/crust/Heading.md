# Crust: Heading

How the crust native module delivers magnetic compass degrees to JS.

## Overview

Heading exposes the device's magnetic compass as a stream of degree values. Runs on iOS and Android with parity. JS calls the module via Expo `AsyncFunction`s; the native side streams results back as `onHeading` events.

## Flow

1. JS calls `startHeading()`.
2. Native `HeadingManager` creates a `CLLocationManager` (iOS) / equivalent (Android) on the main thread, requests when-in-use auth if needed, and starts heading updates.
3. On each sensor tick, the manager emits `onHeading` with `{ degrees }` — but only when the angle changed by ≥1° from the last emission, to keep the bridge quiet.
4. JS calls `stopHeading()` — stops sensor updates and clears the callback.

## Files

### iOS

- [CrustModule.swift](../../../modules/crust/ios/CrustModule.swift) — Expo module entry point; declares `startHeading` / `stopHeading` and the `onHeading` event.
- [HeadingManager.swift](../../../modules/crust/ios/heading/HeadingManager.swift) — `CLLocationManager` wrapper, 1° emission threshold.

### Android

- [CrustModule.kt](../../../modules/crust/android/src/main/java/com/mentra/crust/CrustModule.kt) — Expo module entry point; mirror of the iOS module.
- [HeadingManager.kt](../../../modules/crust/android/src/main/java/com/mentra/crust/heading/HeadingManager.kt) — `SensorManager`-based compass, parity with `HeadingManager.swift`.
