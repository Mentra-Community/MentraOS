# BES MCU firmware OTA

The BES2700 microcontroller on Mentra Live runs its own firmware, separate from the Android (MTK) side. ASG Client can push new BES firmware over UART using the BES OTA protocol — this doc describes how that pipeline works.

For Android-side APK update and crash recovery, see `io/ota/helpers/OtaHelper` and `RecoveryWorkerManager` (`com.mentra.recovery` sidecar).

> **Mentra Live = K900.** Throughout this doc and the BES code, you'll see `K900` — that's the internal codename for Mentra Live's hardware platform. See [overview.md](../overview.md#a-naming-note-k900--mentra-live).

## Architecture

```
Server (version.json) → OtaHelper (download + sha256) → BesOtaManager → ComManager (UART) → BES2700
                                                              ↑
                                                  BesOtaUartListener (parses BES responses)
```

Key files:

- `io/ota/helpers/OtaHelper.java` — version-check, download, sha256 verification
- `io/bes/BesOtaManager.java` — protocol state machine
- `io/bes/util/BesOtaUtil.java` — constants (`MAX_FILE_SIZE = 2048 KB`, `MAGIC_CODE = "009K"`)
- `io/bes/BesOtaUartListener.java` — reads UART responses and routes them back to the manager
- `io/bes/protocol/BesCmd_*.java` — one class per protocol command
- `io/bes/events/BesOtaProgressEvent.java` — EventBus events for progress

UART transport is owned by `ComManager` (the K900 UART driver). When BES OTA is active, `mbOtaUpdating = true` blocks normal `send()` / `sendFile()`; only `sendOta()` can transmit. All inbound UART data is routed to `BesOtaUartListener` for that window.

## Update priority

1. **APK update first.** ASG `OtaHelper` checks for an updated APK; if found, it installs and the app restarts. The recovery sidecar can restore from backup if ASG fails to come back.
2. **BES firmware second.** After restart (or if no APK update was needed), `OtaHelper` checks for new BES firmware. APK updates and BES updates are mutually exclusive at runtime.

## Update flow

1. **Version check.** `OtaHelper` polls the server's `version.json`.
2. **Download.** New `.bin` lands at `/storage/emulated/0/asg/bes_firmware.bin`.
3. **Verify.** SHA-256 of the downloaded file is checked against `version.json` metadata. Mismatch → file is deleted and update aborts.
4. **Protocol handshake** — 11-step BES OTA exchange:

   | Step                         | Outbound (cmd) | Inbound |
   | ---------------------------- | -------------- | ------- |
   | Get protocol version         | `0x99`         | `0x9a`  |
   | Set user                     | `0x97`         | `0x98`  |
   | Get firmware version         | `0x8e`         | `0x8f`  |
   | Select side                  | `0x90`         | `0x91`  |
   | Check breakpoint             | `0x8c`         | `0x8d`  |
   | Set start info               | `0x80`         | `0x81`  |
   | Set config                   | `0x86`         | `0x87`  |
   | Send data (loop)             | `0x85`         | `0x8B`  |
   | Segment verify (every 16 KB) | `0x82`         | `0x83`  |
   | Send finish                  | `0x88`         | `0x84`  |
   | Apply (BES reboots)          | `0x92`         | `0x93`  |

5. **Progress events.** `BesOtaProgressEvent`s fire on EventBus throughout (`STARTED`, `PROGRESS`, `FINISHED`, `FAILED`).

## Wire-format constants

- **Packet size:** 504 bytes per data packet
- **Segment size:** 16 KB chunks for CRC32 verification
- **Max firmware size:** 2 MB (`BesOtaUtil.MAX_FILE_SIZE = 2048 * 1024`)
- **Header:** 5 bytes (1-byte cmd + 4-byte length, little-endian)
- **Magic code:** `"009K"` → `0x30 0x30 0x39 0x4B`
- **Byte order:** little-endian
- **UART:** `/dev/ttyS1` at 460800 baud
- **Pacing:** fast-mode, ~5 ms sleep between packets

