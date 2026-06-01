# React Native Hooks Proposal For The Bluetooth SDK

This document started as a proposal for making the React Native SDK feel more
React-native without hiding the underlying Bluetooth lifecycle. The stable hook
set below is now implemented under:

```ts
import {
  useBluetoothEvent,
  useBluetoothScan,
  useBluetoothStatus,
  useGlassesConnection,
} from '@mentra/bluetooth-sdk/react';
```

It is based on the current React Native starter app in the Partner Kit:

```text
Mentra-Bluetooth-SDK-Partner-Kit/examples/react-native/src/useMentraSdk.ts
```

The starter app is useful as a complete demo, but it is also evidence that
customers will reimplement the same subscription, cleanup, scan, connect,
request/response, and timer patterns unless the SDK gives them small React
building blocks.

## Current Pain Points

- The example app has one large `useMentraSdk()` hook that owns unrelated
  concerns: SDK status, scan results, default-device persistence, photo upload,
  streaming, Wi-Fi, hotspot, mic recording, audio playback, RGB LED controls,
  and console logging.
- Every app must currently remember to load initial status with
  `getGlassesStatus()` and `getBluetoothStatus()`, then separately subscribe to
  `onGlassesStatus()` and `onBluetoothStatus()`, merge partial updates, and
  remove listeners on unmount.
- Device picker flows need scan state, incremental scan results, selected
  device tracking, timeout handling, and cleanup. The current `scan(...)`
  helper is good, but React apps still need lifecycle state around it.
- Connection flows need consistent `connecting`, `connected`, `disconnecting`,
  and `error` state, plus optional default-device persistence.
- Photo capture and streaming are request/response lifecycles. Apps need to
  create request IDs, correlate events, handle timeouts, stop timers, and clean
  up on unmount.
- Microphone recording is easy to start with `setMicState(...)`, but React apps
  need a safe way to collect PCM frames and stop recording without leaking event
  listeners.

## Design Principles

- Keep the root SDK imperative and language-neutral:
  `import BluetoothSdk from '@mentra/bluetooth-sdk'`.
- Add React helpers under an explicit subpath:
  `import {useGlassesConnection} from '@mentra/bluetooth-sdk/react'`.
- Hooks should be thin lifecycle helpers, not a full application framework.
- Hooks should compose. A developer can use only `useBluetoothStatus()` or use a
  higher-level `useGlassesConnection()` that composes scan and connect state.
- Hooks should not own app-specific infrastructure such as local demo servers,
  MediaMTX reachability, Expo audio playback, app analytics, or cloud auth.
- Hooks should make cleanup the default: stop scans, remove listeners, clear
  timers, and stop keep-alives on unmount when the hook created them.
- Hooks should expose SDK-native types. Do not invent a parallel React-only
  status model unless it removes an impossible state.

## Proposed Package Shape

Add a React subpath:

```json
{
  "exports": {
    ".": {
      "types": "./build/index.d.ts",
      "react-native": "./src/index.ts",
      "default": "./build/index.js"
    },
    "./react": {
      "types": "./build/react/index.d.ts",
      "react-native": "./src/react/index.ts",
      "default": "./build/react/index.js"
    }
  }
}
```

Implemented source layout:

```text
mobile/modules/bluetooth-sdk/src/react/index.ts
mobile/modules/bluetooth-sdk/src/react/useBluetoothEvent.ts
mobile/modules/bluetooth-sdk/src/react/useBluetoothStatus.ts
mobile/modules/bluetooth-sdk/src/react/useBluetoothScan.ts
mobile/modules/bluetooth-sdk/src/react/useGlassesConnection.ts
```

The SDK already has `react` as a peer dependency, so the subpath does not add a
new conceptual runtime requirement for React Native consumers.

## Proposed Hooks

### `useBluetoothEvent`

Low-level typed event subscription with automatic cleanup.

```ts
function useBluetoothEvent<EventName extends BluetoothSdkEventName>(
  eventName: EventName,
  listener: BluetoothSdkEventListener<EventName>,
  options?: {enabled?: boolean},
): void
```

Example:

```ts
useBluetoothEvent('button_press', (event) => {
  console.log(event.buttonId, event.pressType);
});
```

This removes the repeated `addListener(...); return subscription.remove` pattern
without hiding the event system.

### `useBluetoothStatus`

Loads initial status, subscribes to partial updates, and returns merged status.

```ts
function useBluetoothStatus(options?: {
  enabled?: boolean;
  onError?: (error: unknown) => void;
}): {
  glassesStatus: Partial<GlassesStatus>;
  bluetoothStatus: Partial<BluetoothStatus>;
  connected: boolean;
  error: unknown | null;
  loading: boolean;
  ready: boolean;
  refresh: () => Promise<void>;
}
```

