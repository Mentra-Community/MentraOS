# Mentra Live USB refurbishment

Bring one USB-connected Mentra Live to one published glasses set: stock ASG client, then MTK firmware, then BES firmware. The set is pinned for the run. The command does not mix a newer firmware CDN blob into an older release, and it does not restore a third-party client.

```bash
./asg_client/scripts/refurbish-mentra-live.sh
```

The default track is production. Until a public, non-draft, non-prerelease `mentra-vX.Y.Z` release exists, that command stops before any download or install.

## Prerequisites

- A Mentra Live in `adb devices` state `device`, connected with the Infinity Cable. USB debugging is enabled from the factory.
- `adb`, `curl`, `jq`, `python3`, and `node` on `PATH`.
- `gh` authenticated for the MentraOS repository. The command reads the complete public GitHub release list and the artifact index. It does not use `prod_live_version.json` or `staging_live_version.json`.
- The stock launcher. If `com.mentra.asg_client.thirdparty` is enabled, the command stops and points at the developer scripts below.
- Enough battery to survive an MTK reboot. Do not start a run when the cell is near empty.

## Choose the glasses

`--serial` is the normal selector. It must match exactly one ready device whose serial is not the shared placeholder `0123456789ABCDEF`.

```bash
./asg_client/scripts/refurbish-mentra-live.sh --serial <adb-serial>
```

When the serial is missing, duplicated, or that placeholder, the command exits `11` and prints each ready device's serial, eMMC CID, and Bluetooth MAC. Pass `--cid` only to answer that error. The CID is `/sys/block/mmcblk0/device/cid`. An unreadable CID stops the run. An empty MAC does not: older factory images never set `persist.mentra.live.mac`, so the report records it as an empty string and the CID identifies the unit. Transport numbers are not identity and are not stored in the report. adb assigns a new transport id after every reboot, so while a shared serial is pinned by transport the updater re-finds that same CID when the old id disappears.

```bash
./asg_client/scripts/refurbish-mentra-live.sh --cid <emmc-cid>
```

One ready device with a real unique serial can be updated with no selector.

## Choose the track

```bash
./asg_client/scripts/refurbish-mentra-live.sh --track production   # default
./asg_client/scripts/refurbish-mentra-live.sh --track staging
./asg_client/scripts/refurbish-mentra-live.sh --track dev
```

`staging` uses the coordinated `beta` channel. There is no `--track beta` flag.

Production accepts only a public `mentra-vX.Y.Z` release whose plan and release record agree, and it downloads the OTA manifest URL stored on that record. Drafts, prereleases, Private Cloud tags, and unpublished source builds are not production.

Staging and dev take the greatest complete `mentra-builds-vX.Y.Z` container for that track. Greatest means a higher `X.Y.Z`, then a higher sequence. The container must hold the release plan, the release record, and the OTA manifest together. An OTA blob by itself is not a release.

## What the terminal shows

Before anything is installed, the terminal prints the track, the pinned release, the OTA manifest URL, and the glasses' current ASG, MTK, and BES versions next to the target versions. A version name ending in `-dev` or `-beta` is called out and replaced, even when its version code is higher. A newer stock version name with no prerelease suffix is kept.

Each phase is marked. MTK uses the incremental patch chain when one starts at the installed version. A full A/B image is used only when no incremental path exists, the device is older than the image, and the package does not wipe userdata or request a downgrade. A failed patch does not switch to a full image. BES is updated only after MTK has booted. If the pinned stock ASG cannot read BES, the command installs a temporary compatibility client after MTK, reads BES, then restores the pinned stock ASG. A trigger is not completion. The result is a fresh read of all three versions.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Fresh reads match the pin. A newer non-prerelease stock ASG may be retained when MTK and BES match. |
| 10 | No published production glasses set. |
| 11 | No single Mentra Live matched, or a third-party launcher is enabled. |
| 12 | A downloaded artifact failed its digest, size, or package checks. Nothing was installed after that failure. |
| 13 | The glasses need the same command again. A finished component is not repeated. |
| 14 | MTK or BES is newer than the pin. Neither was downgraded. |
| 1 | Any other failure. |

