# Spike: Device State & Hardware Events — SDK v3

**Issue:** 048
**Related:** [SDK v3 spike](./spike.md), [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md), [session.mic spike](./session-mic-spike.md), [session.speaker spike](./session-speaker-spike.md), [session.camera spike](./session-camera-spike.md), [046 store compatibility detection](../046-store-compatibility-detection)
**Status:** Spike
**Date:** 2026-03-18

---

## Overview

**What this doc covers:** The full device state and hardware events system for SDK v3 — the Observable pattern for reactive device properties, hardware input events (buttons, head position, touch/gestures), glasses battery, WiFi status and setup, VPS coordinates, the capabilities system, and how all of this consolidates into `session.device`. Covers current architecture audit, known issues, the unified v3 API, and open design questions.

**What this doc does NOT cover:** Phone-side state (`session.phone` — see [session-phone-spike.md](./session-phone-spike.md)), audio input/output (see `session.mic` and `session.speaker` spikes), display (see `session.display`), or the broader SDK v3 migration plan (see [spike.md](./spike.md)).

**Key principle:** `session.device` is the single surface for everything about the physical glasses hardware — what model is connected, what it can do (capabilities), what state it's in (battery, WiFi, charging), and what hardware events it produces (buttons, gestures, head position). Today this is scattered across `session.events`, `session.capabilities`, `session.device.state`, `session.getWifiStatus()`, `session.requestWifiSetup()`, and raw `GLASSES_CONNECTION_STATE` data. V3 consolidates all of it.

**Key decision (from remaining-work.md):** Do NOT flatten `device.state`. The 039 API map (D14) proposed flattening `session.device.state.batteryLevel` → `session.device.batteryLevel`, but `session.device` already has hardware events, WiFi actions, capabilities, and gesture subscriptions. Adding all Observable state properties on the same level makes it too crowded. Keeping `session.device.state` as a sub-object is cleaner — two levels of nesting is fine when `state` is a coherent group of read-only reactive values. This overrides 039 D14.

---

## Current Architecture (v2)

### DeviceState Observable Pattern

**SDK:** `DeviceState` — 87 lines (`device-state.ts`)
**SDK:** `Observable<T>` — 130 lines (`utils/Observable.ts`)

The `DeviceState` class holds 13 `Observable<T>` properties representing the glasses' current state:

```typescript
// device-state.ts — 13 observable properties
class DeviceState {
  // WiFi (3)
  readonly wifiConnected: Observable<boolean>;
  readonly wifiSsid: Observable<string | null>;
  readonly wifiLocalIp: Observable<string | null>;
  // Battery (6)
  readonly batteryLevel: Observable<number | null>;
  readonly charging: Observable<boolean | null>;
  readonly caseBatteryLevel: Observable<number | null>;
  readonly caseCharging: Observable<boolean | null>;
  readonly caseOpen: Observable<boolean | null>;
  readonly caseRemoved: Observable<boolean | null>;
  // Hotspot (2)
  readonly hotspotEnabled: Observable<boolean | null>;
  readonly hotspotSsid: Observable<string | null>;
  // Connection & Device (2)
  readonly connected: Observable<boolean>;
  readonly modelName: Observable<string | null>;
}
```

Each `Observable<T>` provides:

- `observable.value` — synchronous read of the current value
- `observable.onChange(callback)` — register a listener, returns a cleanup function
- Smart initialization: `onChange` only fires the initial callback if `setValue()` has been called at least once (prevents spurious callbacks with default values)
- Change detection: `setValue()` uses strict equality (`===`) — listeners only fire when the value actually changes
- Error isolation: each callback is wrapped in try/catch so one failing listener doesn't kill others
- Implicit coercion: implements `valueOf()` and `Symbol.toPrimitive` so `if (observable) { ... }` works

`DeviceState` is exposed on `AppSession` as:

```typescript
// AppSession constructor — L400
this.device = { state: new DeviceState(this) };
```

Note the wrapping: `session.device` is a plain object with a `state` property. There's no `DeviceManager` class in v2 — `device` is just `{ state: DeviceState }`.

### How DeviceState Gets Updated

Two sources feed device state:

**Source 1 — REST (primary, from mobile app):**

The phone app posts partial `GlassesInfo` updates to `POST /api/client/device/state`. The cloud's `DeviceManager` merges the partial update into its stored `deviceState` and broadcasts a `DEVICE_STATE_UPDATE` message to all connected apps.

**Source 2 — WebSocket (from glasses connection events):**

When glasses connect or disconnect, the `GLASSES_CONNECTION_STATE` message includes model name and WiFi info. The cloud's `glasses-message-handler.ts` converts this to a `updateDeviceState()` call:

```typescript
await userSession.deviceManager.updateDeviceState({
  connected: isConnected,
  modelName: isConnected ? message.modelName || null : null,
  wifiConnected: message.wifi?.connected,
  wifiSsid: message.wifi?.ssid ?? undefined,
  timestamp: new Date().toISOString(),
});
```

**Cloud → SDK flow:**

