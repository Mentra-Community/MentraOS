# OTA Phone-Controlled Updates Implementation Plan

## Overview

Modify the OTA update system to support two modes of operation:

1. **Onboarding Mode (Phone-Initiated)**: Phone checks for updates directly (using existing `fetchVersionInfo()`), user approves, phone tells glasses to start OTA
2. **Background Mode (Glasses-Initiated)**: Glasses detect update available + WiFi + phone connected, notify phone, user approves, glasses start OTA

When glasses are NOT connected to phone via BLE, existing auto-OTA behavior continues unchanged.

## Goals

- Support the onboarding UX flow: Check → "Update Available" prompt → Download/Install with progress
- Support background updates: Glasses notify phone → Prompt user → Download/Install with progress
- Send real-time OTA progress to phone for UI display
- Maintain existing auto-OTA when phone is not connected
- Minimal changes to the stable, critical OTA infrastructure
- **Leverage existing phone-side version check** (`OtaUpdateChecker.tsx`) to avoid redundant glasses→phone roundtrips

## Key Simplification: Phone Does Version Check Directly

The mobile app already has version checking logic in `mobile/src/effects/OtaUpdateChecker.tsx`:

```typescript
// Existing functions we can reuse:
fetchVersionInfo(url) // Fetches version.json from server
isUpdateAvailable(build, json) // Compares versions
getLatestVersionInfo(json) // Extracts version details
```

The phone already knows:

- `otaVersionUrl` - The URL to check (from glasses status)
- `currentBuildNumber` - Current glasses version (from glasses status)
- `wifiConnected` - Whether glasses are on WiFi

**This means for onboarding, the phone can check for updates directly without asking glasses.**

## Architecture

### Three Modes of Operation

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            THREE MODES                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  MODE 1: ONBOARDING (Phone-Initiated)                                  │
│  ────────────────────────────────────                                  │
│  Phone: fetch version.json directly (no BLE roundtrip)                 │
│  Phone: Compare with glasses buildNumber from status                   │
│  Phone shows: "Update Available - Would you like to update?"           │
│  User taps "Yes"                                                        │
│  Phone sends: "ota_start" ──────────────────────► Glasses              │
│  Glasses: Download + Install (sending progress)                         │
│  Phone shows: Progress bar                                              │
│                                                                         │
│  MODE 2: BACKGROUND (Glasses-Initiated)                                │
│  ──────────────────────────────────────                                │
│  Glasses: Periodic check detects update + WiFi + phone connected       │
│  Glasses sends: "ota_update_available" ─────────► Phone                │
│  Phone shows: "Update available - Would you like to update?"           │
│  User taps "Yes"                                                        │
│  Phone sends: "ota_start" ──────────────────────► Glasses              │
│  Glasses: Download + Install (sending progress)                         │
│  Phone shows: Progress bar                                              │
│                                                                         │
│  MODE 3: AUTONOMOUS (No Phone Connected)                               │
│  ───────────────────────────────────────                               │
│  Glasses: Auto-download + Auto-install (existing behavior)             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Differences Between Modes

| Aspect                | Onboarding (Mode 1) | Background (Mode 2)          | Autonomous (Mode 3) |
| --------------------- | ------------------- | ---------------------------- | ------------------- |
| Who checks for update | Phone (direct HTTP) | Glasses (periodic)           | Glasses (periodic)  |
| Who initiates OTA     | Phone               | Phone (after glasses notify) | Glasses             |
| Phone connected       | Yes                 | Yes                          | No                  |
| What user approves    | Download + Install  | Download + Install           | N/A (auto)          |
| Progress shown        | Download + Install  | Download + Install           | None                |

## Simplified Message Protocol

### Phone → Glasses Commands

| Type        | Mode | Description                           | Payload       |
| ----------- | ---- | ------------------------------------- | ------------- |
| `ota_start` | Both | User approved, start download+install | `{timestamp}` |

### Glasses → Phone Messages

| Type                   | Mode       | Description                                | Payload                                                                               |
| ---------------------- | ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `ota_update_available` | Background | Glasses detected update, notifying phone   | `{version_code, version_name, updates[], total_size}`                                 |
| `ota_progress`         | Both       | Real-time progress during download/install | `{stage, status, progress, bytes_downloaded, total_bytes, error_message?, timestamp}` |

**Removed from original plan:**

- ~~`ota_check`~~ - Phone checks directly via HTTP
- ~~`ota_check_result`~~ - Not needed
- ~~`ota_approve`~~ - Merged with `ota_start`
- ~~`ota_ready_to_install`~~ - Not needed (no pre-download flow)

### Message Payload Details

#### `ota_update_available` (Glasses → Phone)

```json
{
  "type": "ota_update_available",
  "version_code": 123,
  "version_name": "1.2.3",
  "updates": ["apk", "mtk", "bes"],
  "total_size": 45000000,
  "timestamp": 1703001234567
}
```

- `updates`: Array of update types available (batched)

#### `ota_start` (Phone → Glasses)

```json
{
  "type": "ota_start",
  "timestamp": 1703001234567
}
```

#### `ota_progress` (Glasses → Phone)

```json
{
  "type": "ota_progress",
  "stage": "download",
  "status": "PROGRESS",
  "progress": 45,
  "bytes_downloaded": 20250000,
  "total_bytes": 45000000,
  "current_update": "apk",
  "error_message": null,
  "timestamp": 1703001234567
}
```

