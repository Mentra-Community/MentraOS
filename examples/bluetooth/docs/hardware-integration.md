# Hardware Integration Notes

The SDK presents a common native API over multiple glasses models. Capabilities differ by model and firmware, so apps should treat advanced features as optional.

## Recommended Flow

1. Ask the user which glasses model they are pairing.
2. Start a scan for that model.
3. Present typed discovered devices from SDK callbacks.
4. Connect using the discovered device or default-device helper.
5. Read `GlassesStatus`, firmware fields, and capability-related status before enabling advanced features.
6. Keep app UI derived from SDK status rather than from command success alone.

Android:

```kotlin
sdk.startScan(DeviceModel.MENTRA_LIVE)

override fun onDeviceDiscovered(device: Device) {
    sdk.connect(device)
}
```

iOS:

```swift
sdk.startScan(model: .mentraLive)

func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: Device) {
    try? sdk.connect(to: device)
}
```

React Native:

```ts
import {DeviceModels} from '@mentra/bluetooth-sdk';

const removeBluetooth = BluetoothSdk.onBluetoothStatus((status) => {
  const device = status.searchResults?.[0];
  if (device) {
    removeBluetooth();
    void BluetoothSdk.connect(device);
  }
});

await BluetoothSdk.startScan(DeviceModels.MentraLive);
```

## Capability Areas

- Display: text, dashboard, brightness, head-up angle, and screen enable/disable commands.
- Input: button, touch, head-up, and switch events.
- Audio: PCM, LC3, audio pairing, preferred microphone, and local transcription.
- Camera: photo, gallery, video recording, and streaming.
- Network: Wi-Fi scan, credentials, and hotspot state.
- Maintenance: version info, OTA availability, OTA progress, shutdown, and restart flows.

## Model Differences

Treat each advanced feature as optional. Your app should degrade gracefully if a model does not support camera, Wi-Fi, display batching, local transcription, streaming, RGB LEDs, or controller pairing.

| Model | Display | Camera | Microphone | Speaker | Primary strengths |
| --- | --- | --- | --- | --- | --- |
| Mentra Live | No | Yes | Yes | Yes | Camera, microphone, speaker, Wi-Fi, streaming, phone-connected workflows |
| G2 | Yes | No | Yes | No | Display and glanceable UI workflows |

Treat unsupported operations as recoverable SDK errors and keep UI state aligned with the latest status callback.

## Connection Resilience

- Subscribe to status callbacks before connecting.
- Retry scans manually from the UI instead of scanning forever in the background.
- On mobile OS background transitions, expect Bluetooth behavior to vary by platform.
- Reconcile command failures with the latest status snapshot before showing destructive UI.
- Provide a visible "forget device" path that clears both the SDK default device and any app-persisted default-device record.
