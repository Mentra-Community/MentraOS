# Video Thumbnail Feature

## Overview

The video thumbnail feature automatically generates and serves thumbnails for video files when accessed through the `/api/photo` endpoint. This allows video files to be displayed as images in galleries and web interfaces.

## Features

- **Automatic Thumbnail Generation**: Creates thumbnails for video files on-demand
- **Caching**: Thumbnails are cached and reused until the video file is modified
- **Multiple Video Formats**: Supports MP4, AVI, MOV, WMV, FLV, WEBM, MKV, and 3GP
- **Separate Management**: Thumbnails are stored in a dedicated directory for easy management
- **Automatic Cleanup**: Old thumbnails are cleaned up along with old media files

## Architecture

### Components

1. **ThumbnailManager**: Core class responsible for thumbnail generation and management
2. **FileManager Integration**: ThumbnailManager is integrated into the FileManager system
3. **AsgCameraServer**: Modified to serve thumbnails for video files

### File Structure

```
base_directory/
├── camera/                    # Main media files
│   ├── photo1.jpg
│   ├── video1.mp4
│   └── video2.avi
└── thumbnails/               # Thumbnail cache
    ├── a1b2c3d4e5f6.jpg      # Thumbnail for video1.mp4
    └── f6e5d4c3b2a1.jpg      # Thumbnail for video2.avi
```

## API Changes

### `/api/photo` Endpoint

The `/api/photo` endpoint now handles both images and videos:

- **Image files**: Served directly as before
- **Video files**: Returns a generated thumbnail instead

**Example Request:**

```
GET /api/photo?file=video1.mp4
```

**Response:**

- Returns a JPEG thumbnail image
- Content-Type: `image/jpeg`

### `/api/gallery` Endpoint

The gallery endpoint now includes video information:

**Example Response:**

```json
{
  "photos": [
    {
      "name": "photo1.jpg",
      "size": 1024000,
      "modified": "2024-01-15 10:30:00",
      "mime_type": "image/jpeg",
      "url": "/api/photo?file=photo1.jpg",
      "download": "/api/download?file=photo1.jpg",
      "is_video": false
    },
    {
      "name": "video1.mp4",
      "size": 52428800,
      "modified": "2024-01-15 11:00:00",
      "mime_type": "video/mp4",
      "url": "/api/photo?file=video1.mp4",
      "download": "/api/download?file=video1.mp4",
      "is_video": true,
      "thumbnail_url": "/api/photo?file=video1.mp4"
    }
  ],
  "total_count": 2,
  "total_size": 53452800
}
```

### `/api/cleanup` Endpoint

The cleanup endpoint now also cleans up old thumbnails:

**Example Response:**

```json
{
  "message": "Cleanup completed successfully",
  "files_removed": 5,
  "thumbnails_removed": 3,
  "max_age_hours": 24,
  "timestamp": 1705312800000
}
```

### `/api/status` Endpoint

The status endpoint now includes thumbnail metrics:

**Example Response:**

```json
{
  "server": "CameraWebServer",
  "port": 8089,
  "total_photos": 25,
  "thumbnail_count": 8,
  "thumbnail_directory_size": 245760,
  "available_space": 1073741824
}
```

## Configuration

### Thumbnail Settings

Thumbnails are generated with the following default settings:

- **Width**: 320 pixels
- **Height**: 240 pixels
- **Quality**: 80% JPEG compression
- **Format**: JPEG

These settings can be modified in the `ThumbnailManager` class:

```java
private static final int THUMBNAIL_WIDTH = 320;
private static final int THUMBNAIL_HEIGHT = 240;
private static final int THUMBNAIL_QUALITY = 80;
```

### Supported Video Formats

The following video formats are supported for thumbnail generation:

- MP4 (`.mp4`)
- AVI (`.avi`)
- MOV (`.mov`)
- WMV (`.wmv`)
- FLV (`.flv`)
- WebM (`.webm`)
- MKV (`.mkv`)
- 3GP (`.3gp`)

## Implementation Details

### Thumbnail Generation Process

1. **File Detection**: Check if the requested file is a video file
2. **Cache Check**: Look for existing thumbnail in the thumbnails directory
3. **Thumbnail Creation**: If no thumbnail exists or it's outdated:
   - Use `MediaMetadataRetriever` to extract a frame from the video
   - Resize the frame to thumbnail dimensions
   - Compress as JPEG
   - Save to thumbnails directory
4. **Serve Thumbnail**: Return the thumbnail image

### Thumbnail Naming

Thumbnails are named using an MD5 hash of the video file path and modification time:

```
hash(video_path + "_" + last_modified) + ".jpg"
```

This ensures:

- Unique names for different videos
- Automatic regeneration when videos are updated
- No naming conflicts

### Error Handling

- **Invalid Video Files**: Returns error response if thumbnail generation fails
- **Missing Files**: Returns 404 if the requested file doesn't exist
- **Unsupported Formats**: Returns error for unsupported video formats

## Performance Considerations

### Memory Management

- Bitmaps are properly recycled after use
- `MediaMetadataRetriever` is released after each operation
- Thumbnails are compressed to reduce storage size

### Caching Strategy

- Thumbnails are cached until the video file is modified
- Old thumbnails are automatically cleaned up
- Thumbnail directory size is monitored

### Thread Safety

- Thumbnail generation is thread-safe
- Uses the same locking mechanism as the FileManager
- Concurrent requests for the same video are handled properly

## Testing

A comprehensive test suite is included in `ThumbnailManagerTest.java` that covers:

- Thumbnail manager initialization
- Video file detection
- Directory operations
- Error handling
- Edge cases

## Usage Examples

### Web Interface

```html
<!-- Display video thumbnail in gallery -->
<img src="/api/photo?file=video1.mp4" alt="Video thumbnail" />

<!-- Download original video -->
<a href="/api/download?file=video1.mp4">Download Video</a>
```

### API Integration

```javascript
// Fetch gallery and display videos with thumbnails
fetch("/api/gallery")
  .then((response) => response.json())
  .then((data) => {
    data.photos.forEach((photo) => {
      if (photo.is_video) {
        // Display thumbnail for video
        displayThumbnail(photo.thumbnail_url, photo.name)
      } else {
        // Display image directly
        displayImage(photo.url, photo.name)
      }
    })
  })
```

## Troubleshooting

### Common Issues

1. **Thumbnail Generation Fails**
   - Check if the video file is corrupted
   - Verify the video format is supported
   - Check available storage space

2. **Thumbnails Not Updating**
   - Clear the thumbnails directory
   - Check file permissions
   - Verify video file modification time

3. **Performance Issues**
   - Monitor thumbnail directory size
   - Adjust thumbnail dimensions if needed
   - Check available memory

### Debug Information

Enable debug logging to see detailed information about thumbnail operations:

```
ThumbnailManager: Creating thumbnail for video: video1.mp4
ThumbnailManager: Thumbnail created successfully: a1b2c3d4e5f6.jpg (24576 bytes)
AsgCameraServer: 🎥 Serving video thumbnail: video1.mp4 (24576 bytes)
```

## Future Enhancements

Potential improvements for future versions:

- **Custom Thumbnail Times**: Allow specifying the time position for thumbnail extraction
- **Multiple Thumbnails**: Generate thumbnails at different time points
- **Thumbnail Formats**: Support additional formats (PNG, WebP)
- **Batch Processing**: Generate thumbnails for multiple videos at once
- **Cloud Storage**: Store thumbnails in cloud storage for better scalability
