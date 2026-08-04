# Crust

Crust is MentraOS's catch-all native module on the mobile side — the place where features land when they need to call platform APIs that React Native or Expo doesn't expose directly.

## What it is

A single Expo native module (`mobile/modules/crust/`) with parallel iOS (Swift) and Android (Kotlin) implementations. JS imports `crust` and calls into it through Expo's `AsyncFunction` and event bridges; the native side owns the lifecycle of whatever platform thing it's wrapping (sensors, system services, SDKs).

The shared entry points are [CrustModule.swift](../../../modules/crust/ios/CrustModule.swift) and [CrustModule.kt](../../../modules/crust/android/src/main/java/com/mentra/crust/CrustModule.kt). Each declares the JS-facing functions and events; the actual work is delegated to topic-specific managers (`NavigationManager`, `HeadingManager`, etc.) so the module file stays a thin dispatcher.

## What it is meant to be

- **The bridge for platform features the rest of the app can't reach** — Google Navigation SDK, magnetic compass, OS settings deep links, installed-apps enumeration, notification listener permission, photo gallery operations, AVRoutePicker, and so on.
- **iOS/Android symmetric** — every feature should ship on both platforms with matching event names and payload shapes. The Swift files comment "Mirrors Android's …" and vice versa; that parity is a real constraint, not aspirational.
- **Thin and dispatch-only at the module layer** — `CrustModule.{swift,kt}` should stay small. Real logic lives in feature-scoped managers under `ios/<feature>/` and `android/.../crust/<feature>/`.
- **Lifecycle-correct** — every `start*` has a matching `stop*` that fully tears down listeners, timers, and cached state. Singletons (`Manager.shared`) are the norm.

## What it is *not*

- Not a place for app-level UI or business logic — that belongs in `mobile/src/`.
- Not a general-purpose utility dump — features go here only when they need native code. If it can be done in TS, it should be.

## Current feature areas

- **Navigation** — see [Navigation.md](Navigation.md).
- **Heading** — see [Heading.md](Heading.md).
- **OS settings & permissions** — `openLocationSettings`, `openAppSettings`, `openBluetoothSettings`, `openNotificationListenerSettings`, `hasNotificationListenerPermission`.
- **Installed apps / notifications** — `getInstalledApps`, `getInstalledAppsForNotifications`, `setNotificationConfig`, plus `phone_notification` / `phone_notification_dismissed` events.
- **Media** — `processGalleryImage`, `mergeHdrBrackets`, `stabilizeVideo`, `saveToGalleryWithDate`.
- **AV routing** — `showAVRoutePicker` (iOS AirPlay/output picker).
- **Build flags** — `isBetaBuild`.

## Adding a new feature

1. Pick a feature folder name; create `ios/<feature>/` and `android/src/main/java/com/mentra/crust/<feature>/`.
2. Write a `FeatureManager` on each side (singleton, main-thread-safe, with explicit `start`/`stop`).
3. Add `AsyncFunction`s and `Events(...)` entries to `CrustModule.swift` and `CrustModule.kt` that delegate to the manager — keep the module file thin.
4. Keep event names and payload shapes identical across platforms.
5. Add a doc page next to this README under `mobile/docs/module/crust/`.

## Files

- Module entry points: [CrustModule.swift](../../../modules/crust/ios/CrustModule.swift), [CrustModule.kt](../../../modules/crust/android/src/main/java/com/mentra/crust/CrustModule.kt)
- Per-feature docs: [Navigation.md](Navigation.md), [Heading.md](Heading.md)
