# @mentra/bluetooth-sdk

React Native and Expo SDK for connecting mobile apps directly to supported Mentra smart glasses over Bluetooth.

The package includes:

- A React Native / Expo module API exposed as `BluetoothSdk`.
- React hooks under `@mentra/bluetooth-sdk/react` for common scan,
  connection, status, and event lifecycles.
- Native Android code published as `com.mentra:bluetooth-sdk`.
- Native iOS code published as the `MentraBluetoothSDK` CocoaPod.
- An Expo config plugin that wires the native dependencies into generated Android and iOS projects.

Use a development build or production native build. Expo Go cannot load this package because the SDK contains native code.

## Requirements

- React Native `0.72+`.
- Expo `49+` when using Expo.
- Android min SDK `28+`.
- iOS deployment target `15.1+`.
- A physical phone for real Bluetooth testing.
- Bluetooth permissions, plus Android location permission where BLE scanning requires it.

## Install

```sh
bun add @mentra/bluetooth-sdk
bunx expo install expo-build-properties
```

For Expo apps, add the plugin to `app.json` or `app.config.ts`:

```json
{
  "expo": {
    "plugins": [
      [
        "@mentra/bluetooth-sdk",
        {
          "node": true
        }
      ],
      [
        "expo-build-properties",
        {
          "android": {
            "minSdkVersion": 28,
            "packagingOptions": {
              "pickFirst": [
                "**/libc++_shared.so",
                "**/libonnxruntime.so",
                "**/libonnxruntime4j_jni.so"
              ]
            }
          }
        }
      ]
    ]
  }
}
```

Then regenerate native projects and run a development build:

```sh
bunx expo prebuild
bunx expo run:ios
# or
bunx expo run:android
```

## Permissions

Android apps should request the permissions required by the features they use:

```json
{
  "android": {
    "permissions": [
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_ADMIN",
      "android.permission.BLUETOOTH_SCAN",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.RECORD_AUDIO",
      "android.permission.INTERNET",
      "android.permission.POST_NOTIFICATIONS"
    ]
  }
}
```

Some Android 12+ devices require Location permission and Location services before BLE scan callbacks are delivered.

iOS apps should include usage descriptions:

```json
{
  "ios": {
    "infoPlist": {
      "NSBluetoothAlwaysUsageDescription": "This app connects to your smart glasses over Bluetooth.",
      "NSMicrophoneUsageDescription": "This app uses the microphone when you enable audio features.",
      "NSLocalNetworkUsageDescription": "This app connects to local photo and streaming helpers during development."
    }
  }
}
```

## Minimal Usage

Use `scan()` when your app needs to show a picker. It calls `onResults` every time the discovered list changes, then resolves with the final list after the timeout.

```ts
import BluetoothSdk, {
  DeviceModels,
} from '@mentra/bluetooth-sdk'

const devices = await BluetoothSdk.scan(DeviceModels.MentraLive, {
  timeoutMs: 10_000,
  onResults: (nextDevices) => {
    console.log('Nearby glasses:', nextDevices)
  },
})

const device = await chooseDevice(devices)
if (!device) {
  throw new Error('No Mentra Live glasses selected')
}

await BluetoothSdk.connect(device)
await BluetoothSdk.requestVersionInfo()
```

In multi-device environments, present an explicit picker instead of
auto-connecting to the first nearby device.

Mentra Live does not have a display. Use display commands only after gating by
model capability.

Use `Device.id` as the stable app-facing key for scan rows, selected devices,
and persisted default devices. Do not parse it for model, name, or address
information; use the typed `model`, `name`, `address`, and `rssi` fields
instead. Android commonly uses a Bluetooth address when available, iOS commonly
uses a CoreBluetooth identifier when available, and the SDK falls back to
`model:name` when no platform identifier is available.

`Device.rssi` is optional. A device can appear in scan results before the
platform reports RSSI, so picker UI should handle `undefined` and avoid
reordering rows just because RSSI metadata arrives later.

## React Hooks

React Native apps can import optional lifecycle helpers from the `react`
subpath for common lifecycle plumbing. Use the root `BluetoothSdk` object for
commands such as `requestPhoto()`, `startStream()`, and `setMicState()`.

```tsx
import {Button, Text, View} from 'react-native'
import {DeviceModels} from '@mentra/bluetooth-sdk'
import {useBluetoothEvent, useMentraBluetooth} from '@mentra/bluetooth-sdk/react'

export function DeviceScreen() {
  const mentra = useMentraBluetooth({
    defaultModel: DeviceModels.MentraLive,
    scanTimeoutMs: 10_000,
  })

  useBluetoothEvent('button_press', (event) => {
    console.log('Glasses button:', event.buttonId, event.pressType)
  })

  return (
    <View>
      <Text>{mentra.glasses.connected ? 'Connected' : 'Disconnected'}</Text>
      <Button disabled={mentra.busy} title="Scan" onPress={() => mentra.scan.start()} />
      {mentra.scan.devices.map((device) => (
        <Button key={device.id} title={device.name} onPress={() => mentra.connect(device)} />
      ))}
      <Button disabled={!mentra.glasses.connected} title="Disconnect" onPress={mentra.disconnect} />
    </View>
  )
}
```

The hooks do not request Android permissions or choose a persistence package for
you. Ask for permissions in your app before calling scan/connect actions, and
pass a `defaultDeviceStorage` adapter to `useMentraBluetooth` if you want a
default device to survive app restarts.

Use `useMentraBluetooth()` as the React status API for connection, battery,
Wi-Fi, hotspot, scan, and SDK runtime state.

The React hook exposes `glasses.connection` as a discriminated union:

```ts
type GlassesConnectionStatus =
  | {state: 'disconnected'}
  | {state: 'scanning'}
  | {state: 'connecting'}
  | {state: 'bonding'}
  | {state: 'connected'; fullyBooted: boolean}
```