## Combined OTA manifest

The phone sends one manifest URL in `ota_start`. ASG 39 and newer persist that URL before doing
any installation. If the manifest contains a newer ASG APK, the old client installs the APK and
stops; after restart, the new client resumes the same top-level session and only then considers BES
firmware. Therefore every manifest admitted for an ASG bootstrap must be valid for both the old
client that starts it and the new client that resumes it.

The staging workflow builds `staging_live_version.json` from the ASG artifact plus
`ota_manifests/firmware_live.json`. Keep the established BES block limited to its target version,
download URL, and compressed hash:

```json
{
  "apps": {
    "com.mentra.asg_client": {
      "versionCode": 123,
      "versionName": "1.2.3",
      "apkUrl": "https://example.com/asg_client_v1.2.3.apk",
      "apkSize": 12345678,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  },
  "mtk_patches": [
    {
      "start_firmware": "MentraLive_20260113",
      "end_firmware": "MentraLive_20260709",
      "url": "https://example.com/mtk_ota_update.zip",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ],
  "bes_firmware": {
    "version": "26.7.30.4",
    "url": "https://firmware.example.com/bes_firmware_26.7.30.4.bin",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

Before reserving UART or sending `mh_ota`, ASG checks the manifest's canonical four-byte target
version, HTTPS artifact URL without a query or fragment, and SHA-256. It then inspects the downloaded
bytes directly:
the release container must have valid chunk structure and CRC, bounded LZMA decoder requirements,
a decompressed image strictly smaller than the BES bootloader limit (`1966080` bytes), and the
Mentra Live product marker. This keeps release authoring simple while still rejecting malformed,
oversized, or wrong-product artifacts before BES sees them. The manifest version remains the target
used for eligibility and the required post-reboot version readback; the image format has no stable,
documented version offset, so ASG does not guess one.

Validate a locally composed manifest with:

```bash
.github/scripts/validate-asg-ota-manifest.sh path/to/staging_live_version.json
```

## EventBus integration

```java
@Subscribe(threadMode = ThreadMode.MAIN)
public void onBesOtaProgress(BesOtaProgressEvent event) {
    switch (event.getStatus()) {
        case STARTED:  Log.d(TAG, "Started: " + event.getTotalBytes() + " bytes"); break;
        case PROGRESS: Log.d(TAG, event.getProgress() + "% — " + event.getCurrentStep()); break;
        case FINISHED: Log.d(TAG, "Finished"); break;
        case FAILED:   Log.e(TAG, "Failed: " + event.getErrorMessage()); break;
    }
}
```

## Files on disk

Stored under `/storage/emulated/0/asg/`:

- `bes_firmware.bin` — currently downloaded firmware

## Internal staging test

The ADB script is available for explicit internal BES upgrades and downgrades. It does not exercise
the phone UI, but it does use the release artifact validator, durable transaction owner, UART
quarantine, reboot reconciliation, and exact-version proof used by the production path. The
receiver requires Android's privileged `DUMP` permission, so ordinary apps cannot trigger it.

Use only release-packaged `update_ota.bin`, never raw BES build output, and state the exact version
the glasses must report after reboot:

```bash
ANDROID_SERIAL=0123456789ABCDEF \
  ./scripts/test-bes-ota.sh /path/to/update_ota.bin 17.26.7.9
