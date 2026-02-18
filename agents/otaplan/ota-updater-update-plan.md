# OTA Updater Update Plan - ASG Client as Updater

## Decision: Option 2 - ASG Client Updates OTA Updater

Your architectural insight is spot on - keeping these apps separate with mutual recovery capability is the right design. Having ASG client update the OTA updater maintains this separation while leveraging the more stable app for the update process.

## Architecture Benefits

- **Mutual Recovery**: Each app can fix the other if it fails
- **Separation of Concerns**: OTA updater focuses on updating ASG client, ASG client handles OTA updater updates
- **Reliability**: ASG client is likely more stable than the "jank" OTA updater
- **No Self-Surgery**: Avoids risky self-update scenarios

## Implementation Plan

### Phase 0: Initial Deployment Strategy - Getting OTA Updater v2 Installed

**Challenge**: How do we get the first OTA Updater v2 onto 400 devices running OTA Updater v1?

**Option 1: Bundle in ASG Client Assets** (Recommended)
**BONUS: This doubles as the recovery mechanism!**

```java
// In AsgClientService.java

private static final String OTA_UPDATER_PACKAGE = "com.augmentos.otaupdater";

@Override
public void onCreate() {
    super.onCreate();

    // Existing initialization...

    // Ensure OTA updater v2 before launching it
    new Handler(Looper.getMainLooper()).postDelayed(() -> {
        ensureOtaUpdaterV2();
    }, 5000);
}

private void ensureOtaUpdaterV2() {
    try {
        int currentVersion = getInstalledVersion(OTA_UPDATER_PACKAGE);

        // Deploy/recover if: not installed (-1), version 1, or corrupted
        if (currentVersion == -1 || currentVersion < 2) {
            Log.i(TAG, "OTA Updater needs deployment/recovery. Version: " + currentVersion);

            // Extract from assets
            InputStream assetStream = getAssets().open("ota_updater.apk");
            File otaV2File = new File("/storage/emulated/0/asg/ota_updater.apk");

            // Copy to filesystem
            try (FileOutputStream fos = new FileOutputStream(otaV2File)) {
                byte[] buffer = new byte[8192];
                int bytesRead;
                while ((bytesRead = assetStream.read(buffer)) != -1) {
                    fos.write(buffer, 0, bytesRead);
                }
            }
            assetStream.close();

            // Install using system broadcast
            Intent intent = new Intent("com.xy.xsetting.action");
            intent.setPackage("com.android.systemui");
            intent.putExtra("cmd", "install");
            intent.putExtra("pkpath", otaV2File.getAbsolutePath());
            sendBroadcast(intent);

            Log.i(TAG, "Installing OTA Updater v2");

            // Wait for installation then launch
            new Handler().postDelayed(() -> {
                launchOtaUpdater();
            }, 15000);
        } else {
            // Current version is v2 or higher, just launch it
            launchOtaUpdater();
        }
    } catch (Exception e) {
        Log.e(TAG, "Failed to ensure OTA updater v2", e);
        launchOtaUpdater(); // Try to launch whatever exists
    }
}

private void launchOtaUpdater() {
    try {
        Intent otaIntent = new Intent();
        otaIntent.setClassName(OTA_UPDATER_PACKAGE, OTA_UPDATER_PACKAGE + ".MainActivity");
        otaIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(otaIntent);
        Log.d(TAG, "Launched OTA updater");
    } catch (Exception e) {
        Log.e(TAG, "Failed to launch OTA updater", e);
    }
}

private int getInstalledVersion(String packageName) {
    try {
        PackageInfo info = getPackageManager().getPackageInfo(packageName, 0);
        return info.versionCode;
    } catch (PackageManager.NameNotFoundException e) {
        return -1; // Not installed
    } catch (Exception e) {
        Log.e(TAG, "Error getting package version", e);
        return -1;
    }
}
```

**This mechanism handles:**

- **Initial deployment**: Upgrades v1 → v2 on first ASG client v6 boot
- **Missing app recovery**: Reinstalls if OTA updater completely missing
- **Corruption recovery**: Reinstalls if OTA updater fails to start
- **Always available**: ASG client carries a known-good copy in assets

**Option 2: Immediate version.json Update** (Riskier)

