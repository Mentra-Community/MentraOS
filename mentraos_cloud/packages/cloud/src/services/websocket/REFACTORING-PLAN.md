# WebSocket Service Refactoring Plan

## Overview

This document outlines the refactoring plan for separating the WebSocket service into multiple files with clearer separation of concerns. The goal is to improve maintainability while ensuring no regression in functionality, especially for the mission-critical features deaf and hard of hearing users rely on.

## Current Issues

1. **Monolithic File**: The `websocket.service.ts` file is large (over 26,000 tokens) and handles many different responsibilities.
2. **Mixed Concerns**: WebSocket communication, session management, and business logic are intermingled.
3. **Error Handling**: Error handling is inconsistent across various message types, making debugging difficult.
4. **Authentication**: Authentication flows differ between glasses clients and TPAs, with TPA authentication happening after connection.
5. **Code Organization**: Related functions are scattered throughout the file, making maintenance challenging.

## Refactoring Goals

1. **Separate WebSocket Handling from Session Logic**: Move session-related functions to session.service.ts.
2. **Improve Error Handling**: Implement handler-level try/catch with a fallback mechanism and standardized error responses.
3. **Implement JWT Authentication for TPAs**: Support header-based authentication for TPAs while maintaining backward compatibility.
4. **Ensure No Regression**: Preserve all specialized processing for each message type.
5. **Clarify Responsibilities**: Make it clear which service handles which parts of the connection lifecycle.

## Implementation Progress

The core WebSocket service has already been implemented in the new directory structure, with the following components:

- `websocket.service.ts`: Core WebSocket setup and routing, implementing the connection upgrade handling
- `websocket-tpa.service.ts` and `websocket-glasses.service.ts` (in progress)

### Completed Implementation Elements

- **Core WebSocket Service**: Implements server initialization and connection routing
- **Authentication Extraction**: Extracts JWT tokens from headers during connection upgrade
- **Enhanced Error Responses**: Improved error handling during connection phase
- **JWT Validation**: Verifies JWT tokens and attaches payload to the request object

## New Directory Structure

```
/packages/cloud/src/services/
├── websocket/
│   ├── websocket.service.ts       # Core WebSocket setup and routing
│   ├── websocket-tpa.service.ts   # TPA-specific connection handling
│   ├── websocket-glasses.service.ts # Glasses client connection handling
│   ├── handlers/                   # Message-specific handlers
│   │   ├── glasses-handlers.ts     # Handlers for glasses messages
│   │   ├── tpa-handlers.ts         # Handlers for TPA messages
│   │   └── common-handlers.ts      # Shared handlers
│   └── REFACTORING-PLAN.md        # This document
├── session/
│   ├── MicrophoneManager.ts       # Microphone state management
│   └── MICROPHONE-MANAGER-DESIGN.md # Design document
├── core/
│   ├── developer.service.ts       # Developer-specific operations
│   └── docs/
│       └── developer-service-design.md # Design document
```

## Functions to Move to Session Service

### App Lifecycle Management

- `startAppSession(userSession, packageName)` - Handles app startup, webhook calls, etc.
- `stopAppSession(userSession, packageName)` - Handles app shutdown and cleanup
- `generateAppStateStatus(userSession)` - Creates app state information
- `isAppRunning(userSession, packageName)` - Checks if an app is already running

### Message Relaying

- **Rename** `broadcastToTpa(userSessionId, streamType, data)` to `relayMessageToTpas(userSession, streamType, data)`
  - Pass userSession object directly instead of userSessionId
  - Name reflects that we're relaying to multiple subscribed TPAs

- **Rename** `broadcastToTpaAudio(userSession, arrayBuffer)` to `relayAudioToTpas(userSession, arrayBuffer)`
  - Clear naming that reflects the audio-specific functionality
  - Already uses userSession object directly

### Session State Management

- `handleTpaInit(ws, initMessage, setCurrentSessionId)` - TPA session setup
- `handleAppStateBroadcast(userSession)` - Broadcast app state to all connected clients
- Parts of message handlers that update session state

## Message Type-Specific Processing

Each message type requires specialized processing that goes far beyond simple routing. These complex handling requirements are being preserved in dedicated handler functions:

### CONNECTION_INIT
- Start dashboard app (system app)
- Load and start all user's previously running apps from database
- Handle errors for each app independently
- Start transcription service
- Return detailed connection acknowledgment
- Track connection in analytics

