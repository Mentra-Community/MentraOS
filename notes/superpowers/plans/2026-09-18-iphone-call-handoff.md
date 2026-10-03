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
   On first use, leave Local Network permission open for at least 65 seconds.
   Verify the phone remains in setup, with the glasses camera still off. Approve
   access and verify setup resumes. Exercise denial/cancellation separately;
   permission response time must not consume media or Teams admission deadlines.
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

## First device attempt and permission fix

The September 18 attempt on build `302018310` / Call 2.1.20 started the glasses
camera briefly, but Local Network permission was still awaiting the user. The
phone displayed `ICE did not connect; WHIP media path failed`. The glasses logs
show camera start at 23:49:18.705 UTC, ICE timeout at 23:49:27.242, camera stop at
23:49:27.445, and hotspot disabled at 23:49:27.995. These are app-driven cleanup,
not the later controller return to Home. No browser joined and no phone first
frame was verified. This does not qualify the original ACS handoff fix.

The iPhone USB hardware connection was lost during the attempt. The native console
and XCTest recorder disconnected; no live video attachment survived. Screenshots,
English steps, exact commands, source hashes and hold/cleanup receipts remain in
the ignored `iphone-call-live-01` run folder. Never substitute the earlier setup
video for the missing Call video. The glasses' independent USB capture remained
healthy. Attempt 20 of 20 was consumed; another stream requires renewed approval.

