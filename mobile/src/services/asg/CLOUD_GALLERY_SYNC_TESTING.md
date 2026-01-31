# Cloud Gallery Sync - Testing Guide

## Overview

This document provides comprehensive testing procedures for the background gallery cloud sync feature.

## Prerequisites

- Glasses paired with mobile app
- Glasses connected to WiFi
- Mobile app on WiFi
- Cloud backend running (`https://api.mentra.glass` or local dev)

## Test Environment Setup

### 1. Enable Dev Mode

In mobile app:

- Go to Settings → Developer Options
- Enable "Dev Mode"
- Set backend URL if testing locally

### 2. Verify Cloud Credentials

Check cloud `.env` has:

```bash
CLOUDFLARE_ACCOUNT_ID=xxx
CLOUDFLARE_R2_ACCESS_KEY_ID=xxx
CLOUDFLARE_R2_SECRET_ACCESS_KEY=xxx
CLOUDFLARE_R2_GALLERY_BUCKET=mentra-gallery
```

### 3. Check Glasses Settings

Via ADB:

```bash
adb shell
cd /data/data/com.mentra.asg_client/shared_prefs
cat com.mentra.asg_client_preferences.xml | grep background_gallery_sync
```

Should see:

```xml
<boolean name="enable_background_gallery_sync" value="true" />
```

---

## Test Suite

### Test 1: Basic Upload (Glasses → Cloud)

**Objective**: Verify glasses upload photos when charging + WiFi

**Steps**:

1. Take 3 photos on glasses
2. Connect glasses to charger
3. Verify glasses connected to WiFi (not hotspot)
4. Wait 10 seconds

**Expected**:

- Glasses logs show: "🚀 Starting cloud gallery upload"
- Glasses logs show: "📤 Uploading image: IMG_xxx.jpg"
- Glasses logs show: "✅ Upload successful: IMG_xxx.jpg"
- Repeat for all 3 photos

**Verify in Cloud**:

```bash
# Check MongoDB
mongo
use mentraos
db.galleryitems.find({userId: "your@email.com", status: "pending"}).count()
# Should return 3
```

**Logs to Monitor**:

- Glasses: `adb logcat | grep BackgroundGallerySyncManager`
- Glasses: `adb logcat | grep CloudGalleryUploader`
- Cloud: `bun run logs:cloud | grep gallery`

---

### Test 2: Mobile Auto-Download (Cloud → Mobile)

**Objective**: Verify mobile polls and downloads pending photos

**Steps**:

1. Complete Test 1 (3 photos in cloud)
2. Open mobile app
3. Ensure mobile on WiFi
4. Wait 30 seconds (polling interval)

**Expected**:

- Mobile logs show: "[CloudGallerySync] Polling for pending items..."
- Mobile logs show: "[CloudGallerySync] Found 3 pending items"
- Mobile logs show: "[CloudGallerySync] Downloading: IMG_xxx.jpg"
- Mobile logs show: "[CloudGallerySync] ✅ Downloaded: IMG_xxx.jpg"
- Mobile logs show: "[CloudGallerySync] ✅ Marked 3 items as synced"

**Verify**:

- Open Gallery screen in app → see 3 new photos
- Check phone Photos app → see 3 new photos (if autoSaveToCameraRoll enabled)
- Cloud MongoDB: `db.galleryitems.find({userId: "your@email.com", status: "synced"}).count()` → 3

**Logs to Monitor**:

- Mobile: `npx react-native log-ios` or `npx react-native log-android`
- Filter: `grep CloudGallerySync`

---

### Test 3: Deduplication (WiFi Direct + Cloud)

**Objective**: Verify same photo doesn't save twice

**Steps**:

1. Take 1 photo on glasses
2. Sync via WiFi Direct (manual sync button)
3. Wait for sync to complete
4. Keep glasses charging + WiFi
5. Wait 1 minute (glasses upload to cloud)
6. Mobile should poll and detect duplicate

**Expected**:

- Mobile logs show: "[CloudGallerySync] Found 1 pending items"
- Mobile logs show: "[FileHashUtil] Duplicate detected: temp_IMG_xxx.jpg matches IMG_xxx.jpg"
- Mobile logs show: "[CloudGallerySync] Skipping duplicate: IMG_xxx.jpg"
- Mobile logs show: "[CloudGallerySync] ✅ Marked 1 items as synced"
- Gallery shows only 1 photo (not 2)

**Verify**:

- Gallery count doesn't increase
- Cloud item marked as synced (deleted from R2)

---

