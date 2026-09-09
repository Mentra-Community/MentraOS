---
status: draft
owner: Mentra
---

# Public hotspot OTA API design

## Outcome

A React Native customer can build Mentra Live OTA pages that match their own app
without reimplementing OTA orchestration. The published Engine owns one tested
Wi-Fi/hotspot, APK/MTK/BES, reboot, retry, and verification state machine. The
stock `MentraLiveOtaFlow` and customer-owned pages render the same public
headless controller.

The public Bluetooth SDK documentation directs React Native/Expo apps to Mentra
Engine for OTA rather than teaching them to assemble the protocol themselves.
The Starter Kit proves the customization path with example-owned OTA pages that
use the controller but do not import the stock `MentraLiveOtaFlow` component.

The Engine OTA dependency path uses only supported public Bluetooth SDK
entrypoints. Customer code never imports `@mentra/bluetooth-sdk/internal`, raw
Engine stores, or Engine services.

This ships as two repository PRs, not a same-repository PR stack:

1. A MentraOS PR against `dev` publishes the public Bluetooth SDK primitives,
   public Mentra Engine controller, stock-flow refactor, and documentation.
2. After that PR merges and coordinated npm packages are available, a Starter
   Kit PR against `main` pins the new packages and uses the controller from a
   custom OTA UI.

## Current problem

The published packages are close to this boundary but do not meet it:

- `@mentra/engine/ota` exports only `MentraLiveOtaFlow`.
- `engine.ota.installSession` is present in generated declarations, but its
  lifecycle is undocumented and the surrounding check/auto-chain orchestration
  still lives in the React component.
- The Bluetooth SDK publicly exposes `setHotspotState`, `startOtaUpdate`,
  `ota_start_ack`, and `ota_status`, but Engine's OTA path still imports
  `@mentra/bluetooth-sdk/internal` for status projection, recovery queries,
  restart signals, clock repair, scoped local networking, and the phone HTTP
  server.
- A customer can render the stock component, but cannot implement a robust
  hotspot OTA flow directly from the supported public primitives.
- The public update guide currently tells apps to call `checkForOtaUpdate()`,
  `startOtaUpdate()`, and render `ota_status` themselves. That omits hotspot
  artifact staging, restart recovery, multi-component chaining, and watchdogs.
- The Starter Kit React Native example currently imports `MentraLiveOtaFlow`,
  which verifies the stock component but does not prove that a customer can fork
  the example and replace its cosmetics safely.

## Design principles

1. There is exactly one OTA state machine.
2. Customers customize rendering and navigation, not OTA sequencing.
3. `MentraLiveOtaFlow` is a thin renderer over the same public hook customers
   use.
4. Engine consumes supported Bluetooth SDK entrypoints throughout its OTA
   dependency closure.
5. Wi-Fi and hotspot OTA retain the same install coordinator and recovery
   behavior.
6. Existing old-ASG Wi-Fi compatibility remains intact, including clients that
   do not emit a session id.
7. No visual redesign is part of this work.
8. Public docs lead with the smallest safe integration and link to one working
   customizable example.

## Public Engine API

`@mentra/engine/ota` will export the existing component plus one supported hook:

```ts
import {
  MentraLiveOtaFlow,
  useMentraLiveOta,
  type MentraLiveOtaController,
  type MentraLiveOtaState,
} from "@mentra/engine/ota"
```

The hook owns all non-visual logic currently split between
`MentraLiveOtaFlow` and `engine.ota.installSession`:

- Engine OTA-only initialization when the full Engine runtime is not running.
- Version refresh and manifest comparison.
- Required/optional update admission.
- Wi-Fi versus hotspot selection.
- Hotspot artifact staging and progress.
- OTA start ownership and acknowledgement.
- APK/MTK/BES progress, reconnect, status-query recovery, and watchdogs.
- Multi-pass auto-chain behavior.
- Retry, completion, discard, and cleanup.

The public state is a semantic read model for rendering, not the underlying
stores. It includes:

- `screen`: the current renderable state, such as `checking`,
  `update_available`, `wifi_required`, `preparing_hotspot`, `updating`,
  `restarting`, `verifying`, `complete`, `failed`, or `disconnected`.
- Update description and whether it is required or a version change.
- Selected transport: `wifi` or `hotspot`.
- OTA step/phase and real or display progress.
- Hotspot staging phase and artifact progress.
- Stable error code plus display fallback text.
- Whether retry, finish, discard, or dismissal is currently allowed.

The public actions are semantic and idempotent:

- `check()` and `retryCheck()`.
- `install()`.
- `retryInstall()`.
- `finish()`.
- `discard()` for the existing developer/super-mode escape hatch.

Navigation remains host-owned through callbacks such as `onFinished` and
`onOpenWifiSetup`. The hook must never import Expo Router or Mentra App routes.

`MentraLiveOtaFlow` will use this hook and contain only rendering, theme,
translation, and callback wiring. Its visible output must not change during the
extraction.

## Documentation contract

The existing **Update Mentra Live** page at
`mintlify-docs/mentra-live/software-update.mdx` is the canonical integration
guide. Do not create a competing OTA integration page. Replace its current
React Native instruction to manually combine `checkForOtaUpdate()`,
`startOtaUpdate()`, and `ota_status` with these sections, in this order:

1. **Use the exact Mentra App OTA pages:** install compatible
   `@mentra/engine` and `@mentra/bluetooth-sdk` releases, then render
   `MentraLiveOtaFlow` after Mentra Live connects. Explain that this is the
   simplest and safest option and gives the app the exact same OTA pages and
   behavior as the Mentra App.
2. **Customize the OTA pages:** use `useMentraLiveOta`, render its semantic
   states, and invoke only its actions. Start from the Starter Kit
   implementation and change presentation components/styles without changing
   sequencing.
3. **Native Android/iOS:** retain the platform SDK API reference, while clearly
   stating that the full Mentra Engine controller is currently the React Native
   integration and that native apps must preserve the documented OTA contract.

The first section includes the complete minimal component snippet and required
host callbacks. The second includes the minimal hook/controller skeleton and a
direct link to the Starter Kit `src/ota/` implementation. Both stay on the
Update Mentra Live page so developers encounter them at the exact point where
the docs currently say their Bluetooth SDK app must implement OTA.

The API reference, example-app guide, Engine README, and Bluetooth SDK README
link back to that canonical page rather than duplicating the full guide. Direct
Bluetooth SDK primitives are documented as building blocks, not a replacement
for the coordinator.

## Starter Kit reference implementation

The React Native example in `Mentra-Bluetooth-SDK-Starter-Kit` becomes the
copyable custom-UI reference:

- It imports `useMentraLiveOta` and public types from `@mentra/engine/ota`.
- It does not import `MentraLiveOtaFlow`, `engine.ota.installSession`, Engine
  stores/services, or `@mentra/bluetooth-sdk/internal`.
- It owns a small `src/ota/` presentation layer that covers the same pages and
  actions as the Mentra App: checking, update available, Wi-Fi setup fallback,
  phone artifact download, hotspot start/join, install progress, reboot,
  verification, complete, failure, retry, and disconnection.
- It may copy the Mentra App page structure and copy as a starting point, but
  styles and components live in the example repo to demonstrate cosmetic
  independence.
- Existing connection-generation admission remains example-owned: the app opens
  OTA once per Mentra Live connection and returns to its tabs through callbacks.
- A source test fails if the example starts importing the stock flow or a private
  path, keeping it a genuine custom-renderer proof.

The Starter Kit README will mark `src/ota/` as the folder customers can fork and
restyle, while warning them not to copy or modify OTA sequencing.

## Public Bluetooth SDK boundary

The existing public root keeps these OTA primitives:

- `requestVersionInfo()` and `version_info`.
- `setOtaVersionUrl()`, `getOtaVersionUrl()`, and `checkForOtaUpdate()`.
- `startOtaUpdate()` and `ota_start_ack`.
- `ota_status`.
- `setHotspotState()` plus `hotspot_status_change` and `hotspot_error`.

