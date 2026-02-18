# OTA I/O Package

A comprehensive Over-The-Air (OTA) update management system for the ASG client that provides unified OTA operations across different update mechanisms, with robust download, installation, and rollback capabilities.

## 📁 Package Structure

```
io/ota/
├── interfaces/
│   ├── IOtaService.java                 # Core OTA service interface
│   ├── IOtaHelper.java                  # Core OTA helper interface
│   └── OtaProgressCallback.java         # OTA progress callback
├── core/
│   ├── BaseOtaService.java              # Abstract base OTA service
│   ├── OtaServiceFactory.java           # Factory for OTA services
│   └── OtaManager.java                  # Central OTA manager
├── services/
│   ├── OtaService.java                  # OTA service implementation
│   └── OtaServiceBinder.java            # Service binder implementation
├── helpers/
│   ├── OtaHelper.java                   # OTA helper implementation
│   └── OtaDownloadManager.java          # Download management
├── events/
│   ├── DownloadProgressEvent.java       # Download progress events
│   ├── InstallationProgressEvent.java   # Installation progress events
│   └── OtaEventBus.java                 # Event bus wrapper
├── utils/
│   ├── OtaUtils.java                    # OTA utilities
│   ├── OtaNotificationManager.java      # Notification management
│   └── OtaConstants.java                # OTA constants
└── README.md                            # This documentation
```

## 🔧 Components

### **OTA Interfaces**

#### **IOtaService**

Core interface for OTA service operations:

- `initialize(Context context)` - Initialize the OTA service
- `startService()` - Start the OTA service
- `stopService()` - Stop the OTA service
- `isServiceRunning()` - Check if service is running
- `checkForUpdates()` - Check for available updates
- `downloadUpdate(String updateUrl)` - Download an update
- `installUpdate(String apkPath)` - Install a downloaded update
- `getStatus()` - Get current OTA status
- `setProgressCallback(OtaProgressCallback callback)` - Set progress callback
- `removeProgressCallback()` - Remove progress callback
- `getStatistics()` - Get OTA statistics
- `shutdown()` - Cleanup resources

#### **IOtaHelper**

Core interface for OTA helper operations:

- `initialize(Context context)` - Initialize the OTA helper
- `startVersionCheck(Context context)` - Start version checking
- `isCheckingVersion()` - Check if version checking is in progress
- `isUpdating()` - Check if update is in progress
- `downloadApk(String urlStr, JSONObject json, Context context)` - Download APK file
- `installApk(Context context)` - Install APK file
- `checkOlderApkFile(Context context)` - Check for older APK files
- `reinstallApkFromBackup()` - Reinstall APK from backup
- `saveBackupApk(String sourceApkPath)` - Save backup APK
- `getBatteryStatusString()` - Get battery status string
- `isBatterySufficientForUpdates()` - Check if battery is sufficient
- `startPeriodicChecks()` - Start periodic checks
- `registerNetworkCallback(Context context)` - Register network callback
- `cleanup()` - Cleanup resources

#### **OtaProgressCallback**

Interface for receiving OTA progress updates:

- `onOtaCheckStarted()` - OTA check starts
- `onOtaCheckCompleted(boolean hasUpdate, String versionInfo)` - OTA check completes
- `onOtaCheckFailed(String error)` - OTA check fails
- `onDownloadStarted(long totalBytes)` - Download starts
- `onDownloadProgress(int progress, long bytesDownloaded, long totalBytes)` - Download progress
- `onDownloadCompleted(String apkPath)` - Download completes
- `onDownloadFailed(String error)` - Download fails
- `onInstallationStarted(String apkPath)` - Installation starts
- `onInstallationCompleted(String apkPath)` - Installation completes
- `onInstallationFailed(String error)` - Installation fails
- `onBackupCreated(String backupPath)` - Backup created
- `onBackupRestorationStarted(String backupPath)` - Backup restoration starts
- `onBackupRestorationCompleted(String backupPath)` - Backup restoration completes
- `onBackupRestorationFailed(String error)` - Backup restoration fails
- `onBatteryStatusChanged(int batteryLevel, boolean isCharging)` - Battery status changes
- `onNetworkStatusChanged(boolean isAvailable)` - Network status changes