1. `DeviceManager.updateDeviceState(partial)` stores the update
2. `broadcastDeviceStateToApps(state)` sends `DEVICE_STATE_UPDATE` to all connected app WebSockets with **only the changed fields**
3. On app connect: `sendFullStateSnapshot(ws)` sends the complete state as `DEVICE_STATE_UPDATE` with `fullSnapshot: true`
4. SDK receives the message, calls `this.device.state.updateFromMessage(message.state)` which selectively sets only the Observables for fields present in the incoming update

The `GlassesInfo` type (shared `@mentra/types` package) defines the full shape with ~20+ fields. `DeviceState` exposes a reactive subset of 13 — it omits static metadata like `androidVersion`, `fwVersion`, `buildNumber`, `serialNumber`, `hotspotPassword`, `style`, `color`, `appVersion`, `bluetoothName`, `otaVersionUrl`. These are metadata-only fields that don't change reactively and aren't useful for Observable subscription.

### Hardware Events

Hardware events (buttons, head position, touch, gestures, battery, VPS) originate from the glasses, flow through the phone to the cloud, and are relayed to subscribed mini apps. They all arrive at the SDK as `DATA_STREAM` messages with different `streamType` values.

#### Button Press

**Type:**

```typescript
interface ButtonPress {
  type: "button_press";
  buttonId: string;
  pressType: "short" | "long";
}
```

**Cloud routing:** Falls through to the `default` case in `glasses-message-handler.ts` → `relayMessageToApps()`. However, button presses also have a **dedicated REST endpoint** (`POST /api/hardware/button-press`) with special logic: if no apps are subscribed to `button_press`, the cloud triggers a system photo request instead (hardware capture button behavior).

**SDK:** `session.events.onButtonPress(handler)` or `session.onButtonPress(handler)` (convenience wrapper).

#### Head Position

**Type:**

```typescript
interface HeadPosition {
  type: "head_position";
  position: "up" | "down";
}
```

**Cloud routing:** Dedicated `handleHeadPosition()` handler — if position is `"up"`, triggers `dashboardManager.onHeadsUp()` (cycles dashboard content). Sends PostHog tracking event. Then `relayMessageToApps()`.

**SDK:** `session.events.onHeadPosition(handler)` or `session.onHeadPosition(handler)`.

#### Touch Events & Gestures

**Type:**

```typescript
interface TouchEvent {
  type: "touch_event";
  device_model: string;
  gesture_name: string;
  timestamp: Date;
}
```

**Valid gestures:** `single_tap`, `double_tap`, `triple_tap`, `long_press`, `forward_swipe`, `backward_swipe`, `up_swipe`, `down_swipe`.

**Cloud routing:** The most sophisticated routing of any hardware event. The cloud's `handleTouchEvent()` supports **dual routing**: it checks both gesture-specific subscriptions (`touch_event:triple_tap`) AND base subscriptions (`touch_event`), deduplicates subscribers, and sends with the appropriate `streamType` per app (gesture-specific if that's what the app subscribed to, base otherwise).

**SDK — two registration patterns:**

```typescript
// Pattern 1: all touch events
session.events.onTouchEvent((event) => { ... })

// Pattern 2: specific gesture
session.events.onTouchEvent("triple_tap", (event) => { ... })
```

Under the hood, pattern 2 creates a stream subscription of `"touch_event:triple_tap"` via `createTouchEventStream(gesture)`.

**Bulk gesture subscription:**

```typescript
session.subscribeToGestures(["single_tap", "double_tap"]);
```

This creates individual stream subscriptions for each gesture. However, this method has a bug — it bypasses the EventManager's handler tracking (calls `subscribe()` directly alongside `events.onTouchEvent()` for each gesture), potentially causing dangling subscriptions.

#### Glasses Battery

**Type:**

```typescript
interface GlassesBatteryUpdate {
  type: "glasses_battery_update";
  level: number; // 0-100
  charging: boolean;
  timeRemaining?: number; // minutes
}
```

**Cloud routing:** Falls through to `default` → `relayMessageToApps()`.

**SDK:** `session.events.onGlassesBattery(handler)`.

**Dual delivery:** Battery info arrives at apps via TWO paths:

1. **Event-based:** `onGlassesBattery()` — per-event, real-time, requires explicit subscription
2. **State-based:** `device.state.batteryLevel.onChange()` — reactive Observable, updated via `DEVICE_STATE_UPDATE` from cloud

Both should be consistent (same source), but they're conceptually duplicate — one is a subscription-based event stream, the other is a state observation. This is confusing.

#### VPS Coordinates

**Type:**

```typescript
interface VpsCoordinates {
  type: "vps_coordinates";
  deviceModel: string;
  requestId: string;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  confidence: number;
}
```

VPS (Visual Positioning System) coordinates represent 3D position + quaternion orientation from visual SLAM/localization.

**Cloud routing:** Falls through to `default` → `relayMessageToApps()`. No VPS-specific handling on the cloud side.

**SDK:** `session.events.onVpsCoordinates(handler)` and `session.onVpsCoordinates(handler)`.

**Assessment:** VPS is **dormant/future-proofed**. The full plumbing exists end-to-end (types, stream enum, event handlers, relay), but:

- No VPS-specific logic on the cloud
- No `hasVPS` in `Capabilities`
- No current glasses hardware known to send VPS data
- The `onVpsCoordinates` wrapper on `AppSession` has a subscription leak (calls `subscribe()` directly AND registers via `events.onVpsCoordinates()`, creating a dangling subscription on cleanup)

It would work if glasses started sending VPS data, but it's never been tested in production.

### Glasses Connection State

`GLASSES_CONNECTION_STATE` messages carry model name, connection status, and WiFi info. The SDK stores this in a private `glassesConnectionState: any` field (typed as `any` — not type-safe) and uses it for the legacy WiFi methods:

```typescript
// AppSession L1217-1230
getWifiStatus() {
  if (!this.capabilities?.hasWifi) return null;
  return this.glassesConnectionState?.wifi || null;
}
isWifiConnected(): boolean {
  return this.getWifiStatus()?.connected === true;
}
```

This is a **separate system** from `DeviceState`. WiFi status exists in two places:

1. `this.glassesConnectionState?.wifi` — from `GLASSES_CONNECTION_STATE` stream data
2. `this.device.state.wifiConnected` — from `DEVICE_STATE_UPDATE` Observable

Both originate from the same cloud `DeviceManager`, but they're stored and accessed differently. Developers who use `getWifiStatus()` get a different code path than developers who use `device.state.wifiConnected.value`.

### WiFi Setup Request

```typescript
// AppSession L1237-1251
requestWifiSetup(reason?: string): void {
  const message = {
    type: "request_wifi_setup",
    packageName: this.config.packageName,
    sessionId: this.sessionId,
    // reason field constructed below
    timestamp: new Date(),
  };
  this.send(message);
}
```

The cloud handler in `app-message-handler.ts` forwards this as `SHOW_WIFI_SETUP` to the mobile app via its WebSocket, which triggers a WiFi setup popup on the user's phone.

Additionally, `ConnectionValidator.validateWifiForOperation()` is used to gate streaming operations (RTMP, managed streams) — if the device has WiFi capability but isn't connected, the request is blocked with `WIFI_NOT_CONNECTED`.

### Capabilities System

**Type:**

```typescript
interface Capabilities {
  modelName: string;
  hasCamera: boolean;
  camera: CameraCapabilities | null;
  hasDisplay: boolean;
  display: DisplayCapabilities | null;
  hasMicrophone: boolean;
  microphone: MicrophoneCapabilities | null;
  hasSpeaker: boolean;
  speaker: SpeakerCapabilities | null;
  hasIMU: boolean;
  imu: IMUCapabilities | null;
  hasButton: boolean;
  button: ButtonCapabilities | null;
  hasLight: boolean;
  light: LightCapabilities | null;
  power: PowerCapabilities;
  hasWifi: boolean;
}
```

**Supported models:** Even Realities G1, Even Realities G2, Mentra Live, Simulated Glasses, Vuzix Z100, None (fallback).

Capabilities are defined in `HARDWARE_CAPABILITIES` as a static record mapping model names to capability profiles.

**Cloud-side flow:**

1. `DeviceManager` derives capabilities from the current model via `getCapabilitiesForModel(modelName)`.
2. When the model changes (via connection state or REST update):
   - Broadcasts `CAPABILITIES_UPDATE` to all connected apps.
   - Runs `stopIncompatibleApps()` via `HardwareCompatibilityService` — checks each running app's hardware requirements against current capabilities. Incompatible apps are stopped.

**SDK-side flow:**

1. Capabilities arrive in `CONNECTION_ACK` at app startup → stored in `session.capabilities`.
2. `CAPABILITIES_UPDATE` messages update `session.capabilities` and fire `events.emit("capabilities_update", ...)`.

**The `session.capabilities` access path:**

```typescript
// Direct on AppSession
session.capabilities; // → Capabilities object
session.events.onCapabilitiesUpdate(handler);
```

Per the 039 API map, this moves to `session.device.capabilities` in v3.

### Two Capability Definition Locations

Capabilities are defined in **two places** that can drift:

1. `packages/types/src/capabilities/` — shared types package, exports model-specific profiles
2. `packages/cloud/src/config/capabilities/` — cloud package, has its own copies used by `getCapabilitiesForModel()`

This duplication is a maintenance risk — a change to capabilities in the types package won't automatically propagate to the cloud's config if they're out of sync.

---

## Issues

