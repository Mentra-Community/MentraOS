# CTKD verification ledger (OS-1905, qualification OS-2116)

Physical-device checklist for iPhone CTKD one-step pairing. OS-2116 stays **NOT RUN** until every row below has physical-device evidence. A written plan, a build, a simulator, or a Mac radio pass is not a result.

This ledger covers C01, C02, T02, T06, U05, the Samsung S22 unchanged-flow checks, and the older-iOS repeat. Other OS-2116 rows stay outside this file.

Allowed status: `NOT RUN` | `PASS` | `FAIL` | `BLOCKED`. **Missing evidence is never PASS.**

Landing on the Pair Audio / Open Settings screen is a **FAIL** for CTKD rows (C01, C02, older-iOS repeats, Run A, Run B). It is not a two-step pass.

## Fixtures

Record the installed image. Flag text in source is not that image.

| Fixture | Required | Recorded |
| --- | --- | --- |
| I1 | Physical iPhone, current supported iOS | Model: _not recorded_. iOS: _not recorded_ |
| I2 | Second physical iPhone, older supported iOS | **BLOCKED.** No older-iOS phone assigned. Owner: Nicolo |
| A1 | Samsung S22 | Android: _not recorded_ |
| B | Second physical phone for T02/T06 | Model / OS: _not recorded_ |
| G1 | Mentra Live glasses | Serial: _not recorded_ |
| Mentra App | Build and SHA of the binary under test | _not recorded_ |
| BES | Version and SHA of the flashed image | _not recorded_. Run A plan start: 17.26.7.28 (confirm on device) |
| ASG | Version and SHA | _not recorded_ |

### Flags (values that count are the installed binary)

| Flag | Checkout / source default | Installed value |
| --- | --- | --- |
| `MENTRA_SECURE_PAIRING` | Mentra 3.3 intends this BES flag on. The app has no flag; it follows the glasses' advertisement (`asg_client/docs/mentra-live-spec.md`). This checkout does not contain the flashed BES image. | _not recorded_ |
| iOS transport bridging (`ConnectOptions.enableTransportBridging`, `CBConnectPeripheralOptionEnableTransportBridgingKey`) | Source default `false` (key omitted). Run A: `false`. Run B: `true`, with ANCS still required. | _not recorded per run_ |

## Reset recipes

**R0 — clean / unowned.** Factory-reset the glasses with the supported lab procedure (both transports). Forget the glasses in iOS Settings > Bluetooth and in the Mentra App. Verify no owner from a sanitized state or trace before the case starts. App reinstall alone is not R0. The triple-tap gesture clears ownership; it is not a factory reset.

**RA — owner A.** Start from R0. Pair A. Verify a BLE bond with encryption and both audio profiles (real A2DP playback and a real HFP call). Save known media (names, counts, hashes) before any transfer or OTA.

**RL — U05 only.** Supported old / flag-off combination. Pair the iPhone through the real customer flow and prove Classic-only ownership before the phone-driven OTA. Save known media. A USB flash does not replace that OTA.

## Required results

- **C01 / R0.** Pair only from the Mentra App. At most one system pairing prompt. LE Secure Connections bond and encryption. CTKD-derived Classic record for the same phone. Real A2DP music playback and a real HFP call. iOS Settings shows one coherent Mentra Live relationship and no second pairing. No Open Settings / Pair Audio screen.
- **C02 / RA.** Relaunch the app, reboot the glasses, reboot the phone. Both transports persist. No new prompt and no Settings pairing. Both profiles work. A connected screen alone is not enough.
- **T02 / RA.** Pair B while A is nearby, then repeat while A is absent. One owner persists. A cannot reconnect over BLE or Classic. B can, including audio. Record media before/after. Do not mark a pass if the build follows a different ownership or media policy than the one approved for the run (see conflicts below).
- **T06 / RA.** A → B → A, three complete round trips, reboot between transfers. One owner after each success; both obsolete glasses-side credentials gone. App Unpair cleans phone and glasses and gives iOS forget guidance. A separate factory reset clears BLE and Classic credentials, and pairing works afterward.
- **U05 / RL, iPhone.** After phone-driven OTA, the Classic-only owner adopts its BLE identity when its Classic ACL reconnects. Media remains. The reverse path (fresh CTKD pair and reconnect, C01 then C02 on that post-OTA image) must still pass. Failed SMP must not drop the Classic owner.
- **Samsung S22.** Pairing and reconnect stay on the current Android flow. No regression. The iOS Pair Audio rule does not apply.
- **Older iOS.** Repeat C01 and C02 on I2. Until I2 exists, those rows stay BLOCKED (owner Nicolo). An I1 pass is not the older-iOS repeat.

## Case ledger

One row per case × phone. Fill actual result only with evidence that meets the rules below.

