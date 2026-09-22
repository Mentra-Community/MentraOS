# January baseline to selected release: iOS on Mac

Status: the supervised January-to-target customer update reached the exact CI
manifest's BES, MTK and active ASG APK on the authorized lab fixture. Its continuous
recording preserves one failed transient-screen assertion; it is not a passing
routine. The January starting state was prepared using compact BES OTA and MTK
factory flashing, with independently verified original system ASG27. Full January
OTA setup and automatic teardown are **not yet qualified**.
The customer-only replay extension below starts from an already prepared baseline;
it does not claim to handle or qualify the complete January setup and recovery.

The test intentionally restores January firmware in setup. That authorized lab
preparation is distinct from the normal [OTA routine](OTA-ROUTINE.md), which does
not downgrade simply to repeat an update. OTA and Mentra Call remain separate.

See the [lifecycle contract](../../notes/superpowers/specs/2026-09-21-routine-lifecycle.md),
[orchestrator design](../../notes/superpowers/specs/2026-09-21-routine-orchestrator.md)
and [active plan](../../notes/superpowers/plans/2026-09-21-day1-ota-and-ci-routines.md).

## Inputs and qualification boundary

Select one CI Mentra App build. Its effective OTA manifest determines the final
BES, MTK and ASG artifacts and the normal return state. Archive exact app/manifest
identity, allowed legacy rescue manifests and every referenced artifact before
setup. Do not copy an old target independently of the app or select "latest"
again during the run.

Private fixture input supplies Bluetooth identity, an explicitly selected physical
USB path or verified Wi-Fi ADB endpoint, immutable eMMC CID and observed transport
aliases. An endpoint locates a candidate; the full MAC, CID and serial still prove
its identity. A January placeholder ADB serial is not
unique. Device credentials, factory assets, calibration/identity backups and raw
command/device evidence remain in ignored local storage.

| January start component | Required proof |
| --- | --- |
| BES | Fresh `17.26.1.13` response after installation of the accepted compact lab artifact; exact artifact digest and OTA gates. |
| MTK | `MentraLive_20260113` from the selected full OTA or explicitly selected factory images, boot completion and matching physical identity. |
| ASG | Original active factory APK bundled in January MTK, expected version code 27; verify exact APK/hash before freezing the baseline. No separate initial ASG installation is needed, and a newer installed update must not mask it. |

The compact BES raw image is 1,966,076 bytes, below the unchanged strict
1,966,080-byte OTA boundary. Its acceptance includes CRC, byte-identical
decompression, apply-model checks and fresh hardware version proof. It changes
diagnostic metadata and retains the installed OTA bootloader: this is a **modified
January lab baseline**, not proof of exact factory bootloader behavior. The
original January raw image is 260 bytes beyond the boundary and must not be used
over OTA. Do not generalize the accepted transformation to another image.

Full MTK OTA is the default for setup and restoration. Freeze a signed full OTA
for the requested target; a missing or unqualified artifact stops preparation
instead of silently choosing factory flashing. The January 13 target-files archive
has now been obtained and matched to the factory image set. Its generated signed
full downgrade OTA passes native signature verification and an apply check against
all fourteen target partitions. Device installation and Wi-Fi recovery remain
unqualified; target files themselves are not installable.

"Full OTA" describes replacement system content; it does not imply erasing user
data. Normal customer upgrades preserve data. The prepared January lab downgrade
explicitly carries a verified downgrade/wipe policy (`POWERWASH=1`): this removes
newer app updates and app data from `/data`, restoring the factory ASG27 already in
January MTK without a separate harness APK installation. January's own SystemUI
installs `/system/media/MentraOSLauncherBackup.apk` on the first boot after reset,
so the active ASG27 can legitimately be under `/data/app`. Verify version 27 and
identical active, system and backup APK hashes; do not uninstall that factory
copy merely because of its path. Reverify the reset policy in the frozen
artifact before dispatch; do not apply it to ordinary customer upgrades or assume
every full OTA wipes data. Saved Wi-Fi settings are also lost. Preserve required
fixture data and prove the normal January BLE Wi-Fi provisioning and independently
identified ADB return path. A successful USB return from newer firmware is not
evidence that January USB will return without a cable replug.

