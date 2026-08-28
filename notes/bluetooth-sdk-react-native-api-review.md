# React Native Bluetooth SDK API Review

This note reviews the React Native-facing Bluetooth SDK API shape. It is intentionally scoped to React Native, not Kotlin or Swift.

## Current Shape

At the start of this review, the package exposed two layers:

- A core imperative module, `BluetoothSdk`, with status getters, event listeners, connection commands, display commands, camera commands, streaming commands, microphone commands, Wi-Fi commands, and media-volume commands.
- A React convenience layer under `src/react`, with `useBluetoothEvent`, `useBluetoothStatus`, `useBluetoothScan`, and `useGlassesConnection`.

The current publish target narrows that React Native surface:

- Root `BluetoothSdk` remains the imperative command surface plus typed hardware events.
- `@mentra/bluetooth-sdk/react` exposes `useMentraBluetooth`, `useBluetoothScan`, and `useBluetoothEvent`.
- Raw native/store status snapshots remain internal implementation details, not the primary partner API.

The example app still has a large app-local `useMentraSdk` hook. That hook currently owns a lot more than basic SDK lifecycle:

- Initial status loading and event subscription.
- Default-device persistence.
- Scan/connect/disconnect UI state.
- Photo upload demo state and local direct receiver state.
- Streaming demo state, keep-alive timers, preview polling, and local direct receiver state.
- PCM microphone recording, WAV file creation, playback state, and audio-route UI text.
- RGB LED UI state, Wi-Fi provisioning UI state, hotspot/gallery convenience state, console events, and placeholder/default URL handling.

That means the big example hook is not automatically proof that the SDK hooks are bad. Some of it is demo-app orchestration. But it is a useful smell when it reimplements generic lifecycle that most partner apps will need.

## External React Native / React SDK Patterns

The common thread across mature React Native/React SDKs is that they separate:

- Long-lived resources from short UI renders.
- Reactive state from imperative commands.
- Common lifecycle cleanup from app-specific UI decisions.

React components mount, unmount, re-render, lose focus, regain focus, and can exist in multiple places at once. Device and network sessions do not naturally follow that lifecycle. Good React SDK APIs mostly exist to bridge that mismatch.

### Apollo Client

Apollo keeps an imperative client object, but the normal React app API is hooks: `useQuery`, `useMutation`, `useSubscription`, `useApolloClient`, and others.

Source: https://www.apollographql.com/docs/react/api/react/hooks

Pattern to copy:

- Keep the core client for escape hatches.
- Make common reactive usage hook-first.
- Hooks return state plus action functions rather than forcing users to manage subscriptions.

Why it helps React developers:

- A component asks for data and gets state such as data/loading/error without owning cache subscriptions.
- The hook updates the component when data changes and tears down observers when the component unmounts.
- Mutations stay imperative because they are user actions, but query/subscription state is reactive because UI should follow it.

### LiveKit React Native

LiveKit React Native has a core room/session object, but React Native apps are encouraged to wrap UI in `LiveKitRoom` and use hooks like `useTracks` and `useConnectionState`.

Sources:

- https://github.com/livekit/client-sdk-react-native
- https://docs.livekit.io/reference/components/react/guide/

Pattern to copy:

- Use a session/provider concept for long-lived realtime device/media state.
- Prefer tested hooks/components for lifecycle-heavy features.
- Warn against repeated mount/unmount patterns that cause reconnect churn.

Why it helps React developers:

- A realtime media room is a long-lived session, not a single button click.
- Hooks like `useTracks` let components render current room state without each screen manually subscribing to track events.
- Provider/context keeps one authoritative session underneath many UI components.
- The SDK protects users from reconnect churn caused by normal React rendering mistakes.

### Stream Chat React Native

Stream uses a client object, a high-level `Chat` provider, and hooks/contexts such as `useCreateChatClient` and `useChatContext`. Their docs recommend a single provider per app and centralizing connection lifecycle.

Source: https://getstream.io/chat/docs/sdk/react-native/core-components/chat/

Pattern to copy:

- For one global connection/session, centralize lifecycle in one provider or top-level hook.
- Avoid every screen hand-rolling subscriptions.
- Expose connection state through context/hooks.

Why it helps React developers:

- Chat connection state is app-wide; duplicating it per screen can create duplicate sockets and stale UI.
- Provider/context gives screens access to the same client and status without prop drilling.
- A hook like `useCreateChatClient` can connect/disconnect at the right time for login/logout.

### Ably React Hooks

Ably exposes React hooks such as `useChannel`, `usePresence`, `usePresenceListener`, and `useConnectionStateListener`. The hooks return state and action functions, and manage listener cleanup on unmount.

Sources:

- https://ably.com/docs/getting-started/react-hooks
- https://ably.com/docs/chat/api/react/use-presence

Pattern to copy:

- Hooks can own subscription lifetimes.
- It is normal for hooks to return both current state and imperative actions.
- Options such as `autoEnterLeave` are useful when lifecycle automation is convenient but should remain explicit.

Why it helps React developers:

- Presence is both state and behavior: the app needs to know "am I present?" and also call `enter`, `leave`, or `update`.
- Auto-enter/leave maps naturally to component mount/unmount, but the option is explicit because it changes behavior.
- Listener hooks prevent forgotten unsubscribe calls, which are one of the most common React realtime bugs.

### React Native BLE PLX

`react-native-ble-plx` is closer to raw BLE. It exposes a `BleManager` and imperative scan/connect functions. Scanning uses a callback listener and the app must call `stopDeviceScan()`. The docs call out duplicate scan emissions and platform-specific constraints.

Sources:

- https://dotintent.github.io/react-native-ble-plx/
- https://github.com/dotintent/react-native-ble-plx/wiki/Bluetooth-Scanning

Pattern to avoid exposing directly to partners:

- Requiring every app to manually dedupe devices.
- Requiring every app to manually coordinate scan cancellation and connect lifecycle.
- Requiring users to know low-level BLE quirks for common flows.

This raw style is useful as a lower-level escape hatch, but our SDK should hide more because Mentra glasses have higher-level product semantics than generic BLE devices.

Why the raw shape exists:

- `react-native-ble-plx` is a generic BLE primitive library. It cannot know what "the right device" is, how to rank devices, when duplicates are meaningful, or what connected means for a product.
- Our SDK does know the device models, expected service behavior, default-device semantics, and glasses readiness lifecycle. That means we can responsibly provide a friendlier hook above raw scan/connect.

### Expo Camera

Expo Camera exposes hardware APIs and small React hooks such as `useCameraPermissions`. It does not turn every command into a hook, but it does provide hooks for stateful platform concerns like permissions.

Source: https://docs.expo.dev/versions/latest/sdk/camera/

Pattern to copy:

- Keep direct command APIs for device actions.
- Provide hooks where React lifecycle or permissions are part of the feature.

Why it helps React developers:

- Taking a photo is a command, so a method is fine.
- Permission state is reactive and platform-owned, so a hook is better.
- This is a useful rule for us too: do not turn every SDK command into a hook. Add hooks where lifecycle/state is the hard part.

## Why Hooks Are Not Just Convenience

For this SDK, hooks are valuable when they remove lifecycle traps. The hardest React Native bugs here are not "how do I call `connect()`?" They are:

- Did I unsubscribe from native events when the component unmounted?
- Did I start two scans from two screens?
- Did I keep a stale selected device after scan results refreshed?
- Did I connect while a scan was still active?
- Did I reconnect repeatedly because a component remounted?
- Did I keep a default-device value in app state after the native SDK cleared it?
- Did I show stale battery/Wi-Fi/hotspot values after disconnect?
- Did I forget stream keep-alive cleanup?

Good hooks should make these mistakes harder:

- `useBluetoothStatus` owns status subscriptions and merges event updates into current React state.
- `useBluetoothScan` owns scan result state, deduping, selected-device invalidation, active scan generation, and stop-on-unmount.
- `useGlassesConnection` should own default-device lifecycle, scan/connect/disconnect action state, and obvious auto-connect behavior.

