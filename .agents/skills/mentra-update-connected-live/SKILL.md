---
name: mentra-update-connected-live
description: Update a USB-connected Mentra Live to the latest published ASG client, BES firmware, and MTK firmware. Use when the user asks to check or update the connected glasses' BES, MTK, or ASG client. Not for firmware_live.json manifest PRs or BES source builds.
---

# Update a connected Mentra Live

Run the stock refurbishment command. It pins one published ASG, MTK, and BES set, updates in that order, and proves completion with a fresh version read.

```bash
./asg_client/scripts/refurbish-mentra-live.sh --serial <adb-serial>
```

The default track is production. It fails closed, before any download, until a public non-draft `mentra-vX.Y.Z` release exists. Do not fall back to `prod_live_version.json`, `staging_live_version.json`, or `asg_client/scripts/update-stock-for-dev.sh`.

```bash
./asg_client/scripts/refurbish-mentra-live.sh --track staging --serial <adb-serial>
./asg_client/scripts/refurbish-mentra-live.sh --track dev --serial <adb-serial>
```

`--serial` is the selector. If the serial is missing, duplicated, or `0123456789ABCDEF`, the command exits 11 and names each device. Pass `--cid` only to answer that error. Read the printed MAC and CID before any staging or dev run continues. Do not flash a unit you cannot identify. An empty MAC fails closed.

Do not use this command to restore a developer build. An enabled `com.mentra.asg_client.thirdparty` launcher makes it exit 11. Third-party restore stays on `asg_client/scripts/update-mentra-live.sh`.

Exit 0 is a pass. Exit 10 means production is unpublished. Exit 12 is a bad artifact and must stop before install. Exit 13 means rerun the same command; do not repeat a component whose fresh read already matches. Exit 14 means MTK or BES is newer than the pin; do not downgrade. The procedure, report path, and lab limits are in `asg_client/docs/refurbishment-usb-update.md`.

A trigger is not completion. The report's final ASG, MTK, and BES values are the versions read after the update. A `-dev` or `-beta` ASG version name is replaced even when its version code is higher. A newer stock version name with no prerelease suffix is retained only when MTK and BES match the pin.
