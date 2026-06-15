# Example OEM App

A minimal Expo app that demonstrates the two Mentra device-side SDKs an OEM
integrator would consume:

- **`@mentra/island`** — the on-device miniapp registry and runtime. The demo
  shows starting/stopping miniapps, listing the running set, stopping all, and
  refreshing the app registry.
- **`@mentra/bluetooth-sdk`** — direct Bluetooth communication with the glasses
  (scan, connect, display, camera, mic, WiFi/hotspot, firmware/OTA). The demo
  wires most public `BluetoothSdk` methods to buttons, plus the
  `useBluetoothStatus` hook for live connection state.

Every button routes through an on-screen console (bottom of the screen) so you
can see each call's result or error without a Metro terminal attached.

## Layout

| File | Purpose |
| --- | --- |
| `App.tsx` | Single screen with sectioned button groups + status + console |
| `src/ui.tsx` | `Section` / `ActionButton` / `StatusRow` presentational helpers |
| `src/useLog.ts` | Tiny in-memory console hook (`run` wraps an SDK call) |
| `app.json` | Expo config: BT plugin, permissions, build properties |
| `metro.config.js` | Watches `mobile/modules` so the SDKs resolve from the monorepo |

## Running

This app contains native code (the Bluetooth SDK), so **Expo Go cannot load it**
— you need a development build on a physical phone.

```sh
# from this directory
bun install
bunx expo prebuild
bunx expo run:ios       # or: bunx expo run:android
```

The SDK packages are consumed straight from the monorepo
(`mobile/modules/bluetooth-sdk`, `mobile/modules/island`). If you edit the island
source, rebuild it first — it resolves to its `build/` output, not `src/`:

```sh
cd ../../mobile/modules/island && bun run build
```

## Notes

- The miniapp **Start** button launches the first registered app. In a real OEM
  integration you configure the island host (`configureIsland`, `configureRuntime`)
  and install miniapps; this demo simply drives whatever the registry already holds.
- Some calls (display, camera, mic, OTA) require connected Mentra Live glasses and
  will surface a descriptive error in the console when no device is connected.