The hook should not hide everything. If the partner wants custom UI, they still need device lists, selected-device state, busy/error state, and actions. But they should not need to write native event plumbing to get there.

## What This Means For Our API

`BluetoothSdk` should remain a plain imperative API. That is important for:

- Non-React code.
- Tests.
- Advanced customers.
- Debugging.
- One-off commands like `displayText`, `requestPhoto`, or `setGalleryModeEnabled`.

React hooks should be the recommended app-building API for lifecycle-heavy flows:

- Status subscription.
- Scan picker.
- Connection/default-device lifecycle.
- Potentially streaming session lifecycle.
- Potentially microphone PCM lifecycle.
- Potentially Wi-Fi provisioning lifecycle.

The example app should eventually prove this division. Its app-local `useMentraSdk` can still exist, but it should become a composition layer over SDK hooks plus demo-specific helpers. If it continues to duplicate generic scan/status/default-device/event lifecycle, then the SDK hooks are not doing enough.

## Hook Design Principles For This SDK

- Hooks should return a single object, not tuples, because the state/action surface is larger than `useState`.
- Hooks should include loading or busy state, error state, current state, and action functions.
- Long-running actions should expose clear action state, for example `"scanning"`, `"connecting"`, `"disconnecting"`, not just a boolean.
- Hooks should clean up native listeners on unmount.
- Hooks should avoid global side effects unless explicitly requested by an option such as `autoConnectDefault`.
- Command methods with several optional/boolean parameters should prefer options objects.
- The public low-level event API can exist, but docs should steer normal app developers toward hooks first.

## Review Of Our Current React Native API

### What Is Good

The two-layer design is directionally right:

- `BluetoothSdk` as an imperative escape hatch is normal.
- `useBluetoothStatus` and `useBluetoothScan` are useful because they own event subscription and cleanup.
- `useGlassesConnection` is the right kind of high-level hook: it combines status, scan, selected device, default device, connection actions, busy state, and errors.
- Removing internal `default_wearable` / `device_name` / `device_address` from public `BluetoothStatus` is the right boundary. Default-device state should flow through `getDefaultDevice`, `setDefaultDevice`, `clearDefaultDevice`, and `default_device_changed`.

### What Feels Arbitrary

`BluetoothStatus` and `GlassesStatus` are not intuitively separated for customers.

- `GlassesStatus` mostly means connected wearable state: connection, battery, firmware, current Wi-Fi, hotspot, capabilities.
- `BluetoothStatus` currently means phone-side SDK/discovery/settings state: scanning, scan results, Wi-Fi scan results, microphone routing/preferences, logs, and gallery mode.

The names are not wrong, but `BluetoothStatus` is easy to misunderstand because it contains things that are not purely Bluetooth, such as Wi-Fi scan results and gallery mode.

`PublicBluetoothStatus = Pick<...>` and `PublicGlassesStatus = Omit<...>` are reasonable internal implementation tools, but they should not shape the public mental model. If the public status surface stabilizes, explicit public interfaces would be easier to review than a Pick/Omit over a larger internal type.

Raw event names are still native/protocol-shaped (`glasses_status`, `bluetooth_status`, `default_device_changed`, `photo_response`). That is workable for a low-level event API, but it does not feel like a polished React Native API. The hooks should be the recommended API for most customers so most users do not need those event names.

Some commands have positional parameter lists that are too long for JavaScript:

- `rgbLedControl(requestId, packageName, action, color, onDurationMs, offDurationMs, count)`
- `setMicState(enabled, useGlassesMic, bypassVad, sendTranscript, sendLc3Data)`

For React Native, options objects are usually friendlier and safer for commands with more than one or two arguments, especially when several values are optional or boolean.

## What The Example App Tells Us

The example app's large `useMentraSdk` should be split, but not all of it belongs in the SDK.

Generic lifecycle that probably belongs in SDK hooks:

- Connection state and default-device handling.
- Scanning, selecting a device, connecting, disconnecting, and clearing the default device.
- Merged glasses/Bluetooth status subscription.
- Stream lifecycle helpers around start/keep-alive/stop if the protocol is common to all customers.
- Microphone subscription lifecycle if the common customer task is "start PCM, receive frames, stop".

Demo/app-specific logic that should probably stay in the example app:

- Local photo receiver and LAN webhook setup.
- Direct WebRTC receiver setup.
- Preview polling and local demo server messages.
- Console event formatting.
- Example UI tabs and display copy.
- File-system-specific WAV writing and Expo Audio playback unless we intentionally want an Expo-specific helper package.

## Recommendation

The React Native API should have three tiers:

1. Low-level escape hatch:
   `BluetoothSdk` command methods, status getters, and `addListener`.

2. Core React hooks:
   `useBluetoothStatus`, `useBluetoothScan`, `useGlassesConnection`, and `useBluetoothEvent`.

3. Optional feature hooks:
   Small hooks for lifecycle-heavy features where almost every customer would otherwise copy the same code.

Potential feature hooks to consider:

- `usePhotoCapture()` if it only manages SDK request/response state, not local server upload infrastructure.
- `useStreamSession()` to own stream requested/active/error state and keep-alive.
- `useMicrophonePcm()` to own mic enable/disable and PCM frame subscription. A separate example helper can turn PCM into WAV/playback.
- `useGalleryMode()` if the current state/toggle lifecycle remains tricky.
- `useWifiProvisioning()` if Wi-Fi scan/connect/disconnect state remains boilerplate-heavy.

Do not add a giant `useMentraSdk` hook to the SDK. That would just move the example app's kitchen sink into the package. The better shape is small composable hooks plus one example app hook that composes them for the demo UI.

## Suggested North-Star Example

The getting-started path should look closer to this:

```tsx
import BluetoothSdk, {DeviceModels} from '@mentra/bluetooth-sdk';
import {useGlassesConnection} from '@mentra/bluetooth-sdk/react';

export function DeviceCard() {
  const glasses = useGlassesConnection({
    scanModel: DeviceModels.MentraLive,
    autoConnectDefault: true,
  });

  return (
    <>
      <Text>{glasses.connected ? 'Connected' : 'Disconnected'}</Text>
      <Button onPress={() => glasses.scan.startScan()}>
        Scan
      </Button>
      {glasses.scan.devices.map((device) => (
        <Button key={device.id} onPress={() => glasses.connect(device)}>
          Connect {device.name}
        </Button>
      ))}
      <Button disabled={!glasses.connected} onPress={glasses.disconnect}>
        Disconnect
      </Button>
    </>
  );
}
```

The imperative API should still be documented immediately after that as the escape hatch:

```ts
const devices = await BluetoothSdk.scan(DeviceModels.MentraLive, {
  onResults: (results) => {
    // Show picker updates while scanning.
  },
});

await BluetoothSdk.connect(devices[0]);
```

## Open Questions

- Should public event names remain snake_case for continuity with native/protocol events, or should React Native expose camelCase event aliases?
- Should `BluetoothStatus` be renamed or reframed in docs as "phone-side SDK state" to avoid implying it only contains Bluetooth adapter state?
- Should `requestPhoto`, `rgbLedControl`, and `setMicState` move to options-object signatures before publishing?
- Should we offer a provider, such as `MentraBluetoothProvider`, to prevent duplicate subscriptions if several screens use hooks independently?
- Which feature hooks belong in the SDK versus only in the example app?

## Rethought SDK Plan

This plan keeps the historical reason for the split between glasses state and SDK state, but stops treating either native store as the public API.

### Decision 1: Keep The Split, Rename The Mental Model

Current names:

- `GlassesStatus`: state about the wearable.
- `BluetoothStatus`: state about the phone-side SDK, discovery, routing, and desired settings.

The distinction still has a real reason. `GlassesStatus` is mostly physical device state: connection, readiness, battery, firmware, Wi-Fi, hotspot, and capabilities. `BluetoothStatus` is mostly phone-side SDK state: scanning, discovered devices, default-device persistence, microphone routing, and settings the SDK intends to apply to glasses.