### **OTA Events**

#### **DownloadProgressEvent**

Event for download progress updates:

- **STARTED** - Download started
- **PROGRESS** - Download progress update
- **FINISHED** - Download finished
- **FAILED** - Download failed

#### **InstallationProgressEvent**

Event for installation progress updates:

- **STARTED** - Installation started
- **FINISHED** - Installation finished
- **FAILED** - Installation failed

### **OTA Services**

#### **OtaService**

OTA service implementation:

- **Service Management**: Android service lifecycle management
- **Notification Management**: User-friendly notifications
- **Event Handling**: EventBus integration for progress updates
- **Battery Monitoring**: Battery status monitoring
- **Network Monitoring**: Network availability monitoring
- **External App Management**: Prevents conflicts with external OTA updaters

### **OTA Helpers**

#### **OtaHelper**

OTA helper implementation:

- **Version Checking**: Automatic version checking with retry logic
- **Download Management**: Robust download with progress tracking
- **Installation Management**: APK installation with verification
- **Backup Management**: Automatic backup creation and restoration
- **Battery Management**: Battery-aware update operations
- **Network Management**: Network-aware update operations
- **Periodic Checks**: Scheduled update checks
- **Error Handling**: Comprehensive error handling and recovery

### **OTA Utilities**

#### **OtaUtils**

Utility class for OTA operations:

- **Version Management**: Get current app version information
- **File Integrity**: MD5 hash calculation and verification
- **Storage Management**: Storage space checking and management
- **File Validation**: APK file validation
- **Formatting**: File size and speed formatting
- **Progress Calculation**: Download progress calculation
- **Cleanup**: Old APK file cleanup

#### **OtaNotificationManager**

Notification management for OTA:

- **Service Notifications**: OTA service status notifications
- **Download Notifications**: Download progress notifications
- **Installation Notifications**: Installation status notifications
- **Error Notifications**: Error notifications
- **Notification Channels**: Android O+ notification channels
- **Progress Tracking**: Real-time progress tracking

#### **OtaConstants**

OTA constants and configuration:

- **URLs**: Version check and update URLs
- **Paths**: APK and backup file paths
- **Actions**: Intent actions for OTA operations
- **Timeouts**: Update timeout configurations
- **Intervals**: Periodic check intervals
- **Package Names**: Application package names

## 🚀 Usage Examples

### **Basic OTA Service Setup**

```java
// Get OTA service
OtaService otaService = new OtaService();

// Initialize
otaService.initialize(context);

// Set progress callback
otaService.setProgressCallback(new OtaProgressCallback() {
    @Override
    public void onOtaCheckStarted() {
        Log.d("OTA", "OTA check started");
    }

    @Override
    public void onOtaCheckCompleted(boolean hasUpdate, String versionInfo) {
        if (hasUpdate) {
            Log.d("OTA", "Update available: " + versionInfo);
        } else {
            Log.d("OTA", "No update available");
        }
    }

    @Override
    public void onOtaCheckFailed(String error) {
        Log.e("OTA", "OTA check failed: " + error);
    }

    @Override
    public void onDownloadStarted(long totalBytes) {
        Log.d("OTA", "Download started: " + totalBytes + " bytes");
    }

    @Override
    public void onDownloadProgress(int progress, long bytesDownloaded, long totalBytes) {
        Log.d("OTA", "Download progress: " + progress + "%");
    }

    @Override
    public void onDownloadCompleted(String apkPath) {
        Log.d("OTA", "Download completed: " + apkPath);
    }

    @Override
    public void onDownloadFailed(String error) {
        Log.e("OTA", "Download failed: " + error);
    }

    @Override
    public void onInstallationStarted(String apkPath) {
        Log.d("OTA", "Installation started: " + apkPath);
    }

    @Override
    public void onInstallationCompleted(String apkPath) {
        Log.d("OTA", "Installation completed: " + apkPath);
    }

    @Override
    public void onInstallationFailed(String error) {
        Log.e("OTA", "Installation failed: " + error);
    }
});

// Start service
boolean success = otaService.startService();
if (success) {
    Log.d("OTA", "OTA service started successfully");
} else {
    Log.e("OTA", "Failed to start OTA service");
}
```

