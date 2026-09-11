# Glasses Status Boundary Implementation Plan

**Status:** Implemented

This plan is retained as the reviewable work-package record. The migration was
implemented as a series of focused commits on the glasses-status boundary branch.

This is the PR-sized implementation plan for
[`README.md`](./README.md). The architecture goal is stable: engine/island owns
MentraOS runtime state and behavior; the host owns branded UI, navigation, copy,
alerts, and user choices.

Each work package below should be independently reviewable. Prefer one focused
commit per package, except OTA, which is intentionally split into smaller
sub-packages because OTA failures are high risk.

## Ground Rules

- Do not change Cloud V1 behavior merely to satisfy the boundary cleanup.
- Do not add a broad `GlassesStatus` replacement API.
- Do not expose hotspot credentials or local IP through a public host/OEM
  facade.
- Do not wrap the entire Bluetooth SDK in engine. Only add engine APIs where
  the behavior is MentraOS runtime policy.
- Keep host UI visually unchanged while replacing raw store reads.
- Keep tests allowed to import raw stores when they are testing island/store
  behavior directly.

## Baseline Inventory

Before starting implementation, capture current leak counts:

```bash
rg -n "from [\"']@/stores/glasses|useGlassesStore|waitForGlassesState|getGlasesInfoPartial|selectGlassesConnected|selectGlassesReady" mobile/src -g '*.ts' -g '*.tsx'
rg -n "@/stores/gallerySync|useGallerySyncStore" mobile/src -g '*.ts' -g '*.tsx'
rg -n "@mentra/bluetooth-sdk|@mentra/bluetooth-sdk-internal|BluetoothSdk" mobile/src -g '*.ts' -g '*.tsx'
rg -n "updateGlassesState|sendGlassesConnectionState|glasses_battery_update|/api/client/device/state" mobile/src mobile/modules/engine/src -g '*.ts' -g '*.tsx'
```

Expected current hotspots:

| Area | Main files |
| --- | --- |
| Raw glasses store shim | `mobile/src/stores/glasses.ts` |
| Product UI | `home.tsx`, settings screens, `DeviceStatus`, `BatteryStatus`, `ConnectDeviceButton`, `GlassesDisplayMirror`, `GalleryScreen`, `wifi/scan.tsx` |
| Pairing/reconnect | `Reconnect.tsx`, `BtClassicPairing.tsx`, pairing routes, `useSearchingState.ts` |
| OTA | `OtaUpdateChecker.tsx`, `ota/check-for-updates.tsx`, `ota/progress.tsx`, `ota/progress-legacy.tsx`, settings glasses screen |
| Network plumbing | `NetworkMonitoring.tsx` |
| Cloud V1 sync | `MantleManager.ts`, `SocketComms.ts`, `WebSocketManager.ts`, island `RestComms.ts` |
| Devtools | `CoreStatusBar`, `stress-test.tsx`, `MemoryWarningMonitor`, `NexDeveloperSettings` |

## Work Package 1: Devtools Boundary

Goal: remove debug/dev screens from the product host migration path before
guardrails make them noisy.

Changes:

- Add a engine devtools export surface, likely
  `mobile/modules/engine/src/devtools/index.ts`.
- Move or wrap engine-owned devtools:
  - `mobile/src/components/dev/CoreStatusBar.tsx`
  - `mobile/src/app/miniapps/settings/stress-test.tsx`
  - `mobile/src/effects/MemoryWarningMonitor.tsx`
  - `mobile/src/components/glasses/NexDeveloperSettings.tsx` if it remains a
    developer tool.
- Keep host debug shell code host-owned:
  - endpoint controls;
  - super/debug toggles;
  - route-test buttons;
  - test-error triggers.
- Delete or fix dead debug links:
  - `/test/switcher`
  - `/miniapps/settings/buffer-debug`
  - `/miniapps/settings/miniapp-developer` vs `miniapp-dev.tsx`

Tests:

```bash
cd mobile && npm test -- --runTestsByPath src/__tests__/glassesFacade.test.ts
cd mobile && npm run compile
```

Exit criteria:

- Product/OEM screens do not need devtool exceptions.
- Any devtool that still reads raw stores lives behind a engine-owned devtools
  export.
- Host debug shell imports only devtools components or host-owned services.

## Work Package 2: Guardrail Script

