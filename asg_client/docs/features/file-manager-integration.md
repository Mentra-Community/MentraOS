# File Manager Integration with SOLID Principles

## Overview

The `PhotoCommandHandler` and `AsgCameraServer` now use the same `FileManager` for consistent file operations. Both components save photos in package-based directories under the FileManager's base directory. The FileManager is responsible for defining the default package name, ensuring centralized configuration.

**New Architecture**: Common package directory management functionality has been extracted into `BaseMediaCommandHandler`, following SOLID principles for better maintainability and reusability.

## Architecture

### SOLID-Compliant Design

#### **Single Responsibility Principle (SRP)**

- **FileManager**: Manages file operations and default package configuration
- **BaseMediaCommandHandler**: Handles common package directory operations
- **PhotoCommandHandler**: Handles only photo-specific commands
- **VideoCommandHandler**: Handles only video-specific commands
- **AsgCameraServer**: Handles only web server operations

#### **Open/Closed Principle (OCP)**

- **BaseMediaCommandHandler**: Open for extension (new media handlers), closed for modification
- **FileManager**: Open for extension (new file operations), closed for modification
- Easy to add new media command handlers without changing existing code

#### **Liskov Substitution Principle (LSP)**

- All media handlers can be substituted with `BaseMediaCommandHandler`
- All handlers implement `ICommandHandler` interface
- Consistent behavior across all media handlers

#### **Interface Segregation Principle (ISP)**

- `ICommandHandler`: Focused interface for command handling
- `FileManager`: Focused interface for file operations
- `BaseMediaCommandHandler`: Focused abstract class for media operations

#### **Dependency Inversion Principle (DIP)**

- Handlers depend on `FileManager` abstraction
- `CommandProcessor` depends on `ICommandHandler` abstractions
- No concrete dependencies in high-level modules

### Package-Based File Organization

Both components use the FileManager's default package name: `com.mentra.asg_client.camera`

- **FileManager**: Defines and provides the default package name via `getDefaultPackageName()`
- **BaseMediaCommandHandler**: Provides common package directory management
- **PhotoCommandHandler**: Uses base class functionality for package operations
- **VideoCommandHandler**: Uses base class functionality for package operations
- **AsgCameraServer**: Uses FileManager's default package for all file operations

### File Path Structure

```
FileManager Base Directory/
├── com.mentra.asg_client.camera/
│   ├── IMG_20231201_143022.jpg
│   ├── IMG_20231201_143045.jpg
│   ├── VID_20231201_143100.mp4
│   └── ...
├── com.custom.package/
│   ├── IMG_20231201_143100.jpg
│   └── ...
└── ...
```

## Integration Points

### FileManager

1. **Default Package Management**:
   - Provides `getDefaultPackageName()` method
   - Centralizes package name configuration
   - Ensures consistency across all components

2. **Package Directory Operations**:
   - `getPackageDirectory(packageName)` - Gets package directory
   - `ensurePackageDirectoryExists(packageName)` - Creates directories if needed
   - Security validation and thread safety for all operations

### BaseMediaCommandHandler

1. **Common Package Operations**:
   - `resolvePackageName(JSONObject data)` - Resolves package name with fallback to default
   - `getPackageDirectory(String packageName)` - Gets and ensures package directory exists
   - `generateUniqueFilename(String prefix, String extension)` - Creates timestamped filenames
   - `generateFilePath(String packageName, String fileName)` - Creates full file paths
   - `validateRequestId(JSONObject data)` - Validates required requestId
   - `logCommandStart(String commandType, String packageName)` - Consistent logging
   - `logCommandResult(String commandType, boolean success, String errorMessage)` - Result logging

2. **Benefits**:
   - Eliminates code duplication across media handlers
   - Provides consistent error handling and logging
   - Centralizes package directory management logic
   - Makes adding new media handlers easier

### PhotoCommandHandler

1. **Extends BaseMediaCommandHandler**:
   - Inherits all common package directory functionality
   - Focuses only on photo-specific logic
   - Uses base class methods for package operations

2. **Photo-Specific Logic**:

   ```java
   // Resolve package name using base class
   String packageName = resolvePackageName(data);
   logCommandStart(getCommandType(), packageName);

   // Validate requestId using base class
   if (!validateRequestId(data)) {
       return false;
   }

   // Generate file path using base class
   String fileName = generateUniqueFilename("IMG_", ".jpg");
   String photoFilePath = generateFilePath(packageName, fileName);
   ```

### VideoCommandHandler

1. **Extends BaseMediaCommandHandler**:
   - Inherits all common package directory functionality
   - Focuses only on video-specific logic
   - Uses base class methods for package operations

2. **Video-Specific Logic**:

   ```java
   // Resolve package name using base class
   String packageName = resolvePackageName(data);
   logCommandStart(getCommandType(), packageName);

   // Validate requestId using base class
   if (!validateRequestId(data)) {
       streamingManager.sendVideoRecordingStatusResponse(false, "missing_request_id", null);
       return false;
   }
   ```

