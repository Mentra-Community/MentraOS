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
  provenance and hashes locally. The newly supplied January target-files archive
  passes all 6,390 entry CRCs and matches the factory partition images. Its signed
  full downgrade OTA passes native signature verification and an apply check
  against all fourteen target partitions. A supervised full OTA and independent
  January boot/ASG27 reconciliation passed; complete tracked execution remains pending.
  The prepared package explicitly uses `POWERWASH=1`, exposing the ASG27 already
  bundled in January MTK without a separate initial APK installation. Full OTA
  alone does not imply a wipe. The target-files archive itself is not installable.
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
- [x] Replace the scripts in the existing company Mac PR ZIP with a native
  `Install Mentra.app`; wire Developer ID signing, Apple notarization, stapling
  and delivered-ZIP checks into the existing PR build/publication workflow.
  Keep the iOS payload's original signature and the existing Mac download link.
- [x] Qualify the locally compiled native installer against PR #4132's original
  signed app: normal replacement and launch, running executable/JavaScript
  hashes matching the manifest, original app signature valid, existing account
  and glasses pairing visible. Save screenshots and verification commands
  privately. This is not notarized-download qualification.
- [x] Retain the native installer after first-time setup and add an HTTPS
  **Install on Mac** link to the existing verified PR artifact page and Slack
  notification. The link selects immutable PR/head/run/publication-attempt
  coordinates; its native handler downloads from the fixed Mentra CDN into an
  owned cache, verifies the receipt/archive/app/OTA pin and replaces the managed
  app. Existing immutable pages keep their original download-only behavior.
- [x] Verify the actual PR #4132 publication-attempt-2 receipt and its original
  build-attempt-1 ZIP through the native downloader, including Mac provisioning,
  signature and cache cleanup. Verify the new ZIP format including AppleDouble
  metadata, and Safari's handoff to the registered URL handler. Keep all commands
  and results in the local run directory.
- [ ] Qualify the full browser link with a notarized persistent helper, both
  already running and after quitting it, including repeated link clicks and
  permission reuse. The locally signed preview was stopped by Gatekeeper before
  the retained helper entered its main function; no security setting or quarantine
  flag was changed to get past that gate.
- [x] Provision the Developer ID Application certificate/private-key export and
  password in Doppler `mentra-mobile-client/prd`. Verify matching keys, team and
  saved values. CI fetches only this pair at signing time; notarization credentials
  remain in the existing GitHub secrets. A real signed/notarized CI artifact is
  still required before merging the packaging change.
- [ ] Download the resulting CI ZIP through a browser on a registered Mac and
  qualify Gatekeeper launch, translocation/folder selection, app replacement and
  permission reuse. Recheck first-use setup on a new test host separately.
- [x] Freeze PR #4132's app/manifest for setup qualification, verify the running
  executable/JS and legacy policy, and cache all eight referenced normal/rescue
  artifacts by size and SHA. This preparation selection is distinct from the
  requested PR #4136 run, which must select its own successful artifacts.
- [x] Preserve original January assets outside Downloads and verify the complete
  copy. Recheck storage at each staging/recording boundary; free space is not a
  permanent readiness claim.
- [x] Add typed lifecycle hooks, durable mutation/phase journal and persistent
  fixture readiness. Hardware adapters still need integration/qualification.
- [x] Implement recovery that reconciles an unfinished write and never blindly
  resends it; 17 tests cover partial setup, cancellation, process interruption,
  damaged journals and failed restoration.
- [x] Qualify the explicit MTK factory-flash alternative around January BES's
  missing `cs_mtkfp`: one flash completed 14 image writes and 24 sampled readbacks.
  USB did not return; read-only Wi-Fi ADB reconciliation verified January MTK and
  the retained ASG overlay. The original timeout remains in evidence.
- [x] Add explicitly selected Wi-Fi ADB observation, preserving CID/serial/full
  Bluetooth identity and fail-closed reconnect classification. Fifteen focused
  tests and a real read-only January observation pass.
- [ ] Qualify the prepared full MTK OTA adapter as the default for setup/restoration,
  retaining flashing only as an explicitly selected setup or recovery option.
  Install compact January BES while modern ASG is active, then apply the full
  January MTK downgrade with its verified wipe policy and verify bundled ASG27.
  Qualify BLE Wi-Fi reprovisioning and independent identity/boot return. Measure
  full OTA and flashing on comparable downgrades; keep staging, generation and
  the later customer update timings separate. One supervised full OTA and baseline
  reconciliation passed; the extracted setup/restoration composition is not yet qualified.
- [x] Implement frozen manifest parsing, fourteen independent firmware/identity
  assertions and an offline verification CLI (16 focused parser/CLI tests).
  Live adapters must collect those observations; supplied JSON alone cannot
  establish hardware qualification. The lifecycle retains the unavailable-fixture
  gate when restoration is unverified.

