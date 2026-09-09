# Maintaining customized Mentra Live devices

This guide is for teams that prepare and manage fleets of Mentra Live devices with a custom ASG
Client. The provided scripts handle initial setup, firmware maintenance, recovery, and returning
the glasses to your custom launcher.

## Choose the command

Run these commands from `asg_client/`:

```bash
# Build and install your custom ASG Client on a new or reset device
./scripts/dev-setup.sh

# Safely update a device that already has your custom ASG Client
./scripts/update-mentra-live.sh

# Remove your custom ASG Client and return the device to stock software
./scripts/restore-stock.sh
```

## Before you begin

- Connect Mentra Live to your computer with the Infinity Cable.
- Confirm that the device appears as `device` when you run `adb devices`.
- Install `adb`, `curl`, `jq`, and `python3` on your computer.
- Keep your computer online while the script downloads and verifies the required files.
- Keep the glasses connected until the script says the operation is complete.

If more than one Android device is attached, select the glasses explicitly:

```bash
ADB_SERIAL=<serial> ./scripts/dev-setup.sh
ADB_SERIAL=<serial> ./scripts/update-mentra-live.sh
```

## Set up a customized device

Use `dev-setup.sh` when preparing a Mentra Live for the first time or when installing a new build
from your checkout:

```bash
./scripts/dev-setup.sh
```

The script:

1. Builds your custom ASG Client.
2. Brings the glasses onto the latest firmware baseline supported by this workflow.
3. Installs the custom client as `com.mentra.asg_client.thirdparty`.
4. Makes the custom client the default launcher.

The stock software remains on the device as a recovery path. Your custom build does not receive
automatic OTA updates from Mentra, so use the maintenance command below when you need to update
the glasses.

## Update a customized device

Use `update-mentra-live.sh` for a device that was prepared with `dev-setup.sh`:

```bash
./scripts/update-mentra-live.sh
```

The script preserves the installed custom APK and its app data, updates the glasses with
Mentra-signed firmware, and returns to the same custom launcher after verifying the update. You do
not need to rebuild or reinstall your custom client.

Run this command as part of your normal device-maintenance process whenever you need to bring a
customized device onto the current supported firmware baseline.

## If USB ADB does not return after a reboot

Some older device versions do not reconnect over USB ADB automatically after a firmware reboot.
The script waits for the reboot and continues on its own when ADB returns.

If the device is still offline after 45 seconds, the script asks you to:

1. Unplug the Infinity Cable.
2. Plug the Infinity Cable back in.
3. Leave the script running; it will resume automatically.

Reconnecting the cable does not restart the update or erase your custom client.

## If an update is interrupted or fails

The scripts use the stock launcher as the safe fallback during maintenance. If the custom launcher
cannot be restored, the device stays on the stock launcher instead of being left without a working
HOME screen.

After reconnecting the Infinity Cable and confirming the device appears in `adb devices`, rerun the
same command. The updater detects and recovers incomplete maintenance work before continuing.

If you want to remove the custom client and return the device to stock software, run:

```bash
./scripts/restore-stock.sh
```

Do not manually uninstall the stock ASG Client or sideload individual firmware files. The scripts
verify the complete update set and preserve the recovery path for you.

## Confirm the device is ready

Before shipping or returning a device to service, confirm that:

- The script exits successfully.
- Your custom launcher is visible after the final reboot.
- The device reconnects to your expected phone or network.
- Camera, audio, and any hardware features used by your product work normally.

If a run fails, save its terminal output before retrying. It contains the device and firmware state
needed to diagnose the problem.
