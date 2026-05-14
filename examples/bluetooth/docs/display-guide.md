# Display Guide

The display API lets your app send glanceable, user-visible information to supported smart glasses.

## Basic Text

Android:

```kotlin
sdk.displayText(
    DisplayTextRequest(
        text = "Turn left in 100 ft",
        x = 0,
        y = 0,
        size = 24,
    )
)
```

iOS:

```swift
try await sdk.displayText(
    DisplayTextRequest(
        text: "Turn left in 100 ft",
        x: 0,
        y: 0,
        size: 24
    )
)
```

React Native:

```ts
await BluetoothSdk.displayText({
  text: "Turn left in 100 ft",
  x: 0,
  y: 0,
  size: 24,
});
```

## Clear Display

Android:

```kotlin
sdk.clearDisplay()
```

iOS:

```swift
try await sdk.clearDisplay()
```

React Native:

```ts
await BluetoothSdk.clearDisplay();
```

## Dashboard

Android:

```kotlin
sdk.showDashboard()
```

iOS:

```swift
sdk.showDashboard()
```

React Native:

```ts
await BluetoothSdk.showDashboard();
```

Dashboard support depends on the connected glasses model and firmware.

## Settings That Affect Display

Android:

```kotlin
sdk.setBrightness(60)
sdk.setAutoBrightness(true)
sdk.setDashboardPosition(DashboardPositionRequest(height = 4, depth = 6))
sdk.setHeadUpAngle(20)
sdk.setScreenDisabled(false)
```

iOS:

```swift
try await sdk.setBrightness(60)
try await sdk.setAutoBrightness(enabled: true)
try await sdk.setDashboardPosition(DashboardPositionRequest(height: 4, depth: 6))
try await sdk.setHeadUpAngle(20)
try await sdk.setScreenDisabled(false)
```

React Native currently exposes the display command path directly through `displayText`, `clearDisplay`, and `showDashboard`. For app UIs that need brightness, dashboard position, head-up angle, or screen-disable controls, confirm those controls are exported in the package version you are integrating before exposing them in production UI.


## Guidelines

- Keep text short. Glasses displays are glanceable, not phone screens.
- Prefer one primary message at a time.
- Avoid rapid display churn. Debounce frequent updates.
- Clear the display when information is no longer relevant.
- Handle disconnected, not-ready, and unsupported-capability states gracefully.
