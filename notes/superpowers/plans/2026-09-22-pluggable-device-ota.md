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
- [ ] Establish provider/session types, registration, observation and admission.
- [ ] Add synthetic fourth-provider contract coverage.
- [ ] Preserve the existing 237-test/reference consumer baseline; add missing lifecycle/background coverage as extraction proceeds.

## B. Complete Live extraction

- [ ] Move hook decisions into a headless Live session; retain pure public presentation and compatibility APIs.
- [ ] Own auto-chain state per Live flow and preserve its algorithm/deadlines.
- [ ] Extract background availability and coordinate clock-recovery commands.
- [ ] Protect coordinator ownership and asynchronous check publication.
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

The Mac NIMO bench update succeeded earlier; that device is now on the target firmware. It is not an eligible old-firmware phone test by itself. NIMO interruption recovery and production firmware approval remain unverified. AR99 activation/readback and Live phone regression updates require actual device evidence. Do not silently mark these checks complete or reflash/downgrade hardware speculatively.

## Working notes

- Initial research logs: `.context/ota-design-review/`; NIMO captured protocol/bench: `.context/nimo-ota-bench/`.
- Only reviewed behavior changes are permitted: provider lifetime, explicit resource/concurrency guards, and NIMO required compatibility. Live manifest/protocol algorithms remain intact.
