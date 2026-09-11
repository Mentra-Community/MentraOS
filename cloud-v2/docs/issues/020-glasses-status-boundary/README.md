# 020 - Glasses Status Boundary

**Status:** Implemented

This document is the design record for the glasses-status boundary migration.
Sections that say "current" describe the pre-migration state that motivated the
implementation.

Implementation plan: [implementation-plan.md](./implementation-plan.md).
Fable 5 handoff: [fable-5-handoff.md](./fable-5-handoff.md).

## Goal

Remove host-side access to raw glasses runtime state.

The engine/island layer owns the MentraOS smartglasses runtime: BLE/native
status, normalized glasses state, pairing readiness, wifi/hotspot state, OTA
orchestration, controller state, gallery sync, diagnostic context, and the
runtime rules that turn device events into app behavior.

The host layer owns OEM-branded UI: screens, navigation, copy, visual
treatment, alerts, modals, route transitions, and user choices. The host should
not know the internal shape of the glasses store, mutate it directly, or pass a
raw `GlassesStatus` snapshot out of engine and back into another engine/cloud
operation.

The clean boundary is:

- Engine exposes typed read models, events, and commands.
- Host renders those read models and calls those commands.
- Engine keeps the raw store, store selectors, normalization, retries, waits on
  raw store keys, and mutation methods private.

This boundary is about engine-owned state, not about pretending the Bluetooth
SDK does not exist. The Bluetooth SDK is a standalone low-level product that
customers can use to build their own glasses apps. If a connection type or
predicate is useful at that level, it probably belongs in the Bluetooth SDK. We
should not create a second engine connection type unless it adds real
MentraOS/runtime semantics beyond the Bluetooth SDK contract.

## Current Problem

`mobile/src/stores/glasses.ts` is a compatibility shim that re-exports the
island-owned glasses store into host code:

```ts
export {
  isGlassesConnected,
  isGlassesLinkLayerBusy,
  isGlassesReady,
  selectGlassesConnected,
  selectGlassesReady,
  getGlasesInfoPartial,
  getGlassesSystemTimeMs,
  useGlassesStore,
  waitForGlassesState,
} from "@mentra/engine"
```

That shim was useful while moving ownership into island, but it is now the main
leak. It lets host screens and services:

- read raw `GlassesStatus` fields;
- import connection predicates that should be engine internals;
- wait on raw store keys;
- call store mutation methods such as `setGlassesInfo`,
  `setOtaUpdateAvailable`, `setOtaProgress`, and
  `setMtkUpdatedThisSession`;
- rebuild cloud/status payloads from internal runtime state.

The result is a muddled contract: OEM UI code must understand the MentraOS
runtime store schema before it can render a branded app.

## Current Inventory

Production host code still touching raw glasses state falls into these buckets.