### **OTA Helper Operations**

```java
// Create OTA helper
OtaHelper otaHelper = new OtaHelper(context);

// Start version check
boolean checkStarted = otaHelper.startVersionCheck(context);
if (checkStarted) {
    Log.d("OTA", "Version check started");
}

// Download APK
String updateUrl = "https://server.com/update.apk";
JSONObject metadata = new JSONObject();
metadata.put("version", "1.2.3");
metadata.put("md5", "abc123...");

boolean downloadStarted = otaHelper.downloadApk(updateUrl, metadata, context);
if (downloadStarted) {
    Log.d("OTA", "APK download started");
}

// Install APK
boolean installStarted = otaHelper.installApk(context);
if (installStarted) {
    Log.d("OTA", "APK installation started");
}

// Check battery status
String batteryStatus = otaHelper.getBatteryStatusString();
Log.d("OTA", "Battery status: " + batteryStatus);

boolean batterySufficient = otaHelper.isBatterySufficientForUpdates();
if (batterySufficient) {
    Log.d("OTA", "Battery sufficient for updates");
} else {
    Log.w("OTA", "Battery insufficient for updates");
}
```

### **OTA Events**

```java
// Listen for download progress events
@Subscribe(threadMode = ThreadMode.MAIN)
public void onDownloadProgress(DownloadProgressEvent event) {
    switch (event.getStatus()) {
        case STARTED:
            Log.d("OTA", "Download started: " + event.getTotalBytes() + " bytes");
            break;
        case PROGRESS:
            Log.d("OTA", "Download progress: " + event.getProgress() + "%");
            break;
        case FINISHED:
            Log.d("OTA", "Download finished");
            break;
        case FAILED:
            Log.e("OTA", "Download failed: " + event.getErrorMessage());
            break;
    }
}

// Listen for installation progress events
@Subscribe(threadMode = ThreadMode.MAIN)
public void onInstallationProgress(InstallationProgressEvent event) {
    switch (event.getStatus()) {
        case STARTED:
            Log.d("OTA", "Installation started: " + event.getApkPath());
            break;
        case FINISHED:
            Log.d("OTA", "Installation finished: " + event.getApkPath());
            break;
        case FAILED:
            Log.e("OTA", "Installation failed: " + event.getErrorMessage());
            break;
    }
}
```

### **OTA Utilities**

```java
// Get current version information
long versionCode = OtaUtils.getCurrentVersionCode(context);
String versionName = OtaUtils.getCurrentVersionName(context);
Log.d("OTA", "Current version: " + versionName + " (" + versionCode + ")");

// Verify APK integrity
String apkPath = "/path/to/update.apk";
String expectedMd5 = "abc123...";
boolean isValid = OtaUtils.verifyApkIntegrity(apkPath, expectedMd5);
if (isValid) {
    Log.d("OTA", "APK integrity verified");
} else {
    Log.e("OTA", "APK integrity check failed");
}

// Check storage space
long requiredBytes = 50 * 1024 * 1024; // 50MB
boolean hasSpace = OtaUtils.hasSufficientStorage(requiredBytes);
if (hasSpace) {
    Log.d("OTA", "Sufficient storage space available");
} else {
    Log.w("OTA", "Insufficient storage space");
}

// Format file sizes
long fileSize = 1024 * 1024 * 25; // 25MB
String formattedSize = OtaUtils.formatFileSize(fileSize);
Log.d("OTA", "File size: " + formattedSize);

// Clean up old APK files
OtaUtils.cleanupOldApkFiles(3); // Keep latest 3 files
```

### **Notification Management**

```java
// Create notification manager
OtaNotificationManager notificationManager = new OtaNotificationManager(context);

// Show service notification
notificationManager.showServiceNotification("OTA Service Running");

// Show download notification
notificationManager.showDownloadNotification(50, 25 * 1024 * 1024, 50 * 1024 * 1024);

// Show installation notification
notificationManager.showInstallationNotification("/path/to/update.apk");

// Show error notification
notificationManager.showErrorNotification("Download Failed", "Network error occurred");

// Update download notification
notificationManager.updateDownloadNotification(75, 37 * 1024 * 1024, 50 * 1024 * 1024);

// Cancel notifications
notificationManager.cancelDownloadNotification();
notificationManager.cancelAllNotifications();
```

