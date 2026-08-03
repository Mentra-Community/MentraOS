# BES MCU firmware OTA

The BES2700 microcontroller on Mentra Live runs its own firmware, separate from the Android (MTK) side. ASG Client can push new BES firmware over UART using the BES OTA protocol — this doc describes how that pipeline works.

For Android-side APK update and crash recovery, see `io/ota/helpers/OtaHelper` and `RecoveryWorkerManager` (`com.mentra.recovery` sidecar).

> **Mentra Live = K900.** Throughout this doc and the BES code, you'll see `K900` — that's the internal codename for Mentra Live's hardware platform. See [overview.md](../overview.md#a-naming-note-k900--mentra-live).

## Architecture

```
Server (version.json) → OtaHelper (artifact admission) → BesOtaManager → ComManager (UART) → BES2700
                                                              ↑
                                                  BesOtaUartListener (parses BES responses)
```

Key files:

- `io/ota/helpers/OtaHelper.java` — version-check, download, and release artifact admission
- `io/ota/utils/BesFirmwareArtifactValidator.java` — compressed/decompressed identity and safety checks
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
3. **Admit artifact.** Before authorization, ASG requires immutable release metadata and verifies the compressed bytes, complete LZMA-chunk container, embedded CRC32, decompressed bytes, hard flash-size limit, product marker, and embedded target version. Any mismatch deletes the file and aborts without sending `mh_ota`.
4. **Authorize once per boot.** ASG first proves a stable UART session, freezes baud reconfiguration, persists the glasses boot identity, and sends `mh_ota`. It never sends that authorization twice in one glasses boot. A reported write failure is treated as ambiguous: ASG keeps exclusive ownership and waits for `hm_ota` rather than releasing normal JSON into a BES that may already be in raw OTA mode.
5. **Protocol handshake** — 11-step BES OTA exchange after `hm_ota` grants authorization:

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

6. **Progress events.** `BesOtaProgressEvent`s fire on EventBus throughout (`STARTED`, `PROGRESS`, `FINISHED`, `FAILED`).

## Wire-format constants

- **Packet size:** 504 bytes per data packet
- **Segment size:** 16 KB chunks for CRC32 verification
- **Max firmware size:** 2 MB (`BesOtaUtil.MAX_FILE_SIZE = 2048 * 1024`)
- **Header:** 5 bytes (1-byte cmd + 4-byte length, little-endian)
- **Magic code:** `"009K"` → `0x30 0x30 0x39 0x4B`
- **Byte order:** little-endian
- **UART:** `/dev/ttyS1` at 460800 baud
- **Pacing:** fast-mode, ~5 ms sleep between packets

## Server-side `version.json`

Release A deliberately rejects the legacy three-field BES manifest before authorization. A later BES-bearing release must add the full admission metadata below and must reference the release-packaged `update_ota.bin`, never a raw build output:

```json
{
  "apps": {
    "com.mentra.asg_client": {
      "versionCode": 1000,
      "versionName": "1.0.0",
      "apkUrl": "https://example.com/asg_client_v1.0.0.apk",
      "sha256": "abc123...",
      "releaseNotes": "ASG Client updates"
    }
  },
  "bes_firmware": {
    "version": "17.26.7.25",
    "format": "bes-lzma-chunks-v1",
    "product": "best1502x_ibrt_bpone",
    "artifact_id": "bes-17.26.7.25-update_ota.bin",
    "url": "https://example.com/releases/bes-17.26.7.25-update_ota.bin",
    "compressed_size": 812345,
    "sha256": "compressed-artifact-sha256",
    "decompressed_size": 1900000,
    "decompressed_sha256": "raw-image-sha256",
    "version_offset": 1809280
  }
}
```

All shown `bes_firmware` fields are mandatory. The URL must be HTTPS, have no query or fragment, and end exactly in `artifact_id`. `compressed_size` and `sha256` describe `update_ota.bin`; `decompressed_size` and `decompressed_sha256` describe its raw image. `decompressed_size` must be strictly less than `0x1E0000` bytes. `version_offset` identifies the four embedded version bytes that must equal `version`.

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

## Testing

A test script ships with the repo:

```bash
./scripts/test-bes-ota.sh path/to/firmware.bin
```

Manual procedure:

1. Upload `firmware.bin` to a server.
2. Update `version.json` with the new metadata, including a fresh sha256.
3. `sha256sum bes_firmware.bin` to compute the hash.
4. Wait for the 30-minute auto-check or restart the app to trigger an immediate check.
5. `adb logcat | grep BesOtaManager` to watch progress.
6. Confirm BES reboots after `Apply` and the new version is reported on next `request_version`.

## Troubleshooting

- **Update never starts** — confirm BES OTA path is initialized (`BesOtaManager` log line at startup). Check WiFi, battery (≥ 5%), and that no APK update is currently running.
- **Stall or ambiguous authorization** — after `mh_ota` may have reached BES, ASG intentionally quarantines the UART instead of assuming BES returned to JSON mode. Reboot the glasses and wait for fresh version discovery before retrying. Do not retry in the same boot.
- **Stall mid-transfer** — a dead-man watchdog reports failure after 30 seconds without a BES response. Because BES parser state is not provable after authorization, recovery requires rebooting the glasses before retrying the whole OTA. Check `BesOtaUartListener` logs and the Infinity Cable if this repeats.
- **`File too big`** — the compressed artifact exceeds the download cap or its declared/decompressed raw image reaches the `0x1E0000`-byte bootloader limit.
- **`SHA-256 mismatch`** — the downloaded `.bin` doesn't match `version.json`. The file is deleted; verify your hash and re-upload.
- **Stuck in OTA mode** — after authorization uncertainty this is a deliberate safety quarantine. Restart the glasses, not only the app; the persisted same-boot gate prevents an app restart from resending `mh_ota`.

## Logcat tags

| Tag                  | Component                                            |
| -------------------- | ---------------------------------------------------- |
| `BesOtaManager`      | Protocol state machine                               |
| `BesOtaUartListener` | UART response parser                                 |
| `OtaHelper`          | Version-check, download, sha256                      |
| `ComManager`         | UART driver (especially `mbOtaUpdating` transitions) |
