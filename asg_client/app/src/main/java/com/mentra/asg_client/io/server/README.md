# ASG Server Package

A comprehensive server package for ASG (AugmentOS Smart Glasses) applications, built with SOLID principles and dependency injection. Provides local network access to camera functionality and other services through a modular, extensible architecture.

## Architecture Overview

The server package follows SOLID principles with a modular, interface-based architecture:

### 🏗️ **SOLID Architecture**

- **Single Responsibility**: Each class has one clear purpose
- **Open/Closed**: Extensible through interfaces and composition
- **Liskov Substitution**: Uses interfaces for polymorphism
- **Interface Segregation**: Specific interfaces for different concerns
- **Dependency Inversion**: Depends on abstractions, not concretions

### 📁 **Package Structure**

```
server/
├── interfaces/           # Interface definitions
│   ├── ServerConfig.java
│   ├── Logger.java
│   ├── NetworkProvider.java
│   ├── CacheManager.java
│   └── RateLimiter.java
├── impl/                # Concrete implementations
│   ├── DefaultServerConfig.java
│   ├── AndroidLogger.java
│   ├── DefaultNetworkProvider.java
│   ├── DefaultCacheManager.java
│   ├── DefaultRateLimiter.java
│   └── DefaultServerFactory.java
├── AsgServer.java       # Abstract base server class
├── CameraWebServer.java # Camera-specific implementation
├── ServerManager.java   # Centralized server management
└── README.md           # This documentation
```

## Core Components

### 1. **AsgServer** (Abstract Base Class)

- **File**: `AsgServer.java`
- **Purpose**: Abstract base class providing common server functionality
- **SOLID Features**:
  - Dependency injection through constructor
  - Abstract methods for extensibility
  - Interface-based dependencies
- **Features**:
  - Rate limiting via `RateLimiter` interface
  - File caching via `CacheManager` interface
  - CORS support with configurable origins
  - Comprehensive logging via `Logger` interface
  - Network information via `NetworkProvider` interface
  - Error handling and security measures
  - Static file serving from assets

### 2. **CameraWebServer** (Concrete Implementation)

- **File**: `CameraWebServer.java`
- **Purpose**: Camera-specific web server extending AsgServer
- **Features**:
  - RESTful API for photo capture and management
  - Photo gallery browsing with metadata
  - File download capabilities with proper headers
  - Mobile-friendly HTML interface
  - Integration with existing CameraNeo system
  - Picture request listener for external integration

### 3. **ServerManager** (Centralized Management)

- **File**: `ServerManager.java`
- **Purpose**: Singleton manager for multiple server instances
- **Features**:
  - Centralized server registration and lifecycle management
  - Configuration management via `ServerConfig` interface
  - Status monitoring and metrics
  - Bulk operations (start/stop all servers)
  - Mediated access to server URLs and information

### 4. **Interfaces** (Abstractions)

- **ServerConfig**: Server configuration management
- **Logger**: Logging abstraction for different implementations
- **NetworkProvider**: Network information and IP address detection
- **CacheManager**: Caching with TTL support and statistics
- **RateLimiter**: Rate limiting with configurable windows

### 5. **Implementations** (Concrete Classes)

- **DefaultServerConfig**: Builder pattern for server configuration
- **AndroidLogger**: Android-specific logging implementation
- **DefaultNetworkProvider**: Network utilities and IP detection
- **DefaultCacheManager**: In-memory cache with automatic cleanup
- **DefaultRateLimiter**: Time-window based rate limiting
- **DefaultServerFactory**: Factory for creating default implementations

## API Endpoints

### Core Endpoints

- `GET /` - Main interface page with dynamic content
- `POST /api/take-picture` - Trigger photo capture
- `GET /api/latest-photo` - Get the most recent photo (cached)
- `GET /api/gallery` - List all photos with metadata
- `GET /api/photo?file=<filename>` - Get specific photo
- `GET /api/download?file=<filename>` - Download photo file
- `GET /api/status` - Server status and metrics
- `GET /api/health` - Health check endpoint

### Static Files

- `GET /static/<filename>` - Serve static assets (CSS, JS, images)

## Usage Examples

### Basic Server Setup with Dependency Injection