```

The script computes and verifies the local/device SHA-256 before sending the protected intent.
Selecting an older target is allowed for bench recovery and compatibility testing. A wrong target
does not create false success: durable reconciliation fails unless post-reboot `sr_syvr` reports the
exact supplied version.

Use the phone-driven procedure below for release qualification because it additionally exercises
the immutable manifest pin, Mentra App progress UI, and BLE reconnect behavior.

1. Land the candidate ASG and `firmware_live.json` on `staging` so the staging
   workflow publishes one combined, immutable-per-run manifest and embeds its URL in that run's
   Mentra App artifact.
2. Install that staging Mentra App on the phone. Begin with glasses on ASG 39 and the oldest BES
   version admitted by the rollout. ASG 39 is the bootstrap boundary that honors the manifest URL
   carried by `ota_start`.
3. Start the update from the Mentra App. Confirm ASG 39 persists the session and manifest URL,
   installs the newer ASG APK first, and does not start BES in the old process.
4. After the ASG restart, confirm the new client resumes the same session and manifest, proves the
   old BES UART path, explicitly returns BES from negotiated fast baud to 460800, validates the BES
   artifact, and only then sends one `mh_ota`.
5. Follow logs with an explicit device selector:

   ```bash
   adb -s 0123456789ABCDEF logcat \
     -s OtaHelper BesOtaManager BesOtaUartListener K900BluetoothManager BesUartTransport
   ```

6. Confirm the BES transfer reaches Apply, the glasses reconnect, and a fresh version reply reports
   the target. Repeat from both supported deployed BES baselines and include power loss/restart at
   every persisted boundary in the release matrix.

The rolling `staging_live_version.json` is useful for discovery, but record and test the immutable
per-run manifest URL embedded in the phone artifact. Never infer the tested manifest from the ASG
version name after the fact.

## Troubleshooting

- **Update never starts** — confirm BES OTA path is initialized (`BesOtaManager` log line at startup). Check WiFi, battery (≥ 5%), and that no APK update is currently running.
- **Stall mid-transfer** — UART instability or BES not responding. The transfer is response-driven, so a lost response no longer stalls silently: a dead-man watchdog aborts the transfer after 30 seconds without any BES response (`AsgConstants.BES_OTA_RESPONSE_TIMEOUT_MS`), runs the normal cleanup (OTA mode exited, wake leases released), posts a failure the phone surfaces as "Update failed", and emits a `bes_ota_response_timeout` lifecycle trace with the transfer position (`sentPos`, `confirmedSegments`). The BES stays on its current firmware — the recovery is simply retrying the whole OTA from the phone. If aborts recur, look for `BesOtaUartListener` logs and check the Infinity Cable; loose connections kill UART traffic.
- **Artifact admission failure** — the combined manifest is invalid, or direct inspection found a
  corrupt, oversized, or wrong-product release artifact. BES has not seen `mh_ota`; correct the
  manifest/artifact and Retry is safe.
- **Install-phase failure** — ASG may have queued `mh_ota`, so local write failure or silence is
  ambiguous. Do not resend it in the same boot. The UI requires a glasses restart before another
  attempt so BES and ASG return to a known framed UART state.
- **Stuck in OTA mode** — a persisted nonterminal BES session deliberately owns/quarantines UART
  until raw-versus-framed recovery resolves. A raw `0x9a` proves BES is still in OTA mode; only the
  exact fresh `sr_syvr` requested by the audited framed probe can prove normal mode.
- **Hard reboot after apply** — Android filesystem persistence can expose the earlier authorization
  record even when apply was committed and acknowledged immediately before power loss. On a later
  Linux boot, ASG keeps that record quarantined while bounded raw-first recovery runs: raw `0x9a`
  fails the update and an exact target `sr_syvr` completes it. Exhausting the transport scan starts
  a short grace window because BES may still be rebooting. Even after that grace expires, a fresh
  framed reply from the later boot may supersede only `recovery_timeout` or
  `verification_timeout`, and only when it exactly matches the requested target. Authorization,
  artifact, protocol, raw-mode, and version-mismatch failures remain terminal. A process restart in
  the original Linux boot remains an immediate failure.

## Logcat tags

| Tag                  | Component                                            |
| -------------------- | ---------------------------------------------------- |
| `BesOtaManager`      | Protocol state machine                               |
| `BesOtaUartListener` | UART response parser                                 |
| `OtaHelper`          | Version-check, download, sha256                      |
| `ComManager`         | UART driver (especially `mbOtaUpdating` transitions) |
