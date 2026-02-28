# Backup APK Strategy for OTA Updates

## Current State

- **ASG Client Backup**: `/storage/emulated/0/asg/asg_client_backup.apk`
- **OTA Updater Backup**: Not implemented
- **Backup Creation**: Manual (no automatic backup on successful update)

## Proposed Backup Implementation

### 1. Storage Locations

```
/storage/emulated/0/asg/
├── asg_client_backup.apk          # Current ASG client backup
├── ota_updater_backup.apk         # New: OTA updater backup
├── update.apk                     # Temporary download location
└── metadata.json                  # Version tracking
```

### 2. Automatic Backup Creation

#### In ASG Client (for OTA Updater backup)

```java
// Before updating OTA updater
private boolean createOtaUpdaterBackup() {
    try {
        PackageInfo info = getPackageManager().getPackageInfo(
            "com.augmentos.otaupdater", 0);
        String sourceApk = info.applicationInfo.sourceDir;

        File backupFile = new File(BASE_DIR, "ota_updater_backup.apk");
        File sourceFile = new File(sourceApk);

        // Copy current APK to backup location
        Files.copy(sourceFile.toPath(), backupFile.toPath(),
                   StandardCopyOption.REPLACE_EXISTING);

        Log.i(TAG, "OTA updater backup created: " + backupFile.getAbsolutePath());
        return true;
    } catch (Exception e) {
        Log.e(TAG, "Failed to create OTA updater backup", e);
        return false;
    }
}
```

#### In OTA Updater (for ASG Client backup)

```java
// After successful ASG client update
private void updateBackupAfterSuccess(String packageName) {
    if ("com.mentra.asg_client".equals(packageName)) {
        try {
            // Wait for installation to complete
            Thread.sleep(5000);

            PackageInfo info = getPackageManager().getPackageInfo(packageName, 0);
            String sourceApk = info.applicationInfo.sourceDir;

            File backupFile = new File(BACKUP_APK_PATH);
            Files.copy(new File(sourceApk).toPath(), backupFile.toPath(),
                      StandardCopyOption.REPLACE_EXISTING);

            Log.i(TAG, "Updated ASG client backup after successful update");
        } catch (Exception e) {
            Log.e(TAG, "Failed to update backup", e);
        }
    }
}
```

### 3. Recovery Procedures

#### ASG Client Recovery (exists)

- Triggered by: OTA updater when heartbeat fails
- Uses: `/storage/emulated/0/asg/asg_client_backup.apk`
- Method: `OtaHelper.reinstallApkFromBackup()`

#### OTA Updater Recovery (new)

```java
// In ASG client
public void recoverOtaUpdater() {
    File backupApk = new File(BASE_DIR, "ota_updater_backup.apk");

    if (!backupApk.exists()) {
        Log.e(TAG, "No OTA updater backup available");
        return;
    }

    try {
        // Verify backup APK
        PackageInfo info = getPackageManager().getPackageArchiveInfo(
            backupApk.getAbsolutePath(), PackageManager.GET_ACTIVITIES);

        if (info != null && info.packageName.equals("com.augmentos.otaupdater")) {
            // Install backup
            Intent intent = new Intent("com.xy.xsetting.action");
            intent.setPackage("com.android.systemui");
            intent.putExtra("cmd", "install");
            intent.putExtra("pkpath", backupApk.getAbsolutePath());
            sendBroadcast(intent);

            Log.i(TAG, "OTA updater recovery initiated");
        }
    } catch (Exception e) {
        Log.e(TAG, "Failed to recover OTA updater", e);
    }
}
```

### 4. Initial Backup Deployment

For the 400 beta devices without backups:

#### Option A: Include in Next Update

```java
// In ASG client v6 onCreate()
private void ensureInitialBackups() {
    File asgBackup = new File(BACKUP_APK_PATH);
    File otaBackup = new File(BASE_DIR, "ota_updater_backup.apk");

    // Create ASG client backup if missing
    if (!asgBackup.exists()) {
        createSelfBackup();
    }

    // Create OTA updater backup if missing
    if (!otaBackup.exists()) {
        createOtaUpdaterBackup();
    }
}
```

#### Option B: Download from Server

```java
// Download known-good versions as backups
private void downloadInitialBackups() {
    if (!new File(BACKUP_APK_PATH).exists()) {
        downloadBackup("asg_client_v5_backup.apk", BACKUP_APK_PATH);
    }

    if (!new File(OTA_BACKUP_PATH).exists()) {
        downloadBackup("ota_updater_v1_backup.apk", OTA_BACKUP_PATH);
    }
}
```

### 5. Best Practices

1. **Create backup BEFORE update attempt**
2. **Verify backup after creation** (check it's readable and valid)
3. **Update backup AFTER successful update** (keep latest working version)
4. **Never delete backups** unless replacing with newer working version
5. **Include version info in metadata.json** for backup tracking

### 6. Emergency Recovery Commands

For manual intervention via ADB:

```bash
# Check backup status
adb shell ls -la /storage/emulated/0/asg/

# Manual backup creation
adb shell cp /data/app/com.mentra.asg_client*/base.apk /storage/emulated/0/asg/asg_client_backup.apk
adb shell cp /data/app/com.augmentos.otaupdater*/base.apk /storage/emulated/0/asg/ota_updater_backup.apk

# Trigger recovery
adb shell am broadcast -a com.augmentos.RECOVER_ASG_CLIENT
adb shell am broadcast -a com.augmentos.RECOVER_OTA_UPDATER
```

This backup strategy ensures both apps can be recovered if updates fail, maintaining the mutual support architecture.
