# Direct ASG MTK maintenance

`scripts/test-mtk-ota.sh` uses the installed ASG debug receiver and the existing
SystemUI/Update Engine installer. The Mentra App does not need to be connected.
The installed ASG must include the MTK-only self-reboot behavior introduced in
`c5113f7663` (July 2026; present in current ASG). Historical factory ASG builds
without it are unsupported by this script's automatic postboot verification;
the script does not add a second or fallback reboot.
Choose an unambiguous ADB serial or already verified endpoint with
`ANDROID_SERIAL`. Physical fixture identification and exclusive maintenance
ownership belong to the caller; a USB port is not a glasses identity.

Incremental mode keeps the existing filename contract:

```sh
ANDROID_SERIAL="$GLASSES_SERIAL" ./scripts/test-mtk-ota.sh \
  /verified/mtk_firmware_20260113_20260921.0.zip
```

Full mode accepts the original signed ZIP filename and requires the real target.
For the January factory baseline, select the separately verified January full
POWERWASH artifact explicitly:

```sh
ANDROID_SERIAL="$GLASSES_SERIAL" ./scripts/test-mtk-ota.sh \
  /verified/january-full.zip --full --end-firmware MentraLive_20260113
```

The caller must authenticate the intended full package and verify its release
SHA-256 before invoking `--full`. The script checks the A/B header, payload and
metadata hashes/sizes, duplicate ZIP entries/metadata keys, and agreement between
`ota-wipe` and `POWERWASH`. A downgrade also requires `ota-downgrade=yes`. It prints
whether POWERWASH will erase userdata and serves the exact bytes it hashes.
These checks do not prove full versus incremental payloads or authenticate a
release. Payload parsing and compatibility checks remain with the native
installer; its signature enforcement depends on the installed build. The script
never invents a firmware version or modifies the ZIP.

For explicit maintenance, the generated `apps: {}` manifest contains one
`mtk_patches` route from the freshly read current version to the requested target,
with the exact full ZIP URL, SHA-256 and size. This reuses the existing receiver's
exact-base route; the normal newer-only `mtk_full_ota` product policy is unchanged.
ASG performs the download and installation, including its own MTK-only reboot.
The script sends no second reboot. It waits within the existing 15-minute OTA
deadline for a completed new boot, the same eMMC CID, the opposite A/B slot and
the exact target firmware. Full mode dispatches once and never retries.

If wiping changes ADB authorization or its selector, target verification remains
incomplete. Reacquire the same physical fixture and inspect its actual state;
do not rerun the installer to compensate for missing observation. January
POWERWASH also clears Wi-Fi settings and exposes the bundled factory ASG. These
scripts do not restore credentials or install a selected newer ASG APK.

The HTTP server binds only loopback. Cleanup stops this invocation's server and
logcat reader, removes only the ADB reverse mapping it created, and deletes its
temporary serving directory. Existing script cache clearing still requires an
idle device with no competing updater. Keep outer run logs and never erase an
active or ambiguous firmware operation's evidence.

Neither OTA script disables or replaces BLE pings. Current ASG's phone-disconnect
handler does not cancel OTA, and the old inferred phone-heartbeat timeout has
been removed. USB-staged BES and ADB-reverse MTK avoid hotspot ping keepalive.
Native UART/OTA timeouts remain active. This does not establish the behavior of
every historical BES firmware's separate phone-link watchdog.

Offline preparation and tests make no device or network calls:

```sh
python3 scripts/mtk-ota-manifest.py /verified/january-full.zip --full \
  --device-version MentraLive_20260921.0 --end-firmware MentraLive_20260113
python3 -m unittest discover -s scripts -p test_mtk_ota_manifest.py
```