Use `connection.state` for link progress. `fullyBooted` only exists when `state === 'connected'`. Android and iOS native APIs also keep `connectionState`, `connected`, and `fullyBooted` as native status properties for Kotlin and Swift callers.

## Default Device

`connectDefault()` connects to the default glasses target stored in SDK state. Apps that want this target to survive app restarts should persist the scanned `Device` in app storage and restore it with `setDefaultDevice()` before calling `connectDefault()`.

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

## Common Commands

```ts
await BluetoothSdk.clearDisplay()
await BluetoothSdk.showDashboard()
await BluetoothSdk.setDashboardPosition(4, 2)

await BluetoothSdk.requestWifiScan()
await BluetoothSdk.sendWifiCredentials('Office WiFi', 'secret')
await BluetoothSdk.forgetWifiNetwork('Office WiFi')
await BluetoothSdk.setHotspotState(true)

await BluetoothSdk.setGalleryModeEnabled(true)
await BluetoothSdk.setGalleryModeEnabled(false)

await BluetoothSdk.setPreferredMic('auto')
await BluetoothSdk.setMicState(true)
await BluetoothSdk.setOwnAppAudioPlaying(false)

await BluetoothSdk.rgbLedControl(
  `led-${Date.now()}`,
  'com.example.app',
  'on',
  'green',
  500,
  500,
  3,
)
```

`setMicState(true)` defaults to continuous microphone PCM from the glasses. The SDK does not apply phone-side Voice Activity Detection gating to microphone audio events. Use `setVoiceActivityDetectionEnabled(false)` when you want glasses-side Voice Activity Detection disabled for continuous external STT, recording, or playback. `voice_activity_detection_status` reports whether glasses-side Voice Activity Detection is enabled, and `speaking_status` reports speaking/not-speaking when supported. Microphone events include the latest `voiceActivityDetectionEnabled` value.

## Photo Upload

```ts
await BluetoothSdk.requestPhoto({
  requestId: `photo-${Date.now()}`,
  appId: 'com.example.app',
  size: 'medium',
  webhookUrl: 'https://api.example.com/mentra/photo',
  authToken: 'optional-token',
  compress: 'medium',
  sound: true,
})
```

The webhook should accept multipart form data with a `photo` file and `requestId`. If `authToken` is provided, the uploader adds `Authorization: Bearer <token>`. The camera light is always enabled for photo capture.

## Streaming

```ts
const streamId = `stream-${Date.now()}`

await BluetoothSdk.startStream({
  type: 'start_stream',
  streamUrl: 'http://192.168.1.42:8889/mentra-live/whip',
  streamId,
  video: {fps: 15},
})

await BluetoothSdk.keepStreamAlive({
  type: 'keep_stream_alive',
  streamId,
  ackId: `ack-${Date.now()}`,
})

await BluetoothSdk.stopStream()
```

Use `rtmp://` or `rtmps://` for RTMP, `srt://` for SRT, and `http://` or `https://` for WHIP/WebRTC ingest. Send keep-alives about every 15 seconds while streaming. The camera light is always enabled while streaming.

## Events

React Native components should use `useBluetoothEvent()` for hardware events:

```tsx
import {useBluetoothEvent} from '@mentra/bluetooth-sdk/react'

export function HardwareEventLogger() {
  useBluetoothEvent('button_press', (event) => console.log(event))
  useBluetoothEvent('touch_event', (event) => console.log(event))
  useBluetoothEvent('photo_response', (event) => console.log(event))
  useBluetoothEvent('stream_status', (event) => console.log(event))
  useBluetoothEvent('speaking_status', (event) => console.log(event.speaking))
  useBluetoothEvent('mic_pcm', (event) => {
    console.log(event.sampleRate, event.bitsPerSample, event.channels, event.encoding)
    console.log(event.pcm)
  })

  return null
}
```

For non-React modules, `BluetoothSdk.addListener(...)` is the low-level subscription API. Keep the returned subscription and call `remove()` when the listener is no longer needed.

Common event names include `button_press`, `touch_event`, `head_up`, `battery_status`, `wifi_status_change`, `hotspot_status_change`, `photo_response`, `gallery_status`, `stream_status`, `keep_alive_ack`, `mic_pcm`, `mic_lc3`, `local_transcription`, `rgb_led_control_response`, `audio_connected`, `audio_disconnected`, and `log`.

React Native event payload fields use camelCase. For example, `touch_event` includes `gestureName`, `photo_response` success includes `uploadUrl`, and `gallery_status` includes `hasContent` and `cameraBusy`. `mic_pcm` includes `sampleRate`, `bitsPerSample`, `channels`, and `encoding`; `mic_lc3` includes `sampleRate`, `channels`, `encoding`, `frameDurationMs`, `frameSizeBytes`, `bitrate`, and `packetizedFromGlasses`.

Only documented imports are supported for app developers. Undocumented package subpaths or symbols with a leading underscore can change without notice.

## Local SDK Development

For normal app development, install the JavaScript package from npm. For SDK source development or release testing, install a local checkout and point Metro/native resolution at the same path:

```sh
bun add --no-save /path/to/MentraOS/mobile/modules/bluetooth-sdk
MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk bunx expo run:ios
```

Use `bunx expo run:android` for Android. Keep local paths in your shell or CI environment, not in committed app config.

## Starter Example App

The [Mentra Bluetooth SDK Starter Kit](https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit) includes starter example apps for Android, iOS, and React Native / Expo. The React Native starter demonstrates scan/connect, display, camera photo upload, RTMP/SRT/WebRTC streaming, Wi-Fi/hotspot, microphone PCM, RGB LED, gallery mode, and console event inspection.
