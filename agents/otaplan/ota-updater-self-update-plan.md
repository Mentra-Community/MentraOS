# OTA Updater Self-Update Plan - Leveraging Existing Logic

## Revised Approach: Extend OTA Updater to Update Both Apps

You're right - duplicating the update check logic would be inefficient and error-prone. Instead, let's extend the existing OTA updater to handle both apps.

## Current OTA Updater Logic

- Initial check: 15 seconds after start
- Periodic checks: Every 30 minutes
- WiFi triggers: Checks when WiFi becomes available
- Battery constraints: Won't update if battery < 5%

## Proposed Changes

### 1. Enhanced version.json

```json
{
  "apps": {
    "com.mentra.asg_client": {
      "versionCode": 6,
      "apkUrl": "...",
      "sha256": "..."
    },
    "com.augmentos.otaupdater": {
      "versionCode": 2,
      "apkUrl": "...",
      "sha256": "..."
    }
  }
}
```

### 2. Modify OtaHelper.java

```java
// In startVersionCheck method, check both apps
private void checkForUpdates() {
    try {
        JSONObject versionInfo = fetchVersionInfo();
        JSONObject apps = versionInfo.getJSONObject("apps");

        // Check each app
        for (Iterator<String> it = apps.keys(); it.hasNext(); ) {
            String packageName = it.next();
            JSONObject appInfo = apps.getJSONObject(packageName);

            checkAndUpdateApp(packageName, appInfo);
        }
    } catch (Exception e) {
        Log.e(TAG, "Update check failed", e);
    }
}

private void checkAndUpdateApp(String packageName, JSONObject appInfo) {
    try {
        int currentVersion = getInstalledVersion(packageName);
        int serverVersion = appInfo.getInt("versionCode");

        if (serverVersion > currentVersion) {
            // Special handling for self-update
            if (packageName.equals(context.getPackageName())) {
                handleSelfUpdate(appInfo);
            } else {
                // Normal update flow
                downloadAndInstall(packageName, appInfo);
            }
        }
    } catch (Exception e) {
        Log.e(TAG, "Failed to check " + packageName, e);
    }
}

private void handleSelfUpdate(JSONObject appInfo) {
    // For self-update, we need ASG client's help
    Intent updateRequest = new Intent("com.mentra.asg_client.UPDATE_OTA_UPDATER");
    updateRequest.setPackage("com.mentra.asg_client");
    updateRequest.putExtra("apkUrl", appInfo.getString("apkUrl"));
    updateRequest.putExtra("sha256", appInfo.getString("sha256"));
    updateRequest.putExtra("versionCode", appInfo.getInt("versionCode"));
    context.sendBroadcast(updateRequest);

    Log.i(TAG, "Requested ASG client to update OTA updater");
}
```

### 3. ASG Client Side - Simple Receiver

```java
// In ASG client - just a simple broadcast receiver
public class OtaUpdaterUpdateReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if ("com.mentra.asg_client.UPDATE_OTA_UPDATER".equals(intent.getAction())) {
            // Download and install OTA updater update
            String apkUrl = intent.getStringExtra("apkUrl");
            String sha256 = intent.getStringExtra("sha256");

            // Use same installation mechanism
            downloadAndInstallOtaUpdater(apkUrl, sha256);
        }
    }
}
```

## Benefits of This Approach

1. **Single Source of Truth**: All update logic remains in OTA updater
2. **Reuses Existing Logic**: WiFi checks, battery checks, periodic scheduling all work
3. **Minimal ASG Client Changes**: Just adds a broadcast receiver
4. **Maintains Architecture**: Each app still has its specific role
5. **Backwards Compatible**: Old version.json format can be supported

## Migration Path

1. **Phase 1**: Deploy ASG client v6 with the broadcast receiver
2. **Phase 2**: Update version.json to new format
3. **Phase 3**: Deploy OTA updater v2 that checks both apps

## Fallback for Legacy Devices

For devices that don't update ASG client first:

```json
{
  // New format for updated devices
  "apps": { ... },

  // Legacy format for old OTA updaters
  "versionCode": 6,
  "apkUrl": "...",  // Points to ASG client
  "sha256": "..."
}
```

## Implementation Timeline

1. **Week 1**: Add broadcast receiver to ASG client
2. **Week 2**: Modify OTA updater to check multiple apps
3. **Week 3**: Test with both old and new version.json formats
4. **Week 4**: Deploy to beta devices

This approach leverages the existing, tested update logic while adding multi-app support with minimal changes.
