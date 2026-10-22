# Display Guide

The display API lets your app send glanceable, user-visible information to supported smart glasses.

Mentra Live does not have a display. Use display APIs only on display-equipped models such as G2.

## Basic Text

Android:

```kotlin
sdk.displayText(text = "Turn left in 100 ft", x = 0, y = 0, size = 24)
```

iOS:

```swift
try await sdk.displayText("Turn left in 100 ft", x: 0, y: 0, size: 24)
```

React Native:

```ts
await BluetoothSdk.displayText("Turn left in 100 ft", 0, 0, 24);
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
sdk.setDashboardPosition(height = 4, depth = 6)
sdk.setHeadUpAngle(20)
sdk.setScreenDisabled(false)
```

iOS:

```swift
try await sdk.setBrightness(60)
try await sdk.setAutoBrightness(enabled: true)
try await sdk.setDashboardPosition(height: 4, depth: 6)
try await sdk.setHeadUpAngle(20)
try await sdk.setScreenDisabled(false)
```

React Native:

```ts
await BluetoothSdk.setBrightness(60, false);
await BluetoothSdk.setAutoBrightness(true);
await BluetoothSdk.setDashboardPosition(4, 6);
await BluetoothSdk.setHeadUpAngle(20);
await BluetoothSdk.setScreenDisabled(false);
```


## Guidelines

- Keep text short. Glasses displays are glanceable, not phone screens.
- Prefer one primary message at a time.
- Avoid rapid display churn. Debounce frequent updates.
- Clear the display when information is no longer relevant.
- Handle disconnected, not-ready, and unsupported-capability states gracefully.
