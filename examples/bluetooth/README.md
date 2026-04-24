# Mentra Bluetooth SDK Partner Kit

Private documentation and partner enablement materials for the Mentra Bluetooth SDK.

This repo is intended for licensed partners building mobile apps that connect directly to supported Mentra smart glasses over Bluetooth. It contains the integration guides, production checklists, hardware notes, and runnable examples that sit on top of the public `@mentra/bluetooth-sdk` package.

## Start Here

1. Read [Getting Started](docs/getting-started.md).
2. Review [API Reference](docs/api-reference.md).
3. Run the [React Native example](examples/react-native/README.md).
4. Use the [Production Checklist](docs/production-checklist.md) before shipping.

## What This Repo Covers

- Installing the SDK in React Native and Expo apps
- Scanning for compatible glasses
- Connecting, disconnecting, and tracking connection state
- Displaying text and clearing the display
- Handling hardware events such as button presses, touch gestures, head-up state, battery, and audio events
- Using microphone, PCM, LC3, and local transcription events
- Working with camera, gallery, WiFi, hotspot, stream, and OTA APIs
- Production validation and troubleshooting

## Access Model

This repository is private because it contains partner-facing implementation guidance, integration playbooks, and production support material. Do not copy these docs into public repos or public package READMEs without product approval.

## Related Package

```sh
npm install @mentra/bluetooth-sdk
```

The SDK source currently lives in the MentraOS monorepo. This repo is the customer-facing documentation and example layer.
