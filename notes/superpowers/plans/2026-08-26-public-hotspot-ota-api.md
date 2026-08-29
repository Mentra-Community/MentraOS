---
status: draft
owner: Mentra
---

# Public hotspot OTA API and Starter Kit implementation plan

> Two-repository execution checklist. MentraOS lands and publishes first; the
> Starter Kit then consumes the published packages. Do not split either
> repository's work into a dependent same-repository PR stack.

**Goal:** Let React Native customers render their own Mentra Live OTA pages over
the same Engine-owned Wi-Fi/hotspot state machine used by the stock flow, while
removing private Bluetooth SDK imports from the Engine OTA dependency path and
proving the integration in the forkable Starter Kit example.

**Architecture:** The Bluetooth SDK exposes the existing native OTA/status and
local-network/server capabilities through supported entrypoints. Engine retains
all OTA policy and orchestration. A public `useMentraLiveOta` hook projects that
single state machine into semantic UI state and actions; `MentraLiveOtaFlow` is
rewritten as a thin renderer over the hook. The Starter Kit owns separate visual
components that render the same hook, proving customers can change cosmetics
without forking OTA logic.

**Tech Stack:** TypeScript, React Native/Expo, Android Kotlin/Java, Swift,
Expo modules, Jest/Bun, npm package verification.

**Spec source of truth:**
`notes/superpowers/specs/2026-08-26-public-hotspot-ota-api-design.md`

---

## File map

| Path | Action | Responsibility |
|---|---|---|
| `mobile/modules/bluetooth-sdk/src/index.ts` | Modify | Publish existing OTA/status methods and events |
| `mobile/modules/bluetooth-sdk/src/BluetoothSdk.types.ts` | Modify | Define the supported OTA/status contract |
| `mobile/modules/bluetooth-sdk/src/ota-transport/` | Create | Wrap scoped networking and OTA HTTP server primitives |
| `mobile/modules/bluetooth-sdk/package.json` | Modify | Export `./ota-transport` |
| `mobile/modules/engine/src/services/` OTA files | Modify | Replace `/internal` use and private state mutation |
| `mobile/modules/engine/src/react/useMentraLiveOta.ts` | Create | Public headless React OTA controller |
| `mobile/modules/engine/src/react/MentraLiveOtaFlow.tsx` | Modify | Render the public hook without behavior or visual changes |
| `mobile/modules/engine/src/react/index.ts` | Modify | Export hook and public types from `@mentra/engine/ota` |
| `mobile/modules/engine/src/bluetooth-sdk/` | Modify | Mirror the public OTA transport subpath |
| SDK/Engine tests and package scripts | Modify | Enforce the public boundary and consumer compilation |
| `mintlify-docs/mentra-live/software-update.mdx` | Modify | Canonical stock-flow then custom-page integration guide |
| `mintlify-docs/mentra-live/api-reference.mdx` | Modify | Separate Engine flow from low-level/native primitives |
| `mintlify-docs/mentra-live/examples.mdx` | Modify | Point to the customizable Starter Kit implementation |
| Engine and Bluetooth SDK READMEs | Modify | Document stock and custom-page integration |
| Starter Kit `examples/react-native/src/ota/` | Create | Example-owned custom OTA pages over the hook |
| Starter Kit React Native app/tests/README | Modify | Integrate and prove the custom renderer |

---

## Conventions

- One MentraOS PR against `dev`, then one Starter Kit PR against `main` after the
  matching Engine and Bluetooth SDK packages are published.
- Preserve the current OTA wire protocol and coordinator behavior.
- Do not expose raw Zustand stores or the private Bluetooth SDK singleton.
- Do not add a new timer or background keep-alive path.
- Do not change OTA page styling or copy during the behavior extraction.
- Target Android 13/API 33 and current supported iOS.

---

## Phase 1: Establish the public Bluetooth SDK primitives

### Task 1: Promote existing OTA and status operations

**Files:** Bluetooth SDK public index, types, and focused API tests

- [ ] Add public `queryOtaStatus()` over the existing native status query.
- [ ] Add `glasses_session_changed` and `mtk_update_complete` to the public
      typed event map and runtime allowlist.
- [ ] Publish `setSystemTime()` and the legacy `ping()` operation used by Engine.
- [ ] Publish immutable Bluetooth/glasses status reads and subscriptions needed
      by the non-React Engine projection.