- `stage`: `"download"` | `"install"`
- `status`: `"STARTED"` | `"PROGRESS"` | `"FINISHED"` | `"FAILED"`
- `current_update`: `"apk"` | `"mtk"` | `"bes"` (which update in batch)

### Progress Update Frequency

**Every 2 seconds OR every 5% change, whichever comes first.**

This provides:

- Responsive UI feel (not stale)
- Not too chatty over BLE (~30 messages for full download)
- Smooth progress bar animation

## Sequence Diagrams

### Onboarding Flow (Phone-Initiated)

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   PHONE (UI)     │     │  PHONE (Native)  │     │    GLASSES       │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │
         │ [WiFi setup complete]  │                        │
         │ Navigate to            │                        │
         │ "Checking for updates" │                        │
         │                        │                        │
         │ fetchVersionInfo() ────┼───────► [HTTP to server]
         │ (direct HTTP call)     │                        │
         │◄────────────────────────────────── version.json │
         │                        │                        │
         │ isUpdateAvailable()    │                        │
         │ (compare with          │                        │
         │  buildNumber from      │                        │
         │  glasses status)       │                        │
         │                        │                        │
         │ [If available]         │                        │
         │ Navigate to            │                        │
         │ "Update Available"     │                        │
         │                        │                        │
         │ [User taps "Update"]   │                        │
         │                        │                        │
         │ startOtaUpdate() ─────►│                        │
         │                        │ ota_start ────────────►│
         │                        │                        │
         │ Navigate to            │                        │
         │ "Updating" screen      │                        │
         │                        │                        │ [Download APK]
         │                        │◄──── ota_progress ─────│
         │◄── onOtaProgress ──────│   {stage: "download",  │
         │    [Update progress]   │    progress: 45}       │
         │                        │                        │
         │                        │                        │ [Install APK]
         │                        │◄──── ota_progress ─────│
         │◄── onOtaProgress ──────│   {stage: "install"}   │
         │                        │                        │
         │                        │◄──── ota_progress ─────│
         │◄── onOtaProgress ──────│   {status: "FINISHED"} │
         │                        │                        │
         │ [Navigate to next      │                        │
         │  onboarding step]      │                        │
```

### Background Flow (Glasses-Initiated)

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   PHONE (UI)     │     │  PHONE (Native)  │     │    GLASSES       │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │
         │                        │                        │ [Periodic check]
         │                        │                        │ [WiFi connected]
         │                        │                        │ [Phone BLE connected]
         │                        │                        │ [Update available]
         │                        │                        │
         │                        │◄─ ota_update_available─│
         │◄─ onOtaUpdateAvailable─│   {version: "1.2.3",   │
         │                        │    updates: ["apk"]}   │
         │                        │                        │
         │ [Show update prompt]   │                        │
         │                        │                        │
         │ [User taps "Update"]   │                        │
         │                        │                        │
         │ startOtaUpdate() ─────►│                        │
         │                        │ ota_start ────────────►│
         │                        │                        │
         │                        │                        │ [Download APK]
         │                        │◄──── ota_progress ─────│
         │◄── onOtaProgress ──────│   {stage: "download"}  │
         │                        │                        │
         │                        │                        │ [Install APK]
         │                        │◄──── ota_progress ─────│
         │◄── onOtaProgress ──────│   {stage: "install",   │
         │                        │    status: "FINISHED"} │
```

### Autonomous Flow (No Phone)

```
┌──────────────────────────────────────────────────────────────────────┐
│                           GLASSES (alone)                            │
└────────────────────────────────────┬─────────────────────────────────┘
                                     │
                                     │ [Periodic check - every 15 min]
                                     │ [WiFi connected: YES]
                                     │ [Phone BLE connected: NO]
                                     │
                                     │ [Fetch version.json]
                                     │ [Compare versions]
                                     │ [Update available]
                                     │
                                     │ [Download APK]
                                     │ [Verify SHA256]
                                     │ [Install APK]
                                     │ [Reboot]
                                     │
                                     │ (Existing behavior - unchanged)
```

## Design Decisions

### 1. No timeout for background approval

If user taps "Later", glasses will not auto-install. Re-prompt on next app open.

### 2. Re-prompt behavior

When user taps "Later" on background prompt, re-prompt on next app open (glasses will send `ota_update_available` again on next periodic check if phone is connected).

### 3. Batch all update types (phone UI only)

If APK, MTK, and BES all need updates, the phone shows ONE prompt to the user (not 3 separate prompts). The glasses' actual OTA process is **unchanged** - they still download and install each update type sequentially using existing `processAppsSequentially()` logic. We're only batching the user approval step on the phone.

### 4. Progress update frequency

Every 2 seconds OR every 5% change, whichever comes first.

## Implementation Details

### Phase 1: ASG_CLIENT (Glasses)

#### 1.1 OtaHelper.java Modifications

**File:** `asg_client/app/src/main/java/com/mentra/asg_client/io/ota/helpers/OtaHelper.java`

**New interface for phone communication:**

```java
public interface PhoneConnectionProvider {
    boolean isPhoneConnected();
    void sendOtaUpdateAvailable(JSONObject updateInfo);
    void sendOtaProgress(JSONObject progress);
}

private PhoneConnectionProvider phoneConnectionProvider;

public void setPhoneConnectionProvider(PhoneConnectionProvider provider) {
    this.phoneConnectionProvider = provider;
}
```

**New state variables:**

