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

await BluetoothSdk.findCompatibleDevices("Mentra Live")
await BluetoothSdk.connectDefault()
await BluetoothSdk.displayText({text: "Hello from Mentra", x: 0, y: 0, size: 24})

removeStatusListener()
```

## Support

For integration support, request access to the private partner documentation repo from Mentra.