### **Service Integration**

```java
// Start OTA service
public static void startOtaService(Context context) {
    Intent intent = new Intent(context, OtaService.class);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent);
    } else {
        context.startService(intent);
    }
}

// Stop OTA service
public static void stopOtaService(Context context) {
    Intent intent = new Intent(context, OtaService.class);
    context.stopService(intent);
}

// Check OTA status
public static boolean isOtaServiceRunning() {
    // Implementation depends on how you track service status
    return false;
}
```

## 🔄 OTA Workflow

### **Version Check Workflow**

1. **Initialization**: OTA service is initialized
2. **Network Check**: Verify network connectivity
3. **Battery Check**: Verify battery level is sufficient
4. **Version Request**: Request version information from server
5. **Version Comparison**: Compare with current version
6. **Update Decision**: Decide if update is needed
7. **User Notification**: Notify user of available updates

### **Download Workflow**

1. **Download Initiation**: Start download process
2. **Storage Check**: Verify sufficient storage space
3. **Download Progress**: Track download progress
4. **Integrity Verification**: Verify downloaded file integrity
5. **Backup Creation**: Create backup of current version
6. **Download Completion**: Complete download process

### **Installation Workflow**

1. **Installation Initiation**: Start installation process
2. **Permission Check**: Verify installation permissions
3. **APK Verification**: Verify APK file integrity
4. **Installation Progress**: Track installation progress
5. **Installation Completion**: Complete installation
6. **Restart Notification**: Notify user to restart app

### **Rollback Workflow**

1. **Failure Detection**: Detect installation failure
2. **Backup Verification**: Verify backup file exists
3. **Rollback Initiation**: Start rollback process
4. **Backup Restoration**: Restore from backup
5. **Rollback Completion**: Complete rollback process
6. **Error Reporting**: Report rollback to user

## 🛡️ Features

### **Robust Update Management**

- **Automatic Checks**: Periodic automatic update checks
- **Network Awareness**: Network-aware update operations
- **Battery Awareness**: Battery-aware update operations
- **Retry Logic**: Automatic retry with exponential backoff
- **Error Recovery**: Comprehensive error handling and recovery

### **Security and Integrity**

- **MD5 Verification**: APK file integrity verification
- **Version Validation**: Version compatibility checking
- **Backup Management**: Automatic backup creation and restoration
- **Rollback Support**: Automatic rollback on failure
- **Permission Management**: Proper permission handling

### **User Experience**

- **Progress Tracking**: Real-time progress tracking
- **Notifications**: User-friendly notifications
- **Status Updates**: Clear status updates
- **Error Reporting**: Detailed error reporting
- **Background Operation**: Background update operations

### **Performance Optimization**

- **Storage Management**: Efficient storage space management
- **Memory Management**: Memory-efficient operations
- **Network Optimization**: Optimized network usage
- **Battery Optimization**: Battery-efficient operations
- **Resource Cleanup**: Proper resource cleanup

## 📈 Benefits

1. **Unified Interface**: Single interface for all OTA operations
2. **Robust Updates**: Reliable update mechanism with rollback support
3. **User Friendly**: Clear progress tracking and notifications
4. **Battery Aware**: Battery-conscious update operations
5. **Network Aware**: Network-aware update operations
6. **Secure**: File integrity verification and validation
7. **Extensible**: Easy to add new update mechanisms

## 🔮 Future Enhancements

- **Delta Updates**: Support for delta updates to reduce download size
- **Background Updates**: Completely background update operations
- **Scheduled Updates**: Scheduled update installations
- **Update Channels**: Multiple update channels (stable, beta, alpha)
- **Cloud Integration**: Cloud-based update management
- **Analytics**: Update analytics and insights
- **A/B Testing**: A/B testing support for updates
- **Rollback Analytics**: Rollback analytics and insights

---

This OTA I/O package provides a comprehensive, secure, and user-friendly foundation for all OTA operations in the ASG client system, supporting robust update mechanisms with automatic rollback capabilities.