| Bucket | Current files | Leaked state / behavior | Boundary judgment |
| --- | --- | --- | --- |
| Compatibility shims | `mobile/src/stores/glasses.ts`, `mobile/src/stores/gallerySync.ts` | Raw island stores and selectors re-exported into host | Remove after typed facades cover the remaining host needs. |
| Legacy Cloud V1 status sync | `mobile/src/services/MantleManager.ts`, `mobile/src/services/WebSocketManager.ts`, `mobile/src/services/SocketComms.ts` | `getGlasesInfoPartial`, raw store subscriptions, battery/status sends, `setGlassesInfo` | Deletion candidate. Do not port this generic state mirror to Cloud V2 and do not add a engine API for it. Keep only until the remaining Cloud V1 feature dependencies are removed or proven dead. |
| OTA | `mobile/src/effects/OtaUpdateChecker.tsx`, `mobile/src/app/ota/check-for-updates.tsx`, `mobile/src/app/ota/progress.tsx`, `mobile/src/app/ota/progress-legacy.tsx`, `mobile/src/app/miniapps/settings/glasses.tsx` | build numbers, firmware versions, wifi state, OTA URL, update info, progress/status, `mtkUpdatedThisSession`, store mutations and waits | OTA orchestration belongs in engine. Host should render an OTA read model and call high-level commands. |
| Pairing/reconnect | `mobile/src/effects/Reconnect.tsx`, `mobile/src/effects/BtClassicPairing.tsx`, `mobile/src/app/pairing/scan.tsx`, `mobile/src/app/pairing/btclassic.tsx`, `mobile/src/app/pairing/loading.tsx`, `mobile/src/app/pairing/success.tsx`, `mobile/src/hooks/useSearchingState.ts` | raw connection object, connected/ready predicates, bluetooth classic state, raw waits | Engine should expose pairing/readiness/Bluetooth-classic read models and commands. Host should own route transitions and copy. |
| Device/status UI | `mobile/src/app/home.tsx`, settings screens, `DeviceStatus`, `BatteryStatus`, `ConnectDeviceButton`, `GlassesDisplayMirror` | connection, readiness, battery, case, device identity, controller, wifi, bt classic | These should be straightforward reads from typed engine status/info/controller/wifi facades. |
| Device devtools | `CoreStatusBar`, `NexDeveloperSettings`, stress-test/dev overlays | runtime diagnostics, BLE/debug status, device-specific test commands | Engine-owned devtools should move behind engine devtools exports before permanent host import guardrails land. |
| Gallery UI | `mobile/src/components/glasses/Gallery/GalleryScreen.tsx` | glasses connected selector plus gallery sync shim | Gallery should use `engine.gallery.status()` for gallery state and `engine.glasses.status()` only for generic device availability if needed. |
| Network monitoring | `mobile/src/effects/NetworkMonitoring.tsx` | hotspot local IP read directly from island store to configure ASG camera API | This is runtime plumbing, not host UI. Move into island/gallery/ASG services so host never handles hotspot internals. |

The incident/feedback flow was already corrected: host feedback UI no longer
constructs an internal glasses-status payload. It calls the public reporting
surface, and engine collects diagnostic context internally.

Cloud V1 miniapps have already been removed from the home screen, and Cloud V2
miniapps run locally in JS on the phone. Device compatibility is therefore a
local engine/runtime decision, not a reason to keep a generic cloud-side
glasses-state mirror.

## Proposed Engine Interface

Prefer small domain read models over one giant exported `GlassesStatus`.

### Device Status

Use the existing `engine.glasses.status()` and `engine.glasses.onStatus()`.
Extend only as needed for host rendering.

```ts
type GlassesStatusSnapshot = {
  state: "disconnected" | "scanning" | "connecting" | "bonding" | "connected"
  fullyBooted: boolean
  battery: number
  charging: boolean
  case: {
    battery: number
    charging: boolean
    open: boolean
    removed: boolean
  }
  signal: number
  micEnabled: boolean
  vadEnabled: boolean
  btClassic: boolean
}
```

Host usage:

- render home/device cards;
- show connect/disconnect affordances;
- gate screens that require connected or fully booted glasses;
- show battery/case state.

Engine-owned details:

- raw BLE connection object;
- store-backed readiness waits and timeout/reporting policy;
- link-layer busy rules;
- raw island store subscription/mutation details.

The public Bluetooth SDK already exposes `GlassesConnectionStatus` and basic
connection predicates. Bluetooth SDK usage should be classified by intent; it
should not be used as a proxy for the raw store-leak cleanup.

## Bluetooth SDK Policy

The Bluetooth SDK remains the public low-level SDK for customers building their
own glasses apps. The engine should not wrap or re-export the entire Bluetooth
SDK just for purity.

For a host app embedding the MentraOS engine, product flows should prefer
engine facades when the behavior is MentraOS-specific. Use engine for:

- pairing flow policy and route-ready state;
- default/saved device behavior;
- settings sync before connect/reconnect;
- fully-booted readiness waits;
- diagnostics and automatic reports;
- OTA orchestration;
- gallery/ASG coordination;
- local miniapp runtime streams and compatibility checks.

Direct Bluetooth SDK usage can still be valid when it is genuinely low-level:

- standalone customer apps that are not embedding the MentraOS engine;
- internal devtools/device experiments;
- public SDK types and predicates, such as `GlassesConnectionStatus`, when the
  host is handling low-level Bluetooth state intentionally;
- temporary migration call sites that are classified and then either moved
  behind engine or kept as intentional low-level use.

Rule for this migration:

- Do not create new engine types that duplicate Bluetooth SDK types unless the
  engine is projecting a higher-level MentraOS read model.
