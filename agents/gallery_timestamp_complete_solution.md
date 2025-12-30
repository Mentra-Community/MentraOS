# Gallery Chronological Ordering - Complete Solution

## Problem Statement

When syncing photos and videos from Mentra Live glasses to phone:

1. **Original issue**: Files appeared in download order (all photos, then all videos) instead of capture order
2. **Deeper issue**: Files captured days ago appeared as "today's" photos in gallery

## Root Causes

### Issue 1: Download Order ≠ Capture Order

- Photos download first (small files, fast)
- Videos download second (large files, slow)
- Files saved immediately as downloaded
- Result: Gallery showed all photos first, then all videos

### Issue 2: Sync Time ≠ Capture Time

- Files added to MediaStore with current timestamp
- `DATE_TAKEN` metadata not set to original capture time
- Gallery apps show photos by capture date, not by "date added"
- Result: Photos taken 2 days ago appeared as today's photos

## Complete Solution

### Part 1: Sort Before Save (Fixes Issue 1)

**What**: Download all files, sort by capture time, then save in chronological order

**Why**: Ensures "date added" matches capture order as fallback

**How**:

```typescript
// Sort all files by capture timestamp
const sortedFiles = [...files].sort((a, b) => {
  const timeA = parseInt(a.modified) || Number.MAX_SAFE_INTEGER
  const timeB = parseInt(b.modified) || Number.MAX_SAFE_INTEGER
  return timeA - timeB // Oldest first
})

// Save in chronological order
for (const file of sortedFiles) {
  await saveToGallery(file.path, file.captureTime)
}
```

### Part 2: Set DATE_TAKEN Metadata (Fixes Issue 2)

**What**: Write actual capture timestamp to MediaStore/Photos metadata

**Why**: Gallery apps primarily sort by DATE_TAKEN, not "date added"

**How**: Native module sets metadata using platform APIs

**Android** (`MediaStore.Images.Media.DATE_TAKEN`):

```kotlin
val values = ContentValues().apply {
    put(MediaStore.Images.Media.DATE_TAKEN, captureTimeMillis)
}
resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
```

**iOS** (`PHAsset.creationDate`):

```swift
PHPhotoLibrary.shared().performChanges {
    let request = PHAssetChangeRequest.creationRequestForAsset(from: image)
    request.creationDate = Date(timeIntervalSince1970: captureTimeMillis / 1000)
}
```

## Implementation

### 1. Native Module - `CoreModule.saveToGalleryWithDate()`

**Android**: `mobile/modules/core/android/src/main/java/com/mentra/core/CoreModule.kt`

```kotlin
AsyncFunction("saveToGalleryWithDate") { filePath: String, captureTimeMillis: Long? ->
    val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
        if (captureTimeMillis != null) {
            put(MediaStore.Images.Media.DATE_TAKEN, captureTimeMillis)
        }
    }
    val uri = resolver.insert(collection, values)
    // Copy file data to MediaStore
}
```

**iOS**: `mobile/modules/core/ios/CoreModule.swift`

```swift
AsyncFunction("saveToGalleryWithDate") { (filePath: String, captureTimeMillis: Int64?) ->
    PHPhotoLibrary.shared().performChanges {
        let request = PHAssetChangeRequest.creationRequestForAsset(from: fileURL)
        if let millis = captureTimeMillis {
            request.creationDate = Date(timeIntervalSince1970: Double(millis) / 1000)
        }
    }
}
```

### 2. TypeScript Interface

**File**: `mobile/modules/core/src/CoreModule.ts`

```typescript
declare class CoreModule {
  saveToGalleryWithDate(
    filePath: string,
    captureTimeMillis?: number,
  ): Promise<{success: boolean; uri?: string; error?: string}>
}
```

### 3. Updated MediaLibraryPermissions

**File**: `mobile/src/utils/MediaLibraryPermissions.ts`

```typescript
static async saveToLibrary(filePath: string, creationTime?: number): Promise<boolean> {
  // Use native module instead of MediaLibrary.createAssetAsync
  const result = await CoreModule.saveToGalleryWithDate(cleanPath, creationTime)
  return result.success
}
```

### 4. Gallery Screen - Sort and Save

**File**: `mobile/src/components/glasses/Gallery/GalleryScreen.tsx`