This replaces the repeated combination of:

```ts
await BluetoothSdk.getGlassesStatus();
await BluetoothSdk.getBluetoothStatus();
BluetoothSdk.onGlassesStatus(...);
BluetoothSdk.onBluetoothStatus(...);
```

It should use `createDisconnectedGlassesStatus()` as the initial glasses state.

### `useBluetoothScan`

React lifecycle wrapper around `BluetoothSdk.scan(...)`.

```ts
function useBluetoothScan(options?: {
  model?: DeviceModel;
  timeoutMs?: number;
  dedupe?: 'id' | 'name' | ((device: Device) => string);
  onError?: (error: unknown) => void;
}): {
  devices: Device[];
  scanning: boolean;
  error: unknown | null;
  model: DeviceModel;
  setModel: (model: DeviceModel) => void;
  selectedDevice: Device | null;
  selectDevice: (device: Device | null) => void;
  startScan: (model?: DeviceModel) => Promise<Device[]>;
  stopScan: () => Promise<void>;
  clearResults: () => void;
}
```

Why both a returned `Promise<Device[]>` and live `devices` state:

- `devices` updates as scan results arrive, so the UI can show a picker during
  the scan.
- The returned promise resolves with the final scan result list, so submit-style
  code can do one thing after scanning completes.

This is the React version of the lower-level SDK `scan(model, {onResults})`
helper rather than a replacement for it.

### `useGlassesConnection`

Common connection state and actions, optionally composed with `useBluetoothScan`.

```ts
type DefaultDeviceStorage = {
  load: () => Promise<Device | null>;
  save: (device: Device | null) => Promise<void>;
};

function useGlassesConnection(options?: {
  scanModel?: DeviceModel;
  scanTimeoutMs?: number;
  autoConnectDefault?: boolean;
  defaultDeviceStorage?: DefaultDeviceStorage;
  onError?: (error: unknown) => void;
}): {
  glassesStatus: Partial<GlassesStatus>;
  bluetoothStatus: Partial<BluetoothStatus>;
  connected: boolean;
  ready: boolean;
  busy: boolean;
  action: 'idle' | 'scanning' | 'connecting' | 'disconnecting' | 'forgetting';
  error: unknown | null;
  defaultDevice: Device | null;
  scan: ReturnType<typeof useBluetoothScan>;
  connect: (device?: Device) => Promise<void>;
  connectDefault: () => Promise<void>;
  disconnect: () => Promise<void>;
  forget: () => Promise<void>;
  clearDefaultDevice: () => Promise<void>;
  setDefaultDevice: (device: Device | null) => Promise<void>;
}
```

The storage adapter keeps the SDK from choosing AsyncStorage, MMKV, SecureStore,
or a filesystem implementation for the customer. The starter app can pass its
current file-backed default-device storage, while customer apps can pass their
own persistence.

Basic customer usage:

```tsx
import {DeviceModels} from '@mentra/bluetooth-sdk';
import {useGlassesConnection} from '@mentra/bluetooth-sdk/react';

function DevicePicker() {
  const glasses = useGlassesConnection({
    scanModel: DeviceModels.MentraLive,
    autoConnectDefault: true,
    defaultDeviceStorage: myDeviceStorage,
  });

  return (
    <>
      <Button disabled={glasses.busy} title="Scan" onPress={() => glasses.scan.startScan()} />
      {glasses.scan.devices.map((device) => (
        <Button key={device.id} title={device.name} onPress={() => glasses.connect(device)} />
      ))}
      <Button disabled={!glasses.connected} title="Disconnect" onPress={glasses.disconnect} />
    </>
  );
}
```

### `usePhotoRequest`

Not implemented yet.

Correlates `requestPhoto(...)` calls with `photo_response` events.

```ts
function usePhotoRequest(options: {
  appId: string;
  timeoutMs?: number;
  onResponse?: (event: PhotoResponseEvent) => void;
  onError?: (error: unknown) => void;
}): {
  activeRequestId: string | null;
  response: PhotoResponseEvent | null;
  status: 'idle' | 'requesting' | 'success' | 'error' | 'timeout';
  error: unknown | null;
  requestPhoto: (request: {
    requestId?: string;
    size: PhotoSize;
    webhookUrl: string | null;
    authToken?: string | null;
    compress?: PhotoCompression;
    sound?: boolean;
  }) => Promise<string>;
  reset: () => void;
}
```

This should not start a local phone photo receiver or poll a local cloud helper.
Those are starter-kit concerns. The hook only handles the SDK request and the
SDK response event lifecycle.