Goal: prevent new leaks while migration is in progress.

Changes:

- Add a small script, for example
  `scripts/check-mobile-runtime-boundary.sh`.
- Have it fail on new production host imports of:
  - `@/stores/glasses`
  - `@/stores/gallerySync`
  - direct `useGlassesStore` imports from `@mentra/engine`
- Add an explicit temporary allowlist file, for example
  `mobile/boundary-allowlist.txt`, generated from the baseline inventory.
- Make the script ignore:
  - `mobile/modules/engine/**`
  - tests (`*.test.ts`, `*.test.tsx`, `__tests__/**`)
  - engine devtools internals.

Start with a manual/report-only command in this branch. Turn it into CI once
the high-volume product UI and OTA paths are converted.

Tests:

```bash
./scripts/check-mobile-runtime-boundary.sh
git diff --check
```

Exit criteria:

- The script reports only allowlisted current files.
- New host files cannot add raw store imports without editing the allowlist.

## Work Package 3: Missing Facade Deltas

Goal: provide the host enough typed engine read models before converting UI.

Current facade deltas:

| Domain | Existing | Add |
| --- | --- | --- |
| `engine.glasses` | `status()`, `onStatus()`, `info()`, `requestVersionInfo()` | `onInfo(cb)` and any missing info fields needed by settings UI |
| `engine.glasses.controller` | connect/disconnect/forget commands | `status()`, `onStatus(cb)` |
| `engine.pairing` | scan/pair/setDefault/onPairFailure/onGlassesNotReady/waitForReady | `readiness()`, `onReadiness(cb)`, `waitForBluetoothClassic(options)` |
| `engine.ota` | `updateAvailable()`, `status()`, `onUpdateAvailable()`, `onStatus()`, primitive `install()`/`retry()` | `snapshot()`, `onSnapshot(cb)`, later `checkForUpdates()`, `clear()` |

Likely files:

- `mobile/modules/engine/src/facades/glasses.ts`
- `mobile/modules/engine/src/facades/pairing.ts`
- `mobile/modules/engine/src/facades/ota.ts`
- `mobile/modules/engine/src/services/GlassesReadiness.ts`
- optional host helper: `mobile/src/hooks/useEngineSnapshot.ts`

Tests:

```bash
cd mobile && npm test -- --runTestsByPath src/__tests__/glassesFacade.test.ts src/__tests__/glassesWifi.test.ts
cd mobile && npm run compile
```

Exit criteria:

- Product UI can read device status, device info, controller state, pairing
  readiness, Wi-Fi state, gallery status, and OTA snapshot without importing
  raw stores.
- Snapshot subscriptions are deduped on projected output, matching existing
  facade style.

## Work Package 4: Low-Risk Product UI Conversion

Goal: remove raw store imports from components that only render state.

Convert first:

- `mobile/src/components/glasses/info/BatteryStatus.tsx`
- `mobile/src/components/home/DeviceStatus.tsx`
- `mobile/src/components/glasses/ConnectDeviceButton.tsx`
- `mobile/src/components/mirror/GlassesDisplayMirror.tsx`
- `mobile/src/app/miniapps/settings/device-info.tsx`
- `mobile/src/app/miniapps/settings/controller.tsx`
- `mobile/src/app/miniapps/settings/position.tsx`
- `mobile/src/app/miniapps/settings/dashboard.tsx`
- `mobile/src/app/miniapps/settings/camera.tsx`
- `mobile/src/app/miniapps/settings/glasses.tsx` for non-OTA display reads
- `mobile/src/app/home.tsx`
- `mobile/src/app/wifi/scan.tsx`
- `mobile/src/components/glasses/Gallery/GalleryScreen.tsx` connection gating

Implementation notes:

- Use `engine.glasses.status()` / `onStatus()` for connection, readiness,
  battery, case, signal, mic/VAD, and Bluetooth Classic.
- Use `engine.glasses.info()` / `onInfo()` for device identity and versions.
- Use `engine.glasses.controller.status()` / `onStatus()` for controller UI.
- Use `engine.glasses.wifi.status()` / `onStatus()` for Wi-Fi UI.
- Use `engine.gallery.status()` / `onStatus()` for gallery sync UI.

Tests:

```bash
cd mobile && npm test -- --runTestsByPath src/__tests__/glassesFacade.test.ts
cd mobile && npm run compile
```