- Do not create pass-through engine wrappers for every Bluetooth SDK method by
  default.
- Classify each remaining host `@mentra/bluetooth-sdk` import as one of:
  intentional low-level SDK use, engine-runtime behavior that should move
  behind a facade, engine devtools/debug use, or dead code.
- Add a pure Bluetooth SDK types/predicates subpath for shared connection status
  helpers. Engine should use that for low-level predicates and keep
  engine-specific waits/policies in island.

Proposed shape:

```ts
import {
  type GlassesConnectionStatus,
  isBusyGlassesConnectionStatus,
  isConnectedGlassesConnectionStatus,
  isReadyGlassesConnectionStatus,
} from "@mentra/bluetooth-sdk/types"
```

The subpath must be side-effect free: no native module import, no Expo module
load, and no runtime initialization.

### Device Info

Keep `engine.glasses.info()` and add `engine.glasses.onInfo(cb)`.

```ts
type GlassesInfoSnapshot = {
  model: string
  style: string
  color: string
  bluetoothName: string
  firmwareVersion: string
  mtkFirmware: string
  besFirmware: string
  appVersion: string
  serialNumber: string
  buildNumber: string
  btMac: string
}
```

Host usage:

- render settings/device-info rows;
- choose visual variants for the device card;
- display developer diagnostics.

Engine-owned details:

- how identity/version fields are populated;
- when to request fresh version info;
- internal naming differences between Bluetooth SDK, cloud payloads, and UI.

### Wifi And Hotspot

Keep `engine.glasses.wifi.status()` and `onStatus()`.

Do not expose `engine.glasses.hotspot.status()` as a normal host/OEM read
model. Hotspot state is runtime plumbing for gallery/ASG sync, not branded host
UI state. The Bluetooth SDK may expose raw hotspot status for low-level SDK
customers, but engine host code should not receive hotspot credentials or local
IP plumbing.

Host usage:

- render wifi connection status;
- scan/connect/forget wifi through `engine.glasses.wifi.*`;
- render gallery sync phases and notices through `engine.gallery.status()` and
  `engine.gallery.onNotice()`.

Engine-owned details:

- hotspot status and credentials;
- ASG camera server configuration;
- gallery sync network probing;
- local IP plumbing for runtime services.
- manual Wi-Fi join guidance, if needed, as a gallery notice rather than a
  generic hotspot read model.

### Controller

Extend `engine.glasses.controller` beyond commands with a read model:

```ts
type ControllerStatusSnapshot = {
  connected: boolean
  fullyBooted: boolean
  battery: number
  signal: number
}

engine.glasses.controller.status(): ControllerStatusSnapshot
engine.glasses.controller.onStatus(cb): () => void
```

Host usage:

- render controller card;
- show controller connect/disconnect actions.

Engine-owned details:

- raw controller connection events;
- controller identity settings;
- controller readiness rules.

### Pairing And Readiness

Use `engine.pairing` for user-visible pairing flow primitives.

Needed public shape:

```ts
type PairingReadinessSnapshot = {
  glassesConnected: boolean
  fullyBooted: boolean
  btClassicConnected: boolean
  nativeLinkBusy: boolean
}

engine.pairing.readiness(): PairingReadinessSnapshot
engine.pairing.onReadiness(cb): () => void
engine.pairing.waitForReady(options): Promise<...>
engine.pairing.waitForBluetoothClassic(options): Promise<boolean>
```

Host usage:

- decide which pairing route to show;
- show loading/searching states;
- decide when to navigate to success.

Engine-owned details:

- raw `waitForGlassesState`;
- exact timeout diagnostics;
- connection-predicate logic.

### OTA

Move OTA orchestration behind `engine.ota`.

Needed public shape:

```ts
type OtaSnapshot = {
  connected: boolean
  wifiConnected: boolean
  wifiStatusKnown: boolean
  currentBuildNumber: string
  mtkFirmware: string
  besFirmware: string
  updateAvailable: OtaUpdateInfo | null
  status: OtaStatus | null
  progress: OtaProgress | null
  checking: boolean
  installing: boolean
  error: string | null
}

engine.ota.snapshot(): OtaSnapshot
engine.ota.onSnapshot(cb): () => void
engine.ota.checkForUpdates(): Promise<OtaCheckResult>
engine.ota.install(update?: OtaUpdateInfo): Promise<void>
engine.ota.retry(): Promise<void>
engine.ota.clear(): void
```

