# Complete OTA Update System Flow

## Overview

This document shows how all the pieces work together for the new OTA update system.

## Initial Deployment Flow (Updating OTA Updater to v2)

1. **Deploy ASG Client v6** (with OTA Updater v2 APK in assets)
   - Current OTA Updater (v1) downloads and installs ASG Client v6 normally
2. **ASG Client v6 boots**
   - OtaUpdaterManager initializes
   - Registers PackageInstallReceiver
   - After 5 seconds, checks OTA updater version
3. **OTA Updater v1 detected** (versionCode < 2)
   - ASG Client extracts v2 APK from assets to `/storage/emulated/0/asg/ota_updater.apk`
   - Sends install broadcast to system
4. **System updates OTA Updater to v2**
   - Same package name, just newer versionCode
   - PackageInstallReceiver detects the update
   - Automatically launches the updated OTA Updater
5. **OTA Updater v2 starts**
   - Now runs as Foreground Service (not Activity)
   - Uses new multi-app version.json format
   - Can update both itself and ASG Client
   - Has retry logic and proper error handling

## Ongoing Update Flows

### ASG Client Update

1. OTA Updater checks version.json every 30 mins
2. Detects new ASG Client version
3. Downloads, verifies, installs as before
4. ASG Client restarts automatically (it's the launcher)

### OTA Updater Self-Update

1. OTA Updater checks version.json
2. Detects newer version of itself
3. Creates backup at `/storage/emulated/0/asg/ota_updater_backup.apk`
4. Downloads new version to `ota_updater_update.apk`
5. Sends install broadcast to system
6. System replaces OTA Updater
7. ASG Client's PackageInstallReceiver detects the update
8. Automatically launches new OTA Updater

## Recovery Scenarios

### OTA Updater Missing/Corrupted

- ASG Client detects on every boot
- Redeploys from bundled assets
- PackageInstallReceiver launches it

### ASG Client Fails

- OTA Updater's RecoveryWorker detects via heartbeat
- Reinstalls from `/storage/emulated/0/asg/asg_client_backup.apk`
- System restarts ASG Client (it's the launcher)

### Both Apps Fail

- Device is effectively bricked
- No user recovery possible
- This is why the code must be bulletproof

## Version.json Evolution

### Current (Legacy)

```json
{
  "versionCode": 5,
  "apkUrl": "https://...",
  "sha256": "..."
}
```

### New (Multi-App)

```json
{
  "apps": {
    "com.mentra.asg_client": {
      "versionCode": 6,
      "apkUrl": "https://...",
      "sha256": "..."
    },
    "com.augmentos.otaupdater": {
      "versionCode": 2,
      "apkUrl": "https://...",
      "sha256": "..."
    }
  }
}
```

### Transition Strategy

- OTA Updater v2 supports both formats
- Use legacy format until most devices have v2
- Then switch to new format

## File System Layout

```
/storage/emulated/0/asg/
├── update.apk                    # ASG Client updates
├── ota_updater_update.apk        # OTA Updater self-updates
├── asg_client_backup.apk         # ASG Client backup
├── ota_updater_backup.apk        # OTA Updater backup
├── ota_updater.apk           # Temporary during initial deployment
└── metadata.json                 # Version tracking
```

## Key Design Decisions

1. **Bundle in Assets**: Guarantees v2 deployment without network dependency
2. **Package Monitoring**: Enables immediate restart after self-update
3. **Mutual Recovery**: Each app can fix the other
4. **System Broadcast**: Leverages ODM's installer for all updates
5. **No Hash Verification**: Trust assets, simplify code

This architecture ensures reliable updates while maintaining the ability to recover from most failure scenarios.