Exit criteria:

- Each converted file removes its `@/stores/glasses` import.
- Visual behavior is unchanged.
- Boundary allowlist shrinks after each conversion.

## Work Package 5: Bluetooth SDK Types/Predicates Subpath

Goal: share low-level connection predicates without importing native modules.

Changes:

- Add a pure subpath under the Bluetooth SDK package, for example:
  - `mobile/modules/bluetooth-sdk/src/types/index.ts`
  - package export `./types`
- Export:
  - `GlassesConnectionStatus`
  - `isConnectedGlassesConnectionStatus`
  - `isReadyGlassesConnectionStatus`
  - `isBusyGlassesConnectionStatus`
- Update `mobile/modules/engine/src/services/GlassesReadiness.ts` to consume
  those helpers and keep only engine-specific wait/reporting policy.
- Update host type-only imports that are intentionally low-level.

Tests:

```bash
cd mobile && npm run compile
./scripts/check-android-compile.sh bluetooth-sdk
```

Exit criteria:

- The `./types` subpath is side-effect free.
- No Expo/native module import is required for shared predicates.
- Engine no longer duplicates low-level predicate logic.

## Work Package 6: Pairing And Reconnect Conversion

Goal: host pairing UI renders engine state and calls engine commands; island
owns readiness waits and timeout diagnostics.

Convert:

- `mobile/src/hooks/useSearchingState.ts`
- `mobile/src/effects/Reconnect.tsx`
- `mobile/src/effects/BtClassicPairing.tsx`
- `mobile/src/app/pairing/scan.tsx`
- `mobile/src/app/pairing/btclassic.tsx`
- `mobile/src/app/pairing/loading.tsx`
- `mobile/src/app/pairing/success.tsx`

Implementation notes:

- Use `engine.pairing.readiness()` for route-level readiness display.
- Use `engine.pairing.waitForReady()` for the boot wait and automatic report.
- Use `engine.pairing.waitForBluetoothClassic()` instead of raw
  `waitForGlassesState("bluetoothClassicConnected", ...)`.
- Keep host navigation, wording, and troubleshooting UI in host routes.

Tests:

```bash
cd mobile && npm test -- --runTestsByPath src/__tests__/app/pairing/loading.test.tsx src/__tests__/app/pairing/scan.test.tsx src/__tests__/app/pairing/success.test.tsx src/effects/Reconnect.test.ts
cd mobile && npm run compile
```

Exit criteria:

- Pairing/reconnect production files no longer import `@/stores/glasses`.
- Automatic pairing timeout reporting remains island-owned.
- Host route transitions still behave as before.

## Work Package 7: Network And Gallery Plumbing

Goal: remove host handling of hotspot internals and ASG camera local IP.

Changes:

- Move the `NetworkMonitoring.tsx` behavior into island, near:
  - `mobile/modules/engine/src/services/DeviceEventRouter.ts`
  - `mobile/modules/engine/src/services/asg/gallerySyncService.ts`
  - `mobile/modules/engine/src/services/asg/asgCameraApi.ts`
- Let island configure `asgCameraApi` from hotspot or gallery sync state.
- Keep host gallery UI on `engine.gallery.status()` and
  `engine.gallery.onNotice()`.
- If manual Wi-Fi join guidance is needed, emit a gallery notice with the
  smallest user-actionable payload. Do not expose a generic hotspot facade.

Tests:

```bash
cd mobile && npm test -- --runTestsByPath src/services/__tests__/deviceEventRouter.test.ts src/services/asg/gallerySyncService.test.ts
cd mobile && npm run compile
```

Exit criteria:

- `mobile/src/effects/NetworkMonitoring.tsx` is deleted or reduced to a
  host-only mount wrapper with no hotspot read.
- Product host code no longer reads `hotspot.localIp`.
- Gallery sync still configures the camera API when hotspot/network state
  changes.

## Work Package 8: OTA Consolidation

OTA should be implemented as four smaller packages. Do not delete
`progress-legacy.tsx` until package 8D.

### 8A: OTA Snapshot And Check Orchestration

Goal: `engine.ota` owns update checking and exposes one snapshot.

Likely files:

- `mobile/modules/engine/src/facades/ota.ts`
- new `mobile/modules/engine/src/services/OtaCoordinator.ts`
- existing `mobile/modules/engine/src/services/OtaService.ts`
- `mobile/modules/engine/src/services/asgOtaVersionUrl.ts`
- `mobile/src/effects/OtaUpdateChecker.tsx`
- `mobile/src/app/ota/check-for-updates.tsx`

Move into island:

- version-info request/wait;
- BES/MTK late-arrival waits;
- manifest URL resolution;
- clock-skew pre-check;
- `mtkUpdatedThisSession` filtering;
- `setOtaUpdateAvailable` mutations.

Tests:

```bash
cd mobile && npm test -- --runTestsByPath src/effects/__tests__/OtaUpdateChecker.test.ts src/services/asg/__tests__/glassesClockSync.test.ts
cd mobile && npm run compile
```

Exit criteria:

- Host check screen calls `engine.ota.checkForUpdates()`.
- Host check screen renders `engine.ota.snapshot()`.
- No host code mutates `setOtaUpdateAvailable`.

### 8B: OTA Install State Machine

Goal: island owns install lifecycle and recovery.

Move into island:

- `ota_start` send/retry;
- `ota_start_ack` handling;
- `ota_query_status` on reconnect/remount and after `mtk_update_complete`;
- idle/no-reply fallback from query to `ota_start`;
- ping keepalive during active OTA;
- global, no-ack, stuck-at-zero, and progress-stall watchdogs;
- terminal cleanup;
- `setMtkUpdatedThisSession`;
- APK/MTK/BES sequencing and restart rules.

Tests to add under island service tests:

- starts OTA when connected with no active session;
- retries/fails when no `ota_start_ack` arrives;
- does not fail no-ack after ack;
- query `idle` does not cancel fallback and eventually retries `ota_start`;
- no useful query reply retries `ota_start`;
- `mtk_update_complete` triggers query and marks MTK updated this session;
- progress-stall timer is keyed on stable progress signature;
- BES terminal status enters restart/continue state.

Commands:

```bash
cd mobile && npm test -- --runTestsByPath src/__tests__/otaService.test.ts src/app/ota/__tests__/progress.test.tsx
cd mobile && npm run compile
```

Exit criteria:

- Host progress screen no longer calls `BluetoothSdk.sendOtaQueryStatus()`,
  `BluetoothSdk.ping()`, or raw `setMtkUpdatedThisSession`.
- Host progress screen only renders snapshot state and calls engine commands.

### 8C: Old-Build Compatibility In Unified Model

Goal: keep compatibility without a second host progress screen.

Preserve and test:

- legacy `ota_progress` mapping to unified snapshot;
- APK completion by build-number increase when explicit reconnect status is
  absent;
- manifest URL fallback for ASG builds that ignore
  `ota_start.ota_version_url`;
- any empirically required longer watchdog durations, represented as engine
  policy;
- BES restart/continue lockout.

Tests:

```bash
cd mobile && npm test -- --runTestsByPath src/services/__tests__/mantle-ota-status.test.ts src/app/ota/__tests__/deriveOtaDisplayState.test.ts src/app/ota/__tests__/progress.test.tsx
cd mobile && npm run compile
```

Exit criteria:

- Build `< 37` behavior is covered by engine/island tests.
- The unified host progress route renders old-build progress from the snapshot.

### 8D: Delete Legacy Route

Goal: one host progress route.

Changes:

- Delete `mobile/src/app/ota/progress-legacy.tsx`.
- Remove the build `< 37` branch in
  `mobile/src/app/ota/check-for-updates.tsx`.
- Update comments in `otaProgressTimeouts.ts`.
- Delete tests or fixtures that only exist for the old route.

Tests:

```bash
cd mobile && npm test -- --runTestsByPath src/app/ota/__tests__/progress.test.tsx src/app/ota/__tests__/deriveOtaDisplayState.test.ts src/__tests__/otaService.test.ts
cd mobile && npm run compile
```

Exit criteria:

- `rg -n "progress-legacy|MINIMUM_OTA_STATUS_BUILD" mobile/src mobile/modules/engine/src`
  has no production route reference. If the constant remains, it must be only a
  compatibility-policy test fixture or renamed to its real meaning.
- `mobile/src/app/ota/progress.tsx` is presentation only.

## Work Package 9: Cloud V1 Remnant Audit

Goal: produce a concrete deletion map before removing legacy comms.

Create:

- `cloud-v2/docs/issues/020-glasses-status-boundary/cloud-v1-remnant-audit.md`

Audit every call path in:

- `mobile/src/services/MantleManager.ts`
- `mobile/src/services/SocketComms.ts`
- `mobile/src/services/WebSocketManager.ts`
- `mobile/modules/engine/src/services/RestComms.ts`

Table columns:

| Call path | Current trigger | Cloud V1 dependency? | Disposition | Replacement | Delete blocker | Owner |
| --- | --- | --- | --- | --- | --- | --- |

Allowed dispositions:

- delete now;
- keep until named Cloud V2 port;
- move into engine/local runtime;
- intentionally low-level host/devtool.

Tests:

```bash
rg -n "updateGlassesState|sendGlassesConnectionState|glasses_battery_update|/api/client/device/state" mobile/src mobile/modules/engine/src -g '*.ts' -g '*.tsx'
cd mobile && npm run compile
```

Exit criteria:

- Every remnant has a row with a blocker or deletion decision.
- Cloud V1 device-state sync is not treated as a Cloud V2 requirement.

## Work Package 10: Delete Cloud V1 Device-State Sync

Goal: remove the generic device-state mirror after audit confirms no active
dependency.

Changes:

- Remove `MantleManager` subscription to `getGlasesInfoPartial`.
- Remove `WebSocketManager.sendGlassesStateIfNeeded()` or equivalent state push.
- Remove `SocketComms.sendGlassesConnectionState()` if no active V1 runtime path
  consumes it.
- Remove `RestComms.updateGlassesState()` if no remaining feature uses
  `/api/client/device/state`.
- Do not add any Cloud V2 equivalent.

Tests:

```bash
cd mobile && npm test -- --runTestsByPath src/services/MantleManager.test.ts src/services/WebSocketManager.test.ts
cd mobile && npm run compile
```

Exit criteria:

- No production code posts to `/api/client/device/state`.
- No generic cloud-visible glasses-state mirror exists in Cloud V2.

## Work Package 11: Escape Hatch Removal

Goal: make the boundary permanent.

Changes:

- Delete `mobile/src/stores/glasses.ts` after production host imports are gone.
- Delete `mobile/src/stores/gallerySync.ts` after gallery host imports are gone.
- Remove or narrow `engine.stores.glasses` and related raw store exports from
  `mobile/modules/engine/src/engine.ts`.
- Remove flat raw-store exports from `mobile/modules/engine/src/index.ts` unless
  still needed for tests/internal migration only.
- Turn the boundary script from allowlist/report mode into failing mode.

Final verification:

```bash
rg -n "from [\"']@/stores/glasses|useGlassesStore|waitForGlassesState|getGlasesInfoPartial|selectGlassesConnected|selectGlassesReady" mobile/src --glob '!**/__tests__/**' --glob '!**/*.test.ts' --glob '!**/*.test.tsx'
rg -n "@/stores/gallerySync|useGallerySyncStore" mobile/src --glob '!**/__tests__/**' --glob '!**/*.test.ts' --glob '!**/*.test.tsx'
./scripts/check-mobile-runtime-boundary.sh
cd mobile && npm test
cd mobile && npm run compile
./scripts/check-android-compile.sh bluetooth-sdk
```

Exit criteria:

- Production host code has no raw glasses/gallery store imports.
- Engine-owned devtools are inside engine/devtools.
- Remaining Bluetooth SDK imports are classified and intentional.
- Cloud V1 device-state sync is deleted or isolated as explicitly temporary
  legacy with a tracked blocker.

## Recommended Order

1. Work Package 3: missing facade deltas.
2. Work Package 1: devtools boundary.
3. Work Package 2: report-only guardrail.
4. Work Package 4: low-risk product UI.
5. Work Package 5: Bluetooth SDK predicate subpath.
6. Work Package 6: pairing/reconnect.
7. Work Package 7: network/gallery plumbing.
8. Work Package 8A-8D: OTA consolidation.
9. Work Package 9: Cloud V1 remnant audit.
10. Work Package 10: Cloud V1 device-state deletion.
11. Work Package 11: escape hatch removal and failing guardrail.

This order differs slightly from the architecture README: missing facade deltas
come before devtool extraction so the product UI and devtool moves have stable
APIs to land on. The guardrail still starts early, but only in report-only mode.