Factory flashing remains an explicitly selected setup or recovery alternative.
Its unattended helper uses the modern BES `cs_mtkfp` command, absent from January
BES. That option requires temporary compatible BES before flashing, then compact
January BES. The factory images also contain ASG27; any preserved `/data` APK
overlay must be identified and handled explicitly before the baseline can pass.
Preserve the actual installation method in every result. Never retry
an interrupted OTA using flashing until its original write is settled and recovery
is explicitly selected.

Record artifact download, device staging, dispatch, completion/reboot and independent
target verification timestamps separately for both methods. Compare dispatch to
verified boot/identity, disclose observer delays, and do not claim that OTA is faster
until both measured results exist for comparable starting and target states.
Keep package generation/upload time, a same-version reinstall and the later
multi-component customer upgrade separate from this downgrade comparison.

PR #4132's build was installed, verified and restored during the Mac host experiment.
Its effective manifest and legacy deployment policy have since been frozen for
setup qualification, with all eight normal/rescue artifacts cached and verified.
This is distinct from the requested PR #4136 device run: that run must select
its own exact successful producer artifacts and manifest.
The reusable [Mac CI importer](MAC-CI-SETUP.md) is now implemented with opt-in
installation and a pinned host launcher. Live PR #4132 installation, launch,
runtime artifact identity and existing Bluetooth grant reuse passed. This does
not establish firmware-asset availability, all required permissions or glasses
readiness for this routine.

## English routine

1. **Resolve the build and return state.** Archive the selected app's provenance,
   runtime configuration, effective target/rescue manifests and artifacts. Verify
   that recovery can restore the same selection. ASG below 39 does not override a
   deployment policy that disables legacy rescue.
2. **Preflight the host and fixture.** Acquire exclusive ownership; verify physical
   glasses identity, power, available storage, host permissions and tool readiness.
   Record current firmware, active ASG hash, slot and boot identity. Require no
   active call, media transfer or firmware operation.
3. **Establish the January lab baseline.** For the default route, install compact
   January BES through its qualified OTA path while modern ASG remains active,
   then apply the signed full January MTK OTA with its verified `POWERWASH=1`
   policy. Preserve identity/calibration and recover Wi-Fi through the owned
   January BLE setup path. Verify the bundled factory ASG27; do not add a separate
   initial APK installation. Record every mutation and its postconditions. The
   prepared full MTK adapter still needs device qualification; this setup has its
   own result and must not be presented as the customer upgrade.
4. **Verify the starting state.** Independently prove all three January components
   and the same physical glasses. Do not start the customer test with modern MTK
   or an overlaid modern ASG APK. Keep failed preparation attempts as failures.
5. **Start customer-flow evidence.** Begin continuous Mentra window recording plus
   a private hardware/log timeline. Keep pointer and focus available through the
   existing semantic driver. Assign English chapters and screenshots to each
   observed UI action/state.
6. **Connect as a new user.** Open the selected Mentra App, sign in if needed and
   pair the identified glasses through normal UI. Record permission waits and
   onboarding; confirm adequate battery and no conflicting activity.
7. **Accept the mandatory update.** Follow the app's update and Wi-Fi setup screens.
   Read the offered information and start once. Record missing version information
   as a UI limitation rather than claiming it was displayed.
8. **Observe update and reconnect.** Record actual downloads, stages and restarts.
   Follow only the permitted route from the frozen manifests. Re-resolve the
   selected transport and immutable identity after return. Do not Retry, relaunch or resend while a write
   may still be active, even after a recorder deadline or USB disappearance.
9. **Follow remaining normal update offers.** Stay in the same owned sequence
   through any legacy rescue/intermediate release. Intermediate completion does
   not pass a January-to-target test. Never use ADB installation to rescue the
   customer flow's pass result.