## Day-one device qualification

- [ ] Prove January BES, MTK and active factory ASG on the same physical glasses.
- [x] Execute the English customer flow through normal Mentra App UI with continuous
  recording, step screenshots, chapters and independent hardware observations.
- [x] Verify final BES/MTK/ASG version and active ASG hash against the selected
  effective manifest; retain failures without relabeling them after recovery.
- [ ] Verify teardown, idle app connection and the next routine's entry checks.
- [ ] Check actual HTML playback/seek and finalize the full evidence/result bundle.

The full January baseline has scoped setup proof, including verified BES install
continuity through the wipe. The complete recorded day-one routine has not passed.
Neither that setup proof nor a later successful return observation substitutes
for the complete routine, its original test verdict or CI request ownership.
Do not start Mentra Call as part of this routine.

The 2026-09-22 UTC setup diagnostic confirmed a parser failure before firmware
payload transfer was observed: raw-mode entry retained 225 bytes, then three
nine-byte reads with `0x9A` response headers remained incomplete behind the stale
`23 23 30 00 2e` header (declared length 771,764,259). The owned operation ended
`authorization_unreconciled`. Its immutable local admin export preserves the
received-header evidence separately from the absence of a parsed response;
that attempt remains failed and does not qualify the full January baseline.

The subsequent owned transition, with the parser state isolated at admitted raw
entry, passed on hardware: the first `0x9A` response parsed, all 1,162,826 bytes
were confirmed and BES `26.9.21.1` verified after a new boot. The observer initially
rejected the completion event's `verify_boot` field; its error is preserved, and
separate read-only reconciliation verified the same fixture, exact active APK and
successful owned version proof without resending. This is a temporary BES setup
pass only. January MTK was then flashed and independently verified over Wi-Fi ADB.
Compact January BES transferred and rebooted; its recovery timeout was reconciled
by a normal ASG-reader restart and fresh legacy version query, without resend.
The newer ASG overlay was removed, exposing the January system APK (version 27,
matching the verified original digest). A later ASG27 query did not produce a
fresh BES version response; that limitation is retained alongside the same-boot
version proof immediately before the ASG-only revert. This historical setup used
flashing; the later customer recording below does not qualify the prepared full
January OTA setup or return-profile restoration.

The first customer attempt used PR #4136 head `25d5c418`'s verified CI Mac app
(`303006135`) and exact PR OTA manifest. It failed before firmware dispatch:
January ASG27 sends only `version_info_1` and `version_info_2`, but the native
accumulator required `version_info_3`. The normal startup check skipped the fresh
query, so it showed an update offer; pressing Install performed the query and
timed out with a misleading network error. Both native accumulators now recognize
the verified ASG27 format while retaining modern correlation and completion rules.
The shared UI preserves the distinct version-query failure. Focused native and
hook tests passed; the replacement build was exercised in the later run below.

The finalized failed recording has three screenshot/chapter entries and plays in
the authenticated local admin dashboard. Selecting the English failure-observation
step seeks to 1:59 and shows the recorded Check Failed screen. Its test is failed,
teardown remains blocked and the fixture remains unavailable. A separate immutable
CI request (run `35694052494`, attempt 2) authenticated successfully and selected
the same exact artifacts; it did not dispatch this manual qualification.

Measured flash timings: dispatch to writes/readbacks completed was 123.974 seconds;
first independent network boot observation was at 299.785 seconds; complete
read-only verification was at 579.256 seconds. The latter includes the original
USB wait and manual observation delay. The later full OTA transfer/apply took
34.334/186.218 seconds and its first verified boot was at 534.994 seconds. This
is not a matched comparison: the OTA wiped userdata, while flashing preserved it.

The replacement CI app at head `1d716af0` (build `303006206`) completed the normal
customer update from the prepared January baseline on the same 03BE fixture.
Independent checks during recording matched MTK `MentraLive_20260921.0`, BES
`26.9.21.3`, ASG `303006206` and active APK SHA-256
`0b257034d4bbf1ea4f5f25e636053b98c8b6727c1032a706ffebc73efeb419dc`.
The 20-step recording retains a failed transient Downloading expectation after
the UI had advanced to Installing. It remains a failed test with blocked teardown
and an unavailable fixture. The full January OTA setup and authoritative runtime
idle check still require their own device qualification.

The real recording and component assertions were published to the authenticated
local admin as `manual-day1-119ff3af24b9cd693e87f651`. Browser inspection found a
black video despite working chapter selection. The original video decodes in
AVFoundation; the local HTTP server dropped Content-Length on ranged Node streams.
Lazy file bodies fix the response, with a real socket regression covering initial
and tail byte ranges, HEAD and stale If-Range. The unlocked September 22 Safari
recheck confirms correct ranges and fully buffered media without a media error,
but the visible top-level document still reports `visibilityState=hidden` and
does not advance decoded frames. Window/tab selection and moving between displays
did not resolve that rendering failure. Temporary diagnostics were removed;
native fullscreen playback subsequently worked, while inline playback still
reported the hidden-document failure. Normal inline playback remains unverified.
The original recording and publication
remain unchanged.
CI request `routine-35699614125-2-4136-day1-ota` selected the same successful build
but remains context only; this supervised run did not consume it.

