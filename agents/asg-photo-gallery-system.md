# ASG Photo Gallery System Architecture

## Overview

The ASG (AugmentOS Smart Glasses) photo gallery system enables photo/video capture on smart glasses, storage, and synchronization with mobile devices. The system uses advanced compression (AVIF) for efficient transmission and supports multiple media formats.

## System Components

### 1. Smart Glasses (ASG Client)

#### Camera System

- **File**: `asg_client/app/src/main/java/com/augmentos/asg_client/camera/CameraNeo.java`
- **Features**:
  - Photo capture at 1440x1080 resolution
  - Video recording at 720p
  - Buffer recording for continuous capture
  - Auto-exposure and auto-focus

#### Media Capture Service

- **File**: `asg_client/app/src/main/java/com/augmentos/asg_client/MediaCaptureService.java`
- **AVIF Compression**:
  - Uses `com.github.awxkee:avif-coder:1.7.3` library
  - Compresses images for BLE transmission
  - Saves without file extensions (e.g., `I634744046` instead of `I634744046.avif`)
  - Falls back to JPEG if AVIF encoding fails

#### File Management

- **Location**: `asg_client/app/src/main/java/com/augmentos/asg_client/io/file/`
- **Components**:
  - `FileManager`: Central file operations
  - `MimeTypeRegistry`: File type detection
  - `ThumbnailManager`: Video thumbnail generation

### 2. Camera Web Server

#### Server Configuration

- **File**: `asg_client/app/src/main/java/com/augmentos/asg_client/server/AsgCameraServer.java`
- **Port**: 8089
- **Framework**: NanoHTTPD

#### API Endpoints

| Endpoint                     | Method | Description                          |
| ---------------------------- | ------ | ------------------------------------ |
| `/api/gallery`               | GET    | List all photos/videos with metadata |
| `/api/photo?file={name}`     | GET    | Retrieve specific photo/video        |
| `/api/download?file={name}`  | GET    | Download file                        |
| `/api/take-picture`          | POST   | Trigger photo capture                |
| `/api/sync`                  | GET    | Get changed files since last sync    |
| `/api/delete`                | POST   | Delete files from server             |
| `/api/thumbnail?file={name}` | GET    | Get video thumbnail                  |

#### Response Formats

**Gallery Response:**

```json
{
  "status": "success",
  "data": {
    "photos": [
      {
        "name": "IMG_20250808_192645.jpg",
        "size": 343276,
        "modified": "2025-08-08 19:26:46",
        "mime_type": "image/jpeg",
        "url": "/api/photo?file=IMG_20250808_192645.jpg",
        "download": "/api/download?file=IMG_20250808_192645.jpg",
        "is_video": false
      }
    ],
    "total_count": 9,
    "total_size": 1165598,
    "package_name": "com.mentra.asg_client.camera"
  }
}
```

**Sync Response:**

```json
{
  "status": "success",
  "data": {
    "client_id": "mobile_xxx",
    "changed_files": [...],
    "deleted_files": [],
    "server_time": 1754682057692,
    "total_changed": 9,
    "total_size": 1165598
  }
}
```

### 3. Mobile App Integration

#### API Client

- **File**: `mobile/src/app/asg/services/asgCameraApi.ts`
- **Features**:
  - Dynamic server URL configuration
  - Rate limiting and retry logic
  - Batch file operations
  - Sync state management

#### Gallery Screen

- **File**: `mobile/src/app/asg/components/Gallery/GalleryScreen.tsx`
- **UI Features**:
  - Dual tabs: Server photos / Downloaded photos
  - Grid layout with responsive columns
  - Modal photo viewer
  - Sync progress indicator
  - Long-press to delete

#### Local Storage Service

- **File**: `mobile/src/app/asg/services/localStorageService.ts`
- **Functions**:
  - Stores downloaded photos/videos
  - Tracks sync state (client ID, last sync time)
  - Converts between PhotoInfo and DownloadedFile formats

## File Format Support

### Supported MIME Types

- **Images**: JPEG, PNG, GIF, BMP, WebP, SVG
- **Videos**: MP4, AVI, MOV, WMV, FLV, WebM, MKV, 3GP
- **Special**: AVIF (for BLE optimization)

### AVIF File Handling

**Why AVIF?**

- 50% better compression than JPEG
- Optimized for BLE transmission
- Maintains quality at smaller file sizes

**Current Issues:**