```typescript
// Example handler pattern
private async handleConnectionInit(userSession: ExtendedUserSession, message: ConnectionInit): Promise<void> {
  try {
    // Specialized processing for CONNECTION_INIT
    // Start dashboard, load user's apps, etc.
  } catch (error) {
    userSession.logger.error(`Error handling CONNECTION_INIT:`, error);
    // Send appropriate error response
  }
}
```

### REQUEST_SETTINGS
- Retrieve user settings from database
- Format settings based on device capabilities
- Send formatted settings back to glasses

### START_APP/STOP_APP
- Handle app lifecycle transitions
- Update app state in session
- Send state changes to glasses
- Track events in analytics
- Handle connection cleanup for stopped apps

### GLASSES_CONNECTION_STATE
- Trigger microphone state changes based on subscriptions
- Track detailed connection state in analytics
- Manage device model tracking
- Update connection status for TPAs

### VAD (Voice Activity Detection)
- Manage transcription service start/stop
- Update session transcription state
- Handle errors specifically for transcription
- Broadcast to TPAs with appropriate metadata

### LOCATION_UPDATE
- Cache location data for future use
- Update user's location in database
- Broadcast to TPAs with location subscriptions
- Apply any formatting or transformation needed

### CALENDAR_EVENT
- Cache events for future subscribers
- Format and broadcast to TPAs
- Handle different calendar providers

### PHOTO_RESPONSE
- Process through the photoRequestService
- Handle request matching and validation
- Forward to requesting TPA with metadata

### VIDEO_STREAM_RESPONSE
- Forward to the specific requesting TPA
- Validate required fields
- Handle formatting and chunking if needed

### SETTINGS_UPDATE_REQUEST
- Retrieve current settings
- Format and send response
- Handle errors with specific error messages
- Update database with changes

### CORE_STATUS_UPDATE
- Map complex core status to AugmentOS settings
- Detect which specific settings changed
- Update database selectively
- Notify only TPAs subscribed to the changed settings

### Default Case
- Simply relay the message to all subscribed TPAs
- Apply any common transformations needed

## Functions to Keep in WebSocket Services

### Core WebSocket Service (websocket.service.ts)

- `setupWebSocketServers(server)` - WebSocket server initialization
- Connection upgrade handling and authentication extraction
- Routing connections to appropriate handlers
- Shared WebSocket utilities

### TPA WebSocket Service (websocket-tpa.service.ts)

- `handleConnection(ws, request)` - Initial connection setup
- Message parsing and routing to session methods
- WebSocket-specific error handling
- Authentication verification (both JWT and message-based)
- WebSocket event registration (message, close, error)

### Glasses WebSocket Service (websocket-glasses.service.ts)

- `handleConnection(ws, request)` - Uses pre-authenticated userId from request
- Message parsing and routing to appropriate specialized handlers
- WebSocket event registration (message, close, error)
- WebSocket-specific error handling

## Error Handling Architecture

The improved error handling architecture uses multiple layers:

1. **Handler-level try/catch**:
```typescript
private async handleMessageType(userSession: ExtendedUserSession, message: TypedMessage): Promise<void> {
  try {
    // Handler-specific logic with all its complex processing
    
    // Success response if needed
    if (needsResponse) {
      userSession.websocket.send(JSON.stringify({
        type: CloudToGlassesMessageType.SUCCESS_RESPONSE,
        originalMessageType: message.type,
        timestamp: new Date()
      }));
    }
  } catch (error) {
    // Handler-specific error handling
    userSession.logger.error(`Error handling ${message.type}:`, {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      },
      messageType: message.type
    });
    
    // Send error response to client
    try {
      userSession.websocket.send(JSON.stringify({
        type: CloudToGlassesMessageType.ERROR_RESPONSE,
        originalMessageType: message.type,
        errorCode: error.code || 'UNKNOWN_ERROR',
        message: error.message || 'An unknown error occurred',
        timestamp: new Date()
      }));
    } catch (sendError) {
      userSession.logger.error(`Failed to send error response:`, sendError);
    }
  }
}
```