```java
// Track phone-initiated vs glasses-initiated OTA
private static volatile boolean isPhoneInitiatedOta = false;

// Track if we've notified phone about available update (to avoid spam)
private static volatile boolean hasNotifiedPhoneOfUpdate = false;

// Progress throttling
private long lastProgressSentTime = 0;
private int lastProgressSentPercent = 0;
private static final long PROGRESS_MIN_INTERVAL_MS = 2000; // 2 seconds
private static final int PROGRESS_MIN_CHANGE_PERCENT = 5;   // 5%
```

**Modify startVersionCheck() - Add phone notification for background mode:**

```java
public void startVersionCheck(Context context) {
    // ... existing checks ...

    new Thread(() -> {
        synchronized (versionCheckLock) {
            if (isCheckingVersion || isUpdating) {
                return;
            }
            isCheckingVersion = true;
        }

        try {
            String versionInfo = fetchVersionInfo(OtaConstants.VERSION_JSON_URL);
            JSONObject json = new JSONObject(versionInfo);

            // Check if phone is connected
            boolean phoneConnected = isPhoneConnected();

            if (phoneConnected && !isPhoneInitiatedOta && !hasNotifiedPhoneOfUpdate) {
                // BACKGROUND MODE: Check if update available and notify phone
                JSONObject updateInfo = checkForAvailableUpdates(json);
                if (updateInfo != null && updateInfo.optBoolean("available", false)) {
                    notifyPhoneUpdateAvailable(updateInfo);
                    hasNotifiedPhoneOfUpdate = true;
                    // Don't proceed with download - wait for phone to send ota_start
                    return;
                }
            }

            // ONBOARDING MODE (phone initiated) or AUTONOMOUS MODE (no phone)
            // Proceed with normal update flow
            if (json.has("apps")) {
                processAppsSequentially(json, context);
            } else {
                checkAndUpdateApp("com.mentra.asg_client", json, context);
            }
        } catch (Exception e) {
            Log.e(TAG, "Exception during OTA check", e);
        } finally {
            isCheckingVersion = false;
            isPhoneInitiatedOta = false;
        }
    }).start();
}
```

**New method - Check for available updates (without downloading):**

```java
private JSONObject checkForAvailableUpdates(JSONObject json) {
    try {
        JSONObject result = new JSONObject();
        JSONArray updatesArray = new JSONArray();
        long totalSize = 0;
        long latestVersionCode = 0;
        String latestVersionName = "";

        // Check APK updates
        if (json.has("apps")) {
            JSONObject apps = json.getJSONObject("apps");

            // Check asg_client
            JSONObject asgClient = apps.optJSONObject("com.mentra.asg_client");
            if (asgClient != null) {
                long currentVersion = getInstalledVersion("com.mentra.asg_client", context);
                long serverVersion = asgClient.getLong("versionCode");
                if (serverVersion > currentVersion) {
                    updatesArray.put("apk");
                    totalSize += asgClient.optLong("apkSize", 0);
                    latestVersionCode = serverVersion;
                    latestVersionName = asgClient.optString("versionName", "");
                }
            }

            // Check ota_updater
            JSONObject otaUpdater = apps.optJSONObject("com.augmentos.otaupdater");
            if (otaUpdater != null) {
                long currentVersion = getInstalledVersion("com.augmentos.otaupdater", context);
                long serverVersion = otaUpdater.getLong("versionCode");
                if (serverVersion > currentVersion) {
                    // Include in APK updates
                    totalSize += otaUpdater.optLong("apkSize", 0);
                }
            }
        }

        // Check MTK firmware
        if (json.has("mtk_firmware")) {
            JSONObject mtkFirmware = json.getJSONObject("mtk_firmware");
            String currentVersionStr = SysControl.getSystemCurrentVersion(context);
            long currentVersion = 0;
            try {
                currentVersion = Long.parseLong(currentVersionStr);
            } catch (NumberFormatException e) {}

            long serverVersion = mtkFirmware.optLong("versionCode", 0);
            if (serverVersion > currentVersion) {
                updatesArray.put("mtk");
                totalSize += mtkFirmware.optLong("fileSize", 0);
            }
        }

        // Check BES firmware
        if (json.has("bes_firmware")) {
            JSONObject besFirmware = json.getJSONObject("bes_firmware");
            byte[] currentVersion = BesOtaManager.getCurrentFirmwareVersion();
            long serverVersion = besFirmware.optLong("versionCode", 0);
            byte[] serverVersionBytes = BesOtaManager.parseServerVersionCode(serverVersion);

            if (currentVersion != null && serverVersionBytes != null) {
                if (BesOtaManager.isNewerVersion(serverVersionBytes, currentVersion)) {
                    updatesArray.put("bes");
                    totalSize += besFirmware.optLong("fileSize", 0);
                }
            }
        }

        if (updatesArray.length() > 0) {
            result.put("available", true);
            result.put("version_code", latestVersionCode);
            result.put("version_name", latestVersionName);
            result.put("updates", updatesArray);
            result.put("total_size", totalSize);
            return result;
        }

        result.put("available", false);
        return result;
    } catch (Exception e) {
        Log.e(TAG, "Error checking for available updates", e);
        return null;
    }
}
```

**New method - Notify phone of available update:**

```java
private void notifyPhoneUpdateAvailable(JSONObject updateInfo) {
    if (phoneConnectionProvider == null) return;

    try {
        updateInfo.put("type", "ota_update_available");
        updateInfo.put("timestamp", System.currentTimeMillis());

        phoneConnectionProvider.sendOtaUpdateAvailable(updateInfo);
        Log.i(TAG, "Notified phone of available update: " + updateInfo.toString());
    } catch (JSONException e) {
        Log.e(TAG, "Failed to notify phone of update", e);
    }
}
```