10. **Verify the target independently.** Require fresh BES equal to
    `bes_firmware.version`, boot-complete MTK matching `mtk_full_ota.end_firmware`,
    and active ASG version/hash matching `apps["com.mentra.asg_client"]`. Verify
    physical identity and Bluetooth reconnection; preserve contradictory evidence.
11. **Finish and freeze the result.** Use the app's normal Done/Continue control,
    reach paired home and verify no active update. Do not start Mentra Call.
12. **Teardown and verify reuse.** Preserve failure evidence, settle active writes,
    restore the manifest-derived return state if necessary and remove only owned
    helpers/overrides. Verify versions, ASG hash, boot, idle state and app connection.
    Successful restoration never changes a failed test to passed. Unverified
    restoration makes the fixture unavailable to other routines.
13. **Finalize evidence.** Save commands, semantic selectors, screenshots, accessibility
    snapshots, MP4 segments, English chapters and separate test/teardown verdicts.
    Check playback and seeking through the localhost report viewer. Label setup,
    actual upgrade, already-current checks and incomplete attempts separately.

## Replay and remaining work

Reuse the existing semantic driver, Bun report/video pipeline, `ota.ts` and
independent `runner/ota-hardware.ts` checks. Extend them through the lifecycle
contract rather than copy an artifact-specific exploratory script into a general
installer. The January setup/recovery adapters must expose immutable artifact
inputs and no-resend operation ownership before unattended use.

The shared `runner/lifecycle.ts` now supplies setup/test/assertion/teardown hooks,
an append-only mutation journal, no-resend recovery and persistent fixture
readiness. `firmware-state.ts freeze` pins a manifest-derived return profile;
`firmware-state.ts verify` evaluates supplied observations without hardware
access. Its results explicitly say `offline-assertion`. The fourteen checks
cover identity, freshness, boot, target versions, active ASG hash, idle update
state and app connection. The real adapter must collect those observations.

The initial `ci-worker.ts` only authenticates and claims requests. It cannot
install firmware or report a hardware pass. Its current unqualified result is
intentional until the complete January setup and recovery adapters pass on-device.

The successful limited BES preparation required a legacy BLE version query after
the UART-origin recovery timed out. Fresh BES proof was obtained before restoring
ASG27; the app-only restore preserved the same boot and physical identity. ASG27
consumes `hs_syvr/B.version` and does not handle the newer `sr_syvr/B.dpj` reply,
so the subsequent normal query produced no fresh version. Preserve this continuity
evidence and the unavailable fresh post-restore response separately. Do not turn a
cached version into an independent assertion or weaken final modern firmware
checks. This is not proof that January setup is currently unattended.

The first recorded customer attempt on PR #4136 head `25d5c418` stopped before
firmware installation: ASG27 sent two version-info chunks, while the native SDK
waited for a third and the UI mislabeled that timeout as a network error. The fix
recognizes ASG27's terminal second chunk on both native platforms, retains modern
response correlation, and shows a distinct software-version read error. Its unit
tests pass. The replacement CI app was exercised in the next recorded device test.
The failed recording, screenshots and English chapter seeking have been verified
in the local admin dashboard without claiming a complete upgrade or teardown.

The September 22 run on head `1d716af0`, CI app build `303006206`, completed the
normal customer update after a single **Update Now** press. The independently
observed route was January MTK with ASG27 → ASG31 → ASG37, July MTK with factory
ASG39, then the selected PR ASG and September MTK. Live checks matched MTK
`MentraLive_20260921.0`, BES `26.9.21.3`, ASG `303006206` and the manifest's active
APK SHA-256. The original 20-step, 28-minute recording retains OTA-12's failed
expectation: it required the brief Downloading screen after the app had already
advanced to Installing. The compiled routine must accept legitimate forward
progress rather than require every transient label. About 15 minutes 13 seconds
elapsed from the press to the observed Update Complete screen; this multi-component
customer upgrade is not the full January downgrade benchmark.

