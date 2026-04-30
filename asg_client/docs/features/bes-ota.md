# BES MCU firmware OTA

The BES2700 microcontroller on Mentra Live runs its own firmware, separate from the Android (MTK) side. ASG Client can push new BES firmware over UART using the BES OTA protocol — this doc describes how that pipeline works.

For the Android-side APK self-update, see `OtaUpdaterManager` (`OtaUpdaterManager.java`).

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

1. **APK update first.** `OtaUpdaterManager` checks for an updated APK; if found, it installs and the app restarts.
2. **BES firmware second.** After restart (or if no APK update was needed), `OtaHelper` checks for new BES firmware. APK updates and BES updates are mutually exclusive at runtime.

## Update flow

1. **Version check.** `OtaHelper` polls the server's `version.json`.
2. **Download.** New `.bin` lands at `/storage/emulated/0/asg/bes_firmware.bin`.
3. **Verify.** SHA-256 of the downloaded file is checked against `version.json` metadata. Mismatch → file is deleted and update aborts.
4. **Protocol handshake** — 11-step BES OTA exchange:

   | Step | Outbound (cmd) | Inbound |
   |------|----------------|---------|
   | Get protocol version | `0x99` | `0x9a` |
   | Set user | `0x97` | `0x98` |
   | Get firmware version | `0x8e` | `0x8f` |
   | Select side | `0x90` | `0x91` |
   | Check breakpoint | `0x8c` | `0x8d` |
   | Set start info | `0x80` | `0x81` |
   | Set config | `0x86` | `0x87` |
   | Send data (loop) | `0x85` | `0x8B` |
   | Segment verify (every 16 KB) | `0x82` | `0x83` |
   | Send finish | `0x88` | `0x84` |
   | Apply (BES reboots) | `0x92` | `0x93` |

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

## Server-side `version.json`

Add a `bes_firmware` block alongside the existing `apps` block:

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
    "versionCode": 10203,
    "versionName": "1.2.3",
    "firmwareUrl": "https://example.com/bes_firmware_v1.2.3.bin",
    "sha256": "abc123def456...",
    "fileSize": 1048576,
    "releaseNotes": "BES firmware bug fixes and improvements"
  }
}
```

| Field | Description |
|-------|-------------|
| `versionCode` | Integer for comparison |
| `versionName` | Human-readable string |
| `firmwareUrl` | Direct `.bin` URL |
| `sha256` | Hex SHA-256 of the `.bin` |
| `fileSize` | Bytes; must be ≤ `BesOtaUtil.MAX_FILE_SIZE` (2 MB) |
| `releaseNotes` | Free text |

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
- **Silent stall mid-transfer** — UART instability or BES not responding. Look for `BesOtaUartListener` logs. Check the Infinity Cable; loose connections kill UART traffic.
- **`File too big`** — firmware exceeds 2 MB.
- **`SHA-256 mismatch`** — the downloaded `.bin` doesn't match `version.json`. The file is deleted; verify your hash and re-upload.
- **Stuck in OTA mode** — if `mbOtaUpdating` doesn't get cleared (rare), normal BLE traffic stays blocked. Restart the app.

## Logcat tags

| Tag | Component |
|-----|-----------|
| `BesOtaManager` | Protocol state machine |
| `BesOtaUartListener` | UART response parser |
| `OtaHelper` | Version-check, download, sha256 |
| `ComManager` | UART driver (especially `mbOtaUpdating` transitions) |