**New method - Start OTA from phone command:**

```java
public void startOtaFromPhone() {
    Log.i(TAG, "Starting OTA from phone request");
    isPhoneInitiatedOta = true;
    hasNotifiedPhoneOfUpdate = false; // Reset for next check cycle
    startVersionCheck(context);
}
```

**New method - Reset notification flag (called on phone disconnect):**

```java
public void onPhoneDisconnected() {
    hasNotifiedPhoneOfUpdate = false;
}
```

**Modify sendProgressToPhone() - Add throttling:**

```java
private void sendProgressToPhone(String stage, int progress, long bytesDownloaded,
                                  long totalBytes, String status, String errorMessage,
                                  String currentUpdate) {
    if (phoneConnectionProvider == null || !isPhoneConnected()) return;

    long now = System.currentTimeMillis();
    boolean shouldSend = false;

    // Always send STARTED, FINISHED, FAILED
    if ("STARTED".equals(status) || "FINISHED".equals(status) || "FAILED".equals(status)) {
        shouldSend = true;
    }
    // For PROGRESS, throttle: every 2s OR every 5%
    else if ("PROGRESS".equals(status)) {
        boolean timeElapsed = (now - lastProgressSentTime) >= PROGRESS_MIN_INTERVAL_MS;
        boolean percentChanged = Math.abs(progress - lastProgressSentPercent) >= PROGRESS_MIN_CHANGE_PERCENT;
        shouldSend = timeElapsed || percentChanged || progress == 100;
    }

    if (!shouldSend) return;

    try {
        JSONObject progressInfo = new JSONObject();
        progressInfo.put("type", "ota_progress");
        progressInfo.put("stage", stage);
        progressInfo.put("status", status);
        progressInfo.put("progress", progress);
        progressInfo.put("bytes_downloaded", bytesDownloaded);
        progressInfo.put("total_bytes", totalBytes);
        progressInfo.put("current_update", currentUpdate);
        if (errorMessage != null) {
            progressInfo.put("error_message", errorMessage);
        }
        progressInfo.put("timestamp", now);

        phoneConnectionProvider.sendOtaProgress(progressInfo);

        lastProgressSentTime = now;
        lastProgressSentPercent = progress;
    } catch (JSONException e) {
        Log.e(TAG, "Failed to send OTA progress", e);
    }
}
```

**Helper method:**

```java
private boolean isPhoneConnected() {
    return phoneConnectionProvider != null && phoneConnectionProvider.isPhoneConnected();
}
```

#### 1.2 CommunicationManager.java - Add OTA methods

**File:** `asg_client/app/src/main/java/com/mentra/asg_client/service/communication/managers/CommunicationManager.java`

```java
// Implement PhoneConnectionProvider interface
public class CommunicationManager implements ICommunicationManager, OtaHelper.PhoneConnectionProvider {

    @Override
    public boolean isPhoneConnected() {
        return serviceManager != null &&
               serviceManager.getBluetoothManager() != null &&
               serviceManager.getBluetoothManager().isConnected();
    }

    @Override
    public void sendOtaUpdateAvailable(JSONObject updateInfo) {
        if (isPhoneConnected()) {
            try {
                boolean sent = reliableManager.sendMessage(updateInfo);
                Log.d(TAG, "Sent OTA update available: " + (sent ? "success" : "failed"));
            } catch (Exception e) {
                Log.e(TAG, "Failed to send OTA update available", e);
            }
        }
    }

    @Override
    public void sendOtaProgress(JSONObject progress) {
        if (isPhoneConnected()) {
            try {
                // Progress updates don't need reliability (frequent updates)
                String jsonString = progress.toString();
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes(StandardCharsets.UTF_8));
            } catch (Exception e) {
                Log.e(TAG, "Failed to send OTA progress", e);
            }
        }
    }
}
```

#### 1.3 Add OTA Command Handler

**New File:** `asg_client/app/src/main/java/com/mentra/asg_client/service/core/handlers/OtaCommandHandler.java`

```java
package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import org.json.JSONObject;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;

public class OtaCommandHandler {
    private static final String TAG = "OtaCommandHandler";

    private final OtaHelper otaHelper;

    public OtaCommandHandler(OtaHelper otaHelper) {
        this.otaHelper = otaHelper;
    }

    public void handleCommand(JSONObject json) {
        String type = json.optString("type", "");

        switch (type) {
            case "ota_start":
                handleOtaStart(json);
                break;
            default:
                Log.w(TAG, "Unknown OTA command type: " + type);
        }
    }

    private void handleOtaStart(JSONObject json) {
        Log.i(TAG, "Received ota_start from phone");
        if (otaHelper != null) {
            otaHelper.startOtaFromPhone();
        }
    }
}
```

#### 1.4 Wire up in Command Processing

Add to the existing command switch statement:

```java
case "ota_start":
    otaCommandHandler.handleCommand(json);
    break;
```

---

### Phase 2: Android Mobile App

#### 2.1 MentraLive.java - Handle OTA Messages

**File:** `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/MentraLive.java`

**Add state variables:**

```java
// OTA state
private JSONObject otaProgress = null;
private JSONObject otaUpdateAvailable = null;
```

**Add to message processing switch:**