### Test 4: Conflict Management (WiFi Direct Interrupts Cloud)

**Objective**: Verify cloud upload pauses for WiFi Direct sync

**Steps**:

1. Take 10 photos on glasses
2. Connect to charger + WiFi
3. Wait for cloud upload to start (monitor logs)
4. When 50% uploaded, tap "Sync Gallery" in mobile app

**Expected**:

- Glasses logs show: "⚠️ Cloud sync in progress - pausing for WiFi Direct"
- Glasses logs show: "⏸️ Pausing cloud upload"
- WiFi Direct sync completes successfully
- After WiFi Direct done, glasses logs show: "▶️ Resuming cloud upload"
- Remaining photos upload to cloud

**Verify**:

- No upload failures
- All 10 photos eventually in cloud
- No network errors

---

### Test 5: Cellular Detection (Mobile)

**Objective**: Verify mobile doesn't download on cellular

**Steps**:

1. Upload 3 photos to cloud (via Test 1)
2. Disconnect mobile from WiFi
3. Connect to cellular data
4. Open mobile app
5. Wait 2 minutes

**Expected**:

- Mobile logs show: "[CloudGallerySync] Cellular detected - stopping polling"
- NO download attempts
- Gallery screen shows cloud banner: "3 photos in cloud - will download on WiFi"

**Verify**:

- No network requests to cloud
- Photos not in local storage

---

### Test 6: WiFi Reconnection (Mobile)

**Objective**: Verify download resumes when WiFi returns

**Steps**:

1. Continue from Test 5 (3 photos pending, mobile on cellular)
2. Connect mobile to WiFi
3. Wait 30 seconds

**Expected**:

- Mobile logs show: "[CloudGallerySync] WiFi connected - starting cloud sync polling"
- Mobile logs show: "[CloudGallerySync] Found 3 pending items"
- Downloads start automatically

**Verify**:

- Photos appear in gallery
- Cloud items marked as synced

---

### Test 7: Large File Upload (Video)

**Objective**: Verify video upload via presigned URL

**Note**: Video upload is marked as "not yet implemented" in current code. This test will be skipped until implementation complete.

**Steps**:

1. Record 30-second video on glasses
2. Connect to charger + WiFi
3. Wait for upload

**Expected** (when implemented):

- Glasses request presigned URL from cloud
- Upload directly to R2/OSS
- Confirm completion with cloud
- Mobile downloads video

---

### Test 8: Auth Token Expiry

**Objective**: Verify handling of expired JWT token

**Steps**:

1. Manually expire token in cloud (or wait 24 hours)
2. Glasses try to upload
3. Observe error handling

**Expected**:

- Glasses logs show: "🔐 Authentication error - pausing upload"
- Glasses logs show: "Need to request new auth token from mobile"
- Upload pauses (doesn't retry with bad token)

**Manual Recovery**:

- Disconnect/reconnect Bluetooth to get fresh token
- Upload resumes

---

### Test 9: Storage Space Check

**Objective**: Verify behavior when mobile storage full

**Steps**:

1. Fill mobile storage (leave <100MB free)
2. Upload 500MB of photos to cloud
3. Mobile tries to download

**Expected**:

- Download fails gracefully
- Error message shown to user
- No app crash

**Note**: Current implementation doesn't check free space - this is a known gap to address.

---

### Test 10: Settings Toggle

**Objective**: Verify settings control sync behavior

**Steps**:

1. Go to Gallery Settings
2. Disable "Enable Cloud Sync"
3. Upload photos to cloud
4. Mobile on WiFi
5. Wait 2 minutes

**Expected**:

- No downloads occur
- Cloud banner shows pending count but no auto-download

**Then**: 6. Enable "Enable Cloud Sync" 7. Wait 30 seconds

**Expected**:

- Downloads start immediately

---

## Performance Benchmarks

### Upload Speed (Glasses)

| File Type    | Size  | Expected Time | Network        |
| ------------ | ----- | ------------- | -------------- |
| Photo (JPEG) | 2MB   | 2-5 seconds   | WiFi (10 Mbps) |
| Photo (JPEG) | 5MB   | 5-10 seconds  | WiFi (10 Mbps) |
| Video (MP4)  | 50MB  | 40-60 seconds | WiFi (10 Mbps) |
| Video (MP4)  | 500MB | 7-10 minutes  | WiFi (10 Mbps) |

### Download Speed (Mobile)

| File Type    | Size  | Expected Time | Network        |
| ------------ | ----- | ------------- | -------------- |
| Photo (JPEG) | 2MB   | 1-3 seconds   | WiFi (20 Mbps) |
| Photo (JPEG) | 5MB   | 3-6 seconds   | WiFi (20 Mbps) |
| Video (MP4)  | 50MB  | 20-30 seconds | WiFi (20 Mbps) |
| Video (MP4)  | 500MB | 3-5 minutes   | WiFi (20 Mbps) |

### Polling Overhead

- **Active polling**: 1 request every 30s = ~2 requests/minute
- **Idle polling**: 1 request every 10 minutes = 6 requests/hour
- **Bandwidth**: ~500 bytes per poll request (minimal)

---

## Known Issues & Limitations

### Current Implementation Gaps

1. **Video Upload Not Implemented**
   - Videos currently skipped with "not yet implemented" error
   - Need to add presigned URL flow

2. **No Free Space Check**
   - Mobile doesn't check available storage before download
   - Could fail if disk full

3. **No Chunked Upload**
   - Large files upload in single request
   - If interrupted, must restart from beginning

4. **No Conflict Warning in UI**
   - Mobile doesn't show warning when cloud sync active
   - User might not know WiFi Direct will pause cloud upload

### Future Enhancements

1. **Push Notifications**
   - Instead of polling, cloud could push notification via WebSocket
   - Would reduce latency from ~15s to <1s

2. **Thumbnail Generation**
   - Cloud could generate thumbnails for faster preview
   - Mobile downloads thumbnails first, full-res on demand

3. **Selective Download**
   - User can choose which photos to download
   - Not all-or-nothing

4. **Upload Progress in Mobile**
   - Show glasses upload progress in mobile app
   - Via BLE status messages

---

## Debugging Tips

### Glasses Not Uploading

Check:

1. Is charging? `adb shell dumpsys battery | grep level`
2. Is WiFi connected? `adb shell dumpsys wifi | grep "Wi-Fi is"`
3. Has auth token? `adb shell run-as com.mentra.asg_client cat shared_prefs/*.xml | grep auth_token`
4. Is setting enabled? Check SharedPreferences for `enable_background_gallery_sync`

### Mobile Not Downloading

Check:

1. Is WiFi connected? Check NetInfo in dev tools
2. Has auth token? Check `restComms.getCoreToken()` in console
3. Is polling active? Check logs for "[CloudGallerySync] Polling"
4. Are items pending? Call `/api/client/asg/gallery/pending` manually via Postman

### Cloud Issues

Check:

1. Are R2 credentials valid? Test with AWS CLI
2. Is MongoDB connected? Check cloud logs
3. Are files in R2? Check Cloudflare dashboard
4. Are presigned URLs valid? Test URL in browser

---

## Manual Testing Commands

### Test Cloud Upload Endpoint

```bash
# Get JWT token from mobile app (check logs or storage)
TOKEN="your_jwt_token_here"

# Upload test image
curl -X POST https://api.mentra.glass/api/client/asg/gallery/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@test_image.jpg" \
  -F "filename=test_image.jpg" \
  -F "capturedAt=2026-01-19T12:00:00.000Z" \
  -F "deviceId=test_device"
```

### Test Mobile Download Endpoint

```bash
# Get pending items
curl -X GET "https://api.mentra.glass/api/client/asg/gallery/pending?limit=10" \
  -H "Authorization: Bearer $TOKEN"

# Mark as synced
curl -X POST https://api.mentra.glass/api/client/asg/gallery/mark-synced \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ids": ["item_id_1", "item_id_2"]}'
```

### Check MongoDB

```bash
# Connect to MongoDB
mongo

# Switch to database
use mentraos

# Count pending items
db.galleryitems.find({userId: "your@email.com", status: "pending"}).count()

# List pending items
db.galleryitems.find({userId: "your@email.com", status: "pending"}).pretty()

# Check synced items
db.galleryitems.find({userId: "your@email.com", status: "synced"}).count()
```

---

## Success Criteria

All tests must pass before marking feature as complete:

- ✅ Test 1: Basic Upload
- ✅ Test 2: Mobile Auto-Download
- ✅ Test 3: Deduplication
- ✅ Test 4: Conflict Management
- ✅ Test 5: Cellular Detection
- ✅ Test 6: WiFi Reconnection
- ⏳ Test 7: Large File Upload (pending video implementation)
- ✅ Test 8: Auth Token Expiry
- ⏳ Test 9: Storage Space Check (pending implementation)
- ✅ Test 10: Settings Toggle

**Minimum Passing Grade**: 8/10 tests passing (excluding video upload and storage check)
