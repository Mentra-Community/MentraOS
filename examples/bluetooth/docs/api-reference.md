# API Reference

Import the SDK from the package root:

```ts
import BluetoothSdk from "@mentra/bluetooth-sdk";
```

The default export is an Expo native module with promise-based commands and typed event listeners.

## Status Stores

### `getGlassesStatus(): GlassesStatus`

Returns the last native glasses status snapshot.

### `getBluetoothStatus(): BluetoothStatus`

Returns the last native Bluetooth status snapshot.

### `onGlassesStatus(callback): () => void`

Subscribes to partial glasses status updates and returns an unsubscribe function.

### `onBluetoothStatus(callback): () => void`

Subscribes to partial Bluetooth status updates and returns an unsubscribe function.

## Connection

### `findCompatibleDevices(deviceModel: string): Promise<void>`

Starts scanning for glasses compatible with the provided model name.

### `connectDefault(): Promise<void>`

Connects to the saved/default glasses.

### `connectByName(deviceName: string): Promise<void>`

Connects to a discovered device by name.

### `connectSimulated(): Promise<void>`

Connects to simulated glasses. Useful for UI development.

### `disconnect(): Promise<void>`

Disconnects the active glasses connection.

### `forget(): Promise<void>`

Clears the saved glasses pairing/default device.

## Display

### `displayText(params): Promise<void>`

Displays text on supported glasses.

```ts
await BluetoothSdk.displayText({
  text: "Pickup at gate B12",
  x: 0,
  y: 0,
  size: 24,
});
```

### `displayEvent(params): Promise<void>`

Sends a lower-level display event payload. Use `displayText` unless you need advanced display commands.

### `clearDisplay(): Promise<void>`

Clears the glasses display.

### `showDashboard(): Promise<void>`

Requests the glasses dashboard where supported.

## WiFi And Hotspot

### `requestWifiScan(): Promise<void>`

Requests a WiFi scan from supported glasses.

### `sendWifiCredentials(ssid: string, password: string): Promise<void>`

Sends credentials for glasses that support WiFi pairing.

### `forgetWifiNetwork(ssid: string): Promise<void>`

Forgets a saved WiFi network.

### `setHotspotState(enabled: boolean): Promise<void>`

Enables or disables glasses hotspot mode where supported.

## Camera, Gallery, And Video

### `queryGalleryStatus(): Promise<void>`

Requests photo/video gallery status.

### `photoRequest(requestId, appId, size, webhookUrl, authToken, compress, flash, sound): Promise<void>`

Requests a photo capture.

### `startVideoRecording(requestId, save, flash, sound): Promise<void>`

Starts video recording.

### `stopVideoRecording(requestId): Promise<void>`

Stops video recording.

### `startBufferRecording(): Promise<void>`

Starts rolling buffer capture.

### `stopBufferRecording(): Promise<void>`

Stops rolling buffer capture.

### `saveBufferVideo(requestId, durationSeconds): Promise<void>`

Saves the most recent buffered video segment.

## Audio And Transcription

### `setMicState(sendPcmData, sendTranscript, bypassVad): Promise<void>`

Controls microphone event output.

```ts
await BluetoothSdk.setMicState(true, true, false);
```

### `restartTranscriber(): Promise<void>`

Restarts the local transcription pipeline after changing model files.

### `setSttModelDetails(path, languageCode): Promise<void>`

Sets the local STT model path and language code.

### `checkSttModelAvailable(): Promise<boolean>`

Returns whether a local STT model is available.

### `validateSttModel(path): Promise<boolean>`

Validates a model directory.

## Streaming

### `startStream(params): Promise<void>`

Starts a glasses stream using the provided native stream payload.

### `keepStreamAlive(params): Promise<void>`

Sends a stream keep-alive payload.

### `stopStream(): Promise<void>`

Stops streaming.

## OTA And Device Maintenance

### `requestVersionInfo(): Promise<void>`

Requests firmware and app version information from glasses.

### `sendOtaStart(): Promise<void>`

Starts an OTA update that was previously reported as available.

### `ping(): Promise<void>`

Sends a connectivity ping.

## Events

Use `BluetoothSdk.addListener(eventName, callback)` for event subscriptions.

| Event                   | Purpose                                 |
| ----------------------- | --------------------------------------- |
| `glasses_status`        | Partial glasses status updates          |
| `bluetooth_status`      | Partial Bluetooth/search status updates |
| `button_press`          | Hardware button press events            |
| `touch_event`           | Touch or gesture input                  |
| `head_up`               | Head-up state changes                   |
| `battery_status`        | Battery and charging status             |
| `local_transcription`   | Offline/local STT result                |
| `mic_pcm`               | Raw PCM microphone audio                |
| `mic_lc3`               | LC3 microphone audio                    |
| `wifi_status_change`    | WiFi connection status                  |
| `hotspot_status_change` | Hotspot status                          |
| `photo_response`        | Photo capture result                    |
| `gallery_status`        | Gallery availability summary            |
| `stream_status`         | Stream status updates                   |
| `ota_update_available`  | OTA availability                        |
| `ota_progress`          | OTA progress                            |
| `pair_failure`          | Pairing failure                         |
| `audio_pairing_needed`  | Bluetooth audio pairing required        |
| `audio_connected`       | Bluetooth audio connected               |
| `audio_disconnected`    | Bluetooth audio disconnected            |

## Status Types

`GlassesStatus` includes connection state, device metadata, battery levels, WiFi/hotspot status, OTA state, and controller state.

`BluetoothStatus` includes active search state, discovered devices, WiFi scan results, microphone ranking, and recent native logs.