```java
case "ota_update_available":
    handleOtaUpdateAvailable(json);
    break;

case "ota_progress":
    handleOtaProgress(json);
    break;
```

**Add handler methods:**

```java
private void handleOtaUpdateAvailable(JSONObject json) {
    Log.i(TAG, "Received OTA update available: " + json.toString());
    otaUpdateAvailable = json;
    Bridge.sendOtaUpdateAvailable(json);
}

private void handleOtaProgress(JSONObject json) {
    Log.d(TAG, "Received OTA progress: " + json.toString());
    otaProgress = json;
    Bridge.sendOtaProgress(json);
}
```

**Add getters:**

```java
public JSONObject getOtaProgress() { return otaProgress; }
public JSONObject getOtaUpdateAvailable() { return otaUpdateAvailable; }

public void clearOtaUpdateAvailable() {
    otaUpdateAvailable = null;
}
```

**Add command sender:**

```java
public void sendOtaStart() {
    try {
        JSONObject cmd = new JSONObject();
        cmd.put("type", "ota_start");
        cmd.put("timestamp", System.currentTimeMillis());
        sendData(cmd.toString().getBytes(StandardCharsets.UTF_8));
        otaUpdateAvailable = null; // Clear pending
        Log.i(TAG, "Sent ota_start to glasses");
    } catch (JSONException e) {
        Log.e(TAG, "Failed to send ota_start", e);
    }
}
```

#### 2.2 CoreManager.kt - Add OTA method

**File:** `mobile/modules/core/android/src/main/java/com/mentra/core/CoreManager.kt`

```kotlin
fun sendOtaStart() {
    if (sgc is MentraLive) {
        (sgc as MentraLive).sendOtaStart()
    }
}
```

#### 2.3 Bridge.kt - Add OTA Events

**File:** `mobile/modules/core/android/src/main/java/com/mentra/core/Bridge.kt`

```kotlin
companion object {
    // ... existing code ...

    @JvmStatic
    fun sendOtaUpdateAvailable(updateInfo: JSONObject) {
        val event = hashMapOf<String, Any?>(
            "available" to updateInfo.optBoolean("available", false),
            "version_code" to updateInfo.optLong("version_code", 0),
            "version_name" to updateInfo.optString("version_name", ""),
            "updates" to jsonArrayToList(updateInfo.optJSONArray("updates")),
            "total_size" to updateInfo.optLong("total_size", 0),
            "timestamp" to updateInfo.optLong("timestamp", 0)
        )
        sendTypedMessage("ota_update_available", event)
    }

    @JvmStatic
    fun sendOtaProgress(progress: JSONObject) {
        val event = hashMapOf<String, Any?>(
            "stage" to progress.optString("stage", ""),
            "status" to progress.optString("status", ""),
            "progress" to progress.optInt("progress", 0),
            "bytes_downloaded" to progress.optLong("bytes_downloaded", 0),
            "total_bytes" to progress.optLong("total_bytes", 0),
            "current_update" to progress.optString("current_update", ""),
            "error_message" to progress.optString("error_message", null),
            "timestamp" to progress.optLong("timestamp", 0)
        )
        sendTypedMessage("ota_progress", event)
    }

    @JvmStatic
    fun sendOtaStart() {
        CoreManager.getInstance().sendOtaStart()
    }

    private fun jsonArrayToList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        val list = mutableListOf<String>()
        for (i in 0 until array.length()) {
            list.add(array.optString(i, ""))
        }
        return list
    }
}
```

#### 2.4 CoreModule.kt - Expose to React Native

**File:** `mobile/modules/core/android/src/main/java/com/mentra/core/CoreModule.kt`

```kotlin
@ExpoMethod
fun sendOtaStart(promise: Promise) {
    try {
        Bridge.sendOtaStart()
        promise.resolve(true)
    } catch (e: Exception) {
        promise.reject("OTA_START_FAILED", e.message, e)
    }
}
```

---

### Phase 3: iOS Mobile App

Mirror the Android implementation:

#### 3.1 MentraLive.swift

- Handle `ota_update_available`, `ota_progress` messages
- Add `sendOtaStart()` method

#### 3.2 CoreManager.swift

- Add `sendOtaStart()` method

#### 3.3 Bridge.swift

- Add `sendOtaUpdateAvailable()`, `sendOtaProgress()` events
- Add `sendOtaStart()` command forwarder

#### 3.4 CoreModule (Expo)

- Expose `sendOtaStart` to React Native

---

### Phase 4: React Native

#### 4.1 glasses.ts - Add OTA State

**File:** `mobile/src/stores/glasses.ts`

```typescript
// Types
export interface OtaUpdateAvailable {
  available: boolean
  versionCode: number
  versionName: string
  updates: ("apk" | "mtk" | "bes")[]
  totalSize: number
  timestamp: number
}

export interface OtaProgressInfo {
  stage: "download" | "install"
  status: "STARTED" | "PROGRESS" | "FINISHED" | "FAILED"
  progress: number
  bytesDownloaded: number
  totalBytes: number
  currentUpdate: "apk" | "mtk" | "bes"
  errorMessage?: string
  timestamp: number
}

// Add to GlassesState
interface GlassesState {
  // ... existing ...

  // OTA state
  otaUpdateAvailable: OtaUpdateAvailable | null
  otaProgress: OtaProgressInfo | null

  // OTA actions
  setOtaUpdateAvailable: (info: OtaUpdateAvailable | null) => void
  setOtaProgress: (progress: OtaProgressInfo | null) => void
  clearOtaState: () => void
}

// Implementation
export const useGlassesStore = create<GlassesState>()(
  subscribeWithSelector((set) => ({
    // ... existing ...

    // OTA state
    otaUpdateAvailable: null,
    otaProgress: null,

    // OTA actions
    setOtaUpdateAvailable: (info) => set({otaUpdateAvailable: info}),
    setOtaProgress: (progress) => set({otaProgress: progress}),
    clearOtaState: () =>
      set({
        otaUpdateAvailable: null,
        otaProgress: null,
      }),
  })),
)
```

