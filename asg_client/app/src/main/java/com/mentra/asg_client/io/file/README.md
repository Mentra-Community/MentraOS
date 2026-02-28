# FileManager System - SOLID Architecture

A comprehensive, SOLID-compliant file management system for the ASG client that provides secure, thread-safe, and platform-agnostic file operations.

## 🏗️ Architecture Overview

The FileManager system follows SOLID principles and is designed with:

- **Single Responsibility Principle (SRP)**: Each class has one reason to change
- **Open/Closed Principle (OCP)**: Open for extension, closed for modification
- **Liskov Substitution Principle (LSP)**: Implementations can be substituted
- **Interface Segregation Principle (ISP)**: Focused, cohesive interfaces
- **Dependency Inversion Principle (DIP)**: Depends on abstractions, not concretions

## 📁 Package Structure

```
io/file/
├── core/                    # Core interfaces and main implementation
│   ├── FileManager.java     # Main interface composing all operations
│   ├── FileManagerImpl.java # Main implementation orchestrating managers
│   └── FileManagerFactory.java # Factory with strategy pattern
├── interfaces/              # Segregated interfaces
│   ├── FileOperations.java  # Basic file operations
│   ├── FileMetadataOperations.java # Metadata operations
│   ├── PackageOperations.java # Package-level operations
│   └── StorageOperations.java # Storage operations
├── managers/                # Focused manager classes
│   ├── FileOperationsManager.java # File I/O operations
│   ├── FileSecurityManager.java # Security validation
│   ├── FileLockManager.java # Thread synchronization
│   └── DirectoryManager.java # Directory management
├── platform/                # Platform-specific implementations
│   ├── PlatformStrategy.java # Platform abstraction interface
│   ├── PlatformRegistry.java # Platform management
│   ├── AndroidPlatformStrategy.java # Android implementation
│   └── JavaSEPlatformStrategy.java # Java SE implementation
├── security/                # Security-related components
│   └── FileSecurityValidator.java # Security validation
├── utils/                   # Utility components
│   ├── FileOperationLogger.java # Operation logging
│   └── MimeTypeRegistry.java # MIME type management
└── README.md               # This documentation
```

## 🔧 Core Components

### 1. **Core Package** (`core/`)

#### `FileManager` Interface

Composes all focused interfaces:

```java
public interface FileManager extends
    FileOperations,
    FileMetadataOperations,
    PackageOperations,
    StorageOperations {
    // Contains only nested classes for results and metadata
}
```

#### `FileManagerImpl`

- **Responsibility**: Orchestrates focused managers
- **Features**: Security validation, thread synchronization, atomic operations
- **Architecture**: Delegates to specialized managers

#### `FileManagerFactory`

- **Strategy Pattern**: Creates platform-specific instances
- **Singleton Management**: Centralized instance management
- **Configuration**: Platform-agnostic configuration

### 2. **Interfaces Package** (`interfaces/`)

#### `FileOperations`

Handles basic file operations:

- `saveFile()` - Save files with atomic operations
- `getFile()` - Retrieve files
- `deleteFile()` - Delete files safely
- `updateFile()` - Update existing files

#### `FileMetadataOperations`

Manages file metadata:

- `getFileMetadata()` - Get file information
- `listFiles()` - List files in a package
- `fileExists()` - Check file existence

#### `PackageOperations`

Handles package-level operations:

- `getPackageSize()` - Calculate package size
- `cleanupOldFiles()` - Clean up based on retention policy

#### `StorageOperations`

Manages storage information:

- `getAvailableSpace()` - Get available storage
- `getTotalSpace()` - Get total storage

### 3. **Managers Package** (`managers/`)

#### `FileOperationsManager`

- **Responsibility**: File I/O operations
- **Features**: Atomic file operations, temporary file handling
- **Thread Safety**: Delegated to `FileLockManager`

#### `FileSecurityManager`

- **Responsibility**: Security validation
- **Features**: Package/file name validation, MIME type checking
- **Security**: Path traversal prevention, dangerous extension blocking

#### `FileLockManager`

- **Responsibility**: Thread synchronization
- **Features**: Package-level read/write locks
- **Concurrency**: `ConcurrentHashMap` with `ReentrantReadWriteLock`

#### `DirectoryManager`

- **Responsibility**: Directory structure management
- **Features**: Package directory creation, size calculation
- **Organization**: Package-based directory structure

### 4. **Platform Package** (`platform/`)

#### `PlatformStrategy` Interface

```java
public interface PlatformStrategy {
    File getBaseDirectory();
    Logger createLogger();
    String getPlatformName();
    boolean isSupported();
}
```

#### Platform Implementations

- **`AndroidPlatformStrategy`**: Uses Android Context for file paths
- **`JavaSEPlatformStrategy`**: Uses user home directory
- **`PlatformRegistry`**: Manages platform detection and registration

### 5. **Security Package** (`security/`)

#### `FileSecurityValidator`

- **Path Traversal Prevention**: Blocks `../`, `/`, `\`, etc.
- **Dangerous Extensions**: Blocks executable files
- **Input Validation**: Package and file name validation
- **Sanitization**: Safe name generation

### 6. **Utils Package** (`utils/`)

#### `FileOperationLogger`

- **History Tracking**: Last 1000 operations in memory
- **Performance Metrics**: Success rates, byte counts
- **Audit Trail**: Timestamped operation records

#### `MimeTypeRegistry`

- **Comprehensive Mappings**: Images, videos, audio, documents, archives
- **Extension Detection**: File type identification
- **Custom Support**: Add/remove MIME types

## 🔧 Usage Examples

### Android Usage

```java
// Initialize with Android context
FileManagerFactory.initialize(context);

// Get singleton instance
FileManager fileManager = FileManagerFactory.getInstance();