## CI and results integration

The September 22 full downgrade applied successfully over Wi-Fi: transfer took
34.334 seconds and the successful apply observation followed dispatch by 186.218
seconds. After the owned restart, independent reads found January MTK, a new boot
on the expected slot, ASG27, and absence of the owned pre-reset userdata witness.
The active, system and backup ASG APKs all match the original January digest.
The initial recovery check nevertheless failed because it required a system APK
path. Exact January SystemUI disassembly confirms first-boot installation from
its bundled backup, explaining the valid `/data/app` copy. Preserve that failure
and qualify the corrected identity check through separate read-only reconciliation;
these observations alone do not pass the full routine or its teardown.

The later customer sequence at head `e5ecea74` completed the selected firmware
path after a single Update Now action. All fourteen independent return checks
passed for MTK `MentraLive_20260921.0`, BES `26.9.21.3`, ASG `303006291` and its
exact APK. The original recorder failed during an intermediate reboot; its
verdict remains failed. The separate return recording passed its video/chapter
checks. Fixture enrollment then stopped at the Mac lock screen before device
commands; the fixture is still unenrolled and no CI request was consumed.

- [x] Add exact PR build/receipt/archive/OTA selection and immutable request
  validation, including separate build and publication attempts.
- [x] Add cache-only `ci-worker.ts prepare`, using canonical receipt verification,
  Apple signature checks, selected return artifacts and reviewed legacy route.
  The real historical e5 cache passed; this does not authenticate an obsolete
  request as current or install anything.
- [x] Add selected-target full-OTA restoration steps with original-source/apply
  records and read-only recovery after a missing worker dispatch record. The
  concrete local runtime now has subprocess coverage; physical restoration
  remains to be qualified.
- [x] Verify the selected normal MTK full OTA with the native build tools:
  explicit-key signatures pass and all fourteen reconstructed partitions match
  the exact target-files archive. The full image has no POWERWASH/downgrade flag.
  The verification-only job took 135.692 seconds including host tools and did
  not install firmware. The private proof has SHA-256
  `a321f26c01f20ee875f07301a0565f8fe210944c615ce0e87ff4623a5da6b3ff`.
- [x] Compose the existing lifecycle adapters around explicit app stop/start,
  original BES continuity, January setup, recorded customer actions, restoration
  and combined return verification. Preserve an active/unknown writer barrier
  before teardown even when a final read fails after earlier customer success.
  The selected USB fallback observes modern return after Wi-Fi ADB is disabled;
  it requires the real MAC and a different valid boot identity and never carries
  January's empty-property exception onto that return.
- [x] Exercise the tracked BES source observer on actual glasses with temporary
  Wi-Fi ADB enabled then restored. No firmware dispatch or fixture enrollment
  occurred; the complete BES installation runtime remains unqualified.
- [ ] Add coordinated-release selection through the same input interface.
- [ ] Extend coordinated Apple exports with a Mac ZIP and receipt; preserve stable
  identity and effective OTA configuration across installs.
- [x] Add immutable Actions requests and local intake with exclusive durable
  claims and a private exact-revision trust policy. The default CLI registry
  remains closed. An explicitly reviewed lab registration may admit the first
  qualification run using pinned artifact verification, code/component evidence
  and an enrolled fixture. Its admission record must retain that complete-routine
  qualification is still pending; admission never supplies a passing test verdict.
- [ ] Connect qualified day-one execution and upload-only retries to that intake;
  run the current PR's actual artifacts and publish its real result.
- [x] Add authenticated admin Test runs browsing, expected/actual firmware,
  separate phase outcomes and private streaming media with byte-range seeking.
  Local tests and a clearly labeled synthetic browser fixture verify playback,
  chapter seeking, authenticated deep links and filter behavior.
- [ ] Verify actual CI-request ingestion and real recorded evidence in the
  dashboard. Synthetic viewer checks are not a device-run result.
- [x] Implement an independently retryable publisher with explicit asset paths,
  size/hash checks, immutable metadata reconciliation and a durable upload journal.
  It does not repeat device actions. Eleven focused tests pass.
- [ ] Enable independent dev/staging nightlies after routine qualification, recording
  chosen-release age and missing/newer-failed artifact state.
- [ ] Add reviewed path-based PR selection plus author additions and advisory,
  current-head verification comments/checks; test stale-result rejection.
- [ ] Revisit private-repository migration after this simpler path is working.

Proposed schedules, retention, service deployment and required-check policy remain
unactivated. A code PR does not establish physical-device qualification.