Promote the additional existing native capabilities Engine needs:

- A correlated OTA status query, publicly named `queryOtaStatus()`.
- `glasses_session_changed` and `mtk_update_complete` events.
- `setSystemTime()` for the existing clock-skew repair.
- `ping()` while legacy Wi-Fi OTA still requires it.
- Read/subscribe access to Bluetooth and glasses status for non-React Engine
  projection. These remain immutable snapshots and subscriptions; mutation of
  the SDK's internal observable state is not exposed.

Add `@mentra/bluetooth-sdk/ota-transport` as a supported low-level transport
entrypoint. It wraps, rather than directly exports, the existing native modules:

- Scoped local-network connect, disconnect, request, download, cancellation,
  and network-loss/download-progress observation.
- OTA HTTP server start, stop, address wait, artifact download, and artifact
  progress observation.

Engine retains artifact selection, checksum verification, manifest rewriting,
transport selection, and OTA sequencing. The Bluetooth SDK entrypoint provides
native transport capabilities only.

`updateGlasses()` will not become public. Engine will apply the result returned
by `requestVersionInfo()` to its own projection so it no longer mutates the
Bluetooth SDK's private store to force a refresh.

## Package boundary

- `@mentra/engine/ota` exposes the hook, component, and their public types.
- `@mentra/engine` continues to expose `engine.ota`; direct
  `installSession` use is documented as lower-level and the hook is the preferred
  React Native customer surface.
- `@mentra/engine/bluetooth-sdk/ota-transport` mirrors the new Bluetooth SDK
  subpath, consistent with the existing curated Bluetooth SDK re-exports.
- `@mentra/bluetooth-sdk/internal` remains temporarily available for unrelated
  MentraOS migrations, but no file reachable from the public Engine OTA
  entrypoint may import it.

## Compatibility

- Android support starts at Android 13/API 33.
- iOS retains the existing background-capable OTA behavior; this work does not
  add a second keep-alive mechanism.
- Wi-Fi OTA behavior and old clients without `sid` remain supported.
- Modern clients continue to use `glasses_session_changed` for in-place ASG
  restart detection.
- Hotspot OTA continues to pre-download and verify artifacts before joining the
  glasses network, serve plain HTTP locally, and keep the existing teardown and
  hotspot-reclaim behavior.
- Published manifest pin precedence and development-build fail-closed behavior
  do not change.

## Verification

The single PR is acceptable when:

1. A package-level test rejects `/internal` imports in the Engine OTA dependency
   closure.
2. A clean external fixture compiles custom pages using only
   `@mentra/engine/ota` and the curated public Bluetooth SDK exports.
3. The fixture can render every semantic hook state without importing Engine
   stores or services.
4. Existing Engine OTA coordinator, hotspot transport, auto-chain, legacy Wi-Fi,
   and UI tests pass.
5. Android public-SDK compile and iOS package/build checks pass.
6. `npm pack` verification confirms all new JavaScript and declaration
   entrypoints are present and no private paths are required by the fixture.
7. The Starter Kit custom UI compiles against the published packages and covers
   every public controller state without importing the stock flow.
8. Physical Android and iOS hotspot OTA smoke tests complete through the Starter
   Kit custom UI, including iOS backgrounding, proving the published controller
   drives the real install.
9. A Wi-Fi OTA regression smoke test reaches completion through the custom UI.
10. Public documentation builds and all code samples type-check against the
    published API.

## Non-goals

- A second or simplified OTA state machine for customer apps.
- Customer control over artifact ordering, manifest rewriting, retries,
  watchdogs, or restart recovery.
- Removing every non-OTA Engine use of `@mentra/bluetooth-sdk/internal`.
- A new OTA wire protocol or ASG change.
- A visual redesign of the Mentra App OTA pages.
- Supporting Android versions below Android 13.
- Porting Mentra Engine or its React hook to native Android or Swift in this
  change.