### AsgCameraServer

1. **File Reading**:
   - Uses `fileManager.getDefaultPackageName()` for all operations
   - Uses `fileManager.getFile(fileManager.getDefaultPackageName(), fileName)` to read photos
   - Uses `fileManager.listFiles(fileManager.getDefaultPackageName())` to list gallery photos
   - Uses `fileManager.getFileMetadata(fileManager.getDefaultPackageName(), fileName)` for file information

2. **Package Consistency**:
   - Always uses FileManager's default package name
   - All file operations go through the same package directory
   - No hardcoded package names in the server

## Benefits

### SOLID Compliance

- **SRP**: Each class has single responsibility
- **OCP**: Easy to extend without modification
- **LSP**: Consistent behavior across handlers
- **ISP**: Focused, specific interfaces
- **DIP**: Depends on abstractions

### Centralized Configuration

- FileManager is the single source of truth for default package name
- Easy to change default package name in one place
- Consistent package naming across all components

### Code Reusability

- Common functionality extracted to base class
- No code duplication across media handlers
- Easy to add new media handlers
- Consistent error handling and logging

### Security

- FileManager provides security validation for all operations
- Package-based isolation prevents unauthorized access
- Thread-safe operations with read/write locks

### Consistency

- Both components use the same file structure
- Unified file management through FileManager
- Consistent package naming from centralized source
- Standardized logging and error handling

### Maintainability

- Single source of truth for file operations
- Centralized directory management
- Easy to extend for new packages
- No duplicate package name constants
- Reduced code duplication

## Usage Examples

### Taking a Photo with Default Package

```json
{
  "command": "take_photo",
  "requestId": "req_123",
  "webhookUrl": "https://example.com/webhook",
  "transferMethod": "direct",
  "save": true
}
```

**Result**: Photo saved to `{FileManager.getDefaultPackageName()}/IMG_20231201_143022.jpg`

### Taking a Photo with Custom Package

```json
{
  "command": "take_photo",
  "requestId": "req_456",
  "packageName": "com.custom.package",
  "webhookUrl": "https://example.com/webhook",
  "transferMethod": "ble",
  "bleImgId": "ble_123",
  "save": false
}
```

**Result**: Photo saved to `com.custom.package/IMG_20231201_143045.jpg`

### Recording Video with Default Package

```json
{
  "command": "start_video_recording",
  "requestId": "req_789",
  "save": true
}
```

**Result**: Video saved to `{FileManager.getDefaultPackageName()}/VID_20231201_143100.mp4`

### Accessing Photos via Web Server

- **Latest Photo**: `GET /api/latest-photo`
- **Gallery**: `GET /api/gallery`
- **Specific Photo**: `GET /api/photo?file=IMG_20231201_143022.jpg`
- **Download**: `GET /api/download?file=IMG_20231201_143022.jpg`

## Error Handling

### BaseMediaCommandHandler Errors

1. **Missing RequestId**: Returns `false`, logs error
2. **FileManager Failure**: Returns `false`, logs error
3. **Directory Creation Failure**: Returns `false`, logs error
4. **Package Resolution Failure**: Returns `false`, logs error

### PhotoCommandHandler Errors

1. **Media Capture Service Unavailable**: Returns `false`, logs error
2. **Auto Transfer without BLE ID**: Returns `false`, logs error
3. **File Path Generation Failure**: Returns `false`, logs error

### VideoCommandHandler Errors

1. **Media Capture Service Unavailable**: Returns `false`, sends error response
2. **Already Recording**: Returns `true`, sends status response
3. **Not Recording (Stop)**: Returns `false`, sends error response

### AsgCameraServer Errors

1. **File Not Found**: Returns 404 error
2. **File Too Large**: Returns 413 error
3. **Internal Error**: Returns 500 error

## Testing

The integration is tested through multiple test classes:

### BaseMediaCommandHandlerTest

- Tests common package directory functionality
- Tests package name resolution
- Tests file path generation
- Tests requestId validation
- Tests error handling scenarios

### PhotoCommandHandlerTest

- Tests photo command handling
- Tests default package usage (using FileManager's default)
- Tests custom package usage
- Tests FileManager integration
- Tests MediaCaptureService integration

### VideoCommandHandlerTest

- Tests video command handling
- Tests package directory integration
- Tests streaming manager integration

## Future Enhancements

1. **Dynamic Default Package**: Configurable default package name
2. **Package Cleanup**: Automatic cleanup of old files by package
3. **Storage Quotas**: Per-package storage limits
4. **File Compression**: Automatic compression for large files
5. **Backup Integration**: Package-based backup strategies
6. **Additional Media Handlers**: Easy to add new handlers using BaseMediaCommandHandler
7. **Plugin Architecture**: Dynamic loading of media handlers