Host usage:

- render update prompt and progress screens;
- present alerts and route changes;
- show manual retry/cancel actions.

Engine-owned details:

- manifest URL resolution;
- build/firmware waits;
- system-time checks;
- MTK/BES multi-step rules;
- `mtkUpdatedThisSession`;
- deduping/regression protection for progress.

`progress-legacy.tsx` should be deleted as part of this migration, not kept as
a second host-side OTA implementation.

Current evidence:

- `check-for-updates.tsx` still routes ASG builds `< 37` to
  `/ota/progress-legacy`, so the file is not orphaned today.
- The Bluetooth SDK already maps legacy glasses `ota_progress` messages into
  unified `ota_status` events on Android and iOS.
- Island `OtaService` projects unified `ota_status` into both `otaStatus` and
  legacy-shaped `otaProgress`; `progress.tsx` already consumes `otaProgress`
  as a compatibility fallback.
- Current ASG documents `ota_start`, `ota_start_ack`, `ota_status`, and
  `ota_query_status` as the active protocol; `ota_progress` is legacy.
- `progress-legacy.tsx` is a large independent orchestrator with direct
  `BluetoothSdk` calls, raw store reads/writes, padded timers, build-number APK
  fallback, firmware revalidation, MTK/BES sequencing, and no dedicated test
  file. Keeping it would preserve the host/engine leak we are trying to
  remove.

Migration rule: move the real compatibility behavior into one engine-owned OTA
state machine, then route all builds to one host progress screen that renders
`engine.ota.snapshot()`.

Compatibility behavior to preserve before deleting the route:

- legacy `ota_progress` normalization into the same snapshot model as
  `ota_status`;
- old-build fallback when `ota_query_status` is ignored or returns no useful
  session: fall back to `ota_start`;
- APK completion by explicit status when available and build-number increase
  when older builds do not send the explicit reconnect signal;
- current manifest URL fallback for builds that ignore `ota_start.ota_version_url`;
- MTK/BES terminal handling, including BES restart/continue lockout;
- any longer legacy watchdog durations that are still empirically needed,
  expressed as engine policy/config rather than a separate screen.

Add targeted tests for those cases on the unified engine model, then delete
`mobile/src/app/ota/progress-legacy.tsx`, the build `< 37` route branch, and
the "legacy progress screen" comments.

### Cloud V1 Status Sync

Do not port the Cloud V1 `/api/client/device/state` mirror to Cloud V2, and do
not create a engine interface for it.

That endpoint existed because Cloud V1 hosted/routed remote miniapps and needed
server-side session knowledge: connected/model/capabilities/wifi-style state.
In the Cloud V2 model, miniapps run locally on the phone. Engine already owns
the local device state and can enforce compatibility before launching a
miniapp. Runtime streams such as connection or battery can be delivered locally
from island state to local miniapps.

Cloud V2 should receive device state only when a specific V2 feature needs a
specific persisted or processed record. Examples:

- Reports collect diagnostic state on demand.
- SSO/auth does not need glasses state.
- Future Cloud V2 remote/runtime features should define typed, feature-owned
  events or snapshots, not revive a broad mutable `GlassesInfo` mirror.

The remaining Cloud V1 sync code is therefore legacy cleanup work. Delete it
when the dependent Cloud V1 paths are gone or confirmed dead.

## Field Mapping