```java
// Create dependencies
Logger logger = new AndroidLogger();
NetworkProvider networkProvider = new DefaultNetworkProvider(logger);
CacheManager cacheManager = new DefaultCacheManager(logger);
RateLimiter rateLimiter = new DefaultRateLimiter(100, 60000, logger);

// Create server configuration
ServerConfig config = new DefaultServerConfig.Builder()
    .port(8089)
    .serverName("CameraWebServer")
    .context(context)
    .corsEnabled(true)
    .build();

// Create camera web server with dependencies
CameraWebServer cameraServer = new CameraWebServer(
    config, networkProvider, cacheManager, rateLimiter, logger
);

// Set picture request listener
cameraServer.setOnPictureRequestListener(() -> {
    // Trigger photo capture in your app
    mediaCaptureService.takePicture();
});

// Start server
cameraServer.startServer();
```

### Using ServerManager with Factory Pattern

```java
// Get server manager instance
ServerManager manager = ServerManager.getInstance(context);

// Create camera server with default implementations
CameraWebServer cameraServer = new CameraWebServer(context, 8089);
cameraServer.setOnPictureRequestListener(() -> {
    mediaCaptureService.takePicture();
});

// Register with server manager
manager.registerServer("camera", cameraServer);

// Start all servers
manager.startAllServers();

// Get server information
String serverUrl = manager.getServerUrl("camera");
boolean isRunning = manager.isServerRunning("camera");
```

### Integration with ASG Client Service

```java
// In AsgClientService.java
private CameraWebServer cameraWebServer;
private ServerManager serverManager;

@Override
public void onCreate() {
    super.onCreate();

    // Initialize server manager
    serverManager = ServerManager.getInstance(this);

    // Create and configure camera server
    cameraWebServer = new CameraWebServer(this, 8089);
    cameraWebServer.setOnPictureRequestListener(() -> {
        // Trigger photo capture via existing service
        if (mediaCaptureService != null) {
            mediaCaptureService.takePicture();
        }
    });

    // Register with server manager
    serverManager.registerServer("camera", cameraWebServer);

    // Start the server
    serverManager.startServer("camera");
}

@Override
public void onDestroy() {
    super.onDestroy();

    // Cleanup servers
    if (serverManager != null) {
        serverManager.cleanup();
    }
}
```

## SOLID Principles Implementation

### Single Responsibility Principle

- **AsgServer**: Handles HTTP serving and request routing
- **CameraWebServer**: Handles camera-specific operations
- **ServerManager**: Manages server lifecycle
- **CacheManager**: Handles caching operations
- **RateLimiter**: Handles rate limiting logic

### Open/Closed Principle

- **AsgServer**: Open for extension (new server types), closed for modification
- **Interfaces**: Allow new implementations without changing existing code
- **Factory Pattern**: Enables new server creation methods

### Liskov Substitution Principle

- All implementations can be substituted for their interfaces
- **DefaultCacheManager** can replace any **CacheManager** implementation
- **AndroidLogger** can replace any **Logger** implementation

### Interface Segregation Principle

- **ServerConfig**: Only configuration-related methods
- **Logger**: Only logging methods
- **CacheManager**: Only caching methods
- **RateLimiter**: Only rate limiting methods

### Dependency Inversion Principle

- High-level modules depend on abstractions
- **AsgServer** depends on interfaces, not concrete classes
- Dependencies are injected through constructors

## Security Features

### Rate Limiting

- Configurable requests per time window
- Per-IP address tracking
- Automatic window reset
- Implemented via `RateLimiter` interface

### Input Validation

- Directory traversal protection
- File extension validation
- Parameter sanitization
- Security headers

### CORS Support

- Configurable allowed origins
- Preflight OPTIONS request support
- Cross-origin request handling

## Performance Features

### Caching

- In-memory cache with TTL support
- Automatic cleanup of expired entries
- Cache statistics and monitoring
- Configurable cache size limits

### File Handling

- Chunked responses for large files
- Efficient file reading with proper error handling
- Support for files up to 50MB
- Static file serving from assets

### Memory Management

- Automatic cleanup of expired cache entries
- Proper resource disposal on server shutdown
- Memory-efficient file serving
- Scheduled cleanup tasks