The problem is not the split. The problem is exposing large status objects that look like "here is everything we have internally, good luck."

Recommendation:

- Keep native/internal store categories as `glasses` and `bluetooth` for now.
- Public React APIs should frame them as `glasses` and `sdk`, not "Bluetooth status" as the primary app mental model.
- `BluetoothStatus` can remain an internal bridge/store type, but docs and examples should steer customers to hook-returned state.
- Public hook state should be explicit and task-shaped, not a `Pick`/`Omit` projection of internal stores.

Rejected alternative:

- Do not merge everything into one `status` object. That erases a useful distinction and makes it less clear which values are reported by glasses versus managed by the phone SDK.

Pattern link:

- This follows LiveKit and Stream: both keep a lower-level session/client object but expose app-facing React state through context/hooks instead of asking every screen to inspect raw connection internals.

### Decision 2: Define A React Session Hook As The Golden Path

The example app should prove the SDK API by using a React session hook for generic lifecycle, then keeping demo-only logic in the app.

Proposed usage:

```tsx
import {DeviceModels} from '@mentra/bluetooth-sdk';
import {useMentraBluetooth} from '@mentra/bluetooth-sdk/react';

export function DeviceTab() {
  const mentra = useMentraBluetooth({
    defaultModel: DeviceModels.MentraLive,
    autoConnectDefault: true,
  });

  return (
    <>
      <Text>{mentra.glasses.connection.state}</Text>
      <Button disabled={mentra.scan.active} onPress={() => mentra.scan.start()}>
        Scan
      </Button>
      {mentra.scan.devices.map((device) => (
        <Button key={device.id} onPress={() => mentra.connect(device)}>
          Connect {device.name}
        </Button>
      ))}
      <Button disabled={!mentra.glasses.connected} onPress={mentra.disconnect}>
        Disconnect
      </Button>
    </>
  );
}
```

Possible shape:

```ts
type MentraBluetoothSession = {
  error: unknown | null;
  busy: boolean;
  glasses: GlassesRuntimeState;
  sdk: PhoneSdkRuntimeState;
  scan: ScanController;
  connect(device?: Device, options?: ConnectOptions): Promise<void>;
  connectDefault(options?: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  refresh(): Promise<void>;
};
```

This is not a proposal to move the whole example app's `useMentraSdk` into the package. It is a proposal to move only generic Bluetooth lifecycle into the package.

Rejected alternative:

- Do not add a giant `useMentraSdk()` SDK hook that owns photo demo servers, local WebRTC receiver setup, WAV writing, UI copy, and example-specific state. That would just move app complexity into the SDK.

Pattern link:

- Apollo and Ably show why hooks should return state plus actions. The component should see `loading/error/data` or `presence/actions`, not wire up listeners itself.
- BLE PLX shows the lower-level alternative: raw scan callbacks, duplicate devices, explicit stop calls. That is useful as an escape hatch, but our product SDK can do better because it knows Mentra device models and readiness semantics.

### Decision 3: Make Status State Discriminated Where It Prevents Impossible UI

The current `Partial<GlassesStatus>` pattern makes impossible states easy: a disconnected app can still show stale battery, Wi-Fi, firmware, or hotspot values.

Proposed public shape:

```ts
type GlassesRuntimeState =
  | {
      connection: {state: 'disconnected'};
      connected: false;
      ready: false;
    }
  | {
      connection: {state: 'scanning' | 'connecting' | 'bonding'};
      connected: false;
      ready: false;
    }
  | {
      connection: {state: 'connected'; fullyBooted: boolean};
      connected: true;
      ready: boolean;
      device: ConnectedGlassesInfo;
      battery: BatteryState;
      wifi: WifiStatus;
      hotspot: HotspotStatus;
    };
```

This should be the hook-facing shape. Raw status snapshot loading can stay inside the SDK hook implementation, but the example app should not have to manually initialize disconnected state or remember which fields are stale.

