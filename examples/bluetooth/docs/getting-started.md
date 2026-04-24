# Getting Started

This guide walks through adding the Mentra Bluetooth SDK to a React Native or Expo app.

## Requirements

- React Native `0.72` or newer
- Expo `49` or newer
- iOS deployment target `15.1` or newer
- Android min SDK `28` or newer
- A development build. The SDK includes native code and will not run inside Expo Go.
- A supported pair of Mentra smart glasses

## Installation

```sh
npm install @mentra/bluetooth-sdk
npx expo prebuild
npx pod-install
```

For Bun projects:

```sh
bun add @mentra/bluetooth-sdk
bun expo prebuild
cd ios && pod install
```

Do not use `expo prebuild --clean` unless you are intentionally regenerating native projects and have backed up custom native code.

## Configure The Plugin

Add the SDK plugin to your Expo config:

```ts
export default {
  expo: {
    plugins: [
      [
        "@mentra/bluetooth-sdk",
        {
          node: true,
        },
      ],
    ],
  },
};
```

The plugin adds the native Android configuration required by the SDK and can create an iOS `.xcode.env.local` with `NODE_BINARY` for local builds.

## Basic Connection Flow

```ts
import BluetoothSdk from "@mentra/bluetooth-sdk";

const removeGlassesListener = BluetoothSdk.onGlassesStatus((status) => {
  console.log("Glasses status changed", status);
});

const removeBluetoothListener = BluetoothSdk.onBluetoothStatus((status) => {
  console.log("Bluetooth status changed", status);
});

await BluetoothSdk.findCompatibleDevices("Mentra Live");
await BluetoothSdk.connectDefault();

await BluetoothSdk.displayText({
  text: "Hello from Mentra",
  x: 0,
  y: 0,
  size: 24,
});

removeGlassesListener();
removeBluetoothListener();
```

## Listen For Hardware Events

```ts
const buttonSub = BluetoothSdk.addListener("button_press", (event) => {
  console.log(event.buttonId, event.pressType);
});

const batterySub = BluetoothSdk.addListener("battery_status", (event) => {
  console.log(`${event.level}%`, event.charging ? "charging" : "not charging");
});

buttonSub.remove();
batterySub.remove();
```

## Minimal App Lifecycle

1. Request OS-level Bluetooth permissions through your app permission flow.
2. Subscribe to `bluetooth_status` and `glasses_status`.
3. Call `findCompatibleDevices(model)` and present results from `bluetooth_status.searchResults`.
4. Connect with `connectByName(name)` or `connectDefault()`.
5. Send display, camera, audio, or configuration commands.
6. Remove listeners and call `disconnect()` when the user signs out or disables glasses features.

## Next Steps

- See [API Reference](api-reference.md) for supported commands and events.
- See [Display Guide](display-guide.md) for display examples.
- See [Audio Guide](audio-guide.md) for microphone and local transcription flows.
- See [Troubleshooting](troubleshooting.md) if native build or pairing fails.