| Raw field / helper | Public replacement | Owner |
| --- | --- | --- |
| `connection`, `isGlassesConnected`, `selectGlassesConnected` | `engine.glasses.status().state` or derived host boolean | Engine projects; host renders. |
| `isGlassesReady`, `selectGlassesReady`, `fullyBooted` | `engine.glasses.status().fullyBooted` or `engine.pairing.readiness()` | Engine owns readiness rules. |
| `bluetoothClassicConnected` | `engine.glasses.status().btClassic` or pairing readiness | Engine owns native status; host renders. |
| battery/case fields | `engine.glasses.status().battery/case` | Engine projects; host renders. |
| `deviceModel`, `style`, `color`, version/build fields | `engine.glasses.info()` / `onInfo()` | Engine projects; host renders. |
| `wifi`, `wifiStatusKnown` | `engine.glasses.wifi.status()` and OTA snapshot where OTA needs known/unknown | Engine owns wifi state; host renders. |
| `hotspot` | Island-internal gallery/ASG plumbing; no public host facade by default | Engine owns sensitive hotspot details, ASG camera server setup, and any gallery notices. |
| `controllerConnected`, `controllerFullyBooted`, controller battery/signal | `engine.glasses.controller.status()` / `onStatus()` | Engine projects; host renders. |
| `otaProgress`, `otaStatus`, `otaUpdateAvailable`, `otaVersionUrl` | `engine.ota.snapshot()` and OTA commands | Engine owns OTA orchestration. |
| `setGlassesInfo`, `setOtaUpdateAvailable`, `setOtaProgress`, `setMtkUpdatedThisSession` | No host replacement | Engine/runtime mutations only. |
| `waitForGlassesState` | domain waits such as `engine.pairing.waitForReady()` and `engine.ota.checkForUpdates()` | Engine owns waits on internal state. |
| `getGlasesInfoPartial` | No Cloud V2 replacement by default | Delete with Cloud V1 device-state sync; add only feature-specific V2 projections if a real V2 feature needs one. |

## Migration Plan

### 1. Classify And Extract Devtools First

Use the devtools inventory below as the first cleanup pass.

- Classify each current debug route as one of:
  - host debug shell;
  - engine-owned devtool;
  - product/OEM UI that should use normal engine facades;
  - dead route/link to delete.
- Move engine-owned devtools behind a dev-only engine export such as
  `@mentra/engine/devtools`, then have the host mount those exported screens or
  components.
- Start with the devtools that currently reach into raw runtime internals:
  `CoreStatusBar`, `stress-test.tsx` plus `MemoryWarningMonitor`, and
  `NexDeveloperSettings` if it remains a developer tool rather than product UI.
- Keep host-owned debug shell pieces in host code: endpoint switching,
  super/debug mode toggles, route-test links, test-error buttons, and other
  host navigation affordances.
- Clean up obviously dead debug links before adding permanent guardrails:
  `/test/switcher`, `/miniapps/settings/buffer-debug`, and the
  `/miniapps/settings/miniapp-developer` vs `miniapp-dev.tsx` mismatch.

Reason for doing this first: if we add import guardrails before moving
engine-owned devtools, we either fail immediately or create a broad allowlist
for `mobile/src` debug files. That broad allowlist would preserve the leak in a
different form.

### 2. Add Guardrails

- Add a lint/import restriction or CI grep that blocks new host imports from
  `@/stores/glasses` and direct `useGlassesStore` imports from `@mentra/engine`.
- Start in report-only mode or with a short temporary allowlist while migration
  is active.
- Permanent exceptions should be narrow: tests, island internals, and engine
  devtools internals. `mobile/src` host screens should not remain on the final
  allowlist.
- Add the same guardrail for `mobile/src/stores/gallerySync.ts` once gallery UI
  has a facade-backed hook.

### 3. Fill Missing Product Read Models

- Add `engine.glasses.onInfo(cb)`.
- Add `engine.glasses.controller.status()` and `onStatus(cb)`.
- Add a host-friendly hook layer if desired, such as
  `useEngineSnapshot(engine.glasses.onStatus, engine.glasses.status)`, so UI
  files do not each reimplement subscription glue.

These are for product/OEM UI, not devtools. Engine-owned devtools can inspect
engine internals inside the engine boundary.

### 4. Convert Low-Risk Product UI Reads

Start with screens/components that only render status:

- `BatteryStatus`
- `DeviceStatus`
- `ConnectDeviceButton`
- `GlassesDisplayMirror`
- settings device-info/glasses/controller/position/dashboard/camera screens
- `home.tsx`
- `wifi/scan.tsx`
- `GalleryScreen` connection gating

Each conversion should remove raw store imports from that file without changing
the visual behavior.

`CoreStatusBar` is intentionally not in this product-UI pass anymore; it should
be moved/exported as a engine devtool in step 1.

### 5. Add Bluetooth SDK Types/Predicates Subpath

