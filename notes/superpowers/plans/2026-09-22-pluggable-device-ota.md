---
status: active
owner: Mentra
---

# Pluggable device OTA implementation

**Goal:** Implement the approved provider architecture for Live, NIMO and AR99; preserve Live policy/recovery; validate the mobile/native paths; open a PR to `dev`, mark it ready for review, and address CI/review findings. Do not merge automatically.

**Spec:** [Device-owned OTA](../specs/2026-09-22-pluggable-device-ota-design.md).

**Branch/base:** `device-ota-providers`, initially `origin/dev` at `75da48dec4`. Previous NIMO integration PR #4076 is merged. Baseline OTA sources match the reviewed `9762584dca` implementation.

## A. Characterization and contracts

- [x] Confirm current dev and existing PR state; preserve approved spec.
- [x] Establish provider/session types, registration, observation and admission.
- [x] Add synthetic fourth-provider contract coverage.
- [ ] Preserve the existing 237-test/reference consumer baseline; add missing lifecycle/background coverage as extraction proceeds.

## B. Complete Live extraction

- [x] Move hook decisions into a headless Live session; retain pure public presentation and compatibility APIs.
- [x] Own auto-chain state per Live flow and preserve its algorithm/deadlines.
- [x] Extract background availability and coordinate clock-recovery commands.
- [x] Protect coordinator ownership and asynchronous check publication.
- [ ] Implement runtime/resource reservations, safe cleanup and logout admission.
- [ ] Route all Live entry points through the provider; verify source/transport/recovery parity.

## C. NIMO integration

- [ ] Implement native Swift/Kotlin protocol/updater and public native session boundary.
- [ ] Add source/integrity/version policy, provider, operational compatibility restriction and device-aware UI routing.
- [ ] Add shared captured-protocol fixtures and native session tests.
- [ ] Validate phone builds and eligible-device iOS/Android OTA including readback and recovery gates.

## D. AR99 migration and common integration

- [ ] Add native identity/snapshot/ownership around existing managers without changing wire behavior.
- [ ] Move vendor lookup, download and modal execution into provider; preserve organization policy.
- [ ] Verify activation contract and native reconnect/restart behavior.
- [ ] Integrate provider diagnostics and finalize shared routing/UI/SDK docs.

## E. Validation and PR

- [ ] Run focused tests, public consumer/package gates, mobile type/lint checks and relevant Android/iOS builds.
- [ ] Complete hardware acceptance or explicitly record unverified gates; never claim untested OTA safety.
- [ ] Commit and push; create PR against `dev` with precise scope/evidence.
- [ ] Mark ready for review after implementation/validation, run repository Codex PR review, monitor CI and bots, fix supported findings and revalidate the final head.

## Evidence / unresolved hardware gates

User update: no AR99 hardware is available. Live E7FA is paired to the connected Android phone. Finish implementation, automated checks and builds first; ask the user before ANY hardware testing. Do not initiate a Live update, phone runtime test, or interruption experiment without that approval. iPhone remains unavailable.


The Mac NIMO bench update succeeded earlier; that device is now on the target firmware. It is not an eligible old-firmware phone test by itself. NIMO interruption recovery and production firmware approval remain unverified. AR99 activation/readback and Live phone regression updates require actual device evidence. Do not silently mark these checks complete or reflash/downgrade hardware speculatively.

## Working notes

- Initial research logs: `.context/ota-design-review/`; NIMO captured protocol/bench: `.context/nimo-ota-bench/`.
- Only reviewed behavior changes are permitted: provider lifetime, explicit resource/concurrency guards, and NIMO required compatibility. Live manifest/protocol algorithms remain intact.

### Implementation checkpoint: Live provider and ownership

The Live hook now binds to the registered native-device provider. Background checks are headless; the host renders prompts. Managed-owner guards protect legacy controls; coordinator starts revalidate the target, and clock recovery uses the same coordinator. Device/status subscriptions can survive runtime teardown. Gallery/OTA now reserve the existing hotspot lease and inactive gallery cleanup no longer disconnects another owner. User logout, account deletion, device changes and debug deployment changes have admission checks.

Validation so far: Engine TypeScript passes; 249 Jest tests passed across 10 OTA/gallery suites, 16 isolated Bun hook tests passed before the background-timer conversion, and 10 shared service tests passed. Further tests/builds and the remaining lifecycle work are still required. No phone or glasses testing has been performed in this implementation.

Auth/runtime teardown now suspends optional continuation while retaining unsafe native work; re-entry adopts or recreates the appropriate session. Starts recheck the selected manifest/device-version/connection context. The focused Live/session suites pass 117 tests, shared-service suites pass 12 tests, and Engine TypeScript passes after these changes.

Remaining Live work includes journal and native context boundaries, complete common presentation/routing (including development escape compatibility), additional trace/lifecycle coverage, and gallery async-cleanup ownership. NIMO protocol implementation has begun with matching Swift/Kotlin codecs and a shared captured-wire fixture. AR99 implementation has not begun yet. Do not mistake this checkpoint for completion or release approval.

### Native NIMO checkpoint

Implemented matching native OTA codecs/managers, with a shared captured-response/synthetic-block fixture. Both managers validate the image, honor device-requested slices/CRC, bound transfer/sync failures separately, send reset only after validation plus synchronization, and require full firmware/packed/peer readback for success. Native tests cover early failures, stale generations, duplicate start, backpressure, late reconnect and no-reset-on-uncertainty.

The additive native `FirmwareUpdater` contract now has device/updater/session identity, connection generation, revisioned replay, admission, reconcile, cancellation and acknowledgement. NIMO adapters own preparation and journal persistence; cold recovery can inspect a synchronized attempt without replaying a flash. SGC wiring pauses competing traffic, uses the existing connection/queue, negotiates Android OTA MTU after explicit admission, and protects device replacement. Public SDK bridge/types are being completed and tested. These changes are not a production firmware release.

Current evidence: 49 Swift NIMO/firmware tests passed; 131 Android NIMO tests and the SDK AAR compile passed. SDK TypeScript and existing public OTA API checks pass. No hardware tests or installs have run. Still required: Engine NIMO source/compatibility/provider and common routing, AR99 migration, complete Live lifecycle/routing parity, native boundary review, full phone builds and hardware approval/acceptance.

### Engine NIMO policy checkpoint

Added the NIMO provider, strict four-component/full-identity compatibility and manifest parsing, device/source/generation-bound offers, native snapshot replay/adoption, and scoped verified artifact staging. A new generated SDK catalogue has matching TypeScript/Swift/Kotlin values alongside unchanged Live release metadata. It carries the previously bench-verified firmware identity but no remote manifest pin or firmware distribution URL. Organization deployments explicitly disable bundled-source fallback. Native inventory now publishes a fresh sequence only after both version responses arrive.

Evidence: 29 provider/manifest/observation/shared-contract tests pass, six artifact integrity/cleanup tests pass, two catalogue-generator tests pass, 21 deployment-policy tests pass, and Engine/SDK TypeScript passes. Shared UI/routing implementation is underway; the independent fourth-provider render/adoption test passes. Live screen tests are being adapted to explicit native identity and retained-session lifetimes; their assertions still need to be fully green. NIMO native operation restrictions/cached compatibility, AR99, Live remaining lifecycle work, full platform builds and hardware acceptance are still outstanding. This checkpoint is not ready to merge.