- Post OTA Updater v2 in current version.json
- OTA Updater v1 tries to self-update immediately
- Risk: If v1's self-update fails, no recovery

**Recommendation**: Use Option 1 with assets bundling for guaranteed deployment, then switch to version.json updates for future versions.

### Phase 1: Enhanced version.json Structure

```json
{
  "asgClient": {
    "versionCode": 6,
    "apkUrl": "https://github.com/Mentra-Community/MentraOS/releases/...",
    "sha256": "..."
  },
  "otaUpdater": {
    "versionCode": 2,
    "packageName": "com.augmentos.otaupdater",
    "apkUrl": "https://github.com/Mentra-Community/MentraOS/releases/...",
    "sha256": "...",
    "minAsgClientVersion": 6
  }
}
```

### Phase 2: OTA Updater Code - Self-Update Support

**Key insight**: Since the ODM's system service handles the actual installation, the OTA updater CAN update itself. After update, ASG client will restart it.

#### Enhanced version.json format:

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

#### Code changes in OtaHelper.java:

```java
// Modified startVersionCheck to handle multiple apps
private void startVersionCheck(Context context) {
    // Existing WiFi/battery checks...

    try {
        // Fetch version info
        String versionInfo = fetchVersionInfo(Constants.VERSION_URL);
        JSONObject json = new JSONObject(versionInfo);

        // Check if new format (multiple apps) or legacy format
        if (json.has("apps")) {
            // New format - check all apps
            JSONObject apps = json.getJSONObject("apps");
            for (Iterator<String> it = apps.keys(); it.hasNext(); ) {
                String packageName = it.next();
                JSONObject appInfo = apps.getJSONObject(packageName);
                checkAndUpdateApp(packageName, appInfo);
            }
        } else {
            // Legacy format - only ASG client
            checkAndUpdateApp("com.mentra.asg_client", json);
        }
    } catch (Exception e) {
        Log.e(TAG, "Version check failed", e);
    }
}

private void checkAndUpdateApp(String packageName, JSONObject appInfo) throws Exception {
    // Get current version
    long currentVersion = 0;
    try {
        PackageInfo info = context.getPackageManager().getPackageInfo(packageName, 0);
        currentVersion = info.versionCode;
    } catch (PackageManager.NameNotFoundException e) {
        Log.d(TAG, packageName + " not installed");
        return;
    }

    // Check server version
    long serverVersion = appInfo.getLong("versionCode");

    if (serverVersion > currentVersion) {
        Log.d(TAG, "New version available for " + packageName);
        String apkUrl = appInfo.getString("apkUrl");

        // Determine filename based on package
        String filename = packageName.equals(context.getPackageName())
            ? "ota_updater_update.apk"
            : "update.apk";

        boolean downloadOk = downloadApk(apkUrl, appInfo, context, filename);
        if (downloadOk) {
            // Create backup before self-update
            if (packageName.equals(context.getPackageName())) {
                createSelfBackup();
            }

            // Install (same method for all apps)
            installApk(context, new File(BASE_DIR, filename).getAbsolutePath());

            // Note: After self-update, ASG client will restart us
        }
    }
}

private void createSelfBackup() {
    try {
        PackageInfo info = context.getPackageManager().getPackageInfo(
            context.getPackageName(), 0);
        String sourceApk = info.applicationInfo.sourceDir;

        File backupFile = new File(BASE_DIR, "ota_updater_backup.apk");
        File sourceFile = new File(sourceApk);

        // Simple file copy
        FileInputStream fis = new FileInputStream(sourceFile);
        FileOutputStream fos = new FileOutputStream(backupFile);
        byte[] buffer = new byte[8192];
        int bytesRead;
        while ((bytesRead = fis.read(buffer)) != -1) {
            fos.write(buffer, 0, bytesRead);
        }
        fis.close();
        fos.close();

        Log.i(TAG, "Created self backup at: " + backupFile.getAbsolutePath());
    } catch (Exception e) {
        Log.e(TAG, "Failed to create self backup", e);
    }
}

// Modified downloadApk to accept custom filename
public boolean downloadApk(String urlStr, JSONObject json, Context context, String filename) {
    try {
        File asgDir = new File(BASE_DIR);
        if (!asgDir.exists()) {
            asgDir.mkdirs();
        }

        File apkFile = new File(asgDir, filename);
        // ... rest of download logic unchanged
    }
    // ... rest unchanged
}
```