- Add a pure `@mentra/bluetooth-sdk/types` or equivalent subpath exporting
  `GlassesConnectionStatus` and the connected/ready/busy predicates.
- Update island `GlassesReadiness.ts` to import/re-export those low-level
  predicates instead of duplicating their logic.
- Keep `waitForGlassesReady` and timeout/reporting policy in island/engine,
  because those are MentraOS runtime semantics.

### 6. Convert Pairing And Reconnect

- Move raw connection/readiness waits behind `engine.pairing`.
- Convert pairing loading/success/scan/btclassic screens to the pairing
  read-model and commands.
- Convert `Reconnect.tsx` and `BtClassicPairing.tsx` to engine pairing/glasses
  APIs.
- Remove host dependency on the raw island `connection` store object and raw
  store readiness helpers.
- Classify remaining direct `@mentra/bluetooth-sdk` imports using the Bluetooth
  SDK policy above: intentional low-level SDK use, engine-runtime behavior,
  engine devtools/debug use, or dead code.

### 7. Move Network Plumbing Back Into Island

- Remove `NetworkMonitoring.tsx` direct reads of `hotspot.localIp`.
- Let island/gallery/ASG services configure `asgCameraApi` when hotspot state
  changes or when a sync starts.
- Keep host involvement limited to rendering sync status and user-actionable
  notices.
- Do not add a public `engine.glasses.hotspot.status()` facade as part of this
  cleanup. If gallery needs to ask the user to join Wi-Fi manually, expose that
  as a gallery notice with the smallest useful payload.

### 8. Move OTA Orchestration

- Extend `engine.ota` from status/install primitives to a complete OTA
  snapshot and command surface.
- Move update checking, firmware/build waits, manifest URL resolution, clock
  checks, and `mtkUpdatedThisSession` handling into island.
- Move the OTA install state machine into island:
  start/retry timers, reconnect recovery, `ota_query_status` fallback,
  `ota_start_ack` handling, progress watchdogs, APK/MTK/BES sequencing, and
  terminal-state cleanup.
- Preserve old-build compatibility inside that one state machine:
  legacy `ota_progress` normalization, build-number APK completion fallback,
  manifest URL fallback for builds that ignore `ota_start.ota_version_url`, and
  any longer watchdog durations we still need.
- Add focused tests for those compatibility cases before removing the old route.
- Convert OTA screens/effects to render `engine.ota.snapshot()` and call
  `checkForUpdates()`, `install()`, `retry()`, and `clear()`.
- Delete `mobile/src/app/ota/progress-legacy.tsx` and the build `< 37`
  `/ota/progress-legacy` branch after the unified engine path covers those
  behaviors.
- Keep host-owned alerts/navigation/copy in the screens.

### 9. Audit Cloud V1 Remnants

Audit `MantleManager`, `SocketComms`, `RestComms`, and `WebSocketManager` by
feature owner before deleting more legacy code.

Classify each remaining call path as one of:

- delete now: only served Cloud V1 remote miniapps or a dead route;
- keep until named Cloud V2 port: auth/account, app catalog/install/start,
  settings, notifications, calendar, telemetry, or another feature that still
  has a concrete owner;
- move into engine/local runtime: runtime behavior that belongs beside local
  miniapps, gallery, pairing, OTA, diagnostics, or device coordination.

Audit buckets:

- auth/session bootstrap and SSO token exchange;
- app catalog/install/start/stop/uninstall and app settings;
- Cloud V1 remote-miniapp websocket runtime and event forwarding;
- phone notifications and calendar forwarding;
- device-state sync (`/api/client/device/state`);
- battery/connection websocket events;
- media/photo/video/streaming commands;
- debug/developer-only controls.

Rule: do not keep a call path only because it used to feed Cloud V1 miniapps.
Cloud V1 miniapps are no longer launched from the home screen, and Cloud V2
miniapps run locally on the phone.

### 10. Delete Legacy Cloud V1 Status Sync

- Verify which remaining Cloud V1 paths still require
  `POST /api/client/device/state`; delete the mobile sender if none do.
- Remove the `MantleManager` raw store subscription that calls
  `restComms.updateGlassesState`.
- Remove dead `SocketComms.sendGlassesConnectionState()` and V1
  `glasses_battery_update` forwarding if no active V1 runtime path consumes
  them.