```typescript
// After all files downloaded
const sortedFiles = [...downloadResult.downloaded].sort((a, b) => {
  const timeA = typeof a.modified === "string" ? parseInt(a.modified, 10) : a.modified
  const timeB = typeof b.modified === "string" ? parseInt(b.modified, 10) : b.modified
  return timeA - timeB
})

// Save in chronological order with capture timestamps
for (const photoInfo of sortedFiles) {
  const captureTime = typeof photoInfo.modified === "string" ? parseInt(photoInfo.modified, 10) : photoInfo.modified
  await MediaLibraryPermissions.saveToLibrary(filePath, captureTime)
}
```

## How Gallery Sorting Works

### Android Gallery Apps

1. **DATE_TAKEN** (primary) - `MediaStore.Images.Media.DATE_TAKEN` / `MediaStore.Video.Media.DATE_TAKEN`
2. **DATE_ADDED** (fallback) - when file was added to MediaStore
3. **DATE_MODIFIED** (last resort) - file modification time

### iOS Photos App

1. **creationDate** (primary) - `PHAsset.creationDate`
2. **modificationDate** (fallback) - when file was last modified

## Test Scenarios

### Scenario 1: Same-Day Mixed Media

- Capture: Photo A (10:00), Video B (10:05), Photo C (10:10)
- Sync: 11:00
- **Expected**: A, B, C in order
- **Tests**: ✅ Download order (sort) + ✅ DATE_TAKEN metadata

### Scenario 2: Delayed Sync (2 Days)

- Capture: Photo A (Monday 10:00), Photo B (Monday 10:05)
- Sync: Wednesday 11:00
- **Expected**: Photos appear under Monday in gallery, not Wednesday
- **Tests**: ✅ DATE_TAKEN set to Monday timestamps

### Scenario 3: Mixed with Phone Camera

- Monday 10:00: Take Photo A on phone camera
- Tuesday 10:00: Take Photo B on glasses
- Wednesday: Sync glasses photo
- **Expected**: Gallery shows A (Monday), then B (Tuesday)
- **Tests**: ✅ DATE_TAKEN allows proper interleaving with phone photos

## Verification

### Check Logs

```
[GalleryScreen] Sorted 5 files by capture time:
  1. photo_001.jpg - 2024-01-15T10:00:00.000Z (photo)
  2. video_001.mp4 - 2024-01-15T10:05:00.000Z (video)
  ...
[MediaLibrary] Saved to camera roll with DATE_TAKEN: photo_001.jpg (captured: 2024-01-15T10:00:00.000Z)
CoreModule: Successfully saved to gallery with proper DATE_TAKEN
```

### Check Gallery

1. Open phone's gallery app
2. View by "Date" or "Timeline"
3. Verify:
   - Photos appear on correct dates (not today if captured days ago)
   - Photos and videos interleaved correctly by capture time
   - Order matches capture sequence

### Check Metadata (Android)

```bash
adb shell content query --uri content://media/external/images/media \
  --projection _display_name,datetaken
```

## Files Modified

### Native Modules (New)

1. `mobile/modules/core/android/src/main/java/com/mentra/core/CoreModule.kt` - Android MediaStore DATE_TAKEN
2. `mobile/modules/core/ios/CoreModule.swift` - iOS Photos creationDate
3. `mobile/modules/core/src/CoreModule.ts` - TypeScript interface

### JavaScript/TypeScript

4. `mobile/src/utils/MediaLibraryPermissions.ts` - Calls native module
5. `mobile/src/components/glasses/Gallery/GalleryScreen.tsx` - Sorts files, passes timestamps
6. `mobile/src/types/asg/index.ts` - Type definitions

## Key Benefits

1. **Accurate timestamps**: Photos show actual capture date, not sync date
2. **Chronological ordering**: Mixed photos/videos appear in capture order
3. **Works with delays**: Syncing old photos doesn't make them appear as "new"
4. **Platform native**: Uses official APIs (MediaStore, Photos framework)
5. **Backward compatible**: Gracefully handles missing timestamps
6. **Fast downloads**: Photos still download first for quick feedback

## Status

✅ **COMPLETE** - Both issues resolved:

- Files saved in chronological order (sort before save)
- Metadata includes original capture timestamp (DATE_TAKEN / creationDate)
- Gallery displays media correctly by capture date and time