| Case | Phone(s) / glasses | Builds / flags | Status | Actual result and evidence | Failure / blocker / owner |
| --- | --- | --- | --- | --- | --- |
| C01 fresh pair from R0 | I1 + G1 | Candidate app / BES / ASG; both secure-pairing flags; bridging as built | NOT RUN | | |
| C01 fresh pair from R0 | I2 + G1 | Same candidate | BLOCKED | Older supported iOS phone not assigned | Nicolo |
| C02 reconnect (app relaunch, glasses reboot, phone reboot) | I1 + G1 | Same as the C01 pass on this phone | NOT RUN | | |
| C02 reconnect | I2 + G1 | Same candidate | BLOCKED | Depends on I2 | Nicolo |
| T02 takeover, A nearby | I1 (A), B, G1 from RA | Same candidate | NOT RUN | | Name phone B before the run |
| T02 takeover, A absent | I1 (A), B, G1 from RA | Same candidate | NOT RUN | | Name phone B before the run |
| T06 A→B→A ×3, reboots, app Unpair, factory reset | I1 (A), B, G1 from RA | Same candidate | NOT RUN | | Name phone B before the run |
| U05 Classic-only owner adopts BLE after phone OTA; reverse CTKD path still works | I1 + G1 from RL, then candidate OTA | Old/flag-off, then candidate; record each image | NOT RUN | | |
| Samsung pairing unchanged | Samsung S22 + G1 from R0 | Same candidate flags | NOT RUN | | |
| Samsung reconnect unchanged | Samsung S22 + G1 from RA | Same candidate flags | NOT RUN | | |
| Run A baseline (bridging off) | I1 + G1 from R0 | Plan start: app 3.3.0, BES 17.26.7.28; bridging `false`. Follow `asg_client/tools/pairing-matrix/templates/iphone-baseline.md` | NOT RUN | | |
| Run B (transport bridging on) | Same iPhone and glasses as Run A; forgotten bond; factory-reset glasses | W2 build; bridging `true`; ANCS preserved. Same timeline as `templates/iphone-baseline.md` | NOT RUN | | |

## Evidence rules

- Share sanitized BES traces only. Run `asg_client/tools/pairing-matrix/sanitize/sanitize_bes_trace.py` first. No LTK, IRK, or link-key bytes in anything filed, attached, or pasted. Log security properties and record presence, not key material.
- The raw capture stays on this machine under `asg_client/tools/pairing-matrix/runs/`. It is untracked. Do not commit it or attach it to a PR, Linear, or Slack.
- CTKD rows need the sanitized sequence: security request → LE Secure Connections bond → CT2 / key distribution → Classic record for the same phone → A2DP and HFP up. Prompt count is a measured number.
- Screenshots or a short recording for the system prompt, iOS Settings (one Mentra Live relationship), and the in-app result. Audio evidence is a real music playback and a real call, not a route flag alone.
- Transfer and U05 rows need media before/after hashes (names and counts too).
- **Missing evidence is never PASS.** Skipped, untestable, and simulator-only rows stay `NOT RUN` or `BLOCKED`.

## Conflicts to record, not to paper over

OS-2116's written baseline removes the old owner when pairing opens, and it does not delete media. OS-2055 and this branch retain the old owner until the new phone confirms, and OS-2055 wipes media on transfer. Write down which behavior the build actually did. Do not mark the contradictory one as PASS.

OS-1905's "SMP is never started" premise is stale. The bond already completes; these rows judge the Classic stage after that bond.

## OS-2055 v4 pre-freeze spike and merge gate

Run with a `MENTRA_KEY_LOG=1` BES build. Record the BES trace path for each row. Status
stays `PENDING DEVICE` until a real iPhone and a real Samsung have been run. Do not mark
a row PASS from simulator or host tests.

| ID | Question or gate | iPhone | Samsung | Evidence |
|---|---|---|---|---|
| S1 | Under which address is the CTKD-derived Classic key stored? Equal to the BLE identity? | PENDING DEVICE | PENDING DEVICE | |
| S2 | When does the Classic NV record appear relative to the BLE bond event? | PENDING DEVICE | PENDING DEVICE | |
| S3 | With A and B both bonded, is `nv_record_blerec_enum_paired_dev_addr` slot 0 the oldest bond? | PENDING DEVICE | PENDING DEVICE | |
| G1 | After takeover, B's Classic key survives, also across a glasses reboot | PENDING DEVICE | PENDING DEVICE | |
| G2 | A's Classic key is invalidated and A's audio reconnect is refused | PENDING DEVICE | PENDING DEVICE | |
| G3 | An A Classic link that was already open is terminated at commit | PENDING DEVICE | PENDING DEVICE | |
| G4 | B's audio connects and reconnects after an app restart and a glasses reboot, no extra pairing | PENDING DEVICE | PENDING DEVICE | |
| G5 | A reboot at each commit step (`MENTRA_PAIRING_FAULT_INJECT`) leaves exactly one owner | PENDING DEVICE | PENDING DEVICE | |

Until S1 to S3 are answered, the firmware uses the window-entry snapshot rule for the
Classic wipe and a deterministic tie-break at commit.