| #   | Issue                                                              | Impact                                                                                                                                                                                                                                              | Root Cause                                                                                                                                                                              |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Dual WiFi state systems**                                        | `getWifiStatus()` reads from `glassesConnectionState` (raw stream data); `device.state.wifiConnected` reads from Observable. Developers can get different answers from different APIs.                                                              | WiFi status was added to `DeviceState` after the legacy `getWifiStatus()` already existed. Nobody unified them.                                                                         |
| 2   | **`glassesConnectionState` typed as `any`**                        | No type safety for the legacy WiFi access path.                                                                                                                                                                                                     | Comment in code: "Using any for now since GlassesConnectionState is in glasses-to-cloud types." Never fixed.                                                                            |
| 3   | **Battery delivered via two mechanisms**                           | `onGlassesBattery()` (event subscription) and `device.state.batteryLevel.onChange()` (Observable) — same data, two paths, developer confusion.                                                                                                      | Subscription-based events and state-based Observables were designed as separate systems that happen to overlap for battery.                                                             |
| 4   | **`subscribeToGestures` bypasses EventManager**                    | Creates dangling subscriptions that aren't tracked by the handler-based subscription system (Bug 007 fix).                                                                                                                                          | Method calls `subscribe()` directly for each gesture alongside `events.onTouchEvent()`, double-subscribing.                                                                             |
| 5   | **`onVpsCoordinates` has a subscription leak**                     | Calls `subscribe()` directly AND registers via `events.onVpsCoordinates()`, creating duplicate subscriptions. Cleanup function only removes the handler-based one.                                                                                  | Copy-paste pattern — same bug as `onPhotoTaken()` in `AppSession`.                                                                                                                      |
| 6   | **`sanitizeEventData` is incomplete**                              | Only sanitizes `TRANSCRIPTION`, `HEAD_POSITION`, and `BUTTON_PRESS`. Battery, touch, VPS, and connection state events pass through without sanitization. Malformed data hits handlers raw.                                                          | Sanitization was added ad-hoc for the three most common events, never extended to all.                                                                                                  |
| 7   | **Capabilities defined in two packages**                           | `packages/types/` and `packages/cloud/src/config/capabilities/` both define capability profiles. Can drift silently.                                                                                                                                | Cloud needed runtime access to capabilities and copied the definitions rather than importing from the types package.                                                                    |
| 8   | **Hardware events on `session.events` alongside unrelated events** | Button presses, head position, touch events, battery — all mixed with transcription, notifications, location, and system events on the same `EventManager`.                                                                                         | v2 put everything on one event bus with no namespacing.                                                                                                                                 |
| 9   | **No device state snapshot on reconnection**                       | When the SDK reconnects after a transport blip, `DeviceState` Observables retain their last-known values (in-memory). But if the app server process restarted (resurrection), all Observables are at defaults until the next `DEVICE_STATE_UPDATE`. | `DeviceState` is ephemeral in-memory state. Cloud sends `fullSnapshot` on initial connect but not on reconnect (it sends it on `handleAppInit` which only fires for fresh connections). |
| 10  | **WiFi setup has no response/callback**                            | `requestWifiSetup()` is fire-and-forget — no promise, no callback, no confirmation. The developer can't know if the user completed WiFi setup.                                                                                                      | WiFi setup triggers a UI on the phone; the result flows back as a `DEVICE_STATE_UPDATE` (WiFi connected), which the developer would have to listen for separately.                      |
| 11  | **Button press dual path (REST + WebSocket)**                      | Button presses arrive via both WS (glasses message handler default case) and REST (`POST /api/hardware/button-press`). The REST path has special logic (system photo if no subscribers) that the WS path doesn't.                                   | Button press REST endpoint was added for the hardware capture button use case and has divergent behavior from the WS relay path.                                                        |

---

## Proposed v3 API

### `session.device`

```typescript
// ─── Reactive State (Observable) ────────────────
session.device.state.connected              // Observable<boolean>
session.device.state.modelName              // Observable<string | null>
session.device.state.batteryLevel           // Observable<number | null>
session.device.state.charging               // Observable<boolean | null>
session.device.state.caseBatteryLevel       // Observable<number | null>
session.device.state.caseCharging           // Observable<boolean | null>
session.device.state.caseOpen               // Observable<boolean | null>
session.device.state.caseRemoved            // Observable<boolean | null>
session.device.state.wifiConnected          // Observable<boolean>
session.device.state.wifiSsid              // Observable<string | null>
session.device.state.wifiLocalIp           // Observable<string | null>
session.device.state.hotspotEnabled         // Observable<boolean | null>
session.device.state.hotspotSsid           // Observable<string | null>

// ─── Hardware Events (subscription-based) ───────
session.device.onButtonPress(handler)              // → () => void
session.device.onHeadPosition(handler)             // → () => void
session.device.onTouchEvent(handler)               // → () => void (all touch events)
session.device.onTouchEvent(gesture, handler)      // → () => void (specific gesture)
session.device.subscribeToGestures(gestures)       // → () => void (bulk gesture sub)
session.device.onBatteryUpdate(handler)            // → () => void (glasses battery events)

// ─── VPS (dormant — future hardware) ────────────
session.device.onVpsCoordinates(handler)           // → () => void

// ─── Actions ────────────────────────────────────
session.device.requestWifiSetup(reason?: string)   // → void (fire-and-forget)

// ─── Capabilities ───────────────────────────────
session.device.capabilities                        // → Capabilities (read-only)
session.device.onCapabilitiesChange(handler)       // → () => void
```

### Type Definitions

