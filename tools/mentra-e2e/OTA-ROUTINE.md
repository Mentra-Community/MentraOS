# Mentra Live OTA update routine

Status: the real three-component update is recorded and independently verified.
The compiled replay's already-current path is qualified; a complete autonomous
installation awaits a future update. Do not downgrade merely to exercise it again.

## Setup

Use an Apple Silicon Mac with the standalone harness provisioned as in
[SETUP.md](SETUP.md), a signed Mentra App with an explicit
`EXPO_PUBLIC_ASG_OTA_VERSION_URL`, and the agreed Mentra Live pair connected over
Bluetooth and USB. Keep the Mac powered, the glasses charged, and the cable in
place. Start with no call, recording, gallery transfer or update in progress.
The run owns no user media and must not clear application or pairing data.

Pin and archive the exact public manifest bytes and SHA-256 before the run.
Record the expected ASG version code, MTK version and BES version separately.
A rolling feed, a filename, or a completed download is not version proof.

## English steps

1. Start recording the Mentra window. Record the app's executable/JavaScript
   hashes, source/build manifest, selected OTA URL and expected target versions.
2. Identify the agreed glasses. Require the Bluetooth name/address, USB path,
   serial and eMMC CID to match the fixture. Record the current ASG version,
   MTK firmware, BES firmware, boot ID and slot. Stop on a mismatch.
3. Confirm the battery meets the app's minimum and the glasses have a working
   download route. For the first Mac run, use their existing office Wi-Fi.
   Verify there is no media session or update already running.
4. Open the Mentra App at paired home and wait for its normal update check.
   Verify that it offers an update for the selected glasses. An OTA-disabled,
   unsupported-client or check-failed message is a failed setup, not a skip.
5. Open the offered update. Read any release information shown; verify the target
   versions against the app's build pin and archived manifest before installation.
   The initial merged-PR manifest did not show a version on this page; record that
   limitation rather than claiming to have seen one.
6. Start the update once through the accessible update control. Record the
   initial download/install screen and begin the hardware event timeline.
7. Observe each component's download, installation and restart stages. Save a
   screenshot and chapter for each observed stage. Never invent stages missed
   between observations or treat an illustrative progress percentage as bytes.
8. Allow expected disconnections and automatic restarts. Re-resolve USB transport
   and verify the same eMMC CID after every return. Do not click Retry, relaunch
   the app or issue another install while the original update can still be active.
9. Wait for the app's final completion and additional-update check. If it offers
   the next component, continue the same owned sequence; retain all intermediate
   screens and restart evidence in the run.
10. Independently verify the installed ASG code, MTK version and a fresh BES
    response match the target. Confirm Bluetooth reconnects to the same pair and
    retain current-boot evidence. A completion screen without these checks fails.
11. Finish through the app's Done/Continue control and verify paired home. Record
    the final identity and leave the glasses idle for the Mentra Call routine.
12. Finalize the video, English chapters, screenshots, accessibility snapshots,
    logs and machine-readable result. Verify artifact integrity. A subsequent
    run on an already-current pair records “already current”; it does not claim
    to have exercised another installation.

## Replay and failure behavior

Use the existing Swift accessibility driver and Bun report/video pipeline.
The deterministic controller selects only known semantic controls and observed
OTA states; it never uses screen coordinates or model calls during replay.
Read-only USB observations provide independent identity and version evidence;
the installation itself must travel through the Mentra App's OTA flow.

Timeouts and unexpected screens preserve a failed/incomplete result. Ending the
observer must not terminate the app, reboot the glasses, stop an active update,
or trigger a second installation. Recover the original session's outcome before
allowing another run. Raw device logs remain private because they can contain
network credentials. Never factory-reset or downgrade solely to repeat a test.

## Initial target

Original pair: `Mentra_Live_03BE`, Bluetooth `CC:E7:DE:E0:03:BE`, serial
`ML396102B`, eMMC CID `1501003458364b4d42033721d0a33793`.
The first target is the published manifest from merged PR #4080:

```text
https://github.com/Mentra-Community/MentraOS/releases/download/pr-builds/ota-pr-4080-689f1d37ac952569240c5e839ba18ff1af96d889.json
```

