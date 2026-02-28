# BES UART OTA Firmware Update System

## Overview

This document describes the BES2700 firmware OTA update system integrated into ASG Client. The system allows automatic firmware updates for the BES2700 Bluetooth module via UART protocol.

## Architecture

### Component Structure

```
OtaHelper (downloads firmware)
    ↓
BesOtaManager (protocol state machine)
    ↓
ComManager (UART communication)
    ↓
BES2700 Hardware
```

### Key Components

- **BesOtaManager**: Manages firmware file loading, packet transmission, and protocol state machine
- **ComManager**: UART communication with OTA mode support (blocks normal traffic during updates)
- **OtaHelper**: Downloads firmware from server and triggers updates
- **Protocol Classes**: 11 command implementations for BES OTA protocol

## Update Flow

### Sequential Priority System

1. **APK Updates First**: If APK updates are available, they execute first
2. **Firmware Updates Second**: BES firmware updates only proceed if no APK updates needed
3. **Mutual Exclusion**: APK and firmware updates cannot run simultaneously

### BES Firmware Update Steps

1. **Version Check**: OtaHelper checks server for new firmware version
2. **Download**: Firmware .bin file downloaded to `/storage/emulated/0/asg/bes_firmware.bin`
3. **Verification**: SHA256 hash verified against server metadata
4. **Protocol Handshake**: 11-step BES OTA protocol:
   - Get Protocol Version (0x99 → 0x9a)
   - Set User (0x97 → 0x98)
   - Get Firmware Version (0x8e → 0x8f)
   - Select Side (0x90 → 0x91)
   - Check Breakpoint (0x8c → 0x8d)
   - Set Start Info (0x80 → 0x81)
   - Set Config (0x86 → 0x87)
   - Send Data Loop (0x85 → 0x8B)
   - Segment Verify (0x82 → 0x83) - every 16KB
   - Send Finish (0x88 → 0x84)
   - Apply (0x92 → 0x93) - BES reboots
5. **Progress Tracking**: EventBus events emitted throughout process

## Server Configuration

### version.json Format

Add `bes_firmware` section to your version.json:

```json
{
  "apps": {
    "com.mentra.asg_client": {
      "versionCode": 1000,
      "versionName": "1.0.0",
      "apkUrl": "https://server.com/asg_client_v1.0.0.apk",
      "sha256": "abc123...",
      "releaseNotes": "ASG Client updates"
    },
    "com.augmentos.otaupdater": {
      "versionCode": 200,
      "versionName": "2.0.0",
      "apkUrl": "https://server.com/ota_updater_v2.0.0.apk",
      "sha256": "def456...",
      "releaseNotes": "OTA Updater improvements"
    }
  },
  "bes_firmware": {
    "versionCode": 10203,
    "versionName": "1.2.3",
    "firmwareUrl": "https://server.com/bes_firmware_v1.2.3.bin",
    "sha256": "abc123def456...",
    "fileSize": 1048576,
    "releaseNotes": "BES firmware bug fixes and improvements"
  }
}
```

### Field Descriptions

- **versionCode**: Integer version code for comparison
- **versionName**: Human-readable version string
- **firmwareUrl**: Direct download URL for .bin firmware file
- **sha256**: SHA256 hash of firmware file for verification
- **fileSize**: Size in bytes (must be ≤ 1,126,400 bytes / 1100KB)
- **releaseNotes**: Description of changes

## Technical Specifications

### Protocol Details

- **Packet Size**: 504 bytes per data packet
- **Segment Size**: 16KB chunks for CRC32 verification
- **Max File Size**: 1100KB (1,126,400 bytes)
- **Header Format**: 5 bytes (1-byte cmd + 4-byte length in little-endian)
- **Magic Code**: "009K" (0x30, 0x30, 0x39, 0x4b)
- **Byte Order**: Little-endian for all multi-byte values
- **UART Speed**: 460800 baud
- **Transfer Mode**: Fast mode (5ms sleep between packets)

### UART Port Control

During BES OTA updates:

- `ComManager.mbOtaUpdating = true`
- Normal `send()` and `sendFile()` are blocked
- Only `sendOta()` can transmit
- All received data routed to `BesOtaUartListener`

This prevents BLE commands and other traffic from interfering with the firmware update.

## EventBus Integration

### BesOtaProgressEvent

Subscribe to firmware update progress:

```java
@Subscribe(threadMode = ThreadMode.MAIN)
public void onBesOtaProgress(BesOtaProgressEvent event) {
    switch (event.getStatus()) {
        case STARTED:
            Log.d(TAG, "Firmware update started: " + event.getTotalBytes() + " bytes");
            break;
        case PROGRESS:
            Log.d(TAG, "Progress: " + event.getProgress() + "% - " + event.getCurrentStep());
            break;
        case FINISHED:
            Log.d(TAG, "Firmware update completed successfully");
            break;
        case FAILED:
            Log.e(TAG, "Firmware update failed: " + event.getErrorMessage());
            break;
    }
}
```

## File Locations

All files stored in `/storage/emulated/0/asg/`:

- `bes_firmware.bin` - Downloaded firmware file
- `bes_firmware_backup.bin` - Backup of previous firmware (future feature)

## Safety Features

### Mutual Exclusion

- APK updates and firmware updates cannot run simultaneously
- Each checks the other's status before starting
- Flags: `OtaHelper.isUpdating` and `BesOtaManager.isBesOtaInProgress`

### Integrity Verification

- SHA256 hash verification before starting update
- CRC32 checksum every 16KB during transmission
- Invalid files rejected and deleted

### Update Priority

1. **APK updates** always take priority
2. If both APK and firmware updates available:
   - APK updates first
   - App restarts
   - Firmware update proceeds after restart
3. If only firmware update available:
   - Proceeds immediately

## Device Compatibility

- **K900 Devices Only**: Requires K900 with BES2700 Bluetooth module
- **UART Path**: `/dev/ttyS1` at 460800 baud
- **Auto-Detection**: System automatically detects K900 devices
- **Non-K900 Devices**: BesOtaManager not initialized, firmware updates skipped

## Testing

### Manual Testing Procedure

1. Upload firmware .bin file to server
2. Update version.json with firmware metadata
3. Calculate SHA256: `sha256sum bes_firmware.bin`
4. Wait for automatic check (30 minutes) or restart app
5. Monitor logs: `adb logcat | grep BesOtaManager`
6. Verify progress events in EventBus subscribers
7. Confirm BES reboots with new firmware

### Verification

- Check `mbOtaUpdating` blocks normal BLE traffic
- Verify progress tracking shows 0-100%
- Confirm CRC32 verification occurs every 16KB
- Test file size limit (reject files > 1100KB)
- Test SHA256 mismatch (should delete and fail gracefully)

## Troubleshooting

### Common Issues

**Firmware update doesn't start:**

- Check if BesOtaManager is initialized (K900 device only)
- Verify network connectivity
- Check battery level (≥5%)
- Ensure no APK update in progress

**Update fails mid-transfer:**

- Check UART connection stability
- Verify firmware file integrity
- Check BES2700 is responsive
- Review logs for protocol errors

**File too large error:**

- Firmware must be ≤ 1100KB
- Compress or optimize firmware if possible

## Future Enhancements

- Breakpoint resume support (already in protocol)
- Firmware version reporting from BES
- BT name/address configuration during update
- Rollback to backup firmware
- Progress reporting via socket to mobile app
