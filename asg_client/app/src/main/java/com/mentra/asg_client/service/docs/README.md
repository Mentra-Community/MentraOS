# AsgClientService Package - Current Implementation

## Overview

The `AsgClientService` package has been completely refactored from a monolithic 3300+ line service into a modern, SOLID-compliant architecture. The current implementation uses `AsgClientService` as the main service class with dependency injection and manager pattern.

## Current Architecture

### 1. AsgClientService (Main Service)

**Location**: `app/src/main/java/com/augmentos/asg_client/service/AsgClientService.java`
**Purpose**: Main service class implementing SOLID principles
**Responsibilities**:

- Service lifecycle management
- Dependency injection container management
- Event coordination between components
- Interface implementations (NetworkStateListener, BluetoothStateListener)
- Public API for activities

**Key Features**:

- **763 lines** (down from 3300+ lines)
- **Dependency Injection**: Uses ServiceContainer for clean dependency management
- **Interface-Based Design**: Depends on abstractions, not concretions
- **Manager Pattern**: Delegates to focused managers
- **SOLID Compliant**: All 5 principles properly implemented

### 2. ServiceContainer (Dependency Injection)

**Location**: `app/src/main/java/com/augmentos/asg_client/service/di/ServiceContainer.java`
**Purpose**: Centralized dependency management
**Responsibilities**:

- Instantiate and manage all service components
- Provide interface-based access to managers
- Handle component lifecycle
- Enable loose coupling between components

### 3. Interface Definitions

**Location**: `app/src/main/java/com/augmentos/asg_client/service/interfaces/`
**Purpose**: Define contracts for each concern

#### IServiceLifecycle

- Service initialization and cleanup
- Action handling and routing
- State management

#### ICommunicationManager

- Bluetooth communication
- Message sending and formatting
- Connection state management

#### IStateManager

- Battery status tracking
- WiFi connection state
- Service binding state

#### IStreamingManager

- RTMP streaming control
- Video recording status
- Streaming callbacks

### 4. Manager Implementations

**Location**: `app/src/main/java/com/augmentos/asg_client/service/managers/`
**Purpose**: Concrete implementations of interfaces

#### ServiceLifecycleManager

- Handles service initialization and cleanup
- Routes actions to appropriate handlers
- Manages service state transitions

#### CommunicationManager

- Manages all Bluetooth communication
- Formats and sends messages
- Handles connection state changes

#### StateManager

- Tracks battery status and charging state
- Manages WiFi connection state
- Provides state queries

#### StreamingManager

- Controls RTMP streaming
- Manages video recording
- Handles streaming status callbacks

### 5. Supporting Components

#### AsgClientServiceManager

**Location**: `app/src/main/java/com/augmentos/asg_client/service/AsgClientServiceManager.java`
**Purpose**: Legacy component manager (maintained for compatibility)
**Responsibilities**:

- Initialize network, bluetooth, and media services
- Handle component cleanup
- Provide access to legacy components

#### CommandProcessor

**Location**: `app/src/main/java/com/augmentos/asg_client/service/CommandProcessor.java`
**Purpose**: Process JSON commands received via Bluetooth
**Responsibilities**:

- Parse and validate incoming commands
- Route commands to appropriate handlers
- Generate responses
- Handle different command formats (JSON, K900 protocol)

#### AsgNotificationManager

**Location**: `app/src/main/java/com/augmentos/asg_client/service/AsgNotificationManager.java`
**Purpose**: Manage all notification-related functionality
**Responsibilities**:

- Create and update notification channels
- Build notifications
- Show/hide notifications
- Handle notification lifecycle

## SOLID Principles Implementation

### Single Responsibility Principle (SRP)

- **AsgClientService**: Service coordination and lifecycle
- **ServiceContainer**: Dependency management
- **ServiceLifecycleManager**: Service lifecycle operations
- **CommunicationManager**: Bluetooth communication
- **StateManager**: State tracking and queries
- **StreamingManager**: Streaming operations
- **CommandProcessor**: Command processing
- **AsgNotificationManager**: Notification management

### Open/Closed Principle (OCP)

- New managers can be added without modifying existing code
- New commands can be added to CommandProcessor
- New notification types can be added to NotificationManager
- ServiceContainer can be extended with new dependencies