```typescript
// ─── Observable Pattern (unchanged from v2) ─────

/**
 * Reactive value wrapper. Read synchronously, subscribe to changes.
 * Listeners only fire after the first setValue() call (no spurious defaults).
 * Change detection uses strict equality (===).
 */
interface Observable<T> {
  /** Current value (synchronous read). */
  readonly value: T;

  /** Subscribe to value changes. Returns cleanup function.
   *  If a value has already been set, fires immediately with current value. */
  onChange(callback: (value: T) => void): () => void;
}

// ─── Device State ───────────────────────────────

interface DeviceStateObservables {
  // Connection
  readonly connected: Observable<boolean>;
  readonly modelName: Observable<string | null>;

  // Battery
  readonly batteryLevel: Observable<number | null>;
  readonly charging: Observable<boolean | null>;
  readonly caseBatteryLevel: Observable<number | null>;
  readonly caseCharging: Observable<boolean | null>;
  readonly caseOpen: Observable<boolean | null>;
  readonly caseRemoved: Observable<boolean | null>;

  // WiFi
  readonly wifiConnected: Observable<boolean>;
  readonly wifiSsid: Observable<string | null>;
  readonly wifiLocalIp: Observable<string | null>;

  // Hotspot
  readonly hotspotEnabled: Observable<boolean | null>;
  readonly hotspotSsid: Observable<string | null>;
}

// ─── Hardware Events ────────────────────────────

interface ButtonPressEvent {
  buttonId: string;
  pressType: "short" | "long";
  timestamp: number;
}

interface HeadPositionEvent {
  position: "up" | "down";
  timestamp: number;
}

interface TouchEventData {
  gesture: string; // renamed from gesture_name (camelCase consistency)
  model: string; // renamed from device_model
  timestamp: number;
}

type GestureType =
  | "single_tap"
  | "double_tap"
  | "triple_tap"
  | "long_press"
  | "forward_swipe"
  | "backward_swipe"
  | "up_swipe"
  | "down_swipe";

interface BatteryUpdateEvent {
  level: number; // 0-100
  charging: boolean;
  timeRemaining?: number; // minutes
  timestamp: number;
}

interface VpsCoordinatesEvent {
  model: string;
  requestId: string;
  position: { x: number; y: number; z: number };
  orientation: { qx: number; qy: number; qz: number; qw: number };
  confidence: number;
  timestamp: number;
}

// ─── Capabilities ───────────────────────────────

interface Capabilities {
  modelName: string;
  hasCamera: boolean;
  camera: CameraCapabilities | null;
  hasDisplay: boolean;
  display: DisplayCapabilities | null;
  hasMicrophone: boolean;
  microphone: MicrophoneCapabilities | null;
  hasSpeaker: boolean;
  speaker: SpeakerCapabilities | null;
  hasIMU: boolean;
  imu: IMUCapabilities | null;
  hasButton: boolean;
  button: ButtonCapabilities | null;
  hasLight: boolean;
  light: LightCapabilities | null;
  power: PowerCapabilities;
  hasWifi: boolean;
}

// Sub-capabilities unchanged from v2 — CameraCapabilities, DisplayCapabilities, etc.
```

### Usage Examples

```typescript
// ─── Reactive state observation ─────────────────

// Battery monitoring
session.device.state.batteryLevel.onChange((level) => {
  if (level !== null && level < 20) {
    session.display.showText("Low battery!");
  }
});

// WiFi status
session.device.state.wifiConnected.onChange((connected) => {
  if (connected) {
    startVideoUpload();
  }
});

// Read current value (synchronous)
const currentBattery = session.device.state.batteryLevel.value;
const isCharging = session.device.state.charging.value;

// ─── Hardware events ────────────────────────────

// Button press
const stopButton = session.device.onButtonPress((event) => {
  if (event.pressType === "long") {
    toggleRecording();
  }
});

// Head position (used for dashboard cycling, etc.)
session.device.onHeadPosition((event) => {
  if (event.position === "up") {
    showDashboard();
  }
});

// Specific gesture
session.device.onTouchEvent("double_tap", (event) => {
  togglePause();
});

// All touch events
session.device.onTouchEvent((event) => {
  console.log(`Gesture: ${event.gesture} on ${event.model}`);
});

// Bulk gesture subscription
const stopGestures = session.device.subscribeToGestures([
  "single_tap",
  "double_tap",
  "forward_swipe",
  "backward_swipe",
]);

// Battery event (per-event, subscription-based — as opposed to Observable)
session.device.onBatteryUpdate((event) => {
  console.log(`Battery: ${event.level}%, charging: ${event.charging}`);
});

// ─── WiFi setup ─────────────────────────────────

session.device.requestWifiSetup("Video upload requires WiFi");

// ─── Capabilities ───────────────────────────────

if (session.device.capabilities.hasCamera) {
  session.camera.takePhoto();
}

session.device.onCapabilitiesChange((caps) => {
  // Model changed — maybe user switched glasses
  console.log(`Now connected to: ${caps.modelName}`);
});

// Cleanup
stopButton();
stopGestures();
```

---

## Design: Observable vs onChange Callbacks

### The Question

The current `DeviceState` uses a custom `Observable<T>` pattern. Should v3 keep this or switch to a simpler getter + onChange callback?

### The Answer: Keep Observable<T>

The `Observable<T>` pattern is already working, well-tested, and has the right semantics:

1. **Synchronous read** (`observable.value`) — no async, no awaiting
2. **Reactive subscription** (`observable.onChange(cb)`) — auto-fires with current value if already initialized
3. **Cleanup function** — returned by `onChange()`, matches the v3 cleanup pattern everywhere
4. **Change detection** — only fires on actual changes, not on every update
5. **Error isolation** — one bad callback doesn't kill others

A simpler getter + onChange callback would look like:

```typescript
// Alternative (NOT recommended):
session.device.getBatteryLevel(); // getter
session.device.onBatteryLevelChange(cb); // onChange
```

This has two problems: (a) it doubles the API surface (getter + listener for each property), and (b) the getter is a function call rather than a property read. The Observable wraps both into one object.

The only downside of Observable is the `.value` access pattern — `session.device.state.batteryLevel.value` instead of `session.device.state.batteryLevel`. But this is unavoidable for a reactive value that needs both read and subscribe. It's the same tradeoff React's `useRef().current` makes.

**Decision:** Keep `Observable<T>` as-is. No changes to the Observable class.

---

## Design: Consolidating Battery — Observable vs Event

### The Problem

Glasses battery is delivered through TWO mechanisms:

1. **Event-based:** `onGlassesBattery(handler)` → subscription to `glasses_battery_update` stream → fires per-event
2. **State-based:** `device.state.batteryLevel.onChange(handler)` → reactive Observable → fires on state change

Both deliver the same information (battery level, charging status) but through different APIs. A developer might use one, both, or mix them without realizing they're redundant.

### The Answer: Keep Both, But Make the Relationship Clear

The two mechanisms serve different purposes:

- **Observable (`device.state.batteryLevel`):** "What is the battery level right now?" — read on demand, react to changes, no subscription needed (DeviceState updates come automatically via `DEVICE_STATE_UPDATE`).
- **Event (`device.onBatteryUpdate()`):** "Tell me every time a battery event arrives" — explicit subscription, includes `timeRemaining` and full event metadata, requires the `glasses_battery_update` stream subscription.

In practice, most apps should use the Observable. The event is for apps that need high-fidelity battery tracking (e.g., a power management app that wants `timeRemaining` or wants every single update rather than just changes).

**v3 approach:**

- `session.device.state.batteryLevel` — Observable, always available (fed by `DEVICE_STATE_UPDATE`). **Recommended** for most apps.
- `session.device.onBatteryUpdate(handler)` — event subscription, requires explicit opt-in, provides full `BatteryUpdateEvent` with `timeRemaining`. For apps that need it.

Document this clearly. The Observable is the default; the event is the advanced option.

---

## Design: Unifying WiFi Access

### The Problem

WiFi status exists in three places:

1. `session.getWifiStatus()` → reads from `glassesConnectionState` (raw `GLASSES_CONNECTION_STATE` stream data, typed as `any`)
2. `session.isWifiConnected()` → calls `getWifiStatus()?.connected === true`
3. `session.device.state.wifiConnected` → Observable fed by `DEVICE_STATE_UPDATE`

### The Fix

**Kill `getWifiStatus()` and `isWifiConnected()`.** The Observable is the correct single source:

- `session.device.state.wifiConnected.value` — current WiFi status
- `session.device.state.wifiSsid.value` — current SSID
- `session.device.state.wifiConnected.onChange(cb)` — react to changes

The legacy methods become deprecated shims:

```typescript
/** @deprecated Use session.device.state.wifiConnected.value */
getWifiStatus() {
  return {
    connected: this.device.state.wifiConnected.value,
    ssid: this.device.state.wifiSsid.value
  }
}

/** @deprecated Use session.device.state.wifiConnected.value */
isWifiConnected(): boolean {
  return this.device.state.wifiConnected.value === true
}
```

And `requestWifiSetup(reason?)` moves from session-level to `session.device.requestWifiSetup(reason?)`.

---

## Design: Moving Hardware Events from EventManager to DeviceManager

### The Problem

Today, hardware events are registered via `session.events.onButtonPress()`, `session.events.onHeadPosition()`, `session.events.onTouchEvent()`, etc. — all on the generic `EventManager` alongside completely unrelated events like transcription and phone notifications. There's no grouping by domain.

### The Fix

The `DeviceManager` owns all hardware event registrations:

```typescript
// v3 — all hardware on session.device
session.device.onButtonPress(handler);
session.device.onHeadPosition(handler);
session.device.onTouchEvent(handler);
session.device.onTouchEvent("triple_tap", handler);
session.device.subscribeToGestures(gestures);
session.device.onBatteryUpdate(handler);
session.device.onVpsCoordinates(handler);
```

Internally, the `DeviceManager` registers handlers on the `DataStreamRouter` for the relevant stream types (`button_press`, `head_position`, `touch_event`, `touch_event:*`, `glasses_battery_update`, `vps_coordinates`). The subscription system works exactly as before — registering a handler adds a subscription, removing the last handler for a stream removes the subscription.

**Touch event dual routing** works the same as v2: `onTouchEvent(handler)` subscribes to `touch_event` (all gestures), `onTouchEvent("triple_tap", handler)` subscribes to `touch_event:triple_tap` (specific gesture). The cloud's dual-routing logic is unchanged.

