# Retry Logic and Storage Management

## 1. Download Retry Strategy

### Current Issue

No retry logic - if download fails, it just stops.

### Proposed Implementation

```java
// In OtaHelper.java - add retry logic to downloadApk method

private static final int MAX_DOWNLOAD_RETRIES = 3;
private static final long[] RETRY_DELAYS = {30000, 60000, 120000}; // 30s, 1m, 2m

public boolean downloadApk(String urlStr, JSONObject json, Context context, String filename) {
    int retryCount = 0;
    Exception lastException = null;

    while (retryCount < MAX_DOWNLOAD_RETRIES) {
        try {
            // Existing download logic...
            if (downloadApkInternal(urlStr, json, context, filename)) {
                return true; // Success!
            }
        } catch (Exception e) {
            lastException = e;
            Log.e(TAG, "Download attempt " + (retryCount + 1) + " failed", e);

            // Clean up partial download
            File partialFile = new File(BASE_DIR, filename);
            if (partialFile.exists()) {
                partialFile.delete();
            }

            retryCount++;
            if (retryCount < MAX_DOWNLOAD_RETRIES) {
                long delay = RETRY_DELAYS[Math.min(retryCount - 1, RETRY_DELAYS.length - 1)];
                Log.i(TAG, "Retrying download in " + (delay / 1000) + " seconds...");

                try {
                    Thread.sleep(delay);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
    }

    Log.e(TAG, "Download failed after " + MAX_DOWNLOAD_RETRIES + " attempts", lastException);
    EventBus.getDefault().post(new DownloadProgressEvent(
        DownloadProgressEvent.DownloadStatus.FAILED,
        "Failed after " + MAX_DOWNLOAD_RETRIES + " attempts"
    ));
    return false;
}

// Alternative: Use DownloadManager API for more robust downloads
private void downloadWithDownloadManager(String url, String filename) {
    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
    request.setDestinationInExternalPublicDir("/asg", filename);
    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
    request.setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI);
    request.setTitle("OTA Update");
    request.setDescription("Downloading " + filename);

    DownloadManager downloadManager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
    long downloadId = downloadManager.enqueue(request);

    // Monitor download progress...
}
```

## 2. Storage Management Strategy

### Current Issue

We create backups for every update, which will eventually fill up storage.

### Proposed Solution

```java
// In OtaHelper.java - add storage management

private static final long MIN_FREE_SPACE_MB = 500; // 500MB minimum
private static final int MAX_BACKUP_VERSIONS = 2; // Keep only 2 backups

private void createAppBackup(String packageName, Context context) {
    try {
        // Check available storage first
        if (!hasEnoughStorage()) {
            Log.w(TAG, "Low storage, cleaning up old files");
            cleanupOldFiles();
        }

        // Rotate backups (keep only last 2)
        rotateBackups(packageName);

        // Create new backup (existing code)...

    } catch (Exception e) {
        Log.e(TAG, "Failed to create backup", e);
    }
}

private boolean hasEnoughStorage() {
    File asgDir = new File(BASE_DIR);
    StatFs stat = new StatFs(asgDir.getPath());
    long availableBytes = stat.getAvailableBytes();
    long availableMB = availableBytes / (1024 * 1024);
    return availableMB >= MIN_FREE_SPACE_MB;
}

private void cleanupOldFiles() {
    File asgDir = new File(BASE_DIR);

    // Delete old APK files (except backups)
    File[] files = asgDir.listFiles((dir, name) ->
        name.endsWith(".apk") &&
        !name.contains("backup") &&
        !name.equals("update.apk") &&
        !name.equals("ota_updater_update.apk")
    );

    if (files != null) {
        // Sort by last modified (oldest first)
        Arrays.sort(files, (f1, f2) -> Long.compare(f1.lastModified(), f2.lastModified()));

        // Delete oldest files until we have enough space
        for (File file : files) {
            if (hasEnoughStorage()) break;

            Log.i(TAG, "Deleting old file: " + file.getName());
            file.delete();
        }
    }
}

private void rotateBackups(String packageName) {
    String backupBaseName = packageName.equals("com.mentra.asg_client")
        ? "asg_client_backup"
        : "ota_updater_backup";

    // Rename existing backups
    // backup.apk -> backup.1.apk
    // backup.1.apk -> backup.2.apk
    // Delete backup.2.apk if exists

    File backup2 = new File(BASE_DIR, backupBaseName + ".2.apk");
    if (backup2.exists()) {
        backup2.delete();
    }

    File backup1 = new File(BASE_DIR, backupBaseName + ".1.apk");
    if (backup1.exists()) {
        backup1.renameTo(backup2);
    }

    File backup = new File(BASE_DIR, backupBaseName + ".apk");
    if (backup.exists()) {
        backup.renameTo(backup1);
    }
}

// Clean up after successful installation
private void cleanupAfterInstall(String packageName) {
    // Delete the update APK after successful install
    String filename = packageName.equals(context.getPackageName())
        ? "ota_updater_update.apk"
        : "update.apk";

    File updateFile = new File(BASE_DIR, filename);
    if (updateFile.exists()) {
        updateFile.delete();
        Log.d(TAG, "Deleted update file: " + filename);
    }
}
```

## 3. Complete Storage Layout

```
/storage/emulated/0/asg/
├── update.apk                    # Current ASG client update (deleted after install)
├── ota_updater_update.apk        # Current OTA updater update (deleted after install)
├── asg_client_backup.apk         # Most recent ASG backup
├── asg_client_backup.1.apk       # Previous ASG backup
├── ota_updater_backup.apk        # Most recent OTA backup
├── ota_updater_backup.1.apk      # Previous OTA backup
├── ota_updater.apk           # Temporary (deleted after v2 deployed)
└── metadata.json                 # Version tracking
```

## 4. Implementation Priority

1. **Storage cleanup** - Critical to prevent devices from filling up
2. **Retry logic** - Important for reliability on poor connections
3. **DownloadManager migration** - Nice to have for better download handling

## 5. Quick Wins

For immediate implementation without major changes:

```java
// Add to checkAndUpdateApp in OtaHelper.java
if (downloadOk) {
    // Install
    installApk(context, apkFile.getAbsolutePath());

    // Clean up download file after 30 seconds
    new Handler().postDelayed(() -> {
        if (apkFile.exists()) {
            apkFile.delete();
            Log.d(TAG, "Cleaned up update file: " + apkFile.getName());
        }
    }, 30000);

    return true;
}
```

This prevents accumulation of update files while keeping the architecture simple.