## Debugging and Monitoring

### Comprehensive Logging

All server components use detailed logging with emojis for easy identification:

- 🚀 Server startup and initialization
- 🔍 Request handling and routing
- 📸 Camera-specific operations
- 🖼️ Photo serving and caching
- 📚 Gallery operations
- ⬇️ File downloads
- 📊 Status and metrics
- 🛑 Server shutdown and cleanup
- 💥 Error conditions
- 🚫 Rate limiting events
- 💾 Cache operations

### Log Tags

- `CameraWebServer` - Camera server operations
- `ServerManager` - Server management operations
- `AsgServer` - Base server operations
- `CacheManager` - Cache operations
- `RateLimiter` - Rate limiting events

### Testing Endpoints

Use these curl commands to test the server:

```bash
# Health check
curl http://[GLASSES_IP]:8089/api/health

# Get server status
curl http://[GLASSES_IP]:8089/api/status

# Take a picture
curl -X POST http://[GLASSES_IP]:8089/api/take-picture

# Get latest photo
curl http://[GLASSES_IP]:8089/api/latest-photo

# Get photo gallery
curl http://[GLASSES_IP]:8089/api/gallery

# Download specific photo
curl http://[GLASSES_IP]:8089/api/download?file=photo.jpg
```

## Configuration

### Server Configuration

```java
ServerConfig config = new DefaultServerConfig.Builder()
    .port(8089)                    // Server port
    .serverName("CameraWebServer") // Server name
    .context(context)              // Android context
    .corsEnabled(true)             // Enable CORS
    .maxRequestSize(50 * 1024 * 1024) // 50MB max request size
    .requestTimeout(30000)         // 30 second timeout
    .build();
```

### Rate Limiting Configuration

```java
// 100 requests per minute
RateLimiter rateLimiter = new DefaultRateLimiter(100, 60000, logger);
```

### Cache Configuration

```java
// Cache with 5 minute TTL
cacheManager.put("key", data, 300000); // 5 minutes in milliseconds
```

## Migration from Old Architecture

The server package has been completely redesigned to follow SOLID principles:

### Key Changes

- **Interface-based design**: All dependencies are now interfaces
- **Dependency injection**: Dependencies are injected through constructors
- **Factory pattern**: Default implementations are created via factories
- **Separation of concerns**: Each class has a single responsibility
- **Extensibility**: New implementations can be added without modifying existing code

### Benefits

- **Testability**: Easy to mock interfaces for unit testing
- **Maintainability**: Clear separation of concerns
- **Extensibility**: New features can be added through composition
- **Flexibility**: Different implementations can be swapped easily
- **Reliability**: Interface contracts ensure consistent behavior

## Future Enhancements

### Planned Features

- WebSocket support for real-time updates
- Authentication and authorization interfaces
- SSL/TLS encryption support
- Load balancing for multiple servers
- Metrics collection and monitoring interfaces
- Plugin system for custom endpoints

### Performance Improvements

- Async file operations
- Connection pooling
- Compression for large files
- Background cache warming
- Memory-mapped file support

### Security Enhancements

- JWT token authentication
- Request signing
- IP whitelisting
- Audit logging
- Security interface implementations

## Dependencies

- **NanoHTTPD**: Lightweight HTTP server library
- **Android Context**: For asset access and network utilities
- **Java NIO**: For efficient file operations
- **JSON**: For API responses (org.json)
- **Java Collections**: For data structures and caching

## Contributing

When adding new server implementations:

1. **Extend `AsgServer`** class and implement required abstract methods
2. **Use dependency injection** through interfaces
3. **Register with `ServerManager`** for centralized management
4. **Add comprehensive logging** with appropriate tags
5. **Include security measures** and input validation
6. **Follow SOLID principles** in design
7. **Update this documentation** with new features

### Creating New Interfaces

- Follow Interface Segregation Principle
- Keep interfaces focused and specific
- Provide clear documentation
- Include default implementations where appropriate

### Creating New Implementations

- Implement all interface methods
- Add comprehensive logging
- Include proper error handling
- Follow naming conventions
- Add unit tests

## License

This server package is part of the ASG (AugmentOS Smart Glasses) project and follows the same licensing terms as the main project.
