# Mentra Bluetooth SDK

SDK for communicating with Mentra smart glasses from React Native and Expo apps.

## Documentation

This package README is intentionally brief. Full partner documentation, getting started guides, production checklists, and example apps live in the private `Mentra-Bluetooth-SDK-Partner-Kit` repository for licensed partners.

## Installation

The SDK contains native code and requires a React Native or Expo development build. It does not run inside Expo Go.

```sh
npm install @mentra/bluetooth-sdk
npx expo prebuild
npx pod-install
```

## Minimal Usage

```ts
import BluetoothSdk from "@mentra/bluetooth-sdk"

const removeStatusListener = BluetoothSdk.onGlassesStatus((status) => {
  console.log("Glasses status changed", status)
})

await BluetoothSdk.startScan({model: "Mentra Live"})
const device = BluetoothSdk.getCoreStatus().searchResults[0]
if (device) {
  await BluetoothSdk.connect(device)
}
await BluetoothSdk.displayText({text: "Hello from Mentra", x: 0, y: 0, size: 24})

removeStatusListener()
```

## Default Device

`connectDefault()` connects to the default glasses target currently stored in the SDK. Apps that want this target to survive app restarts should persist their own small default-device record and restore it with `setDefaultDevice()` before calling `connectDefault()`.

```ts
await BluetoothSdk.setDefaultDevice({
  model: "Mentra Live",
  name: "Mentra_Live_E7FA",
})

const defaultDevice = BluetoothSdk.getDefaultDevice()
await BluetoothSdk.connectDefault()

await BluetoothSdk.clearDefaultDevice()
```

## Support

For integration support, request access to the private partner documentation repo from Mentra.
