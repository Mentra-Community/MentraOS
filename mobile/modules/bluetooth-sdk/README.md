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

`startScan()` starts the scan. Discovered devices arrive asynchronously through `onCoreStatus()` updates.

```ts
import BluetoothSdk, {type Device} from "@mentra/bluetooth-sdk"

const removeStatusListener = BluetoothSdk.onGlassesStatus((status) => {
  console.log("Glasses status changed", status)
})

const firstDevice = new Promise<Device>((resolve) => {
  let removeCoreListener = () => {}
  removeCoreListener = BluetoothSdk.onCoreStatus((status) => {
    const device = status.searchResults?.[0]
    if (device) {
      removeCoreListener()
      resolve(device)
    }
  })
})

await BluetoothSdk.startScan({model: "Mentra Live"})
await BluetoothSdk.connect(await firstDevice)

// Only call display APIs for glasses models that support a display.
await BluetoothSdk.displayText({text: "Hello from Mentra", x: 0, y: 0, size: 24})

removeStatusListener()
```

## Default Device

`connectDefault()` connects to the default glasses target currently stored in the SDK. Apps that want this target to survive app restarts should persist the scanned `Device` in their own storage and restore it with `setDefaultDevice()` before calling `connectDefault()`.

```ts
const savedDevice = await loadSavedDeviceFromYourAppStorage()
if (savedDevice) {
  await BluetoothSdk.setDefaultDevice(savedDevice)
  await BluetoothSdk.connectDefault()
}

const discoveredDevice = await scanAndChooseDevice()
await BluetoothSdk.connect(discoveredDevice)
await saveDeviceToYourAppStorage(discoveredDevice)

await BluetoothSdk.clearDefaultDevice()
await saveDeviceToYourAppStorage(null)
```

## Support

For integration support, request access to the private partner documentation repo from Mentra.