#### 4.2 MantleBridge.tsx - Handle Events & Add Methods

**File:** `mobile/src/bridge/MantleBridge.tsx`

**Add to parseDataFromCore():**

```typescript
case "ota_update_available":
    useGlassesStore.getState().setOtaUpdateAvailable({
        available: data.available,
        versionCode: data.version_code,
        versionName: data.version_name,
        updates: data.updates,
        totalSize: data.total_size,
        timestamp: data.timestamp,
    })
    GlobalEventEmitter.emit("ota_update_available", data)
    break

case "ota_progress":
    useGlassesStore.getState().setOtaProgress({
        stage: data.stage,
        status: data.status,
        progress: data.progress,
        bytesDownloaded: data.bytes_downloaded,
        totalBytes: data.total_bytes,
        currentUpdate: data.current_update,
        errorMessage: data.error_message,
        timestamp: data.timestamp,
    })
    GlobalEventEmitter.emit("ota_progress", data)
    break
```

**Add method:**

```typescript
// Start OTA update (used by both onboarding and background flows)
public async startOtaUpdate(): Promise<void> {
    useGlassesStore.getState().setOtaProgress({
        stage: 'download',
        status: 'STARTED',
        progress: 0,
        bytesDownloaded: 0,
        totalBytes: 0,
        currentUpdate: 'apk',
        timestamp: Date.now(),
    })
    useGlassesStore.getState().setOtaUpdateAvailable(null)
    await CoreModule.sendOtaStart()
}
```

#### 4.3 Modify OtaUpdateChecker.tsx - Add background prompt

**File:** `mobile/src/effects/OtaUpdateChecker.tsx`

Add handling for `ota_update_available` from glasses:

```typescript
import {useEffect} from "react"
import {useGlassesStore} from "@/stores/glasses"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import showAlert from "@/utils/AlertUtils"
import {MantleBridge} from "@/bridge/MantleBridge"

export function OtaUpdateChecker() {
  const {push} = useNavigationHistory()
  const otaUpdateAvailable = useGlassesStore((state) => state.otaUpdateAvailable)

  // Handle background update notification from glasses
  useEffect(() => {
    if (otaUpdateAvailable?.available) {
      showAlert(
        "Update Available",
        `A software update is available for your glasses (v${otaUpdateAvailable.versionName}).\n\nWould you like to install it now?`,
        [
          {
            text: "Later",
            style: "cancel",
            onPress: () => {
              useGlassesStore.getState().setOtaUpdateAvailable(null)
            },
          },
          {
            text: "Update Now",
            onPress: async () => {
              const bridge = MantleBridge.getInstance()
              await bridge.startOtaUpdate()
              // Optionally navigate to progress screen
              push("/glasses/ota-progress")
            },
          },
        ],
      )
    }
  }, [otaUpdateAvailable])

  // ... existing WiFi-not-connected check logic ...

  return null
}
```

#### 4.4 Onboarding Screens

**New File:** `mobile/src/app/onboarding/ota-check.tsx`

Uses existing `fetchVersionInfo()` and `isUpdateAvailable()` from `OtaUpdateChecker.tsx`:

```typescript
import {useEffect, useState} from "react"
import {View, ActivityIndicator} from "react-native"
import {useRouter} from "expo-router"
import {Text} from "@/components/ignite"
import {useGlassesStore} from "@/stores/glasses"
import {useAppTheme} from "@/contexts/ThemeContext"
import {fetchVersionInfo, isUpdateAvailable, getLatestVersionInfo} from "@/effects/OtaUpdateChecker"

export default function OtaCheckScreen() {
    const router = useRouter()
    const {themed} = useAppTheme()
    const [error, setError] = useState<string | null>(null)

    const otaVersionUrl = useGlassesStore(state => state.otaVersionUrl)
    const currentBuildNumber = useGlassesStore(state => state.buildNumber)

    useEffect(() => {
        const checkForUpdate = async () => {
            try {
                if (!otaVersionUrl || !currentBuildNumber) {
                    // No version info available, skip
                    router.replace("/onboarding/next-step")
                    return
                }

                // Phone checks directly - no BLE roundtrip needed!
                const versionJson = await fetchVersionInfo(otaVersionUrl)

                if (isUpdateAvailable(currentBuildNumber, versionJson)) {
                    const latestInfo = getLatestVersionInfo(versionJson)
                    router.replace({
                        pathname: "/onboarding/ota-available",
                        params: {
                            versionName: latestInfo?.versionName || "",
                            versionCode: String(latestInfo?.versionCode || 0),
                            fileSize: String(latestInfo?.apkSize || 0),
                        }
                    })
                } else {
                    // No update available, continue onboarding
                    router.replace("/onboarding/next-step")
                }
            } catch (err) {
                console.error("OTA check failed:", err)
                setError("Failed to check for updates")
                setTimeout(() => {
                    router.replace("/onboarding/next-step")
                }, 2000)
            }
        }

        checkForUpdate()
    }, [otaVersionUrl, currentBuildNumber])

    return (
        <View style={themed($container)}>
            {error ? (
                <Text style={themed($errorText)}>{error}</Text>
            ) : (
                <>
                    <ActivityIndicator size="large" />
                    <Text style={themed($text)}>Checking for updates...</Text>
                </>
            )}
        </View>
    )
}
```

