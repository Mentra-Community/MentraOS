# Media I/O Package

A comprehensive media management system for the ASG client that provides photo, video, and audio capture, processing, and upload functionality.

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
│   ├── MediaUploadQueueManager.java     # Media upload queue management
│   ├── PhotoQueueManager.java           # Photo queue management
│   └── GlassesMicrophoneManager.java    # Microphone management (REMOVED)
├── upload/
│   ├── MediaUploadService.java          # Media upload service
│   └── PhotoUploadService.java          # Photo upload service
├── utils/
│   └── MediaUtils.java                  # Media utility functions
└── README.md                            # This documentation
```

**Note:** GlassesMicrophoneManager was removed in recent refactoring. Audio management is now handled elsewhere in the codebase.

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
- **Upload Integration**: Automatic upload to cloud services
- **BLE Transfer**: Bluetooth file transfer capabilities
- **Gallery Integration**: Save media to device gallery

#### **PhotoCaptureService**

Specialized service for photo capture operations:

- **Button Press Handling**: Responds to photo button presses
- **Cloud Integration**: REST API calls to cloud servers
- **Local Fallback**: Local photo capture when offline
- **Upload Management**: Photo upload to cloud services

#### **CameraNeo**

Advanced camera implementation with high-quality features:

- **Auto-Exposure**: Dynamic exposure control for optimal quality
- **Auto-Focus**: Automatic focus adjustment
- **High Resolution**: Support for high-resolution capture
- **Video Recording**: Professional video recording capabilities
- **Background Service**: Runs as foreground service for reliability

### **Media Managers**

#### **MediaUploadQueueManager**

Manages queues of media files for upload:

- **Persistence**: Queue survives app restarts
- **Retry Logic**: Automatic retry of failed uploads
- **Status Tracking**: Track upload progress and status
- **Batch Processing**: Process multiple uploads efficiently
- **Error Handling**: Robust error handling and recovery

#### **PhotoQueueManager**

Specialized queue manager for photo uploads:

- **Photo-Specific Logic**: Optimized for photo upload workflows
- **Metadata Management**: Track photo metadata and settings
- **Compression**: Automatic photo compression for upload
- **Gallery Integration**: Save photos to device gallery

### **Media Upload Services**

#### **MediaUploadService**

Foreground service for media upload management:

- **Background Processing**: Upload media in background
- **User Notifications**: Keep users informed of upload progress
- **Queue Processing**: Process upload queues automatically
- **Network Management**: Handle network connectivity issues
- **Statistics Tracking**: Track upload success/failure rates

#### **PhotoUploadService**

Specialized service for photo uploads:

- **Photo-Specific Upload**: Optimized for photo file formats
- **Metadata Handling**: Preserve photo metadata during upload
- **Compression**: Automatic compression for faster uploads
- **Gallery Integration**: Update gallery after successful upload

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

### **Photo Capture with Upload**

```java
// Initialize photo capture service
PhotoCaptureService photoService = new PhotoCaptureService(context, photoQueueManager);

// Set up callbacks
photoService.setPhotoCaptureListener(new PhotoCaptureService.PhotoCaptureListener() {
    @Override
    public void onPhotoCaptured(String requestId, String filePath) {
        Log.d("Photo", "Photo captured: " + filePath);
    }

    @Override
    public void onPhotoUploaded(String requestId, String url) {
        Log.d("Photo", "Photo uploaded: " + url);
    }

    @Override
    public void onPhotoError(String requestId, String error) {
        Log.e("Photo", "Photo error: " + error);
    }
});

// Take photo and upload
photoService.takePhotoAndUpload("/path/to/photo.jpg", "request123", "app456");
```

### **Media Upload Management**

```java
// Initialize upload queue manager
MediaUploadQueueManager uploadManager = new MediaUploadQueueManager(context);

// Set up callbacks
uploadManager.setMediaQueueCallback(new MediaUploadQueueManager.MediaQueueCallback() {
    @Override
    public void onMediaQueued(String requestId, String filePath, int mediaType) {
        Log.d("Upload", "Media queued: " + filePath);
    }

    @Override
    public void onMediaUploaded(String requestId, String url, int mediaType) {
        Log.d("Upload", "Media uploaded: " + url);
    }

    @Override
    public void onMediaUploadFailed(String requestId, String error, int mediaType) {
        Log.e("Upload", "Upload failed: " + error);
    }
});

// Queue media for upload
uploadManager.queueMedia("/path/to/media.jpg", "request123", MediaUploadQueueManager.MEDIA_TYPE_PHOTO);

// Process upload queue
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
2. **Cloud Check**: Service checks cloud connectivity
3. **Capture**: Camera captures high-quality photo
4. **Processing**: Photo is processed and optimized
5. **Queue**: Photo is added to upload queue
6. **Upload**: Photo is uploaded to cloud service
7. **Gallery**: Photo is saved to device gallery
8. **Notification**: User is notified of completion

### **Video Recording Workflow**

1. **Start Recording**: User initiates video recording
2. **Camera Setup**: Camera is configured for video
3. **Recording**: Video is recorded with optimal settings
4. **Stop Recording**: User stops recording
5. **Processing**: Video is processed and compressed
6. **Queue**: Video is added to upload queue
7. **Upload**: Video is uploaded to cloud service
8. **Cleanup**: Temporary files are cleaned up

## 🛡️ Features

### **High-Quality Capture**

- **Auto-Exposure**: Dynamic exposure control
- **Auto-Focus**: Automatic focus adjustment
- **High Resolution**: Support for high-resolution capture
- **Quality Optimization**: Automatic quality optimization

### **Robust Upload System**

- **Queue Management**: Persistent upload queues
- **Retry Logic**: Automatic retry of failed uploads
- **Network Handling**: Graceful network connectivity handling
- **Progress Tracking**: Real-time upload progress tracking

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
3. **Reliable Upload**: Robust upload system with retry logic
4. **Storage Efficient**: Optimized storage usage
5. **User Friendly**: Intuitive user experience
6. **Extensible**: Easy to add new media types and features

## 🔮 Future Enhancements

- **AI Enhancement**: AI-powered image and video enhancement
- **Cloud Sync**: Real-time cloud synchronization
- **Live Streaming**: Live video streaming capabilities
- **Advanced Audio**: Multi-channel audio support
- **Media Analytics**: Usage analytics and insights
- **Batch Processing**: Batch media processing capabilities

---

This media I/O package provides a comprehensive, high-quality foundation for all media operations in the ASG client system, supporting photos, videos, and audio with professional-grade features and robust error handling.
