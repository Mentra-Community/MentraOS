# Media I/O Package

A media management system for the ASG client that provides photo, video, and audio capture, processing, caller-provided webhook upload, and BLE transfer functionality.

## 📁 Package Structure

```
io/media/
├── interfaces/
│   ├── ServiceCallbackInterface.java    # Media service callbacks
│   ├── AudioChunkCallback.java          # Audio chunk callbacks
│   └── MediaCaptureCallback.java        # Media capture callbacks
├── core/
│   ├── MediaCaptureService.java         # Core media capture service
│   ├── PhotoCaptureService.java         # Photo capture service
│   └── CameraNeo.java                   # Advanced camera implementation
├── managers/
│   └── MediaUploadQueueManager.java     # Legacy queue metadata cleanup
├── utils/
│   └── MediaUtils.java                  # Media utility functions
└── README.md                            # This documentation
```

## 🔧 Components

### **Media Interfaces**

#### **ServiceCallbackInterface**

Interface for communication between media services and the main application:

- `sendThroughBluetooth(byte[] data)` - Send data via Bluetooth
- `sendFileViaBluetooth(String filePath)` - Send file via Bluetooth

#### **AudioChunkCallback**

Interface for receiving audio chunk notifications:

- `onSuccess(ByteBuffer chunk)` - Called when new audio chunk is available

#### **MediaCaptureCallback**

Interface for media capture event notifications:

- `onCaptureStarted(String mediaType)` - Capture started
- `onCaptureSuccess(String mediaType, File file)` - Capture completed
- `onCaptureError(String mediaType, String error)` - Capture failed
- `onCaptureCancelled(String mediaType)` - Capture cancelled
- `onCaptureProgress(String mediaType, int progress)` - Capture progress

### **Media Core Services**

#### **MediaCaptureService**

Main service for handling photo and video capture:

- **Photo Capture**: High-quality photo capture with auto-exposure
- **Video Recording**: Video recording with configurable quality
- **Webhook Integration**: Direct photo upload to caller-provided webhooks
- **BLE Transfer**: Bluetooth file transfer capabilities
- **Gallery Integration**: Save media to device gallery

#### **PhotoCaptureService**

Specialized service for photo capture operations:

- **Button Press Handling**: Responds to photo button presses
- **Webhook Integration**: REST API calls to caller-provided upload URLs
- **Local Fallback**: Local photo capture when offline
- **Webhook Upload**: Photo upload to caller-provided endpoints

#### **CameraNeo**

Advanced camera implementation with high-quality features:

- **Auto-Exposure**: Dynamic exposure control for optimal quality
- **Auto-Focus**: Automatic focus adjustment
- **High Resolution**: Support for high-resolution capture
- **Video Recording**: Professional video recording capabilities
- **Background Service**: Runs as foreground service for reliability

### **Media Managers**

#### **MediaUploadQueueManager**

Manages legacy queued media metadata:

- **Persistence**: Queue survives app restarts
- **Status Tracking**: Track upload progress and status
- **Legacy Cleanup**: Stale direct-cloud upload entries are marked failed

### **Media Utilities**

#### **MediaUtils**

Utility class for common media operations:

- **File Management**: Create, delete, and manage media files
- **Storage Management**: Check storage space and availability
- **File Naming**: Generate unique filenames with timestamps
- **Gallery Integration**: Scan files for gallery visibility
- **Format Conversion**: File size formatting and utilities

## 🚀 Usage Examples

### **Basic Media Capture**

```java
// Initialize media capture service
MediaCaptureService mediaService = new MediaCaptureService(context, mediaQueueManager);

// Set up callbacks
mediaService.setMediaCaptureListener(new MediaCaptureService.MediaCaptureListener() {
    @Override
    public void onPhotoCaptured(String requestId, String filePath) {
        Log.d("Media", "Photo captured: " + filePath);
    }

    @Override
    public void onVideoRecordingStarted(String requestId, String filePath) {
        Log.d("Media", "Video recording started: " + filePath);
    }

    @Override
    public void onMediaError(String requestId, String error, int mediaType) {
        Log.e("Media", "Media error: " + error);
    }
});

// Take a photo
mediaService.handlePhotoButtonPress();

// Start video recording
mediaService.handleVideoButtonPress();
```

### **Photo Capture with Webhook Upload**