**New File:** `mobile/src/app/onboarding/ota-available.tsx`

```typescript
import {View} from "react-native"
import {useRouter, useLocalSearchParams} from "expo-router"
import {Text, Button} from "@/components/ignite"
import {MantleBridge} from "@/bridge/MantleBridge"
import {useAppTheme} from "@/contexts/ThemeContext"

export default function OtaAvailableScreen() {
    const router = useRouter()
    const params = useLocalSearchParams<{
        versionName: string
        versionCode: string
        fileSize: string
    }>()
    const {themed} = useAppTheme()

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return "0 B"
        const k = 1024
        const sizes = ["B", "KB", "MB", "GB"]
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
    }

    const handleUpdate = async () => {
        router.replace("/onboarding/ota-progress")
        const bridge = MantleBridge.getInstance()
        await bridge.startOtaUpdate()
    }

    const handleSkip = () => {
        router.replace("/onboarding/next-step")
    }

    return (
        <View style={themed($container)}>
            <Text style={themed($title)}>Update Available</Text>

            <Text style={themed($version)}>
                Version {params.versionName}
            </Text>

            <Text style={themed($size)}>
                {formatBytes(parseInt(params.fileSize || "0", 10))}
            </Text>

            <Text style={themed($description)}>
                A software update is available for your glasses.
                We recommend installing it for the best experience.
            </Text>

            <View style={themed($buttonContainer)}>
                <Button
                    text="Update Now"
                    preset="filled"
                    onPress={handleUpdate}
                />

                <Button
                    text="Skip for Now"
                    preset="default"
                    onPress={handleSkip}
                />
            </View>
        </View>
    )
}
```

**New File:** `mobile/src/app/onboarding/ota-progress.tsx`

```typescript
import {useEffect} from "react"
import {View} from "react-native"
import {useRouter} from "expo-router"
import {Text, Button} from "@/components/ignite"
import {useGlassesStore} from "@/stores/glasses"
import {useAppTheme} from "@/contexts/ThemeContext"

export default function OtaProgressScreen() {
    const router = useRouter()
    const {themed, theme} = useAppTheme()
    const otaProgress = useGlassesStore(state => state.otaProgress)

    useEffect(() => {
        if (otaProgress?.status === "FINISHED") {
            setTimeout(() => {
                router.replace("/onboarding/next-step")
            }, 1500)
        }
    }, [otaProgress?.status])

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return "0 B"
        const k = 1024
        const sizes = ["B", "KB", "MB", "GB"]
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
    }

    const getStageText = () => {
        if (!otaProgress) return "Preparing..."

        switch (otaProgress.stage) {
            case "download":
                if (otaProgress.status === "FINISHED") return "Download complete"
                return "Downloading update..."
            case "install":
                if (otaProgress.status === "FINISHED") return "Update complete!"
                return "Installing update..."
            default:
                return "Updating..."
        }
    }

    const getProgressText = () => {
        if (!otaProgress) return ""

        if (otaProgress.stage === "download" && otaProgress.totalBytes > 0) {
            return `${otaProgress.progress}% (${formatBytes(otaProgress.bytesDownloaded)} / ${formatBytes(otaProgress.totalBytes)})`
        }

        if (otaProgress.stage === "install") {
            return otaProgress.status === "FINISHED" ? "Complete" : "Please wait..."
        }

        return `${otaProgress.progress}%`
    }

    const isError = otaProgress?.status === "FAILED"

    return (
        <View style={themed($container)}>
            <Text style={themed($title)}>
                {isError ? "Update Failed" : "Updating Your Glasses"}
            </Text>

            {isError ? (
                <>
                    <Text style={[themed($description), {color: theme.colors.error}]}>
                        {otaProgress?.errorMessage || "An error occurred during the update."}
                    </Text>
                    <Button
                        text="Continue Anyway"
                        onPress={() => router.replace("/onboarding/next-step")}
                    />
                </>
            ) : (
                <>
                    <Text style={themed($stageText)}>{getStageText()}</Text>

                    {/* Progress bar component here */}
                    <View style={themed($progressBarContainer)}>
                        <View style={[themed($progressBar), {width: `${otaProgress?.progress || 0}%`}]} />
                    </View>

                    <Text style={themed($progressText)}>{getProgressText()}</Text>

                    {otaProgress?.stage === "install" && otaProgress?.status !== "FINISHED" && (
                        <Text style={themed($warningText)}>
                            Please keep your glasses on and nearby.
                            They will restart automatically.
                        </Text>
                    )}
                </>
            )}
        </View>
    )
}
```

---

## Testing Plan

### Unit Tests

1. **OtaHelper.checkForAvailableUpdates()** - Returns correct result for various version scenarios
2. **OtaHelper.startOtaFromPhone()** - Sets correct flags and initiates OTA
3. **Progress throttling** - Sends at correct intervals (2s or 5%)
4. **Message parsing** - All message types parsed correctly on both platforms

### Integration Tests