The result keeps `test: failed`, `teardown: blocked` and `fixture: unavailable`.
Matching component versions do not prove updater inactivity. The new opt-in ASG
activity observation requires a separate build and physical qualification before
it can establish return readiness. The report is a supervised run related to its
CI request, not an unattended execution of that request. Its sanitized recording,
chapters and component assertions use the [reviewed exporter](DAY1-EXPORT.md).

No passing day-one video exists yet. Required completion evidence is one real
January-to-selected-target run with full phase results and verified return state,
plus simulated failure/recovery coverage. The next routine must reject an
unavailable fixture; it must not infer readiness from a recorder exit code.

### Customer replay with a reviewed legacy route

`ota.ts` now has a source-tested, **not yet device-qualified** extension for a
prepared January baseline. It reuses the normal observer/semantic controls and
strict final BES, MTK, ASG version and active APK hash checks. It performs no
baseline installation and no automatic restoration.

Supply `--legacy-route /absolute/path/legacy-route.json` and
`--fixture-state-directory /absolute/path/existing-fixture-state` in addition to
the ordinary OTA arguments and `--install`. The fixture directory must already
contain the existing owner's `fixture.json`, explicitly handed over as ready;
its `fixtureID` is the lowercase eMMC CID. Do not create a second directory or
change an unresolved writer's status to bypass ownership. The shared lifecycle
claims that fixture and durably records one bounded customer sequence before
entering any of its UI actions. The legacy path rejects `--resume`; recovery must
reconcile the existing intent without invoking the UI loop or replaying presses.

The private route follows `LegacyRoute` in `runner/ota-legacy-route.ts`:

- `schemaVersion: 1`, exact selected `buildSha`, `executableSha256` and
  `manifestSha256` bind it to this app and target.
- `effectivePolicy` is an absolute file reference with `size` and `sha256`. Its
  reviewed JSON repeats `buildSha` and `executableSha256`, supplies the selected
  `manifestUrl`, and proves `allowLegacyOtaFallback: true` and
  `modernOverride: null`. Obtain this from actual installed configuration; the
  parser verifies integrity and the declared policy, not the truth of an audit.
- `sourceEvidence` contains nonempty hash/size-locked source or binary inspection
  evidence establishing which legacy URLs the installed ASG versions consume.
- `manifests` contains those exact ordered rescue URLs, local paths, sizes and
  SHA-256 values. January's flat ASG descriptor and later multi-component feeds
  are supported. The permitted MTK route follows first matching rescue patches,
  then the selected modern manifest; unrelated branches stay invalid.
- `artifacts` contains local path/URL/size/SHA-256 records for every ASG and BES
  artifact in those feeds and every selected legacy MTK patch. Existing bytes are
  hashed; the controller never downloads firmware or substitutes another asset.
- `embeddedAsg` records an ASG exposed by an intermediate system image: normalized
  firmware version, ASG `versionCode`, its hash/size-locked `artifact` file and
  separate reviewed `evidence` file. This permits the observed July ASG handoff
  without treating an arbitrary stock version as valid.

The runner compares the mutable rescue endpoint bytes with their frozen digests
before preflight, every **Update Now** press, and final target verification. A
changed endpoint or cached file stops the run. The app still owns its normal OTA
network requests; this does not make a rolling server endpoint immutable between
checks. The legacy path accepts only its explicit ASG set, including during an
active pass. At Device Info it matches the full Bluetooth MAC and exact observed
ASG build because January exposes only a serial suffix. Independent ADB checks
still require the full serial, immutable CID and full MAC on the selected transport.

The lifecycle result separates the customer test from fixture readiness. A fully
verified customer sequence can have `test: passed`, while the overall result and
exit code remain unsuccessful because the authoritative updater-idle/return
adapter is not implemented. `returnVerification` deliberately fails and the
fixture stays `recovery-required`; an empty setup/teardown phase means no adapter
ran, not that January setup or restoration was qualified. The actual video,
chapters and screenshots are finalized and checked with `verify-run.ts`, including
for failed observations. Do not label this extension an unattended end-to-end
pass until setup, independent idle/return verification and recovery are qualified.