// Use file operations
FileOperationResult result = fileManager.saveFile(
    "com.example.app",
    "document.pdf",
    inputStream,
    "application/pdf"
);
```

### Java SE Usage

```java
// Auto-detect platform
FileManagerFactory.initialize();

// Get singleton instance
FileManager fileManager = FileManagerFactory.getInstance();

// Use file operations
List<FileMetadata> files = fileManager.listFiles("com.example.app");
```

### Custom Platform

```java
// Create custom platform configuration
PlatformConfig config = new PlatformConfig(
    new File("/custom/path"),
    new CustomLogger(),
    "Custom Platform"
);

// Initialize with custom config
FileManagerFactory.initialize(config);

// Create custom instance
FileManager fileManager = FileManagerFactory.createInstance(config);
```

## 🛡️ Security Features

### Input Validation

- **Package Names**: Alphanumeric, dots, underscores, hyphens only
- **File Names**: Safe characters, length limits
- **Path Traversal**: Blocked patterns (`../`, `/`, `\`, etc.)
- **Dangerous Extensions**: Blocked executable files

### File Operations

- **Atomic Operations**: Temporary files for safe saving
- **Thread Safety**: Package-level read/write locks
- **Error Handling**: Comprehensive error reporting

## 📊 Monitoring & Logging

### Operation Logging

- **History Tracking**: Last 1000 operations in memory
- **Performance Metrics**: Success rates, byte counts
- **Audit Trail**: Timestamped operation records

### Performance Statistics

```java
PerformanceStats stats = fileManager.getOperationLogger().getPerformanceStats();
System.out.println("Success Rate: " + stats.successRate + "%");
System.out.println("Total Operations: " + stats.totalOperations);
```

## 🔄 Thread Safety

### Lock Management

- **Package-Level Locks**: Each package has its own read/write lock
- **Concurrent Access**: Multiple packages can be accessed simultaneously
- **Deadlock Prevention**: Consistent lock ordering

### Atomic Operations

- **File Saving**: Temporary file → atomic move
- **File Updates**: Atomic replacement
- **Directory Operations**: Safe directory creation

## 🚀 Performance Features

### Memory Efficiency

- **Streaming**: Direct file I/O without loading entire files
- **Buffer Management**: 8KB buffers for optimal performance
- **Lazy Loading**: Metadata loaded on demand

### Storage Optimization

- **Space Monitoring**: Available space checking
- **Cleanup Operations**: Automatic old file removal
- **Size Tracking**: Package and total size monitoring

## 🧪 Testing Support

### Factory Reset

```java
// Reset singleton for testing
FileManagerFactory.reset();

// Create isolated instances
FileManager testManager = FileManagerFactory.createInstance(
    new File("/test/path"),
    new TestLogger()
);
```

### Mock Support

- **Interface-Based**: Easy to mock all interfaces
- **Strategy Injection**: Platform strategies can be mocked
- **Logger Abstraction**: Platform-agnostic logging

## 🔧 Configuration

### Platform Detection

```java
// Auto-detect (recommended)
FileManagerFactory.initialize();

// Manual platform selection
PlatformStrategy strategy = PlatformRegistry.getStrategy("java_se");
FileManagerFactory.initialize(new PlatformConfig(
    strategy.getBaseDirectory(),
    strategy.createLogger(),
    strategy.getPlatformName()
));
```

### Custom Settings

```java
// Custom base directory
File customDir = new File("/custom/files");
Logger customLogger = new CustomLogger();

FileManager fileManager = FileManagerFactory.createInstance(customDir, customLogger);
```

## 📈 Extensibility

### Adding New Platforms

```java
public class CustomPlatformStrategy implements PlatformStrategy {
    @Override
    public File getBaseDirectory() {
        return new File("/custom/path");
    }

    @Override
    public Logger createLogger() {
        return new CustomLogger();
    }

    // ... other methods
}

// Register the new platform
PlatformRegistry.registerStrategy("custom", new CustomPlatformStrategy());
```

### Adding New Operations

```java
// Extend existing interfaces or create new ones
public interface AdvancedFileOperations extends FileOperations {
    FileOperationResult compressFile(String packageName, String fileName);
    FileOperationResult encryptFile(String packageName, String fileName, String key);
}
```

## 🐛 Troubleshooting

### Common Issues

#### "FileManagerFactory not initialized"

```java
// Solution: Initialize before use
FileManagerFactory.initialize(context); // Android
FileManagerFactory.initialize(); // Auto-detect
```

#### "Security validation failed"

```java
// Check package and file names
// Ensure no path traversal attempts
// Verify file extensions are allowed
```

#### "Failed to create package directory"

```java
// Check file permissions
// Verify available storage space
// Ensure base directory is writable
```

### Debug Information

```java
// Get platform information
String platform = FileManagerFactory.getPlatformName();
PlatformConfig config = FileManagerFactory.getPlatformConfig();

// Get operation history
OperationRecord[] history = fileManager.getOperationLogger().getOperationHistory();

// Get performance stats
PerformanceStats stats = fileManager.getOperationLogger().getPerformanceStats();
```

## 🔮 Future Enhancements

### Planned Features

- **Encryption Support**: File-level encryption
- **Compression**: Automatic file compression
- **Cloud Integration**: Cloud storage providers
- **Backup/Restore**: Package backup functionality
- **Advanced Monitoring**: Real-time performance metrics

### Architecture Benefits

- **Maintainable**: Clear separation of concerns
- **Testable**: Easy to unit test each component
- **Extensible**: New features can be added without modification
- **Reliable**: Comprehensive error handling and validation
- **Performant**: Optimized for concurrent access

---

This SOLID-compliant FileManager system provides a robust, secure, and extensible foundation for file operations across multiple platforms while maintaining high performance and thread safety.
