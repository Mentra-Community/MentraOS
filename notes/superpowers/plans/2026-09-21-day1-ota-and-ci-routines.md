---
status: active
owner: Philippe
---

# Day-one OTA and CI routines implementation plan

Build and qualify locally on the existing Mac in MentraOS first. Keep definitions,
specs and reusable code in this repository; keep credentials, fixture identities,
firmware backups and raw evidence ignored/private. Private-repository migration
is deferred until the simpler CI hookup works.

Source of truth:
[lifecycle](../specs/2026-09-21-routine-lifecycle.md),
[orchestrator](../specs/2026-09-21-routine-orchestrator.md),
[CI and admin](../specs/2026-09-21-ci-routines-and-admin-results.md),
[Mac host](../specs/2026-09-21-mac-test-host-installation.md),
[English day-one steps](../../../tools/mentra-e2e/DAY1-OTA-ROUTINE.md).

## Completed investigation

- [x] Locate and compare original January BES/MTK factory assets; keep source
  provenance and hashes locally. January target-files/full downgrade OTA remains
  unavailable and does not block the factory-flash setup design.
- [x] Confirm the original January BES exceeds the OTA boundary by 260 bytes;
  preserve the existing size gate.
- [x] Prepare and independently verify the accepted compact BES artifact on the
  authorized lab fixture, retaining diagnostic-metadata/bootloader limitations and
  the legacy version-query recovery evidence.
- [x] Install and verify PR #4132's CI Mac build; perform PR #4132 → #4101 → #4132
  replacement and confirm Bluetooth grant reuse on the provisioned host.
- [x] Write tracked lifecycle, orchestration, CI/admin and Mac installation specs.
- [x] Write the separate day-one English routine and qualification boundaries.

## Immediate implementation

- [x] Add the selected-PR Mac importer, verification-only default, opt-in install
  and pinned preinstalled-launcher support, with 20 focused unit tests. Document
  exact invocation and one-time approval in [Mac CI setup](../../../tools/mentra-e2e/MAC-CI-SETUP.md).
- [x] Qualify reusable importer installation/launch against PR #4132: running
  executable/JS match the receipt, the pinned host helper is used, existing
  Bluetooth consent is reused and foreground remains unchanged. No firmware
  action or new permission enrollment is covered by this pass.
- [x] Add `e2e-setup-checks.yml` to run the 20 guard unit tests on Ubuntu only;
  this does not enable hardware execution or a nightly schedule.
- [ ] Resolve one app/manifest selection for the day-one test and verify effective
  legacy rescue policy plus all normal return artifacts. The currently restored
  PR #4132 installation alone is not this qualification.
- [ ] Prepare adequate free storage for firmware staging, backups, video and
  recovery without deleting retained evidence or unrelated files.
- [ ] Add typed lifecycle hooks, durable mutation/phase journal and persistent
  fixture readiness around existing runner components.
- [ ] Implement recovery that reconciles an unfinished write and never blindly
  resends it; cover partial setup, failure and cancellation with simulated devices.
- [ ] Qualify MTK factory-flash ordering around January BES's missing `cs_mtkfp`;
  verify original ASG is active after setup and operational recovery works.
- [ ] Implement manifest-derived return verification and the unavailable-fixture
  gate. Restore only owned app/firmware/configuration changes.

## Day-one device qualification

- [ ] Prove January BES, MTK and active factory ASG on the same physical glasses.
- [ ] Execute the English customer flow through normal Mentra App UI with continuous
  recording, step screenshots, chapters and independent hardware observations.
- [ ] Verify final BES/MTK/ASG version and active ASG hash against the selected
  effective manifest; retain failures without relabeling them after recovery.
- [ ] Verify teardown, idle app connection and the next routine's entry checks.
- [ ] Check actual HTML playback/seek and finalize the full evidence/result bundle.

The full January baseline and recorded day-one test have not passed. Limited BES
preparation and earlier ordinary OTA runs cannot substitute for this qualification.
Do not start Mentra Call as part of this routine.

## CI and results integration

- [ ] Add normalized PR/coordinated-release selection and immutable input validation.
- [ ] Extend coordinated Apple exports with a Mac ZIP and receipt; preserve stable
  identity and effective OTA configuration across installs.
- [ ] Add one sequential request queue/worker with durable leases and upload-only
  retries; keep local CLI use independent of the service.
- [ ] Add authenticated admin Test runs browsing, expected/actual results and
  private streaming media with working byte-range seeking.
- [ ] Enable independent dev/staging nightlies after routine qualification, recording
  chosen-release age and missing/newer-failed artifact state.
- [ ] Add reviewed path-based PR selection plus author additions and advisory,
  current-head verification comments/checks; test stale-result rejection.
- [ ] Revisit private-repository migration after this simpler path is working.

Proposed schedules, retention, service deployment and required-check policy remain
unactivated. A code PR does not establish physical-device qualification.