- [ ] Keep the existing public `startOtaUpdate`, `ota_status`, hotspot command,
      and hotspot events unchanged.
- [ ] Add tests proving unsupported event names remain rejected.

### Task 2: Add the public OTA transport subpath

**Files:** `src/ota-transport/`, package exports, package verification scripts

- [ ] Wrap scoped local-network connect/disconnect/request/download/cancel and
      progress/network-loss observation.
- [ ] Wrap OTA HTTP server start/stop/address wait/artifact download and progress
      observation.
- [ ] Do not expose Expo native-module classes or mutable native stores.
- [ ] Export JavaScript, React Native source, and declarations through
      `@mentra/bluetooth-sdk/ota-transport`.
- [ ] Add Android and iOS wrapper tests with mocked native modules.

## Phase 2: Remove private Bluetooth SDK use from Engine OTA

### Task 1: Migrate commands, events, and status projection

**Files:** `OtaService.ts`, `OtaInstallCoordinator.ts`,
`OtaUpdateCheckService.ts`, `GlassesStatusProjection.ts`,
`glassesClockSync.ts`, `facades/ota.ts`

- [ ] Import OTA commands, events, types, status reads, and subscriptions from
      the public Bluetooth SDK entrypoint.
- [ ] Replace `sendOtaQueryStatus()` calls with public `queryOtaStatus()`.
- [ ] Preserve SID-based ASG restart detection and old-client reconnect fallback.
- [ ] Preserve MTK completion handling, legacy ping, and clock-skew repair.
- [ ] Remove `updateGlasses()` use; apply returned version information directly
      to Engine's projection and test repeated refreshes.

### Task 2: Migrate hotspot transport

**Files:** `HotspotOtaTransport.ts`, `asg/localNetworkTransport.ts`, package
re-export files

- [ ] Use the public OTA transport wrappers for scoped networking and HTTP
      serving.
- [ ] Keep artifact planning, download verification, manifest rewriting, and
      teardown policy in Engine.
- [ ] Preserve Android nearby-Wi-Fi permission handling and iOS address wait.
- [ ] Mirror the transport entrypoint beneath
      `@mentra/engine/bluetooth-sdk/ota-transport`.
- [ ] Add a test that fails if an Engine OTA dependency imports
      `@mentra/bluetooth-sdk/internal`.

## Phase 3: Extract the supported headless Engine API

### Task 1: Move orchestration into `useMentraLiveOta`

**Files:** new hook and hook tests; OTA auto-chain/check/install services as
needed without duplicating their logic

- [ ] Move check-page effects, selected-result ownership, transport admission,
      auto-chain decisions, and page transitions out of the component.
- [ ] Project semantic state for custom rendering, including hotspot staging and
      artifact progress.
- [ ] Expose idempotent check, install, retry, finish, and discard actions.
- [ ] Keep navigation, theme, and localization host-owned.
- [ ] Cover remount, reconnect, repeated action, required update, old Wi-Fi
      fallback, hotspot preflight failure, and terminal cleanup cases.

### Task 2: Make the stock flow consume the hook

**Files:** `MentraLiveOtaFlow.tsx`, shared-flow/UI tests

- [ ] Delete component-owned orchestration replaced by the hook.
- [ ] Render every existing page from the hook's semantic state.
- [ ] Preserve current text, colors, geometry, disabled states, and callbacks.
- [ ] Add regression assertions for the button/theme contract that previously
      changed during the Engine extraction.

### Task 3: Publish and document the custom-page contract

**Files:** Engine React entrypoint, declarations, READMEs, Mintlify Mentra Live
software-update/API-reference/example pages

- [ ] Export `useMentraLiveOta` and its state/action types from
      `@mentra/engine/ota`.
- [ ] Update the existing `mintlify-docs/mentra-live/software-update.mdx` page;
      do not create a separate OTA integration guide.
- [ ] First document `MentraLiveOtaFlow` as the simplest and safest default that
      supplies the exact same OTA pages and behavior as the Mentra App.
- [ ] Include a complete minimal stock-flow snippet with initialization and host
      callbacks at that point in the guide.
- [ ] Immediately follow it with “Customize the OTA pages,” using only
      `useMentraLiveOta` and linking directly to the Starter Kit custom UI.
- [ ] Replace the current low-level React Native “implement OTA” recipe with
      those two ordered Mentra Engine paths.
- [ ] Preserve the native Android/iOS primitive reference while distinguishing
      it from the React Native Mentra Engine integration.