### `useStreamSession`

Not implemented yet.

Owns stream start/stop state and keep-alive timer cleanup.

```ts
function useStreamSession(options?: {
  keepAliveIntervalSeconds?: number;
  onStatus?: (event: StreamStatusEvent) => void;
  onError?: (error: unknown) => void;
}): {
  streamId: string | null;
  active: boolean;
  starting: boolean;
  status: StreamStatusEvent | null;
  error: unknown | null;
  startStream: (request: Omit<StreamStartRequest, 'streamId' | 'keepAliveIntervalSeconds'> & {
    streamId?: string;
    keepAliveIntervalSeconds?: number;
  }) => Promise<string>;
  stopStream: () => Promise<void>;
}
```

This hook should call `keepStreamAlive(...)` every interval while active and
stop the timer on `stopStream()` or unmount. Preview readiness, MediaMTX status
queries, and direct in-phone WebRTC receiver setup should stay in the starter
kit because they are demo infrastructure, not Bluetooth SDK behavior.

### `useMicPcmRecorder`

Not implemented yet.

Small utility hook for the most common microphone event lifecycle.

```ts
function useMicPcmRecorder(options?: {
  bypassVad?: boolean;
  sendTranscript?: boolean;
  onFrame?: (frame: Uint8Array) => void;
  onError?: (error: unknown) => void;
}): {
  recording: boolean;
  frames: number;
  bytes: number;
  pcm: Uint8Array;
  error: unknown | null;
  start: () => Promise<void>;
  stop: () => Promise<Uint8Array>;
  reset: () => void;
}
```

This hook should collect PCM bytes from `mic_pcm` and call
`setMicState(true, true, bypassVad, sendTranscript, false)` on start and
`setMicState(false)` on stop. WAV encoding, Expo `File`, and Expo audio playback
should stay in the starter kit because they are app-platform choices.

## What Should Stay Out Of The SDK Hooks

- Android permission request UI. The SDK can document required permissions, but
  apps should decide where and how to ask users.
- Local demo cloud helpers, MediaMTX reachability checks, and direct receiver
  UI. These belong in the starter kit.
- Expo audio playback implementation. The SDK can provide speaker routing
  signals and `setOwnAppAudioPlaying(...)`, but apps play audio through normal
  React Native or Expo audio APIs.
- Customer persistence choices. Hooks can accept a storage adapter but should
  not depend on a specific storage package.
- Console/event log UI. The SDK can expose typed events; apps decide how to
  render logs.

## Migration Path For The Starter App

1. Replace initial status loading and status subscriptions with
   `useBluetoothStatus()`.
2. Replace manual scan state with `useBluetoothScan()`.
3. Replace default-device restore/autoconnect logic with
   `useGlassesConnection({defaultDeviceStorage, autoConnectDefault: true})`.
4. Replace photo request ID/timeout/listener code with `usePhotoRequest()`, but
   keep `MentraDirectReceiver` setup in the starter app.
5. Replace stream keep-alive timer code with `useStreamSession()`, but keep
   MediaMTX/direct receiver preview logic in the starter app.
6. Replace PCM listener and start/stop mic state with `useMicPcmRecorder()`,
   but keep WAV writing and playback in the starter app.

## Open Questions For Review

- Should the first public hook release include only `useBluetoothStatus`,
  `useBluetoothEvent`, `useBluetoothScan`, and `useGlassesConnection`, leaving
  photo/stream/mic hooks as starter-kit recipes until we see customer usage?
- Should `useBluetoothScan` dedupe devices by `id` only, or should it support
  a default Mentra Live name-based dedupe for iOS BLE/audio duplicate rows?
- Should `useGlassesConnection` own Android Bluetooth permission checks, or is
  a separate `useBluetoothPermissions()` hook cleaner?
- Should hooks live in `@mentra/bluetooth-sdk/react`, or should they be root
  exports from `@mentra/bluetooth-sdk` for discoverability?
- Should `useStreamSession` stop the stream automatically on unmount by default?
  This is safer for demos but could surprise an app that intentionally wants a
  stream to survive screen navigation.

## Recommendation

Start with the small stable hook set:

```ts
useBluetoothEvent
useBluetoothStatus
useBluetoothScan
useGlassesConnection
```

These directly address the most error-prone React lifecycle work and make the
device picker flow much easier without committing the SDK to app-specific photo,
stream preview, or audio playback opinions. Then add `usePhotoRequest`,
`useStreamSession`, and `useMicPcmRecorder` after the starter app proves their
shape and Claude/reviewer feedback confirms they are not hiding too much.
