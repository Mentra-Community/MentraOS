# React Native Example

This example is a minimal Expo development-build app for partners who have explicit access to the React Native integration path.

Start with `examples/android` or `examples/ios` unless your partner agreement explicitly includes React Native support.

## Run

```sh
npm install
npx expo prebuild
npx expo run:ios
```

or:

```sh
npm install
npx expo prebuild
npx expo run:android
```

## What It Demonstrates

- Subscribing to glasses and Bluetooth status
- Scanning for compatible glasses
- Connecting to saved/default glasses
- Connecting to simulated glasses
- Displaying text
- Clearing the display
- Listening for button and battery events