- [ ] Make the API reference, examples page, and package READMEs link back to
      Update Mentra Live instead of duplicating the complete instructions.
- [ ] State explicitly that customers must not implement OTA sequencing or
      import `/internal`.

## Phase 4: Package and regression qualification

### Task 1: Prove the published consumer shape

- [ ] Build and pack Bluetooth SDK and Engine.
- [ ] Install both tarballs into a clean React Native fixture.
- [ ] Compile a stock-flow consumer and a custom-page hook consumer.
- [ ] Verify the fixture imports no private or source/build deep paths.
- [ ] Verify all new export-map targets and declaration files are present.

### Task 2: Run repository gates

- [ ] Run focused Bluetooth SDK public API and wrapper tests.
- [ ] Run focused Engine OTA hook, coordinator, hotspot, auto-chain, legacy, and
      rendering tests.
- [ ] Run Engine and Bluetooth SDK package builds and verification scripts.
- [ ] Run `bun compile` for mobile.
- [ ] Run `./scripts/check-android-compile.sh bluetooth-sdk` with the public SDK
      dependency shape.
- [ ] Run the relevant iOS package/build check.
- [ ] Run `git diff --check`.

## Phase 5: Starter Kit custom UI consumer

This phase starts only after the MentraOS PR has merged and compatible npm
packages containing the controller are available.

### Task 1: Pin the published packages

**Repository:** `Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit`

- [ ] Create a fresh worktree and branch from latest `origin/main`.
- [ ] Pin matching published `@mentra/engine` and
      `@mentra/bluetooth-sdk` versions.
- [ ] Regenerate the React Native and ElevenLabs Bun lockfiles with the CI Bun
      version and verify frozen installs.
- [ ] Preserve Android Maven and iOS package pins for the same coordinated
      release where applicable.

### Task 2: Replace the stock component with custom pages

**Files:** `examples/react-native/src/App.tsx`, new
`examples/react-native/src/ota/` components, focused tests

- [ ] Remove the `MentraLiveOtaFlow` import.
- [ ] Initialize and render `useMentraLiveOta` through example-owned page,
      button, progress, and icon components.
- [ ] Cover the Mentra App page sequence and copy while using the Starter Kit's
      local theme and navigation.
- [ ] Retain connection-generation admission and System-tab Wi-Fi fallback.
- [ ] Add a test that forbids `MentraLiveOtaFlow`, `/internal`, raw Engine
      stores/services, and direct `installSession` imports in the example.
- [ ] Add presentation tests that exercise every semantic controller state and
      action.

### Task 3: Explain the fork-and-restyle workflow

**Files:** Starter Kit React Native README and repository-level guidance as
appropriate

- [ ] Identify `src/ota/` as the copyable presentation layer.
- [ ] Show the minimal controller initialization and host callbacks.
- [ ] Explain which files may be restyled and which controller sequencing must
      remain untouched.
- [ ] Link back to the public Mentra Live software-update documentation.

### Task 4: Build and package the Starter Kit consumer

- [ ] Run frozen dependency installation and TypeScript tests.
- [ ] Run Expo prebuild and generated Android compile.
- [ ] Build the release Android APK and verify 16 KB page-size support.
- [ ] Resolve/build the iOS example against the matching published package.
- [ ] Verify the packaged consumer contains no private/deep imports.

## Phase 6: Hardware smoke verification

### Task 1: Verify the custom UI on devices

- [ ] On Android 13+, complete one hotspot OTA through the Starter Kit custom UI and record
      the installed APK/MTK/BES end state as applicable.
- [ ] On iOS, complete one hotspot OTA with the phone backgrounded during the
      install through the custom UI and verify the final version state.
- [ ] Complete one Wi-Fi OTA regression pass, including the old-client recovery
      path when suitable hardware/software is available.
- [ ] Confirm hotspot teardown/reclaim and post-update Bluetooth reconnection.

## Pull request completion and order

- [ ] Open the MentraOS PR against `dev` with the SDK/Engine API, stock-flow
      refactor, package tests, and public documentation.
- [ ] Merge and publish matching coordinated development packages.
- [ ] Open the Starter Kit PR against `main` using those published packages and
      the custom example pages.
- [ ] Include package-fixture evidence in the MentraOS PR and consumer builds
      plus hardware logs in the Starter Kit PR.
- [ ] Address review findings in their owning repository without creating a
      dependent same-repository PR stack.