```java
// The phone requests a photo with a caller-provided webhook URL.
// ASG client captures the photo, uploads it to that URL, then reports success/failure.
mediaService.takePhotoAndUpload(
    "/path/to/photo.jpg",
    "request123",
    "https://partner.example/upload",
    "partner-auth-token",
    false,
    "medium",
    false,
    true,
    "auto"
);
```

### **Legacy Queue Cleanup**

```java
// Initialize the legacy queue manager
MediaUploadQueueManager uploadManager = new MediaUploadQueueManager(context);

// Set up callbacks
uploadManager.setMediaQueueCallback(new MediaUploadQueueManager.MediaQueueCallback() {
    @Override
    public void onMediaQueued(String requestId, String filePath, int mediaType) {
        Log.d("Upload", "Media queued: " + filePath);
    }

    @Override
    @Override
    public void onMediaUploadFailed(String requestId, String error, int mediaType) {
        Log.e("Upload", "Legacy upload skipped: " + error);
    }
});

// Stale queued entries are marked failed; direct cloud upload has been removed.
uploadManager.queueMedia("/path/to/media.jpg", "request123", MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
uploadManager.processQueue();
```

### **Media Utilities**

```java
// Generate unique filename
String filename = MediaUtils.generateMediaFilename(MediaUtils.MEDIA_TYPE_PHOTO, "vacation");

// Create media file
File mediaFile = MediaUtils.createMediaFile(context, MediaUtils.MEDIA_TYPE_PHOTO, filename);

// Check storage space
if (MediaUtils.hasEnoughStorageSpace(context, 1024 * 1024)) { // 1MB
    // Proceed with media capture
}

// Scan file for gallery
MediaUtils.scanMediaFile(context, mediaFile.getAbsolutePath());

// Format file size
String sizeStr = MediaUtils.formatFileSize(mediaFile.length());
Log.d("Media", "File size: " + sizeStr);
```

## 🔄 Media Workflow

### **Photo Capture Workflow**

1. **Button Press**: User presses photo button
2. **Request Mode**: Service determines webhook, BLE, or local-save handling
3. **Capture**: Camera captures high-quality photo
4. **Processing**: Photo is processed and optimized
5. **Delivery**: Photo is uploaded to the caller webhook, relayed over BLE, or kept locally
6. **Gallery**: Photo is saved to device gallery when requested
7. **Notification**: User is notified of completion

### **Video Recording Workflow**

1. **Start Recording**: User initiates video recording
2. **Camera Setup**: Camera is configured for video
3. **Recording**: Video is recorded with optimal settings
4. **Stop Recording**: User stops recording
5. **Processing**: Video is processed and compressed
6. **Delivery**: Video remains on device or is handled by the caller flow
7. **Cleanup**: Temporary files are cleaned up

## 🛡️ Features

### **High-Quality Capture**

- **Auto-Exposure**: Dynamic exposure control
- **Auto-Focus**: Automatic focus adjustment
- **High Resolution**: Support for high-resolution capture
- **Quality Optimization**: Automatic quality optimization

### **Delivery Paths**

- **Webhook Upload**: Caller-provided URLs for photo upload
- **BLE Transfer**: Local relay to the phone when needed
- **Local Storage**: Device retention and gallery integration
- **Legacy Cleanup**: Old queued direct-cloud uploads are marked failed

### **Storage Management**

- **Space Monitoring**: Automatic storage space monitoring
- **File Organization**: Organized file structure
- **Cleanup**: Automatic temporary file cleanup
- **Gallery Integration**: Seamless gallery integration

### **Error Handling**

- **Graceful Degradation**: Fallback mechanisms for failures
- **Error Recovery**: Automatic error recovery
- **User Feedback**: Clear user feedback for errors
- **Logging**: Comprehensive error logging

## 📈 Benefits

1. **Unified Interface**: Single interface for all media operations
2. **High Quality**: Professional-grade media capture
3. **Explicit Delivery**: Webhook, BLE, and local-save flows are owned by callers
4. **Storage Efficient**: Optimized storage usage
5. **User Friendly**: Intuitive user experience
6. **Extensible**: Easy to add new media types and features

## 🔮 Future Enhancements

- **AI Enhancement**: AI-powered image and video enhancement
- **Partner Sync**: Optional caller-owned synchronization
- **Live Streaming**: Live video streaming capabilities
- **Advanced Audio**: Multi-channel audio support
- **Media Analytics**: Usage analytics and insights
- **Batch Processing**: Batch media processing capabilities

---

This media I/O package provides a comprehensive, high-quality foundation for all media operations in the ASG client system, supporting photos, videos, and audio with professional-grade features and robust error handling.
