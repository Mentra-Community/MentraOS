# Cloud Gallery Sync - Glasses Implementation

## Overview

Background service that automatically uploads photos and videos to MentraOS Cloud when glasses are charging and connected to WiFi.

## Architecture

```
BackgroundGallerySyncManager (monitors conditions)
    ↓
CloudGalleryUploader (HTTP client)
    ↓
GalleryUploadQueue (manages files)
    ↓
Cloud API (/api/client/asg/gallery/*)
```

## Components

### BackgroundGallerySyncManager

**Location**: `app/src/main/java/com/mentra/asg_client/service/gallery/BackgroundGallerySyncManager.java`

**Purpose**: Monitor charging and WiFi state, trigger uploads when conditions met

**Trigger Conditions**:

- Device is charging
- Connected to WiFi
- Background sync enabled in settings
- Battery level >= minimum threshold (default: 20%)

**Key Methods**:

- `startMonitoring()` - Start monitoring (called when Bluetooth connects)
- `stopMonitoring()` - Stop monitoring (called when Bluetooth disconnects)
- `setBackgroundSyncEnabled(boolean)` - Enable/disable feature
- `forceSync()` - Manual trigger for testing

### CloudGalleryUploader

**Location**: `app/src/main/java/com/mentra/asg_client/service/gallery/CloudGalleryUploader.java`

**Purpose**: HTTP client for uploading files to cloud

**Features**:

- Multipart form data upload for images
- Presigned URL upload for videos (TODO)
- Retry with exponential backoff (3 attempts)
- Pause/resume capability (for conflict management)
- JWT authentication

**Upload Flow**:

1. Get JWT token from SharedPreferences
2. Build multipart request with file + metadata
3. POST to `/api/client/asg/gallery/upload`
4. Handle response (success/error)
5. Mark as uploaded in queue

**Timeouts**:

- Connect: 30 seconds
- Write: 120 seconds (2 minutes for large files)
- Read: 30 seconds

### GalleryUploadQueue

**Location**: `app/src/main/java/com/mentra/asg_client/service/gallery/GalleryUploadQueue.java`

**Purpose**: Manage queue of files to upload

**Features**:

- Filters already-uploaded files
- Sorts by capture time (oldest first)
- Tracks upload attempts and failures
- Persists state to SharedPreferences

**State Tracking**:

```
SharedPreferences keys:
- cloud_last_sync_timestamp: Last successful sync time
- cloud_uploaded_files: JSON array of uploaded filenames
- cloud_failed_uploads: JSON object of failed uploads with errors
- cloud_upload_attempts: JSON object of retry attempts per file
```

## Integration

### AsgClientService

**Modified**: `app/src/main/java/com/mentra/asg_client/service/core/AsgClientService.java`

**Changes**:

```java
@Override
public void onConnectionStateChanged(boolean connected) {
    if (connected) {
        // Start background sync monitoring
        serviceContainer.getBackgroundSyncManager().startMonitoring();
    } else {
        // Stop background sync monitoring
        serviceContainer.getBackgroundSyncManager().stopMonitoring();
    }
}
```

### ServiceContainer

**Modified**: `app/src/main/java/com/mentra/asg_client/service/core/ServiceContainer.java`

**Changes**:

- Added gallery sync components to dependency injection
- Initialize in constructor
- Cleanup in `cleanup()` method

## Configuration

### SharedPreferences Keys

```java
// Settings
enable_background_gallery_sync = true (boolean)
cloud_sync_wifi_only = true (boolean)
cloud_sync_min_battery = 20 (int, percentage)

// State
cloud_last_sync_timestamp = 1737312000000 (long, milliseconds)
auth_token = "eyJhbGc..." (string, JWT)

// Queue tracking
cloud_uploaded_files = ["IMG_001.jpg", "IMG_002.jpg"] (JSON array)
cloud_failed_uploads = {"IMG_003.jpg": "timeout"} (JSON object)
cloud_upload_attempts = {"IMG_004.jpg": 2} (JSON object)
```

### Cloud Endpoints

**Base URL**: Constructed from `BuildConfig.MENTRAOS_HOST:PORT`

- Production: `https://api.mentra.glass`
- China: `https://api.mentraglass.cn:443`
- Local dev: `http://192.168.x.x:8002`

**Endpoints**:

```
POST /api/client/asg/gallery/upload
  - Upload image directly (max 20MB)
  - Content-Type: multipart/form-data
  - Authorization: Bearer <jwt>

POST /api/client/asg/gallery/video-upload-url
  - Get presigned URL for video upload (TODO)

POST /api/client/asg/gallery/video-upload-complete
  - Confirm video upload finished (TODO)
```

## Testing

### Manual Testing

1. **Enable via ADB**:

```bash
adb shell
run-as com.mentra.asg_client
cd shared_prefs
# Edit preferences file to set enable_background_gallery_sync=true
```

2. **Monitor Logs**:

```bash
adb logcat | grep -E "BackgroundGallerySyncManager|CloudGalleryUploader|GalleryUploadQueue"
```

3. **Trigger Conditions**:

```bash
# Simulate charging
adb shell dumpsys battery set ac 1

# Check WiFi status
adb shell dumpsys wifi | grep "Wi-Fi is"
```

4. **Force Sync** (for testing):

```java
// In AsgClientService or test code
serviceContainer.getBackgroundSyncManager().forceSync();
```

### Automated Testing

See `mobile/src/services/asg/CLOUD_GALLERY_SYNC_TESTING.md` for comprehensive test suite.

## Known Limitations

1. **Video Upload Not Implemented**
   - Currently skips videos with "not yet implemented" message
   - Need to add presigned URL flow

2. **No Chunked Upload**
   - Large files upload in single request
   - If interrupted, must restart from beginning

3. **No Bandwidth Throttling**
   - Uploads at full speed (could impact other apps)
   - Consider adding rate limiting

4. **No Upload Progress to Mobile**
   - Mobile doesn't know glasses are uploading
   - Could add BLE status messages

## Troubleshooting

### Uploads Not Starting

1. Check charging state: `StateManager.isCharging()`
2. Check WiFi state: `StateManager.isConnectedToWifi()`
3. Check setting: `enable_background_gallery_sync`
4. Check battery level: Must be >= 20%

### Upload Failures

1. Check auth token exists in SharedPreferences
2. Check network connectivity
3. Check cloud endpoint reachable
4. Check file size within limits (20MB for images)

### Uploads Stuck

1. Check if paused: `CloudGalleryUploader.isPaused()`
2. Check queue state: Look at SharedPreferences
3. Clear failed uploads: Delete `cloud_failed_uploads` key
4. Restart service

## Future Enhancements

1. **Chunked Upload**
   - Split large files into 5MB chunks
   - Resume from last successful chunk

2. **Bandwidth Control**
   - Limit upload speed to avoid impacting other apps
   - Pause if network becomes slow

3. **Smart Scheduling**
   - Upload during off-peak hours (2-6 AM)
   - Prioritize recent photos

4. **Compression**
   - Optionally compress photos before upload
   - Save bandwidth and storage costs

5. **Conflict UI**
   - Show warning in mobile when cloud sync active
   - Let user choose to wait or interrupt