### Liskov Substitution Principle (LSP)

- All managers implement well-defined interfaces
- Components can be swapped out without breaking the service
- Interface contracts are clearly defined

### Interface Segregation Principle (ISP)

- Each interface is focused and specific
- Components only depend on the interfaces they need
- No forced dependencies on unused methods

### Dependency Inversion Principle (DIP)

- High-level modules depend on abstractions (interfaces)
- Low-level modules implement specific functionality
- Dependencies are injected rather than created internally

## Benefits of Current Implementation

### 1. Maintainability

- **Reduced Complexity**: 77% reduction in main service size (3300+ → 763 lines)
- **Clear Separation**: Each class has a single, well-defined responsibility
- **Easy Debugging**: Issues can be isolated to specific managers
- **Modular Design**: Changes to one area don't affect others

### 2. Testability

- **Unit Testing**: Each manager can be tested independently
- **Mock Injection**: Easy to inject mock objects for testing
- **Interface Testing**: Test against interfaces, not implementations
- **Isolated Testing**: Test components in isolation

### 3. Extensibility

- **Easy Addition**: New features can be added without modifying existing code
- **Manager Extension**: New managers can be added to ServiceContainer
- **Command Extension**: New commands can be added to CommandProcessor
- **Interface Extension**: New interfaces can be added for new concerns

### 4. Performance

- **Lazy Loading**: Components are initialized only when needed
- **Memory Efficiency**: Proper cleanup and resource management
- **Reduced Coupling**: Loose coupling improves performance
- **Better Error Handling**: Isolated error handling per component

## Migration History and Debugging References

### Refactoring Timeline

#### Phase 1: Initial Refactoring

- **Original**: Monolithic AsgClientService (3300+ lines)
- **Created**: AsgClientServiceClean (1538 lines)
- **Status**: ✅ Completed
- **Files**:
  - `AsgClientService.java.backup` (original)
  - `AsgClientServiceClean.java` (deleted)

#### Phase 2: SOLID Implementation

- **Created**: AsgClientServiceRefactored (757 lines)
- **Added**: ServiceContainer, interfaces, managers
- **Status**: ✅ Completed
- **Files**:
  - `AsgClientServiceRefactored.java` (deleted)
  - `ServiceContainer.java` (active)
  - `interfaces/` directory (active)
  - `managers/` directory (active)

#### Phase 3: Final Migration

- **Current**: AsgClientService (763 lines)
- **Status**: ✅ Active
- **Files**:
  - `AsgClientService.java` (current main service)
  - All supporting components (active)

### Debugging References

#### Service Lifecycle Debugging

```java
// Check service initialization
Log.d(TAG, "AsgClientServiceV2 onCreate");
Log.d(TAG, "ServiceContainer initialized");

// Check manager initialization
Log.d(TAG, "LifecycleManager initialized");
Log.d(TAG, "CommunicationManager initialized");
Log.d(TAG, "StateManager initialized");
Log.d(TAG, "StreamingManager initialized");
```

#### Component Access Debugging

```java
// Access service container
ServiceContainer container = serviceContainer;

// Access managers
IServiceLifecycle lifecycle = container.getLifecycleManager();
ICommunicationManager communication = container.getCommunicationManager();
IStateManager state = container.getStateManager();
IStreamingManager streaming = container.getStreamingManager();

// Access legacy components
AsgClientServiceManager serviceManager = container.getServiceManager();
CommandProcessor commandProcessor = container.getCommandProcessor();
AsgNotificationManager notificationManager = container.getNotificationManager();
```

#### Command Processing Debugging

```java
// Command processing flow
CommandProcessor processor = serviceContainer.getCommandProcessor();
processor.processJsonCommand(jsonObject);

// K900 command processing
service.parseK900Command(jsonObject);
```

#### State Management Debugging

```java
// Battery status
stateManager.updateBatteryStatus(level, charging, timestamp);
int batteryLevel = stateManager.getBatteryLevel();
boolean isCharging = stateManager.isCharging();

// WiFi status
boolean wifiConnected = stateManager.isConnectedToWifi();
communicationManager.sendWifiStatusOverBle(wifiConnected);

// Bluetooth status
boolean bluetoothConnected = stateManager.isBluetoothConnected();
```

#### Streaming Debugging