## Reports

Each run writes a JSON report and a transcript:

```text
${MENTRA_REFURB_REPORT_DIR:-$HOME/mentra-live-refurbishment-reports}/<run-id>.json
${MENTRA_REFURB_REPORT_DIR:-$HOME/mentra-live-refurbishment-reports}/<run-id>.txt
```

Override the directory with `--report-dir`. Schema version is 1 (`asg_client/scripts/refurb-report.schema.json`). The report records the sanitized invocation, ADB serial, model, MAC, CID, track, release, artifact digests and sizes, before/target/final versions, phases, elapsed seconds, and PASS or FAIL. When the ADB serial is the placeholder, identify the unit by CID and MAC. The report is replaced into place only after it is fully written. A second unit from the same checkout writes a second report.

## Rerun and reconnect

Run the same command again after a disconnect, a killed process, or exit `13`. The glasses' current versions decide what is left. An ASG that already matches is not reinstalled. An MTK version that already matches the plan target does not start another MTK install. An interrupted compatibility client is restored to the pinned stock ASG before the rest of the run.

If the transport number changes after you unplug and replug the cable, select the same glasses again with `--serial` or, for the placeholder serial, `--cid`. Do not reuse a transport number from an earlier transcript.

## Developer builds

This command refuses an enabled third-party launcher and does not install one. Custom ASG work stays on:

```bash
./asg_client/scripts/update-mentra-live.sh
./asg_client/scripts/restore-stock.sh
```

`update-mentra-live.sh` still updates firmware and returns to the third-party client. It is not the refurbishment command, and it does not follow the published production set.

## Lab note

A legacy unit was updated on the dev track: ASG 36, MTK `MentraLive_20260418`, BES `17.26.4.18` to pin `3.3.0-dev.912` (ASG `3.3.0` / `303000342`, MTK `MentraLive_20260923.0`, BES `26.10.8.0`). A second run on that unit exited 0 and did not flash again. A published production flash is still open: it needs a public `mentra-vX.Y.Z` release. Fixture tests cover the other code paths. They do not close that hardware row.

On the current bench, do not flash the glasses whose Bluetooth MAC is `2C:BA:CA:25:E5:11` and whose eMMC CID is `1501003458364b4d4203b71dcc5eb7b3`. The product command does not contain that identity. Confirm the selected MAC and CID in the terminal before a staging or dev run continues past resolution.

## Qualification status

Automated coverage is `node --test .github/scripts/resolve-glasses-release.test.mjs`, `python3 asg_client/scripts/test_mtk_ota_manifest.py`, and `python3 asg_client/scripts/tests/refurbish_fixture_test.py`.

The no-flash bench checks were run with both lab glasses and a phone attached. Reports are under `~/mentra-live-refurbishment-reports/os-2118/`.

- Default production exited 10 with a FAIL report and did not install.
- No selector exited 11 and named both glasses CIDs. `--cid` for the authorized unit selected that MAC and CID only.
- A corrupted manifest exited 12 before install.
- `--track dev` on the unit that was ahead of the pin read BES `26.10.11.0` against pinned `26.10.8.0` and exited 14. It was not flashed.
- `--track dev --cid 1501003458364b4d4203ce1dcc942845` updated the other unit from ASG 36 / `MentraLive_20260418` / BES `17.26.4.18` to `3.3.0-dev.912`. The final read was ASG `3.3.0` (`303000342`), MTK `MentraLive_20260923.0`, BES `26.10.8.0`. The report recorded MAC `CC:E7:DE:E0:02:6C`. A rerun exited 0 and skipped ASG, MTK, and BES.

These rows are still open:

- Kill-and-rerun after a real trigger, and unplug-and-replug continuation.
- A published production flash. That needs a public `mentra-vX.Y.Z` release.