2. **Switch statement fallback try/catch**:
```typescript
private async handleMessage(userSession: ExtendedUserSession, rawMessage: string): Promise<void> {
  try {
    const message = JSON.parse(rawMessage);
    
    // Validate message has a type
    if (!message || !message.type) {
      throw new Error('Invalid message format: missing type');
    }
    
    try {
      switch (message.type) {
        case GlassesToCloudMessageType.CONNECTION_INIT:
          await this.handleConnectionInit(userSession, message);
          break;
        // Other cases...
        default:
          await this.handleDefault(userSession, message);
          break;
      }
    } catch (handlerError) {
      // This should rarely be hit if individual handlers have proper error handling
      userSession.logger.warn(`Handler error not caught by handler for ${message.type}:`, handlerError);
      // Generic fallback handling
      this.sendErrorResponse(userSession, message.type, 'HANDLER_ERROR', handlerError.message);
    }
  } catch (parseError) {
    userSession.logger.error('Error parsing message:', parseError);
    this.sendErrorResponse(userSession, 'UNKNOWN', 'PARSE_ERROR', 'Failed to parse message');
  }
}
```

3. **Top-level event handler try/catch**:
```typescript
ws.on('message', async (data) => {
  try {
    await this.handleMessage(userSession, data.toString());
  } catch (error) {
    userSession.logger.error('Unhandled error in message handler:', error);
    // Last resort error handling
  }
});
```

## Authentication Flow

### Glasses Client Authentication

- Already implemented using header-based JWT authentication
- Verify JWT during connection upgrade
- Extract userId and pass to handler through the request object
- Close connection with error response if authentication fails

```typescript
// Extract JWT token from Authorization header for glasses
const coreToken = request.headers.authorization?.split(' ')[1];
if (!coreToken) {
  logger.error('No core token provided in request headers');
  socket.write(
    'HTTP/1.1 401 Unauthorized\r\n' +
    'Content-Type: application/json\r\n' +
    '\r\n' +
    JSON.stringify({
      type: CloudToGlassesMessageType.CONNECTION_ERROR,
      message: 'No core token provided',
      timestamp: new Date()
    })
  );
  socket.destroy();
  return;
}
```

### TPA Authentication

- **New Approach** (JWT-based):
  - Extract JWT from Authorization header during connection upgrade
  - Verify JWT and extract packageName and apiKey
  - Validate apiKey against stored hash in the database using developer.service
  - Pass verified data to handler through request object
  - Provide detailed error messages if authentication fails

- **Legacy Approach** (message-based):
  - Accept TpaConnectionInit message with packageName and apiKey
  - Validate apiKey against stored hash using developer.service
  - Maintain backward compatibility for existing TPAs
  - This approach will be used as fallback if JWT is not present

## Migration Strategy

Our migration strategy emphasizes safety and maintainability:

1. We will NOT modify the existing `websocket.service.ts` file at all
2. All new code will be in separate directories:
   - `/services/websocket/` for WebSocket-related components
   - `/services/session/` for session-related components
   - `/services/core/developer.service.ts` for developer-related functions
3. The existing WebSocket service will continue to function as is
4. Only the new WebSocket services will use the new components
5. We'll test both implementations side-by-side to ensure behavior parity
6. Only after thorough testing will we switch over to the new implementation
7. Finally, we'll remove unused functions from app.service.ts once we confirm everything works

## Implementation Plan

1. **Phase 1**: Create new directory structure and skeleton files (✅ Completed)
2. **Phase 2**: Implement core WebSocket service with authentication (✅ Completed)
3. **Phase 3**: Implement specialized handlers with proper error handling (🔄 In Progress)
4. **Phase 4**: Create MicrophoneManager and developer.service (🔄 In Progress)
5. **Phase 5**: Comprehensive testing to ensure no functionality is lost (⏳ Planned)
6. **Phase 6**: Transition to the new implementation while maintaining backward compatibility (⏳ Planned)
7. **Phase 7**: Remove duplicate code after confirming new implementation works perfectly (⏳ Planned)

## Benefits

1. **Improved Maintainability**: Smaller, focused files with clear responsibilities
2. **Better Error Handling**: Consistent error handling with detailed error messages
3. **Enhanced Security**: JWT-based authentication with better security model
4. **Clearer Architecture**: Proper separation between WebSocket handling and session logic
5. **Improved Developer Experience**: Better error messages and feedback
6. **Easier Testing**: Can test components independently with better separation of concerns
7. **Future Extensibility**: Clearer structure makes it easier to add new message types and handlers