```java
// RTMP streaming
streamingManager.startRtmpStreaming();
streamingManager.stopRtmpStreaming();

// Video recording
streamingManager.sendVideoRecordingStatusResponse(success, status, details);

// Streaming callbacks
StreamingStatusCallback callback = streamingManager.getStreamingStatusCallback();
```

### Common Issues and Solutions

#### Issue 1: Service Not Starting

**Symptoms**: Service fails to start or crashes on startup
**Debug Steps**:

1. Check `AsgClientService.onCreate()` logs
2. Verify ServiceContainer initialization
3. Check manager initialization in ServiceContainer
4. Verify AndroidManifest.xml service declaration

**Common Causes**:

- Missing permissions in AndroidManifest.xml
- ServiceContainer initialization failure
- Manager dependency injection failure

#### Issue 2: Bluetooth Communication Issues

**Symptoms**: No data received or sent via Bluetooth
**Debug Steps**:

1. Check `CommunicationManager` logs
2. Verify Bluetooth permissions
3. Check `StateManager.isBluetoothConnected()`
4. Verify Bluetooth manager initialization

**Common Causes**:

- Bluetooth permissions not granted
- Bluetooth manager not initialized
- Connection state not properly tracked

#### Issue 3: Command Processing Issues

**Symptoms**: Commands not processed or incorrect responses
**Debug Steps**:

1. Check `CommandProcessor.processJsonCommand()` logs
2. Verify JSON parsing
3. Check command routing logic
4. Verify response generation

**Common Causes**:

- Malformed JSON data
- Unknown command types
- CommandProcessor not initialized
- Missing command handlers

#### Issue 4: State Management Issues

**Symptoms**: Incorrect battery/WiFi status or state not updated
**Debug Steps**:

1. Check `StateManager` logs
2. Verify state update calls
3. Check state query methods
4. Verify state persistence

**Common Causes**:

- State not properly updated
- State manager not initialized
- State persistence issues

#### Issue 5: Streaming Issues

**Symptoms**: RTMP streaming not working or video recording issues
**Debug Steps**:

1. Check `StreamingManager` logs
2. Verify streaming service initialization
3. Check streaming callbacks
4. Verify video recording permissions

**Common Causes**:

- Camera permissions not granted
- Streaming service not initialized
- Network connectivity issues
- RTMP URL configuration issues

### Performance Monitoring

#### Memory Usage

```java
// Monitor service memory usage
Runtime runtime = Runtime.getRuntime();
long usedMemory = runtime.totalMemory() - runtime.freeMemory();
Log.d(TAG, "Service memory usage: " + usedMemory + " bytes");
```

#### Component Performance

```java
// Monitor manager performance
long startTime = System.currentTimeMillis();
// ... manager operation ...
long endTime = System.currentTimeMillis();
Log.d(TAG, "Manager operation took: " + (endTime - startTime) + "ms");
```

#### Command Processing Performance

```java
// Monitor command processing time
long startTime = System.currentTimeMillis();
commandProcessor.processJsonCommand(jsonObject);
long endTime = System.currentTimeMillis();
Log.d(TAG, "Command processing took: " + (endTime - startTime) + "ms");
```

## Future Development Guidelines

### Adding New Features

1. **New Manager**: Create interface in `interfaces/` and implementation in `managers/`
2. **New Commands**: Add handlers to `CommandProcessor`
3. **New Notifications**: Extend `AsgNotificationManager`
4. **New State**: Add methods to `StateManager`

### Testing Guidelines

1. **Unit Tests**: Test each manager independently
2. **Integration Tests**: Test service with mocked managers
3. **Mock Objects**: Use dependency injection for testing
4. **Interface Testing**: Test against interfaces, not implementations

### Code Quality

1. **SOLID Principles**: Always follow SOLID principles
2. **Interface Segregation**: Keep interfaces focused and specific
3. **Dependency Injection**: Use ServiceContainer for dependencies
4. **Error Handling**: Implement proper error handling in each component
5. **Logging**: Use appropriate log levels for debugging

## Conclusion

The current `AsgClientService` implementation represents a modern, maintainable, and extensible architecture that follows SOLID principles. The 77% reduction in complexity, clear separation of concerns, and comprehensive debugging capabilities make it an excellent foundation for future development and maintenance.
