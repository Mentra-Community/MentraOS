---
status: active
owner: nicolo
---

# BLE photo transfer speed, iOS vs Android: experiment plan

> Execution checklist. Update checkboxes as work lands.

**Goal:** Measure end-to-end BLE photo transfer speed from one Mentra Live to several iPhones and Android phones, find which leg limits it (the serial link inside the glasses, or the Bluetooth link to the phone), and produce a speed floor for the Thundercomm response.

**Architecture:** A host script sends `take_photo` (`transferMethod: ble`) to the glasses over an adb broadcast, one photo at a time. It reads the glasses' `⏱️ [BLE PHOTO] PIPELINE FINISHED` line and records one CSV row per photo. Phone logs are captured only to label the transport (L2CAP or GATT). `summarize.py` pools run directories into a per-cell table, the floor, and a limiting-leg verdict.

**Tech Stack:** Python 3.9+ standard library, `adb`, `libimobiledevice` (`idevicesyslog`, `ideviceinfo`).

**Spec source of truth:** this document. Background: [OS-1409](https://linear.app/mentralabs/issue/OS-1409/mentra-live-improve-ble-image-transfer-quality-and-speed).

---

## Background

- No recorded photo transfer speed is labelled as measured on an iPhone. The best logged runs (July 2026, phone OS not recorded) reached 85-100 KB/s glasses-side and about 80-83 KB/s end to end.
- The ceiling today is the MTK-to-BES UART at 1,152,000 baud, not BLE airtime.
- iOS has the same L2CAP file channel (PSM `0xC9`) as Android. CoreBluetooth cannot request PHY or connection priority, so the BES firmware owns those link updates on iOS.

## Metrics

All from the glasses' `PIPELINE FINISHED` line (`BlePhotoTimingLog.appendSizeAndSpeed`). KB is 1024 bytes.

| Metric | Definition |
|---|---|
| End-to-end speed (primary) | `payload / phone_confirm`: transfer start until the phone's `transfer_complete` |
| Serial-link speed | `transfer_speed`: payload / time until the BES acknowledges the last packet |
| Radio-leg drain | `last_packet_to_phone_ack`: last serial acknowledgement until the phone's confirmation |

Only photos with `success=true` and both end-to-end inputs present count toward speed statistics. Failures, timeouts, and retries are reported separately.

## File Map

| Path | Action | Responsibility |
|---|---|---|
| `asg_client/tools/ble-photo-speed/run_cell.py` | Create | Runs one cell (phone, condition, size, N photos) |
| `asg_client/tools/ble-photo-speed/summarize.py` | Create | Per-cell table, floor, limiting leg (`--json` available) |
| `asg_client/tools/ble-photo-speed/blespeed/` | Create | Log parsing, per-photo outcome tracking, adb I/O, transport labelling, statistics |
| `asg_client/tools/ble-photo-speed/tests/` | Create | Offline unit and fake-adb end-to-end tests |
| `asg_client/app/.../AsgConstants.java` | Modify (experiment branch only) | `ENABLE_PHOTO_TIMING_LOGS = true` |

## Branches

- `nicolo/ble-photo-speed-tools`: the tools, tests, and this document. Based on `dev`.
- `nicolo/ble-photo-speed-asg-timing`: the tools branch plus the one-line timing-log flag flip. Build the experiment APK from it. Never merge it.

## Automated tests

Offline, no adb or hardware:

```bash
python3 -m unittest discover -s asg_client/tools/ble-photo-speed/tests -v
```

The tests cover:
- Log parsing: real July 2026 lines and synthetic variants.
- The per-photo outcome state machine: busy retry, timeout, dropped broadcast, glasses-internal retries.
- adb command quoting and device selection.
- Transport labelling from iOS and Android logs.
- Percentile, floor, and leg heuristics.
- A full cell against a scripted fake adb, including baud aborts.
- Golden output for `summarize.py`.

---

## Phase 1: Setup

### Task 1: Experiment ASG build

- [ ] Check out `nicolo/ble-photo-speed-asg-timing`. Build and install the ASG client (`asg_client/AGENTS.md`, `./scripts/dev-setup.sh`).
- [ ] Record the ASG commit, the BES firmware version (17.26.7.5 or newer), and the Mentra App build on each phone.
- [ ] Confirm the glasses log shows `UART link ready at fast baud 1152000` (tag `BES-UART`) or `Serial port opened at 1152000 baud` (tag `BAUD-SWITCH`). `run_cell.py` aborts on any other baud.

### Task 2: Host prerequisites

- [ ] `adb devices` lists the glasses (and the Android phone, when it's plugged in for log capture).
- [ ] For iPhones: `brew install libimobiledevice`, trust the host, get the UDID from `idevice_id -l`.
- [ ] Dry run: `python3 asg_client/tools/ble-photo-speed/run_cell.py --phone test --phone-os android --condition A --size medium --glasses-serial <G> --dry-run`.

---

## Phase 2: Pilot

- [ ] Take 5 photos on one Android phone and 5 on one iPhone in condition A, medium.
- [ ] Every photo reports `finished` with a non-zero `phone_confirm_ms` in `results.csv`.
- [ ] `phone-log.txt` shows `File transfer complete` for each photo. Photos that the phone didn't request take the generic file path, which still sends `transfer_complete`.
- [ ] `provenance.json` has `transport.session_label` set to `l2cap` (or `gatt`, which is recorded as such), and `glasses.timing_logs_observed` is `true`.
- [ ] No `not_received` rows. Those mean the broadcast was dropped.

---

## Phase 3: Main matrix

### Session protocol (repeat on every phone visit)

1. Connect only this phone in the Mentra App. Every other phone has Bluetooth off.
2. Start `run_cell.py` with `--wait-transport 60`, then reconnect the glasses in the app so the phone log shows `L2CAP: channel open`.
3. `run_cell.py` sends `disconnect_wifi`, takes one discarded warm-up photo, then takes `--count` photos.
4. Run every condition and size for this phone before moving to the next phone.

Visit order: ABCD, then DCBA, 10 photos per cell per visit, giving 20 per phone per condition per size.

### Conditions

| Id | Setup | Checklist |
|---|---|---|
| A | App foreground, screen on, 0.5 m | Static scene, fixed lighting |
| B | App backgrounded, screen locked | Lock the phone after `run_cell.py` prints `Transport:` |
| C | 3 m, line of sight | Measure the distance, no body between phone and glasses |
| D | Glasses mic streaming concurrently | A Mentra App miniapp using the glasses mic (e.g. live captions) is running and audio is flowing before the cell starts |

### Example commands

```bash
cd asg_client/tools/ble-photo-speed
# iPhone
python3 run_cell.py --phone iphone15 --phone-os ios --phone-udid <UDID> \
  --glasses-serial <G> --condition A --size medium --count 10 --wait-transport 60 \
  --asg-commit <sha> --app-build <build>
# Android phone plugged into the same host
python3 run_cell.py --phone pixel8 --phone-os android --phone-serial <P> \
  --glasses-serial <G> --condition A --size max --count 10 --wait-transport 60
```

Each run writes `runs/<utc>-<phone>-<cond>-<size>/`: `results.csv`, `glasses-logcat.txt`, `phone-log.txt`, and `provenance.json`. `runs/` is git-ignored.

### Confirmation arm

- [ ] For each phone in condition A, take 10 photos from the Mentra App or the Bluetooth SDK example app instead of adb, with the glasses log captured (`adb -s <G> logcat -v threadtime > confirm-<phone>.txt`).
- [ ] Compare the glasses' end-to-end speed for these photos with the adb-triggered photos from the same phone. The phone also logs `📊 Transfer rate: N bytes/sec` on this path. A difference of more than 10% means the adb path is biased, and must be reported with the results.

---

## Phase 4: Report

```bash
python3 summarize.py runs/            # table
python3 summarize.py runs/ --json     # machine-readable
python3 summarize.py runs/ --exclude-b  # if the floor need not hold with the app backgrounded
```

### Decision rule

- **Floor:**
  1. For each phone, take the 10th percentile (nearest rank) of end-to-end speed, pooled across conditions A-C.
  2. Take the lowest phone's value.
  3. Multiply by 0.8 and round down to a multiple of 5 KB/s.
  4. Report condition D separately as the loaded figure.
- **Radio-limited:** a phone's drain time grows faster than 2 ms per KB of payload while its serial-link speed is within 15% of the cross-phone median.
- **Serial-limited:** drain time stays flat. If every phone is serial-limited, the glasses' internal UART is the ceiling and phone OS isn't the variable to spec.
- **Mixed:** drain time grows but the serial-link speed also differs. Look at the raw logs.
- A cell with more than 5% failures is flagged.

### Results template

| Phone | OS | Cond | Size | n | ok | fail % | e2e median | e2e p10 | UART median | drain median | Transport |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | | A | medium | | | | | | | | |

- Floor (A-C): ___ KB/s. Limiting phone: ___
- Loaded (D): ___ KB/s
- Limiting leg per phone: ___
- Confirmation arm delta (adb vs app-triggered): ___ %
- Provenance: ASG commit ___, BES firmware ___, baud 1152000, Mentra App build ___

## Open questions

- Which phone models are available (newest and oldest supported iPhone; the Android reference phone).
- Whether the Thundercomm floor must hold with the iOS app backgrounded and the screen locked (condition B).