Its SHA-256 is `1fdd6e6e269c466904e126dd7fdd63b259a165f0349cc17862e7bc416eb2155b`.
Targets: ASG `302000015`, MTK `MentraLive_20260915.0`, BES `26.9.17.0`.
All firmware entries were compared with dev `e8e1ced74c`.
The original MTK `20260908.4` had no matching incremental entry; the manifest
therefore supplies a signed full OTA of 640,341,164 bytes. The app and glasses
must apply their normal compatibility, space, hash and signature checks.

## Build and replay

Add the chosen public URL as `EXPO_PUBLIC_ASG_OTA_VERSION_URL` in the isolated
checkout's `mobile/.env`, then run `bun ios:mac --build-only --e2e-host-network`
from `mobile/`. The network adapter flag is needed only for the separate Mac Call
test; this OTA used the glasses' existing office Wi-Fi and the normal OTA path.
The build manifest now records `otaManifestUrl` and the build verifies that the
exact URL exists in bundled JavaScript. Keep the environment file out of Git.

Create a fixture JSON with `serial`, physical `usb` path, immutable `cid`,
`bluetooth`, and a `before` object containing `firmware`, `asgVersion`, `bootId`
and `slot`. Obtain these from the actual device; never copy a previous boot pin
blindly. Archive the selected manifest's exact bytes in a separate JSON file.

From the repository root:

```sh
bun tools/mentra-e2e/ota.ts \
  --fixture /absolute/path/fixture.json \
  --manifest /absolute/path/manifest.json \
  --manifest-url https://public-host/exact-pinned-manifest.json \
  --build-manifest mobile/build/ios-mac/build-manifest.json \
  --install
```

The URL must match the build pin and the published bytes must match the archived
manifest. `--install` permits one installation; omit it for an already-current
verification. `--resume` only observes an existing update and never starts one.
The default observation deadline is 30 minutes. The runner never stops an update
when its own deadline expires.

Before installation, the runner briefly defers an initial offer, opens Device
info and matches the app's serial/Bluetooth address to USB. It then relaunches the
same signed build to obtain the normal update offer again. No build replacement,
coordinate click, global mouse/key input or permission reset is involved.

Progress chapters are generated from actually observed state changes. Brief
states may be absent between polls; the routine does not require every optional
transition to remain visible for a later assertion. The final pass requires the
installed ASG APK SHA-256, target MTK version and a BES version response no more
than 30 seconds old from the current boot. Cached BES properties are insufficient.

## September 16 qualification (Pacific)

- Actual upgrade: `2026-09-17T02-33-08-925Z-mentra-live-ota-discovery-bf2ed2`,
  nine recorded steps, 608.695-second video. All three targets were installed;
  ASG SHA-256 matched and BES reported `26.9.17.0` after reboot. MTK activated
  slot `_b`, boot `29d9df46-e015-4b38-a62a-035153d8a026`; the eMMC CID matched.
  The run remains **failed as a harness discovery** because its final-check
  assertion arrived after that brief screen had advanced to Update Complete.
  The failed assertion and original report are retained. Hardware qualification
  is recorded separately. Screenshots, video and liveness checks passed.
- Final compiled already-current replay:
  `2026-09-17T02-54-37-726Z-mentra-live-ota-16bc79`, six steps, 7.34 seconds,
  zero model calls, all target/artifact/UI checks passed. It verified the app's
  paired identity and returned to home. This did not reinstall firmware.

Review also corrected the already-current decision to include BES, so a BES-only
release is not skipped when ASG and MTK already match. Home recognition uses the
Settings tile and does not depend on Mentra Call being enabled. Harness TypeScript
and all 25 runner/native tests passed (53 assertions).

Evidence folders are under `.test-results/mentra-e2e/` in the integration
checkout. Run `bun tools/mentra-e2e/verify-run.ts <run-folder>` for artifact checks.
The current private fixture, manifest and build evidence are in
`ota-setup-2026-09-17/`; do not reuse its pre-update boot/version values as a new
device authorization without checking them.