**Key changes:**

1. Support both legacy (single app) and new (multiple apps) version.json formats
2. Check and update multiple apps including itself
3. Create backup before self-update
4. Use different filenames to avoid conflicts
5. Rely on ASG client to restart after self-update

````

### Phase 3: Clean Architecture with OtaUpdaterManager

Create a separate `OtaUpdaterManager` class to handle all OTA-related functionality:

```java
// In AsgClientService.java - simplified
public class AsgClientService extends Service {
    private OtaUpdaterManager otaUpdaterManager;

    @Override
    public void onCreate() {
        super.onCreate();

        // Initialize OTA updater manager
        otaUpdaterManager = new OtaUpdaterManager(this);
        otaUpdaterManager.initialize();
    }

    @Override
    public void onDestroy() {
        if (otaUpdaterManager != null) {
            otaUpdaterManager.cleanup();
        }
        super.onDestroy();
    }
}
````

**Key Features of OtaUpdaterManager:**

1. **Package Install Monitoring**: Detects when OTA updater is installed/updated and automatically launches it
2. **Self-Contained Logic**: All OTA-related code in one place
3. **Automatic Recovery**: Handles deployment, updates, and recovery scenarios
4. **Immediate Restart**: After self-update, the new OTA updater launches immediately (no reboot needed)

See `ota-updater-manager-code.md` for complete implementation.

### Phase 4: Safety Mechanisms

1. **Version Tracking**

   ```java
   // Track update attempts to prevent loops
   SharedPreferences prefs = getSharedPreferences("ota_updater_updates", MODE_PRIVATE);
   int updateAttempts = prefs.getInt("update_attempts_v2", 0);
   long lastAttemptTime = prefs.getLong("last_attempt_time", 0);
   ```

2. **Backup Preservation**

   ```java
   // Keep backup of current OTA updater before update
   File currentApk = getApkFile(OTA_UPDATER_PACKAGE);
   File backupApk = new File("/storage/emulated/0/asg/ota_updater_backup.apk");
   copyFile(currentApk, backupApk);
   ```

3. **Rollback Capability**
   ```java
   // If new OTA updater fails to start, reinstall backup
   if (!isOtaUpdaterHealthy()) {
       installApk(backupApk.getAbsolutePath());
   }
   ```

### Phase 5: OTA Updater v2 Improvements

The new OTA updater should include:

1. **Retry Logic**: Exponential backoff for failed downloads
2. **Better Error Handling**: Don't crash on failures
3. **Health Reporting**: Broadcast status to ASG client
4. **Self-Healing**: Ability to request reinstall from ASG client

## Migration Timeline

1. **Week 1**: Implement OtaUpdaterManager in ASG client
2. **Week 2**: Create improved OTA updater v2 with retry logic
3. **Week 3**: Test on development devices
4. **Week 4**: Deploy ASG client v6 to beta devices
5. **Week 5**: Monitor and verify OTA updater updates
6. **Week 6**: Full rollout if successful

## Rollback Plan

If issues arise:

1. ASG client keeps functioning normally (update code is try-catch wrapped)
2. Old OTA updater continues working if update fails
3. Backup APK available for manual recovery
4. Version.json can be reverted to stop updates

## Success Criteria

- OTA updater successfully updates from v1 to v2
- New retry logic reduces update failures by 80%
- No devices bricked during migration
- Both apps maintain ability to update each other

## Long-term Benefits

1. **Sustainable Updates**: Both apps can now be updated reliably
2. **Maintained Architecture**: Separation of concerns preserved
3. **Future Flexibility**: Can iterate on either app independently
4. **Beta Testing**: Can test new OTA updater versions on subset of devices

## CRITICAL WARNING: No User Recovery

**IMPORTANT**: These are consumer smart glasses worn by non-technical users. There is NO way for end users to recover via ADB or any manual intervention. If our code fails, the device is effectively bricked for that user.

**This means:**

- Every update MUST be thoroughly tested
- Failure modes MUST be handled gracefully
- Backup mechanisms MUST be bulletproof
- We CANNOT fuck up - there's no second chance

The stakes are high: 400 devices in the field with no physical access and no technical users to help with recovery.
