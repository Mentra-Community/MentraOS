# January baseline to selected release: iOS on Mac

Status: preparation and design are in progress. A compact January BES image was
installed and freshly verified on the authorized lab fixture. January MTK factory
flashing also completed with independent Wi-Fi ADB verification, and the original
system ASG27 is active with its exact January APK hash. Full January OTA, the
complete customer OTA recording and automatic teardown are **not yet qualified**.
This document does not add a runnable day-one
command or claim that the existing `ota.ts` handles all January behavior.

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

Private fixture input supplies Bluetooth identity, physical USB path, immutable
eMMC CID and observed transport aliases. A January placeholder ADB serial is not
unique. Device credentials, factory assets, calibration/identity backups and raw
command/device evidence remain in ignored local storage.

| January start component | Required proof |
| --- | --- |
| BES | Fresh `17.26.1.13` response after installation of the accepted compact lab artifact; exact artifact digest and OTA gates. |
| MTK | `MentraLive_20260113` from verified factory images, boot completion and matching physical identity. |
| ASG | Original active factory APK, expected version code 27; verify exact APK/hash before freezing the baseline. A newer installed update must not mask it. |

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
has now been obtained and matched to the factory image set. Building and qualifying
its signed full OTA remains in progress; target files themselves are not installable.

"Full OTA" describes replacement system content; it does not imply erasing user
data. Normal customer upgrades preserve data. The January lab downgrade must
explicitly carry the verified downgrade/wipe policy (`POWERWASH=1`): this removes
newer app updates and app data from `/data`, exposing the factory ASG27 already in
January MTK. Saved Wi-Fi settings are also lost. Before dispatch, preserve required
fixture data and prove the normal January BLE Wi-Fi provisioning and independently
identified ADB return path. A successful USB return from newer firmware is not
evidence that January USB will return without a cable replug.

Factory flashing remains an explicitly selected alternative. Its unattended helper
uses the modern BES `cs_mtkfp` command, absent from January BES. That option requires
temporary compatible BES before flashing, then compact January BES and factory ASG
restoration. Preserve the actual installation method in every result. Never retry
an interrupted OTA using flashing until its original write is settled and recovery
is explicitly selected.

Record artifact download, device staging, dispatch, completion/reboot and independent
target verification timestamps separately for both methods. Compare dispatch to
verified boot/identity, disclose observer delays, and do not claim that OTA is faster
until both measured results exist for comparable starting and target states.

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
3. **Establish the January lab baseline.** Use the qualified BES and full MTK OTA
   setup adapters in their verified order, preserving identity/calibration. Record
   every mutation and any owned clean-data reset. This preparation has its own
   result and must not be presented as the customer upgrade.
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
   Follow only the permitted route from the frozen manifests. Re-resolve USB and
   immutable identity after return. Do not Retry, relaunch or resend while a write
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

No passing day-one video exists yet. Required completion evidence is one real
January-to-selected-target run with full phase results and verified return state,
plus simulated failure/recovery coverage. The next routine must reject an
unavailable fixture; it must not infer readiness from a recorder exit code.