**`subscribeToGestures` fix:** The v2 version bypasses EventManager (calls `subscribe()` directly alongside `events.onTouchEvent()` for each gesture). The v3 version registers proper handlers internally:

```typescript
// DeviceManager.subscribeToGestures — fixed in v3
subscribeToGestures(gestures: GestureType[]): () => void {
  const cleanups = gestures.map(gesture =>
    this.onTouchEvent(gesture, (event) => {
      // Forward to a general gesture handler if the developer
      // registered one via onTouchEvent(handler) (no gesture arg)
      this.emitGesture(event)
    })
  )
  return () => cleanups.forEach(fn => fn())
}
```

Each gesture gets a proper handler registration, so cleanup removes all subscriptions correctly. No dangling subscriptions.

---

## Design: VPS Coordinates — Keep or Remove?

### Assessment

VPS (Visual Positioning System) is dormant. The full plumbing exists (types, enum, handlers, relay), but:

- No cloud-specific logic
- No `hasVPS` in `Capabilities`
- No current glasses hardware sends VPS data
- The `onVpsCoordinates` wrapper on `AppSession` has a subscription leak (double-subscribe bug)

### Decision: Keep, Fix, and Mark as Experimental

Remove the subscription leak. Move to `session.device.onVpsCoordinates(handler)`. Keep the types and plumbing. If glasses hardware starts sending VPS data, it will work immediately. No harm in keeping it — it's a handful of types and one handler registration.

Don't add `hasVPS` to `Capabilities` yet — add it when VPS-capable hardware ships.

---

## What Changes Where

### SDK

| File / Module               | Change                                                                                                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New: `DeviceManager`        | `session.device` — state observables, hardware events, WiFi, capabilities                                                                                                                                                                                                              |
| `DeviceState` (87 lines)    | Kept as `DeviceStateObservables` — internal to `DeviceManager`, exposed as `session.device.state`                                                                                                                                                                                      |
| `Observable<T>` (130 lines) | No changes — keep as-is                                                                                                                                                                                                                                                                |
| `EventManager` (574 lines)  | Remove `onButtonPress()`, `onHeadPosition()`, `onTouchEvent()`, `onGlassesBattery()`, `onVpsCoordinates()`, `onGlassesConnectionState()`, `onCapabilitiesUpdate()` — all move to `DeviceManager`                                                                                       |
| `AppSession` (2,423 lines)  | Remove `getWifiStatus()`, `isWifiConnected()`, `requestWifiSetup()`, `onButtonPress()`, `onHeadPosition()`, `onTouchEvent()`, `subscribeToGestures()`, `onVpsCoordinates()`, `onGlassesConnectionState()`, `glassesConnectionState: any`, `capabilities`. All move to `DeviceManager`. |
| `LegacyEventShim`           | `session.events.onButtonPress()` → `session.device.onButtonPress()`, etc.                                                                                                                                                                                                              |
| Deprecated getters          | `session.capabilities` → `session.device.capabilities`                                                                                                                                                                                                                                 |
| Deprecated methods          | `session.getWifiStatus()` → shim via `session.device.state`, `session.isWifiConnected()` → shim, `session.requestWifiSetup()` → `session.device.requestWifiSetup()`                                                                                                                    |
| `TouchEvent` type           | Rename `gesture_name` → `gesture`, `device_model` → `model` (camelCase consistency)                                                                                                                                                                                                    |
| `VpsCoordinates` type       | Restructure into `VpsCoordinatesEvent` with nested `position` and `orientation` objects                                                                                                                                                                                                |

### Cloud

| File / Module                | Change                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DeviceManager`              | No changes — state management and broadcasting stay the same                                                                            |
| `glasses-message-handler.ts` | No changes — event routing stays the same                                                                                               |
| `app-message-handler.ts`     | No changes — WiFi setup handling stays the same                                                                                         |
| Capability definitions       | Consider consolidating `packages/types/` and `packages/cloud/src/config/capabilities/` to eliminate duplication (separate cleanup task) |

### Wire Protocol

| Message                                           | Change                                       |
| ------------------------------------------------- | -------------------------------------------- |
| `DEVICE_STATE_UPDATE`                             | No change — same partial state updates       |
| `CAPABILITIES_UPDATE`                             | No change                                    |
| `DATA_STREAM` (button, head, touch, battery, VPS) | No change — same stream types, same payloads |
| `REQUEST_WIFI_SETUP`                              | No change                                    |

The wire protocol requires **zero changes**. All v3 work is in the SDK's `DeviceManager` — consolidating scattered access paths, fixing subscription bugs, and providing a clean namespace.

---

## Legacy Shim

```typescript
// ─── Hardware events ────────────────────────────

// v2 code:
session.events.onButtonPress(handler)
// LegacyEventShim maps to:
session.device.onButtonPress(handler)

// v2 code:
session.events.onHeadPosition(handler)
// LegacyEventShim maps to:
session.device.onHeadPosition(handler)

// v2 code:
session.events.onTouchEvent("triple_tap", handler)
// LegacyEventShim maps to:
session.device.onTouchEvent("triple_tap", handler)

