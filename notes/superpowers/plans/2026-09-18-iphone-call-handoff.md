---
status: active
owner: philippe
---

# iPhone Call handoff and immediate retry

Extends the Call lifecycle described in [AcsMeeting README](../../../mobile/modules/acs-meeting/README.md)
and the [iOS Call plan](2026-09-16-mentra-call-ios.md).

## Evidence and scope

Incident `rep_01M2V6QNHHP05C37FCH86NPJD7` ran app `3.2.1-dev.286`, commit
`8bb1fba`. ACS preparation completed before hotspot association. Cellular became
available, the same agent joined, then ACS disconnected with `430/10065` before
admission. The miniapp displayed `Call ended`; Rejoin during the approximately
9.8-second cleanup returned the old join promise. The hidden error and ineffective
retry are confirmed. Loss of ACS signaling during the handoff remains a hypothesis.

The candidate defers iOS agent creation until native join, after the host's
hotspot/default-route wait. Android retains its cellular-pinned early preparation.
Agent creation timing is logged; route availability alone is not proof of ACS
signaling health. This change does not alter established iOS background support.

Mentra-Call [PR #38](https://github.com/Mentra-Community/Mentra-Call/pull/38)
preserves admission errors and queues retries behind cleanup. The bundled candidate
is 2.1.20 from merged main commit `e6b31d3`, packed with `pack:prod`. It uses the existing
production backend and makes no backend changes. Repacked from merged main; every ZIP entry matches the initially built candidate.

## Preparation

- [x] Read the original phone logs and distinguish observations from hypotheses.
- [x] Add retry/error regression tests, including concurrent retries and cancellation.
- [x] Pass all 480 miniapp tests and the miniapp typecheck.
- [x] Pass 234 host tests for ACS, SoftAP sequencing, and host lifecycle.
- [x] Build the USB WebDriverAgent runner and read the physical iPhone accessibility tree.
- [x] Build and install the Release candidate on iPhone 15, build `302018310`.
- [x] Verify Mentra Call is visible with `EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS=true`.
- [ ] Qualify the physical handoff and record the run.

Local test override: `mobile/.env` sets `EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS=true`.
Unset remains the normal hidden iOS behavior. Automatic OTA stays unpinned for
this fixture because another task owns its experimental firmware. The OTA routine
is separate; this Call routine must not update the glasses.

## English routine

1. Record the iPhone UDID, installed app version/build, candidate executable and
   JavaScript hashes, bundled Call ZIP/hash, and active miniapp version. Confirm
   the iPhone has mobile data. Record the glasses identity and installed firmware
   from the hardware coordinator's fresh evidence.
2. Start the iPhone screen recording. Open the Mentra App and verify Mentra Call
   is visible. Open it and verify its Home screen and the active bundle version.
3. With the hardware coordinator's release, pair the identified 03BE glasses to
   the iPhone, including Bluetooth audio. Record pairing timestamps. Ensure other
   phones and the Mac are not competing for the glasses connection.
4. Prepare a browser guest using the laptop's microphone, camera, and speakers.
   Reserve one authorized live attempt only when both endpoints and collectors
   are ready. Create/join the meeting and approve the glasses hotspot if asked.
5. Verify hotspot association and internet routing, then inspect the logs for
   fresh ACS agent creation after the route wait. Verify lobby or connected state;
   retain the complete error if admission fails.
6. Verify first-frame reception, then hold the stream for 180 seconds for the USB
   investigation. Do not poll or operate the glasses during this hold. Normal
   cleanup begins only after coordinator release (or the agreed bounded deadline).
7. If admitted, admit the selected browser guest. Verify the participant count,
   advancing glasses video in the browser, and audible audio in both directions.
   Microphone ownership and speaker devices must be recorded; counters alone do
   not qualify audible audio.
8. Verify mute/unmute, background and screen-off operation, roster updates, and
   participant leave/rejoin when allowed by the remaining live-attempt budget.
   If testing a failed join's immediate Rejoin, reserve another authorized attempt;
   confirm it gets a fresh agent after cleanup and does not reuse the failure.
9. Leave normally, verify the glasses publisher and hotspot stop, leave the browser
   peer, and retire only this run's owned meeting. Save final device/host state.
10. Finish the recording, verify playback, and generate the HTML report with English
    step chapters and per-step screenshots. Mark unexecuted checks as not run.

Each run's raw logs, screenshots, recording, local configuration, and exact replay
commands belong under gitignored `.test-results/`. Do not commit authentication
material or raw incident bundles. The physical-iPhone routine is not qualified yet.

## Local toolchain finding

The Xcode 27 Release compile succeeds with a local deployment-target override,
but the iOS 27 device terminates the app before JavaScript starts at
`___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke`.
The Expo 55 AppDelegate still uses the pre-scene lifecycle. This is separate from
the ACS incident and blocks qualification of that local artifact. Use a compatible
Xcode 26 build for this Call change; do not treat a successful compile as a device
pass or silently patch the executable's SDK identity.

The installed test candidate is `com.mentra.mentra` build `302018310` on iPhone 15
UDID ending `E1A01E`. The local `candidate.json` records hashes and the exact device.
Xcode 26.6 (17F113, iOS SDK 26.5) built the same candidate with the normal iOS
15.5 deployment target. That installed build opens successfully and displays
Mentra Call. The installed ZIP is verified against the merged-source package.

No live Call attempt was consumed during preparation. iPhone `devicectl`
screenshots work, but native `screen-record` reports the capability unsupported.
WebDriverAgent's XCTest recording exports H.264 successfully when
`UserAttachmentLifetime=keepAlways`; the 78.798-second preflight contains 1,062
frames and passes complete decoding. This is recorder preparation, not a Call pass.

The USB connection subsequently interrupted both XCTest and the app console.
macOS `usbmuxd` reports repeated `kIOReturnNoDevice`, `kIOReturnNotResponding`,
and USB pipe errors for the iPhone. Keep this distinct from the glasses' ADB
investigation and stabilize the phone connection before starting a live attempt.

## Pairing preparation

The iPhone initially discovered other glasses but not 03BE. macOS reported 03BE
under connected devices with BLE service, and the Mac Mentra process was running.
Gracefully closing that app changed 03BE to not connected on the Mac; the wearer
then confirmed 03BE appeared in the iPhone scan. Both iPhone BLE and Bluetooth
audio pairing completed. The native app reports `Mentra_Live_03BE` as its active
Bluetooth A2DP output. Include competing-controller checks in the routine, not
only the Mac's Classic audio connection.

Local discovery evidence includes English-labelled JSON steps, `phone-step.ts`,
fresh accessibility snapshots, per-step screenshots, command receipts, XCTest
result bundles, and exported recordings. Failed preparation steps remain failed;
they must not be presented as a complete replay or successful Call qualification.