- Do not add a Cloud V2 `/api/client/device/state` equivalent.
- If a V2 feature later needs cloud-visible device state, design a narrow API
  for that feature instead of reusing the V1 mirror.

### 11. Delete The Escape Hatches

- Remove `mobile/src/stores/glasses.ts` once production host imports are gone.
- Remove or narrow `engine.glassesStore` exports if they still exist publicly.
- Remove `mobile/src/stores/gallerySync.ts` once gallery UI is facade-backed.
- Make the import restriction permanent.

## Success Criteria

- `rg "useGlassesStore|waitForGlassesState|getGlasesInfoPartial" mobile/src`
  returns no production host call sites.
- Production host code no longer imports raw island glasses-store APIs:
  `useGlassesStore`, `waitForGlassesState`, `getGlasesInfoPartial`, store
  selectors, or store mutation methods.
- Host code never calls raw glasses-store mutation methods.
- Host code renders typed engine read models and calls typed engine commands.
- OTA has one host progress route. `progress-legacy.tsx` is deleted, the build
  `< 37` route branch is gone, and old-build behavior is covered by engine OTA
  tests rather than a second host-side orchestrator.
- Any remaining production host imports from `@mentra/bluetooth-sdk` are
  classified as intentional low-level SDK use, engine-runtime behavior moved
  behind a facade, engine devtools/debug use, or dead code.
- Low-level connection predicates are shared from a pure Bluetooth SDK
  types/predicates subpath; island keeps only engine-specific wait/policy
  helpers.
- Engine-owned devtools that need raw runtime state are exported from engine
  devtools and mounted by host code; they are not rebuilt in `mobile/src` with
  raw store imports.
- Hotspot credentials/local IP remain internal to engine gallery/ASG services;
  product host UI uses gallery sync status/notices rather than a generic
  hotspot facade.
- Incident/feedback reporting remains clean: the host submits user text and UI
  choices; engine collects runtime diagnostics.
- Cloud V1 device-state sync is deleted or isolated as known temporary legacy
  code; Cloud V2 has no generic device-state mirror.
- `MantleManager` / `SocketComms` / `RestComms` / `WebSocketManager` remnants
  are classified as delete-now, keep-until-named-V2-port, or move-into-engine.

## Devtools Policy

Dev-only diagnostic screens are not OEM host UI when they are owned by the
engine. They are MentraOS devtools that a host app may mount.

Policy:

- OEM/host screens must not import raw engine stores.
- Engine-owned devtools screens may inspect engine internals because they
  live inside the engine boundary.
- The host should mount engine devtools screens/components exported by engine,
  not build equivalent screens in `mobile/src` by importing `useGlassesStore`.
- Do not create broad public OEM APIs only because a devtool needs internal
  visibility. Prefer a dev-only/internal export such as
  `@mentra/engine/devtools`.
- If a screen is product UI, branded settings UI, or OEM-customizable UI, it
  should use the normal typed engine facades instead of raw stores.

## Current Devtools Inventory

