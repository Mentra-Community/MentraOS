# OTA Updater v2 Improvements

## 1. Unified Backup Strategy for Both Apps

### Current Issue

Only OTA updater creates backups before self-update. ASG client updates don't create backups.

### Improved Code for OtaHelper.java

```java
// Generic backup creation for any app
private void createAppBackup(String packageName) {
    try {
        PackageInfo info = context.getPackageManager().getPackageInfo(packageName, 0);
        String sourceApk = info.applicationInfo.sourceDir;

        // Determine backup filename
        String backupFilename = packageName.equals("com.mentra.asg_client")
            ? "asg_client_backup.apk"
            : "ota_updater_backup.apk";

        File backupFile = new File(BASE_DIR, backupFilename);
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

        Log.i(TAG, "Created backup for " + packageName + " at: " + backupFile.getAbsolutePath());
    } catch (Exception e) {
        Log.e(TAG, "Failed to create backup for " + packageName, e);
    }
}

// Updated checkAndUpdateApp to always create backups
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
            // ALWAYS create backup before ANY update
            createAppBackup(packageName);

            // Install
            installApk(context, new File(BASE_DIR, filename).getAbsolutePath());
        }
    }
}
```

## 2. Sequential Update Processing

### Current Issue

Both apps might try to download updates simultaneously, overwhelming the slow WiFi antenna.

### Improved Sequential Update Logic

```java
// In OtaHelper.java - process updates one at a time
private boolean isUpdateInProgress = false;
private final Object updateLock = new Object();

private void startVersionCheck(Context context) {
    // Existing WiFi/battery checks...

    synchronized (updateLock) {
        if (isUpdateInProgress) {
            Log.d(TAG, "Update already in progress, skipping version check");
            return;
        }
    }

    try {
        // Fetch version info
        String versionInfo = fetchVersionInfo(Constants.VERSION_URL);
        JSONObject json = new JSONObject(versionInfo);

        // Check if new format (multiple apps) or legacy format
        if (json.has("apps")) {
            // New format - process sequentially
            processAppsSequentially(json.getJSONObject("apps"));
        } else {
            // Legacy format - only ASG client
            synchronized (updateLock) {
                isUpdateInProgress = true;
            }
            try {
                checkAndUpdateApp("com.mentra.asg_client", json);
            } finally {
                synchronized (updateLock) {
                    isUpdateInProgress = false;
                }
            }
        }
    } catch (Exception e) {
        Log.e(TAG, "Version check failed", e);
    }
}

private void processAppsSequentially(JSONObject apps) throws Exception {
    // Process apps in order - important for sequential updates
    String[] orderedPackages = {
        "com.mentra.asg_client",     // Update ASG client first
        "com.augmentos.otaupdater"      // Then OTA updater
    };

    for (String packageName : orderedPackages) {
        if (!apps.has(packageName)) continue;

        JSONObject appInfo = apps.getJSONObject(packageName);

        // Check if update needed
        long currentVersion = 0;
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(packageName, 0);
            currentVersion = info.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            continue; // App not installed, skip
        }

        long serverVersion = appInfo.getLong("versionCode");

        if (serverVersion > currentVersion) {
            // Update needed
            Log.i(TAG, "Processing update for " + packageName + " (sequential mode)");

            synchronized (updateLock) {
                isUpdateInProgress = true;
            }

            try {
                checkAndUpdateApp(packageName, appInfo);

                // After successful update, continue to next app immediately
                Log.i(TAG, "Completed update for " + packageName + ", checking next app...");

                // Add a small delay to let the system settle after installation
                Thread.sleep(5000); // 5 seconds between updates

            } finally {
                synchronized (updateLock) {
                    isUpdateInProgress = false;
                }
            }

            // Continue loop to check next app immediately
        }
    }

    Log.d(TAG, "All apps are up to date");
}
```

### Alternative: Ordered JSON Approach

If you prefer order defined in version.json:

```json
{
  "apps": [
    {
      "packageName": "com.mentra.asg_client",
      "versionCode": 6,
      "apkUrl": "https://...",
      "sha256": "..."
    },
    {
      "packageName": "com.augmentos.otaupdater",
      "versionCode": 2,
      "apkUrl": "https://...",
      "sha256": "..."
    }
  ]
}
```

Then process as array instead of object to maintain order.

## 3. Foreground Service Migration Plan

### For OTA Updater v2

Add this note to the implementation:

```java
/**
 * TODO for OTA Updater v2:
 * Migrate from Activity-based architecture to Foreground Service
 *
 * Issues with current Activity approach:
 * - Can be killed by system at any time
 * - Downloads interrupted when activity dies
 * - Heartbeat monitoring stops if activity is destroyed
 * - No protection from Android resource management
 *
 * Migration plan:
 * 1. Create OtaUpdaterService extends Service
 * 2. Move all functionality from MainActivity to service
 * 3. Use startForeground() with notification
 * 4. MainActivity becomes thin UI layer only
 * 5. Service handles:
 *    - Heartbeat monitoring
 *    - Version checks
 *    - Downloads
 *    - Battery monitoring
 *
 * ASG Client can start the service with:
 * Intent serviceIntent = new Intent();
 * serviceIntent.setClassName("com.augmentos.otaupdater",
 *                           "com.augmentos.otaupdater.OtaUpdaterService");
 * startForegroundService(serviceIntent);
 */
```

### In OtaUpdaterManager.java

```java
// Add method to start OTA Updater as service (for v2)
private void startOtaUpdaterService() {
    try {
        // For v2+ with foreground service
        Intent serviceIntent = new Intent();
        serviceIntent.setClassName(OTA_UPDATER_PACKAGE,
                                  OTA_UPDATER_PACKAGE + ".OtaUpdaterService");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent);
        } else {
            context.startService(serviceIntent);
        }

        Log.d(TAG, "Started OTA updater service");
    } catch (Exception e) {
        Log.e(TAG, "Failed to start OTA updater service, falling back to activity", e);
        launchOtaUpdater(); // Fall back to activity
    }
}
```

## Benefits of These Changes

1. **Unified Backup Strategy**
   - Both apps get backed up before updates
   - Consistent recovery mechanism
   - Simpler, shared code

2. **Sequential Updates**
   - Never overwhelm slow WiFi with concurrent downloads
   - Predictable update order
   - Better reliability on constrained devices

3. **FGS Migration Path**
   - Clear plan for fixing Activity-based issues
   - ASG client ready to start service when available
   - Proper architecture for critical system component

## Implementation Priority

1. **First**: Sequential updates (immediate benefit for slow WiFi)
2. **Second**: Unified backup (improves recovery)
3. **Third**: FGS migration (requires new OTA updater version)