1. **Onboarding Flow**
   - WiFi connected → Phone checks → Update available → User approves → Download → Install → Complete
   - WiFi connected → Phone checks → No update → Skip to next step
   - WiFi connected → Check fails → Continue with error message

2. **Background Flow**
   - Glasses detect update + phone connected → `ota_update_available` sent → Prompt shown → User approves → OTA starts
   - User taps "Later" → Prompt dismissed, re-prompt on next app open
   - Phone disconnects → Glasses proceed with autonomous OTA

3. **Autonomous Flow**
   - Phone not connected → Full auto-OTA (existing behavior unchanged)

### Manual Test Scenarios

| Scenario                     | Expected Behavior                                             |
| ---------------------------- | ------------------------------------------------------------- |
| Onboarding: Update available | Check screen → Available screen → Progress screen → Next step |
| Onboarding: No update        | Check screen → Next step (skip available/progress)            |
| Onboarding: User skips       | Available screen → Next step (no download)                    |
| Background: Glasses notify   | Alert shown with Update/Later options                         |
| Background: User updates     | Progress shown, glasses restart                               |
| Background: User declines    | Alert dismissed, re-prompt next app open                      |
| No phone: WiFi connected     | Auto download + install (existing)                            |
| Phone disconnects mid-OTA    | OTA continues autonomously                                    |

---

## Edge Cases & Error Handling

### Timeout Scenarios

| Scenario               | Handling                                       |
| ---------------------- | ---------------------------------------------- |
| Phone HTTP check fails | Show error, continue onboarding                |
| Download stalls        | Existing retry logic (3 attempts with backoff) |
| Install takes too long | No timeout - install is system-controlled      |

### Connection Loss

| Scenario                     | Handling                                         |
| ---------------------------- | ------------------------------------------------ |
| Phone disconnects during OTA | OTA continues autonomously, no progress on phone |
| Phone reconnects during OTA  | Progress resumes from current state              |
| BLE unstable                 | Progress may be delayed but OTA continues        |

### State Recovery

| Scenario                       | Handling                                      |
| ------------------------------ | --------------------------------------------- |
| App killed during progress     | On reopen, check glasses state via status     |
| Glasses restart during install | Normal - install causes restart               |
| Multiple update types          | Handled sequentially, all batched in one flow |

---

## Implementation Order

### Sprint 1: Core Infrastructure (ASG_CLIENT)

1. [ ] Add PhoneConnectionProvider interface to OtaHelper
2. [ ] Implement checkForAvailableUpdates()
3. [ ] Implement startOtaFromPhone()
4. [ ] Add progress throttling to sendProgressToPhone()
5. [ ] Implement notifyPhoneUpdateAvailable()
6. [ ] Create OtaCommandHandler
7. [ ] Wire up CommunicationManager as PhoneConnectionProvider

### Sprint 2: Android Mobile

1. [ ] MentraLive.java: Handle ota_update_available, ota_progress
2. [ ] MentraLive.java: Add sendOtaStart()
3. [ ] Bridge.kt: Add OTA events and commands
4. [ ] CoreModule.kt: Expose sendOtaStart to React Native

### Sprint 3: iOS Mobile

1. [ ] MentraLive.swift: Mirror Android implementation
2. [ ] CoreManager.swift: Add sendOtaStart()
3. [ ] Bridge.swift: Add OTA events and commands

### Sprint 4: React Native

1. [ ] glasses.ts: Add OTA state (otaUpdateAvailable, otaProgress)
2. [ ] MantleBridge.tsx: Handle events, add startOtaUpdate()
3. [ ] OtaUpdateChecker.tsx: Handle background ota_update_available
4. [ ] Onboarding screens: ota-check, ota-available, ota-progress

### Sprint 5: Testing & Polish

1. [ ] Unit tests
2. [ ] Integration tests
3. [ ] Manual testing all scenarios
4. [ ] Error handling refinement
5. [ ] UI polish

---

## Files to Modify/Create

### ASG_CLIENT (Glasses)

- **Modify:** `asg_client/app/src/main/java/com/mentra/asg_client/io/ota/helpers/OtaHelper.java`
- **Modify:** `asg_client/app/src/main/java/com/mentra/asg_client/service/communication/managers/CommunicationManager.java`
- **Create:** `asg_client/app/src/main/java/com/mentra/asg_client/service/core/handlers/OtaCommandHandler.java`
- **Modify:** Command processing (likely `CommandProcessor.java`)

### Android Mobile

- **Modify:** `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/MentraLive.java`
- **Modify:** `mobile/modules/core/android/src/main/java/com/mentra/core/CoreManager.kt`
- **Modify:** `mobile/modules/core/android/src/main/java/com/mentra/core/Bridge.kt`
- **Modify:** `mobile/modules/core/android/src/main/java/com/mentra/core/CoreModule.kt`

### iOS Mobile

- **Modify:** `mobile/modules/core/ios/Source/sgcs/MentraLive.swift`
- **Modify:** `mobile/modules/core/ios/Source/CoreManager.swift`
- **Modify:** `mobile/modules/core/ios/Source/Bridge.swift`

### React Native

- **Modify:** `mobile/src/stores/glasses.ts`
- **Modify:** `mobile/src/bridge/MantleBridge.tsx`
- **Modify:** `mobile/src/effects/OtaUpdateChecker.tsx`
- **Create:** `mobile/src/app/onboarding/ota-check.tsx`
- **Create:** `mobile/src/app/onboarding/ota-available.tsx`
- **Create:** `mobile/src/app/onboarding/ota-progress.tsx`