// v2 code:
session.events.onGlassesBattery(handler)
// LegacyEventShim maps to:
session.device.onBatteryUpdate(handler)

// v2 code:
session.events.onVpsCoordinates(handler)
// LegacyEventShim maps to:
session.device.onVpsCoordinates(handler)

// v2 code:
session.events.onCapabilitiesUpdate(handler)
// LegacyEventShim maps to:
session.device.onCapabilitiesChange(handler)

// v2 code:
session.events.onGlassesConnectionState(handler)
// LegacyEventShim maps to:
session.device.state.connected.onChange(handler)
// (Note: v2 handler receives full GlassesConnectionState object,
//  v3 Observable fires with just the boolean. Shim wraps.)

// ─── WiFi ───────────────────────────────────────

// v2 code:
session.getWifiStatus()
// Deprecated getter maps to:
{ connected: session.device.state.wifiConnected.value,
  ssid: session.device.state.wifiSsid.value }

// v2 code:
session.isWifiConnected()
// Deprecated getter maps to:
session.device.state.wifiConnected.value === true

// v2 code:
session.requestWifiSetup(reason)
// Deprecated method maps to:
session.device.requestWifiSetup(reason)

// ─── Capabilities ───────────────────────────────

// v2 code:
session.capabilities
// Deprecated getter maps to:
session.device.capabilities

// ─── Touch event type rename ────────────────────

// v2 data shape:
{ device_model: "G1", gesture_name: "triple_tap", timestamp: ... }
// v3 data shape:
{ model: "G1", gesture: "triple_tap", timestamp: ... }
// Shim adds v2 fields as aliases on the event object
```

---

## Open Questions

| #   | Question                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Should `device.state` include `GlassesInfo` metadata fields?** | Currently, `DeviceState` omits `androidVersion`, `fwVersion`, `buildNumber`, `serialNumber`, etc. These are static/rarely-changing metadata. Should they be available as non-observable read-only properties on `session.device` (not on `.state`)? E.g., `session.device.firmwareVersion`. Useful for diagnostics but clutters the API.                              |
| 2   | **DeviceState full snapshot on reconnect**                       | Today the cloud sends `fullSnapshot: true` on initial `handleAppInit` but not on reconnect. For v3's `TRANSPORT_DOWN` → `RUNNING` transition, should the cloud re-send a full device state snapshot? The SDK preserves in-memory Observables across reconnects, but if state changed during the gap, the SDK would miss it. Leaning yes — send snapshot on reconnect. |
| 3   | **`onBatteryUpdate` — glasses only, or include case battery?**   | The current `GlassesBatteryUpdate` event includes glasses battery. Case battery comes via `DEVICE_STATE_UPDATE` (Observable only, no event). Should `onBatteryUpdate` also fire for case battery changes? Or keep case as Observable-only? Leaning: keep separate. Case battery changes infrequently.                                                                 |
| 4   | **Should `requestWifiSetup` return a Promise?**                  | Currently fire-and-forget. A Promise that resolves when WiFi connects (via `DEVICE_STATE_UPDATE`) or rejects on timeout would be much better DX. Requires the SDK to correlate the request with a subsequent state update. Worth doing but adds complexity.                                                                                                           |
| 5   | **VPS — should we remove it entirely?**                          | It's dormant. No hardware sends it. The subscription leak bug suggests it was never properly tested. Removing would be cleaner. But keeping it costs almost nothing and avoids re-adding plumbing later. Leaning keep.                                                                                                                                                |
| 6   | **Capability change — should this stop the app?**                | The cloud's `stopIncompatibleApps()` already stops apps whose hardware requirements aren't met by the new model. But from the SDK perspective, the app just sees `onCapabilitiesChange` fire and then `onStop` fire. Should `DeviceManager` emit a specific "incompatible" event before the stop?                                                                     |
| 7   | **Button press system photo fallback**                           | The REST path (`POST /api/hardware/button-press`) triggers a system photo if no apps are subscribed to `button_press`. The WS relay path doesn't have this logic. Should this be unified on the cloud side? It's a cloud concern, not SDK, but worth noting.                                                                                                          |
| 8   | **Touch event `device_model` → `model` rename**                  | The v2 field name is `device_model` (snake_case). v3 renames to `model` (shorter, consistent with `session.device.state.modelName`). The legacy shim adds `device_model` as an alias. But this means the wire protocol sends `device_model` and the SDK renames it. Fine?                                                                                             |
| 9   | **Observable `Symbol.toPrimitive` — keep or remove?**            | `Observable<T>` implements `valueOf()` and `Symbol.toPrimitive` so you can write `if (batteryLevel > 20)` without `.value`. Clever but confusing — it looks like you're comparing the Observable itself, not its value. TypeScript doesn't narrow the type correctly either. Consider removing implicit coercion and requiring `.value` always.                       |
| 10  | **Should `session.device.state` be freezable/snapshotable?**     | A `session.device.state.snapshot()` method that returns a plain object `{ connected: true, batteryLevel: 85, ... }` would be useful for logging, debugging, and sending state to analytics. Low cost, nice to have.                                                                                                                                                   |