Do not expose inferred capabilities yet. For example, display support is currently inferred in the example UI from model strings. That is acceptable demo logic, but the SDK should only expose `capabilities.display` after native/glasses provide a real reported value.

Rejected alternative:

- Do not rely on `Partial<GlassesStatus>` as the main hook shape. It mirrors native event patches, not app state.

Pattern link:

- Expo Camera is a useful comparison: direct commands are simple methods, but lifecycle-sensitive state such as permissions gets a hook because UI needs a safe current state.

### Decision 4: Command Promises Should Mean "Command Accepted", Not "World Reached Desired State"

Current lifecycle check:

- Native `DeviceStore` initializes disconnected glasses state, disabled hotspot, disconnected Wi-Fi, empty scan results, and default settings such as `gallery_mode`.
- Internal React status plumbing loads initial snapshots and merges native status/event patches; the exported hook exposes shaped state.
- `connect(device)` saves default-device state if requested, sets pending wearable state, and calls native `connectByName(...)`. It does not guarantee the glasses are fully booted when the promise resolves.
- `scan(...)` is different: it is intentionally a time-bounded operation. It returns final results after timeout/cancellation and can also stream intermediate results through `onResults`.
- `requestPhoto(...)`, `startStream(...)`, `setMicState(...)`, and `setGalleryModeEnabled(...)` request behavior. The resulting state or response arrives through events/status updates.

Public contract:

- Commands resolve when the SDK accepted or dispatched the request to native code.
- Readiness and completion should be observed through hook state/events.
- Hooks may provide action state such as `"connecting"` or `"startingStream"` so UI can show progress immediately.
- Feature hooks should subscribe to completion events and expose domain-specific state when that is the common customer need.

Example:

```tsx
await mentra.connect(device);

// Do not assume ready here.
// Render from mentra.glasses.ready instead.
if (mentra.glasses.ready) {
  await BluetoothSdk.displayText('Hello');
}
```

Rejected alternative:

- Do not make `connect()` block until fully booted unless we intentionally rename it to something like `connectAndWaitUntilReady()`. Blocking inside a command hides real lifecycle and creates awkward timeout semantics.

Pattern link:

- LiveKit connection and media state are long-lived and event-driven; commands initiate lifecycle, hooks render actual lifecycle. We should follow that instead of pretending every command is synchronous state transition.

### Decision 5: Separate Desired Settings From Reported Device State

Gallery mode is a good example of the subtlety.

Current behavior:

- `gallery_mode` lives in the phone-side SDK settings store.
- `setGalleryModeEnabled(true | false)` writes that desired setting and asks connected glasses to apply it.
- The public app currently treats that value as if it always represents confirmed glasses behavior.

Recommendation:

- Hook state should label this clearly as desired SDK setting unless the glasses protocol provides a confirmed reported value.
- Example UI copy should be "Requested mode" or should optimistically show the setting with a short "sent to glasses" action state.
- If we later get a real device ack/reported state, model it separately.

Possible shape:

```ts
type GalleryModeState = {
  enabled: boolean;
  applying: boolean;
  lastError: unknown | null;
};
```

Rejected alternative:

- Do not silently move desired settings into `GlassesRuntimeState` unless they are actually reported by the glasses.

Pattern link:

- This is the same state-vs-command split Apollo and Ably make: local/requested action state and server/device-confirmed state should not be conflated.

### Decision 6: Add Feature Hooks Only Where Lifecycle Is The Product

Good candidates:

```ts
function useMentraBluetooth(options?: UseMentraBluetoothOptions): MentraBluetoothSession;
function useBluetoothEvent<EventName extends BluetoothSdkEventName>(...): void;
function usePhotoCapture(options?: UsePhotoCaptureOptions): PhotoCaptureController;
function useStreamSession(options?: UseStreamSessionOptions): StreamSessionController;
function useMicrophonePcm(options?: UseMicrophonePcmOptions): MicrophonePcmController;
function useWifiProvisioning(options?: UseWifiProvisioningOptions): WifiProvisioningController;
function useGalleryMode(options?: UseGalleryModeOptions): GalleryModeController;
```