| Surface | Current location | Access / purpose | Current internals | Judgment |
| --- | --- | --- | --- | --- |
| Debug settings hub | `mobile/src/app/miniapps/settings/debug.tsx` | Shown when debug mode is enabled from Settings. Links to route tests, onboarding, OTA check, websocket reset, test errors, backend/cloud URL controls, navigation test, and super settings. | Uses host settings/navigation plus `navigationService`, `WebSocketManager`, and `SocketComms`; no raw glasses-store import. | Mostly host/dev shell. Keep host-owned for endpoint switching/navigation/test-error affordances, but route engine-runtime diagnostics to engine devtools screens. |
| Super settings | `mobile/src/app/miniapps/settings/super.tsx` | Long-press/debug path for super mode, debug navigation history, debug Bluetooth status bar, native-dashboard flag, native debug buttons, stress test. | Calls `@mentra/bluetooth-sdk-internal` `dbg1()` / `dbg2()` and toggles debug settings. | Split: host can own the super/debug toggles; native/BLE debug actions should move behind engine devtools or a clearly internal Bluetooth SDK dev surface. |
| Stress test | `mobile/src/app/miniapps/settings/stress-test.tsx` | Super-mode jetsam/JSC memory benchmark screen. | Uses `engine.dev.getMemoryMB()`, `miniappRunningRegistry`, `useStressTestStore`, and internal Bluetooth SDK JSC benchmark calls. | Engine/runtime devtool. Move/export from engine devtools; host should mount it. |
| Memory warning monitor | `mobile/src/effects/MemoryWarningMonitor.tsx` | Always-mounted helper that records iOS memory warnings for the stress-test screen. | Writes to `useStressTestStore`. | Move with the stress-test devtool or expose a engine devtools lifecycle hook. |
| Core status bar | `mobile/src/components/dev/CoreStatusBar.tsx` | Debug overlay for BLE/core/cloud-client/mic/touch status; currently disabled by a commented mount in `Screen.tsx`. | Reads raw `useGlassesStore`, `useCoreStore`, `useConnectionStore`, `useCloudClientStatusStore`, and `useDebugStore`. | Engine devtools overlay candidate. Raw store access is acceptable only after moving behind a engine-owned devtools export. |
| Version info | `mobile/src/components/dev/VersionInfo.tsx` | Footer/version tap target that enables debug/super mode and copies build/user/backend info. | Reads host settings, auth user, and `useCloudClientStatusStore`. | Host debug shell. Does not need raw glasses state. |
| Backend/cloud URL controls | `mobile/src/components/dev/BackendUrl.tsx`, `mobile/src/components/dev/CloudUrl.tsx`, `mobile/src/components/dev/OtaVersionUrl.tsx` | Debug endpoint and OTA-manifest controls surfaced from debug settings. | Mostly host settings; OTA URL affects runtime behavior. | Keep endpoint switching host-owned. Review OTA override with OTA migration; likely engine OTA devtools or typed dev config. |
| Miniapp developer settings | `mobile/src/app/miniapps/settings/miniapp-dev.tsx` | Developer entry point for QR scan and manual dev URL. | Uses host navigation/UI; links into engine app registry/runtime surfaces. | MentraOS developer tooling. Good candidate for engine-provided devtools screen or engine-owned building blocks with host UI adapters. |
| Miniapp dev scanner | `mobile/src/app/miniapps/miniappdev/scanner.tsx` | QR scanner for `miniapp://dev`, `miniapp://release`, and URL launches. | Uses Expo Camera, host permission UI, `appRegistry`, `decideDevLaunchRoute`, `registerDevApp`, `useAppStatusStore`. | Engine developer tool with host permission/UI dependencies. Move carefully: either exported devtool screen with host adapters or keep host screen but no raw runtime stores. |
| Miniapp dev URL loader | `mobile/src/app/miniapps/miniappdev/developer-url.tsx` | Manual URL loader and recent-dev-app launcher. | Uses `decideDevLaunchRoute`, `registerDevApp`, `useAppStatusStore`, storage, and host permission UI. | Same as scanner. Engine owns dev-app runtime logic; host currently owns UI/permissions. |
| Dev miniapp offline screen | `mobile/src/app/applet/dev-offline.tsx` | Offline fallback screen for dev miniapps. | Uses `useApps`, `decideDevLaunchRoute`, `useAppStatusStore`, host capsule/nav. | Miniapp developer UX. Can remain host UI using typed engine app APIs. |
| Nex developer settings | `mobile/src/app/glasses/nex-developer-settings.tsx`, `mobile/src/components/glasses/NexDeveloperSettings.tsx` | Mentra Display/Nex display and BLE test UI linked from glasses settings. | Reads `useGlassesStore(selectGlassesConnected)`, uses `engine.display`, settings, and BLE command debug events. | Device-specific engine devtool unless promoted to product UI. Move/export from engine devtools or convert raw connection check to `engine.glasses.status()`. |
| Test mini app route | `mobile/src/app/test/mini-app.tsx` | Empty test route linked from debug settings. | No runtime state. | Dead/test shell; decide whether to delete. |
| Broken/dead debug links | `debug.tsx` links `/test/switcher` and `/miniapps/settings/buffer-debug`; `super.tsx` links `/miniapps/settings/miniapp-developer` while the file is `miniapp-dev.tsx`. | Debug-only route links. | No matching files found in current app tree. | Cleanup candidates before or during devtools migration. |
