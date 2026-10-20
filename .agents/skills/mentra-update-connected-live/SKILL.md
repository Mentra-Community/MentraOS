---
name: mentra-update-connected-live
description: Update a USB-connected Mentra Live to the latest published ASG client, BES firmware, and MTK firmware from the newest public Mentra release. Use when the user asks to check or update the connected glasses' BES, MTK, or ASG client. Not for firmware_live.json manifest PRs or BES source builds.
---

# Update a connected Mentra Live

Bring one USB-connected Mentra Live up to the newest public Mentra release's glasses set: ASG client, then MTK, then BES. Keep the Infinity Cable attached. MTK reboots Android and ADB drops until the new slot boots. Start BES only after that boot has finished.

Do not use `asg_client/scripts/update-stock-for-dev.sh`, `update-mentra-live.sh`, or the `staging-builds` manifest `staging_live_version.json`. That snapshot lags the coordinated release and will skip or downgrade a current device.

## Resolve the target

Take the newest public GitHub release whose tag matches `mentra-v*`. Skip `mentra-private-cloud-*`. The release body links the ASG APK and the glasses OTA manifest (`mentra-live-ota-<version>.json` under `mentra-builds-v<family>` on `artifactscdn.mentraglass.com`).

Download that manifest with `curl --fail --silent --show-error --location`. It pins:

- `apps["com.mentra.asg_client"]` — `versionCode`, `versionName`, `apkUrl`, `apkSize`, `sha256`
- `bes_firmware` — `version`, `url`, `sha256`
- `mtk_full_ota.end_firmware` and `mtk_patches`

Cross-check BES <https://firmwarecdn.mentraglass.com/latest.json> and MTK <https://mtkfirmware.mentraglass.com/latest.json>. The release pin and the CDN must name the same BES version and the same MTK target (`target_firmware` / full `end_firmware`). If they disagree, stop and report both. Do not mix a newer CDN blob into an older release.

Fetch with curl. Python urllib has been served the OTA website HTML from these hosts.

Re-check the newest `mentra-v*` tag after a long download. If a newer public release pins different artifacts, switch to that set before flashing anything still pending.

## Read the glasses

Require one `adb` device in `device` state whose `ro.product.model` is `Mentra Live`. If more than one device is attached, set `ANDROID_SERIAL`. Source `scripts/lib/glasses-device.sh` when a script already does.

- MTK: `adb shell getprop ro.custom.ota.version` (`MentraLive_YYYYMMDD[.N]`)
- ASG: the first `versionCode` and `versionName` from `dumpsys package com.mentra.asg_client`. That is the updated system app. A later block is the factory image underneath and is not the running client.
- BES: start `com.mentra.asg_client/.MainActivity`, wait until the process is up, then:

```sh
adb shell am broadcast \
  -a com.mentra.asg_client.ACTION_SEND_COMMAND \
  --es json '{"type":"request_version","mId":424242}' \
  -n com.mentra.asg_client/.receiver.IntentCommandReceiver
```

Read `bes_fw_version` from a `version_info_3` log line. `BES firmware version cached successfully` is the same value once UART is up. The glasses clock often shows the firmware build date, so logcat timestamps are not wall time.

## Decide

Update only what is behind. Order is ASG, then MTK, then BES.

- ASG matches `versionCode` and `versionName` has no `-dev` suffix: leave it.
- A `-dev` `versionName` is a local sideload. Its `versionCode` is intentionally higher than the published client. Replace it.
- BES and MTK: if the device is already equal, leave it. If the device is newer than the release pin, stop. Do not downgrade.
- MTK behind: use the `mtk_patches` entry whose `start_firmware` is the device version and whose `end_firmware` is the release target. If that entry does not exist, use the full OTA only after the wipe check below. Intermediate builds such as `MentraLive_20260906.2` often have no incremental to the latest target.

`dumpsys battery` `level` can be a bad gauge. Voltage near 4400 mV is a charged cell even when `level` is a few percent, and the Infinity Cable may report USB as unpowered. Do not flash when voltage is near empty.

## Install

Download each changed artifact with curl. Require the manifest SHA-256 and, when the manifest has one, the byte size. Keep the files outside the repo.

ASG:

```sh
adb -s "$ANDROID_SERIAL" install -r -d <apk>
```

`-d` replaces a `-dev` sideload. Confirm the first dumpsys `versionCode` and `versionName`. If install fails on signature, stop.

MTK runs before BES. An incremental applies when a patch starts at the device version:

```sh
ANDROID_SERIAL="$ANDROID_SERIAL" \
  ./asg_client/scripts/test-mtk-ota.sh <patch.zip>
```

MTK full, when no such patch exists. Before flashing, read `META-INF/com/android/metadata` and `payload_properties.txt`. Require `ota-type=AB`, no `ota-wipe=yes`, no `POWERWASH=1`, and no `ota-downgrade=yes` on an upgrade. `test-mtk-ota.sh` prints `POWERWASH=0` after its own check. Refuse a wiping package.

```sh
ANDROID_SERIAL="$ANDROID_SERIAL" \
  ./asg_client/scripts/test-mtk-ota.sh <full.zip> \
  --full --end-firmware <MentraLive_target>
```

The script checks the new boot, the opposite A/B slot, the same eMMC CID, and the exact target version. ADB disappears during the reboot. If observation is interrupted, reconnect and read `ro.custom.ota.version`. Do not start a second install to compensate. Do not start BES until this boot has finished and ASG is running again.

BES uses the release `.bin` from the manifest, never a raw BES build:

```sh
ANDROID_SERIAL="$ANDROID_SERIAL" \
  ./asg_client/scripts/test-bes-ota.sh <bin> <version> --no-follow
```

The script returns when the trigger is sent. Proof is a later `terminal_status=SUCCESS` with `actual=<version>`, then a fresh `version_info_3` whose `bes_fw_version` equals that version. A tag-filtered `logcat -t` can miss this after ASG restarts. If the log says `BesOtaManager not initialized`, start the activity and send the trigger once more. Authorization denied, CRC failure, or apply error stops the run.

## Prove it

After BES apply, read all three again. ASG `versionCode` / `versionName`, MTK `ro.custom.ota.version`, and BES `bes_fw_version` must match the release that was pinned. Report that tag. Manifest checks do not prove the device; the post-update reads do.