The product fix waits for iOS local access before the hotspot join resolves, using
a real TCP connection to the glasses' existing port 8089 endpoint. Local Network
permission has no media deadline and remains cancellable. The miniapp's admission
deadline also waits for native setup to finish. The replacement bundle is 2.1.21,
packed for the existing production backend from published source commit `3009ca8`
in [Mentra-Call #39](https://github.com/Mentra-Community/Mentra-Call/pull/39).
That PR merged to `main` as `fede2a4` on September 19. Its complete source tree
matches packaged commit `3009ca8`, so no repack or reinstall is needed. No backend
change is included.

A separate physical-iPhone permission probe uses the exact production gate against
a temporary TCP listener on the Mac. The real alert stayed pending for 80.404
seconds, then Allow completed the connection without restarting the request.
It used no camera, microphone, Bluetooth command or Call stream. An initial UDP
Network.framework approach reported ready without requesting permission; that
approach was rejected and is not the shipped gate. The retained screenshots and
native timestamps establish the permission result, not full Call qualification.

A second, scripted permission-only run left the alert open for 65 seconds and
completed after Allow. Its 76.407-second H.264 recording passes full decoding,
browser playback and all four English chapter seeks. Screenshots, accessibility
trees, command receipts and frozen replay inputs are saved beside the video in
the ignored `permission-probe/tcp-replay` folder. Set both XCTest
`SystemAttachmentLifetime` and `UserAttachmentLifetime` to `keepAlways`, then
allow attachment transfer to finish before shutting down the runner. Check the
exported file itself: a result bundle can contain an attachment-error text file
instead of the requested video even when the XCTest run succeeds.

The replacement host source `9652b43c5a`, build `302018310`, with bundled Call
2.1.21 installed and launched successfully on the same iPhone at 00:15:47 UTC
on September 19. The 00:18:38 screenshot confirms Mentra Home and visible Call.
Installation and this permission probe started no additional Call stream. The
active runtime bundle still needs confirmation before the next live attempt.

Regression checks: 25 native core tests, 235 host tests and 481 miniapp source tests
pass. The miniapp typechecks. Keep the host PR draft until a fresh coordinated Call
run verifies media, admission, audio, cancellation, background behavior and cleanup.

## Physical iPhone follow-up

The user authorized ten more attempts, extending the local ledger to 30. Run
`iphone-call-live-02` aborted during its first accessibility query when the
iPhone USB/developer connection disappeared. No join was dispatched and no
attempt was consumed. The later 03BE USB loss was associated with the user's
reported accidental drop; do not label it a spontaneous Call regression.

Run `iphone-call-live-03` consumed attempt 21 on the same installed host source
`9652b43c5a` / build `302018310`, with active Call 2.1.21. All seven extracted
miniapp files matched the packaged ZIP. The identified 03BE glasses entered this
run with USB already unavailable, so it cannot qualify USB regression behavior.

- Local network access completed at 00:40:54.221 UTC on September 19.
- A fresh ACS agent started at 00:40:57.301 and completed at 00:40:58.062.
- The iPhone received its first glasses frame at 00:40:59.760, trace `1e5d36b4`.
  The call reached connected state at 00:41:01.078; the original pre-admission
  disconnect did not recur in this one run.
- The selected browser guest was admitted. Received video advanced from 77 to
  347 decoded frames at 960 × 540. Incoming audio packets advanced from 309 to
  1,065, and outgoing laptop audio packets from 39 to 982.
- The browser's combined audio/video sending assertion failed because outgoing
  video stayed at zero despite a live built-in camera track. The iOS host has no
  remote-video renderer; this is also a previously documented limitation of that
  browser check. Preserve the failure and use the existing audio-only companion
  for audible return audio and mute/unmute qualification.
- The phone stayed connected through the complete 240-second diagnostic hold.
  It left normally at 00:45:00.612; hotspot shutdown was reported at 00:45:04.968.
  Home returned at 00:45:22.954, followed by a 120-second observation tail ending
  at 00:47:22.959. Backend meeting retirement was not independently verified.

The native 716.802-second recording exported successfully. Its review copy trims
preparation waiting and uses source frame timestamps for English chapter offsets.
Raw video, browser evidence, screenshots, command receipts and frozen replay
sources remain in the ignored run directory. Audible duplex, background,
mute/unmute, failed-join retry and permission cancellation remain unqualified.

## Follow-up with the audio-only browser routine

Run `iphone-call-live-04` consumed attempt 22 with the same installed candidate.
The phone developer connection interrupted preparation; recovering XCTest
required the user to enter the iPhone passcode to enable UI automation. Finish
this system authentication before starting a Call or its admission deadline.
The recovered recording and native console passed preflight before Join.

The iPhone USB transport stopped responding at 01:16:41.751 UTC, before the
hotspot approval at 01:16:44.805. Both XCTest and the native console disconnected.
Do not classify this as a proven consequence of the Wi-Fi handoff. The separate
glasses collector confirmed WHIP/ICE at 01:16:58.476–478 and a camera frame at
01:16:58.605, trace `120a1ee6`; 03BE's USB remained healthy. The phone controller
could not independently verify its first frame or extract the meeting link, so
no browser joined and no audible check occurred.

The controller preserved its hold until the operator release at 01:20:43.540.
With phone automation unavailable, the user pressed the current Call's Leave
button. The glasses collector verified `stop_stream` at 01:21:06.656, camera stop
at 01:21:06.937, capture close at 01:21:07.011, WHIP stop at 01:21:07.183 and
playback close at 01:21:11.310. After the iPhone cable was reconnected, a screenshot
independently confirmed “You left the call.” Preserve a two-minute tail after the
actual stop, separate from the failed controller's automatic tail.

Neither interrupted XCTest result contained a video attachment. The run retains
screenshots, commands, frozen sources, the native-console prefix, host USB logs,
manual-cleanup receipt and the independent glasses observations. It is a tooling
failure, not a passing routine, and the earlier run03 video is not substituted
for it. Stabilize the phone transport before another live qualification attempt.

Preparation also exposed covered Home elements in the accessibility tree while
Settings was foreground. Require visible targets and distinct step IDs across
preparation retries; otherwise a hidden tile can receive a positional click and
a later screenshot can overwrite earlier failure evidence. The local preparation
manifest records the affected overwritten screenshot rather than claiming it was
preserved.

## Managed-relay cancellation review

Review 5254129154 found another consumer of the shared permission gate: managed
WHIP relay preparation also waits for Local Network access. Its Stop previously
waited for preparation before calling native stop, leaving denied permission,
the hotspot lease and the coordinator's transition lock stuck indefinitely.

Cancel now interrupts only the owned, pending native preparation immediately,
before waiting for that transition lock. Stop awaits the same native cleanup
promise before disabling the glasses hotspot and releasing its lease. Cleanup
failure retains ownership for another Stop; a late successful prepare cannot
start the glasses. The iOS relay forwards `permission_required` with instructions
and drops queued permission notifications after cancellation. This reuses the
existing native stop/leave barrier, without a new deadline or permission API.

The denied-permission regression failed on the previous implementation and now
passes. The focused host suites pass 302 tests, including real lease ownership,
cancellation/approval ordering, cleanup retry and a subsequent managed stream.
All 25 Swift core tests pass, including cancellation followed by late approval.
The Xcode 26.6 iOS Release build and formatting checks pass. No live stream was
started for this review fix; physical qualification above
remains partial, and the installed phone candidate is unchanged.

## Transient local-network waiting review

Review 5254213633 confirmed that an ordinary `NWConnection.State.waiting` was
incorrectly treated as terminal. The regression test reproduced a failed join
for `waiting(.ENETUNREACH)` followed by `ready`, including a nil current path.
The request now consumes the actual Network.framework states and path reasons;
the adapter also forwards path changes so later permission information is seen.
Transient waiting keeps the same connection alive for Network.framework to retry.

Ordinary local connection setup gets a cumulative 30-second budget, matching the
existing allowance for a verified hotspot address. Permission waiting pauses
the budget without resetting it; repeated waiting/preparing updates cannot
extend it indefinitely. Ready, terminal failure and cancellation finish once,
cancel the timer and ignore late callbacks. Both Call and managed relay use the
same request, with no extra consumer-specific retry loop.

All 30 Swift core tests and 310 focused host tests pass. Deterministic clock tests
cover ordinary timeout, repeated updates, 200 seconds of excluded permission
waiting, resuming the remaining budget and cancellation followed by late ready
and timeout events. The Xcode 26.6 iOS Release build and Swift formatting pass.
This source review adds no physical qualification result.
