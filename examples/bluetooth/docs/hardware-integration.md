# Hardware Integration Notes

The SDK presents a common React Native API over multiple glasses models. Capabilities differ by model and firmware.

## Recommended Flow

1. Ask the user which glasses model they are pairing.
2. Call `findCompatibleDevices(model)`.
3. Read `bluetooth_status.searchResults`.
4. Connect using `connectByName(deviceName)`.
5. Read `glasses_status.deviceModel`, firmware fields, and capability-related status before enabling advanced features.

## Capability Areas

- Display: text and dashboard commands.
- Input: button, touch, head-up, and switch events.
- Audio: PCM, LC3, audio pairing, and local transcription.
- Camera: photo, gallery, video recording, and streaming.
- Network: WiFi scan, credentials, and hotspot state.
- Maintenance: version info, OTA availability, OTA progress, and restart flows.

## Model Differences

Treat each advanced feature as optional. A partner app should degrade gracefully if a model does not support camera, WiFi, display batching, local transcription, or streaming.

## Connection Resilience

- Subscribe to `glasses_status` and `bluetooth_status` early.
- Keep UI state derived from SDK status rather than from command success alone.
- Retry scans manually from the UI instead of scanning forever in the background.
- On mobile OS background transitions, expect Bluetooth behavior to vary by platform.