Guardrail:

- Each hook should remove listener/timer/scan cleanup that customers would otherwise copy.
- If a hook mostly wraps one command without lifecycle state, do not add it.

Rejected alternative:

- Do not add a hook for every command. `displayText()`, `clearDisplay()`, `setHeadUpAngle()`, and similar one-off commands should stay imperative unless we find repeated lifecycle bugs.

Pattern link:

- Expo Camera does not turn every command into a hook. It adds hooks around platform-owned/lifecycle state. We should be similarly restrained.

### Decision 7: Options Objects For Complex Commands Before Publishing

Commands with several booleans or optional values are easy to call incorrectly:

```ts
BluetoothSdk.setMicState(true, true, true);
BluetoothSdk.rgbLedControl(requestId, packageName, action, color, onMs, offMs, count);
```

Preferred shape:

```ts
await BluetoothSdk.setMicrophone({
  enabled: true,
  source: 'glasses',
  vad: 'bypass',
  output: 'pcm',
});

await BluetoothSdk.requestPhoto({
  requestId,
  appId,
  size: 'medium',
  webhookUrl,
  compress: 'medium',
  sound: true,
});

await BluetoothSdk.setRgbLed({
  requestId,
  action: 'on',
  color: 'green',
  pattern: {onMs: 500, offMs: 500, count: 3},
});
```

Rejected alternative:

- Do not keep long positional APIs for newly published JavaScript SDK surfaces just because they mirror the native bridge. They are not idiomatic React Native/TypeScript.

Pattern link:

- Apollo mutations, Stream operations, and most modern React SDK APIs prefer named options where commands can grow. This makes examples copy-pasteable and harder to misuse.

### Example App Migration Plan

1. Introduce the new public hook shape without removing low-level APIs.
2. Update the React Native example app's `useMentraSdk` to consume the SDK hook for:
   - Initial glasses/sdk/default-device snapshot loading.
   - Native listener cleanup.
   - Scan device list, selected device, stop-on-unmount, and connect actions.
   - Disconnected-state clearing.
   - Gallery-mode desired setting lifecycle if we add `useGalleryMode`.
3. Keep example-local logic for:
   - Local photo receiver.
   - Direct WebRTC receiver.
   - Stream preview health polling.
   - PCM-to-WAV file writing and playback UI.
   - Console event formatting.
4. Rewrite docs so the first examples use hooks and root imperative commands.
5. Do not publish raw React Native `BluetoothStatus` / `GlassesStatus` snapshots as the main partner surface. They can stay inside the internal bridge used by MentraOS and by the hooks.

Success criterion:

- A partner can build a connection picker without manually subscribing to `onBluetoothStatus`.
- A partner can render connected/disconnected UI without stale battery or Wi-Fi values.
- A partner can understand whether a displayed setting is desired-by-phone or reported-by-glasses.
- The example app loses generic lifecycle plumbing instead of gaining another abstraction layer on top of it.

### First Implementation Slice

Implemented first:

- Added `useMentraBluetooth()` as a React session hook that composes the existing scan/status/connection hooks.
- Moved the React Native example app's generic lifecycle to that hook:
  - Initial glasses/sdk/default-device snapshot loading.
  - Default-device storage synchronization.
  - Scan result state and selected device state.
  - Connect, connect-default, disconnect, and clear-default actions.
  - Gallery-mode desired setting state.
- Removed raw status listeners from the example app and stopped exporting raw status hooks from `@mentra/bluetooth-sdk/react`.
- Kept native/store snapshots in the private bridge only, so the public React Native hook returns shaped `glasses`, `sdk`, and `scan` state.
- Kept demo-specific logic in the example app: local photo receiver, direct stream receiver, stream preview polling, PCM WAV writing, playback, UI copy, and event formatting.

Deferred:

- Options-object command signatures.
- Feature hooks for photo, stream, microphone, Wi-Fi, and gallery mode.
- Public capability fields such as display support until the SDK has real native/glasses-reported data rather than model-name inference.
