# Display Guide

The display API lets your app send user-visible information to supported smart glasses.

## Basic Text

```ts
await BluetoothSdk.displayText({
  text: "Turn left in 100 ft",
  x: 0,
  y: 0,
  size: 24,
});
```

## Clear Display

```ts
await BluetoothSdk.clearDisplay();
```

## Guidelines

- Keep text short. Glasses displays are glanceable, not phone screens.
- Prefer one primary message at a time.
- Avoid rapid display churn. Debounce frequent updates.
- Clear the display when information is no longer relevant.
- Handle `glasses_not_ready` and disconnected status gracefully.

## Dashboard

```ts
await BluetoothSdk.showDashboard();
```

Dashboard support depends on the connected glasses model and firmware.
