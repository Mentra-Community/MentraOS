# Logging Package

A platform-agnostic logging system for the ASG client that provides consistent logging across different platforms.

## 📁 Package Structure

```
logging/
├── Logger.java           # Main logging interface
├── AndroidLogger.java    # Android-specific implementation
├── ConsoleLogger.java    # Console-based implementation
├── LoggerFactory.java    # Factory for creating loggers
└── README.md            # This documentation
```

## 🔧 Components

### **Logger Interface**

The main logging interface that defines the contract for all logger implementations:

- `debug(String tag, String message)` - Log debug messages
- `info(String tag, String message)` - Log info messages
- `warn(String tag, String message)` - Log warning messages
- `error(String tag, String message)` - Log error messages
- `error(String tag, String message, Throwable throwable)` - Log error messages with exceptions

### **AndroidLogger**

Android-specific implementation using Android's `Log` class:

- Uses `android.util.Log` for platform-specific logging
- Provides consistent tag handling
- Supports all Android log levels

### **ConsoleLogger**

Console-based implementation for non-Android platforms:

- Uses `System.out` and `System.err` for output
- Provides colored output for different log levels
- Includes stack trace printing for exceptions

### **LoggerFactory**

Factory class for creating platform-specific loggers:

- Auto-detects platform (Android vs non-Android)
- Provides convenience methods for creating loggers
- Supports custom tag configuration

## 🚀 Usage Examples

### **Basic Usage**

```java
// Auto-detect platform and create logger
Logger logger = LoggerFactory.createLogger();

// Use the logger
logger.info("MyTag", "Application started");
logger.debug("MyTag", "Processing request");
logger.error("MyTag", "An error occurred", exception);
```

### **Platform-Specific Loggers**

```java
// Create Android logger explicitly
Logger androidLogger = LoggerFactory.createAndroidLogger();

// Create console logger explicitly
Logger consoleLogger = LoggerFactory.createConsoleLogger();
```

### **Integration with FileManager**

```java
// In FileManagerFactory
Logger logger = LoggerFactory.createLogger();
FileManager fileManager = new FileManagerImpl(baseDirectory, logger);
```

## 🔄 Platform Detection

The `LoggerFactory` automatically detects the platform:

1. **Android Detection**: Tries to load `android.util.Log` class
2. **Fallback**: Uses `ConsoleLogger` if Android is not available
3. **Manual Override**: Can explicitly create specific logger types

## 🛡️ Features

### **Platform Agnostic**

- Works on Android and non-Android platforms
- Consistent API across all implementations
- No platform-specific dependencies in core code

### **Thread Safe**

- All implementations are thread-safe
- No shared state between logger instances
- Safe for concurrent use

### **Extensible**

- Easy to add new logger implementations
- Factory pattern allows for easy extension
- Interface-based design follows SOLID principles

### **Performance**

- Minimal overhead
- No unnecessary object creation
- Efficient platform detection

## 🔧 Integration

### **With FileManager System**

The logging package is designed to work seamlessly with the FileManager system:

```java
// In platform strategies
@Override
public Logger createLogger() {
    return LoggerFactory.createLogger();
}

// In FileManagerFactory
Logger logger = LoggerFactory.createLogger();
```

### **With Server Components**

```java
// In server implementations
Logger logger = LoggerFactory.createLogger();
// Use logger for all server operations
```

## 📈 Benefits

1. **Centralized Logging**: All logging goes through a single interface
2. **Platform Independence**: Works on Android and non-Android platforms
3. **Consistent API**: Same logging methods across all implementations
4. **Easy Testing**: Can easily mock or replace logger implementations
5. **Performance**: Minimal overhead with efficient platform detection

## 🔮 Future Enhancements

- **File Logging**: Add file-based logger implementation
- **Remote Logging**: Add network-based logger for remote debugging
- **Log Levels**: Add configurable log level filtering
- **Log Formatting**: Add customizable log message formatting
- **Performance Metrics**: Add logging performance monitoring

---

This logging package provides a robust, platform-agnostic foundation for all logging needs in the ASG client system.