1. **Files without extensions**: BLE optimization saves files as `I634744046` instead of `I634744046.avif`
2. **MIME type detection failure**: AVIF not registered in `MimeTypeRegistry.java`
3. **Display as "application/octet-stream"**: Fallback MIME type for unknown formats

## Sync Workflow

### 1. Connection

```
Mobile App → Discovers glasses WiFi IP from status
Mobile App → Connects to http://{glasses_ip}:8089
```

### 2. Initial Gallery Load

```
Mobile App → GET /api/gallery
Glasses → Returns list of all photos/videos
Mobile App → Displays in grid
```

### 3. Sync Process

```
Mobile App → GET /api/sync?client_id={id}&last_sync={timestamp}
Glasses → Returns changed_files array
Mobile App → Downloads files in batches of 3
Mobile App → Saves to local storage
Mobile App → Updates sync state
Mobile App → (Optional) DELETE /api/delete to clean server
```

### 4. File Download

```
For each file:
  Mobile App → GET /api/photo?file={name}
  Glasses → Returns file as blob
  Mobile App → Converts to data URL
  Mobile App → Stores locally
```

## Network Architecture

```
┌─────────────────┐         WiFi Network        ┌──────────────┐
│  Smart Glasses  │ ◄────────────────────────► │ Mobile Phone │
├─────────────────┤                             ├──────────────┤
│ Camera Module   │                             │ Gallery App  │
│ AVIF Encoder    │                             │ Sync Manager │
│ Web Server:8089 │                             │ Local Storage│
│ File System     │                             │ API Client   │
└─────────────────┘                             └──────────────┘
```

## Known Issues and Solutions

### Issue 1: AVIF Files Show as "application/octet-stream"

**Root Cause:**

- AVIF MIME type not registered in `MimeTypeRegistry.java`
- Files saved without extensions for BLE compatibility

**Solution:**

1. Add AVIF support to `MimeTypeRegistry.java`:

```java
mimeTypeMap.put("avif", "image/avif");
mimeTypeMap.put("avifs", "image/avif-sequence");
```

2. Update file detection to handle extension-less AVIF files:

```java
// Check file header for AVIF signature
if (isAvifFile(fileContent)) {
    return "image/avif";
}
```

### Issue 2: Images Not Displaying in Gallery

**Root Cause:**

- React Native Image component doesn't support AVIF format natively
- Files with "application/octet-stream" MIME type not rendered

**Solution:**

1. Convert AVIF to JPEG/PNG on download
2. Use thumbnail data for preview
3. Implement AVIF decoder in React Native

### Issue 3: Sync Hanging at 0/9

**Root Cause:**

- AVIF files being served as text instead of binary
- FileReader fails to process binary data as text

**Solution:**

1. Ensure proper blob handling in `downloadFile` method
2. Check Content-Type headers in server response
3. Handle AVIF files as binary blobs

## Performance Optimizations

1. **Caching**: Frequently accessed files cached in memory
2. **Compression**: AVIF reduces file sizes by 50%
3. **Batch Operations**: Process multiple files together
4. **Thumbnails**: Generate for videos to improve load times
5. **Rate Limiting**: 100 requests/minute to prevent overload

## Security Considerations

1. **Path Traversal Protection**: Validates file paths
2. **Rate Limiting**: Prevents DoS attacks
3. **CORS Headers**: Controls cross-origin access
4. **File Size Limits**: Prevents memory exhaustion

## Development Guidelines

### Adding New File Formats

1. Update `MimeTypeRegistry.java` with MIME type mapping
2. Add file header detection if needed
3. Update mobile app to handle new format
4. Test sync and display functionality

### Debugging Sync Issues

1. Check glasses WiFi connection status
2. Verify server is running on port 8089
3. Monitor network requests in mobile app logs
4. Check sync state in AsyncStorage
5. Verify file permissions on glasses

### Testing Checklist

- [ ] Photo capture and save
- [ ] Video recording
- [ ] Gallery load from server
- [ ] Sync process completion
- [ ] File download and local storage
- [ ] Image display in gallery
- [ ] Delete functionality
- [ ] Offline mode with downloaded photos

## Future Improvements

1. **Progressive Image Loading**: Load thumbnails first, then full images
2. **WebP Support**: Additional compression format
3. **Background Sync**: Automatic sync when connected
4. **Cloud Backup**: Optional cloud storage integration
5. **Smart Caching**: Predictive pre-loading of images
6. **HEIF/HEIC Support**: iOS-compatible formats
