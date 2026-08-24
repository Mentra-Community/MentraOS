# Mentra Live firmware maintenance for custom ASG Clients

This runbook covers the supported shell-script flow for bringing Mentra Live ASG, BES, and MTK
firmware to the latest staging baseline before or while running a custom ASG Client.

## Choose the command

From `asg_client/`:

```bash
# First installation, or rebuilding the custom client from this checkout
./scripts/dev-setup.sh

# Firmware maintenance when dev-setup.sh already installed the custom client
./scripts/update-mentra-live.sh

# Remove the custom client and return to stock
./scripts/restore-stock.sh
```

`update-mentra-live.sh` supports the package installed by `dev-setup.sh`:
`com.mentra.asg_client.thirdparty`. It does not rebuild, reinstall, or clear that package, so its
APK and app data survive the maintenance window.

## Prerequisites

- Connect Mentra Live with the Infinity Cable and confirm it appears in `adb devices`.
- Install `adb`, `curl`, `jq`, and `python3` on the host.
- Keep the host online while artifacts download.
- If multiple Android devices are attached, select the glasses explicitly:

  ```bash
  ADB_SERIAL=<serial> ./scripts/update-mentra-live.sh
  ```

The scripts download every required artifact and verify its SHA-256 before changing packages or
firmware. Do not disconnect the glasses during a BES or MTK transfer.

## Baseline selection

Each run downloads this rolling staging manifest exactly once:

```text
https://github.com/Mentra-Community/MentraOS/releases/download/staging-builds/staging_live_version.json
```

That local snapshot controls the entire run: target stock ASG APK, BES image, and the exact MTK
patch graph. Although the release asset is mutable between staging publications, it cannot change
under a run after the initial download.

For a deliberate test, override the manifest without editing the script:

```bash
./scripts/update-mentra-live.sh --manifest-url https://example.com/version.json
```

The manifest and all referenced files must pass the same HTTPS, schema, size, and SHA-256 checks.

## Why ASG 36 is a bridge

Factory/day-one BES firmware cannot reliably communicate with current ASG builds. The updater
temporarily installs the officially signed ASG 36 bridge because it can communicate with that old
BES generation and its high version code can replace old stock update layers.

ASG 36 reads `/storage/emulated/0/asg/bes_firmware.bin` and accepts a no-metadata debug broadcast.
Current ASG reads a hash-addressed debug artifact and validates target/hash metadata. The shared
`test-bes-ota.sh` stages both forms, but moves any existing phone-owned legacy artifact aside and
restores it immediately after ASG 36 synchronously loads the debug image. The backup uses a stable
path, so a later run restores it before staging anything if ADB disappeared during the short
compatibility window.

Modern BES can retain a negotiated 1152000 baud when its ASG process stops, while ASG 36 only
opens the universal 460800 rendezvous baud. The updater therefore uses the manifest-pinned stock
client, or retains an already-installed newer stock client, to probe both supported baud rates.
When it proves a BES link, it sends a BES-only reset, requires confirmation that the reset reached
UART, and force-stops the current client before it can renegotiate. ASG 36 then starts after BES
has returned to 460800. If current ASG cannot find BES at either baud, ASG 36 performs the legacy
discovery needed by the factory BES generation. Any later failure removes the bridge and restores
the manifest-pinned stock client before selecting stock HOME.

After ASG 36 reports apply success, the updater waits for the BES chip to reboot and repeatedly
requests `version_info_3`. It does not continue until the reported BES version is at least the
manifest target. A newer BES is retained rather than downgraded.

## Update sequence

The updater performs these steps:

1. Resolve exactly one ADB device and read its current MTK version.
2. Snapshot and validate the staging manifest.
3. Download and verify ASG 36, target stock ASG, BES firmware, and every MTK patch in the exact
   current-to-terminal path.
4. Disable the third-party client, recovery sidecar, and legacy updater; use the manifest-pinned
   stock ASG (or an already-installed newer stock ASG) to probe both UART bauds and reset a proven
   BES link to 460800.
5. Activate ASG 36 and update BES when the device is below the manifest target.
6. Move the stock package's legacy external-files tree to uninstall-safe shared storage.
7. Remove the ASG 36 update layer, install the manifest-pinned stock ASG, and restore the legacy
   tree so current ASG can migrate captures to `/storage/emulated/0/asg_media`.
8. Apply each exact MTK patch, issue `adb reboot`, require a changed Android boot ID, and verify
   `ro.custom.ota.version` after the reboot.
9. For `update-mentra-live.sh`, disable stock/recovery again and restore the existing third-party
   package as HOME. For `dev-setup.sh`, install the newly built third-party APK instead.

Unknown MTK starting versions fail closed. MTK versions newer than the manifest terminal are kept
instead of downgraded.

## USB ADB after an MTK reboot

Many older MTK releases do not restore USB ADB while the Infinity Cable remains connected. The
updater identifies a real Android reboot by comparing `/proc/sys/kernel/random/boot_id`; a cable
disconnect/reconnect alone is not accepted. The MTK helper also enforces a 15-minute overall
deadline after each trigger, so a stalled update exits into stock recovery instead of holding the
development setup indefinitely.

If ADB is still offline 45 seconds after the reboot command, the script prints:

```text
Unplug the Infinity Cable, then plug it back in.
The script will resume automatically when ADB returns.
```

The script keeps waiting for the selected device. If ADB returns with the old boot ID, it sends an
explicit `adb reboot` up to three times and bounds the online wait for each attempt. Wi-Fi ADB
devices are waited for without showing the USB cable instruction.

## Failure and recovery behavior

The safe fallback is signed stock ASG, not the custom client:

- A failure before device mutation leaves the current installation unchanged.
- A failure after mutation stops/disables a partially activated third-party client, restores any
  staged legacy stock data, removes ASG 36 when it is active, reinstalls the manifest-pinned stock
  ASG, activates stock HOME, and enables available recovery packages.
- If failure occurs while ADB is offline, reconnect the Infinity Cable and rerun the same updater.
  It detects an interrupted ASG 36 installation and restores the manifest-pinned stock ASG before
  attempting another bridge transition. `./scripts/restore-stock.sh` remains the path for removing
  the third-party package after stock has been recovered.
- If returning to the custom client fails after firmware completed, the firmware remains updated
  but stock stays active so the device retains a working launcher.

The standalone update reports success only after the third-party package is enabled and Android
resolves HOME to its `MainActivity`.

## Validation checklist

Before changing this flow, test at least:

1. Factory/day-one BES through ASG 36, target BES, target stock ASG, MTK patch, and reboot.
2. A modern BES already negotiated at 1152000, including the proven reset to 460800 before ASG 36.
3. A device already at the manifest BES and MTK targets.
4. A device newer than the manifest targets to confirm downgrade prevention.
5. USB ADB failing to return until the Infinity Cable is unplugged and reconnected.
6. A cable-only reconnect with an unchanged boot ID.
7. Legacy captures under the stock app-owned external-files tree across bridge removal.
8. An interrupted ASG 36 compatibility-artifact swap recovered by the next run.
9. `update-mentra-live.sh` returning to the same third-party APK, data, and HOME activity.
10. Failures during artifact download, BES transfer, MTK reboot, stock restoration, and third-party
   handoff.

The shell scripts can validate manifests, downloads, hashes, and device state, but BES and MTK
transitions still require a physical Mentra Live test.
