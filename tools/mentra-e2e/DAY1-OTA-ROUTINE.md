# January baseline to selected release: iOS on Mac

Status: preparation and design are in progress. A compact January BES image was
installed and freshly verified on the authorized lab fixture. January MTK and
factory ASG restoration, the complete customer OTA recording and automatic
teardown are **not yet qualified**. This document does not add a runnable day-one
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

MTK uses factory flashing now. A future qualified January downgrade OTA may replace
only this setup adapter once the necessary files exist. Factory images are not a
target-files archive. Qualify installation order and recovery first: the current
unattended MTK flasher uses the modern BES `cs_mtkfp` command, absent from January
BES. A temporary compatible BES followed by MTK flashing, compact January BES and
factory ASG restoration is a candidate sequence, not a proven procedure.

PR #4132's build was installed, verified and restored during the Mac host experiment.
That proves candidate installation/permission reuse, not selection or qualification
for this OTA test. Resolve its effective manifest and legacy deployment policy,
or choose another explicit CI selection, before baseline mutation.
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
3. **Establish the January lab baseline.** Use the qualified BES OTA and MTK factory
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

The successful limited BES preparation required a legacy BLE version query after
the UART-origin recovery timed out. Preserve both observations; this is not proof
that January setup is currently unattended. Qualify legacy identity/version
queries without weakening final modern firmware checks.

No passing day-one video exists yet. Required completion evidence is one real
January-to-selected-target run with full phase results and verified return state,
plus simulated failure/recovery coverage. The next routine must reject an
unavailable fixture; it must not infer readiness from a recorder exit code.
