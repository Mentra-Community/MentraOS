# Current WebSocket Implementation Documentation

## Overview

This document outlines the current implementation of the WebSocket service in AugmentOS, focusing on how it manages connections, sessions, and communication between clients (glasses) and Third-Party Applications (TPAs). This service is critical for deaf and hard of hearing users who rely on the system's functionality.

## Key Files

- `/packages/cloud/src/services/core/websocket.service.ts`: Main WebSocket service implementation
- `/packages/cloud/src/services/core/app.service.ts`: App management and API key validation
- `/packages/cloud/src/services/core/session.service.ts`: Session management
- `/packages/cloud/src/services/core/subscription.service.ts`: TPA subscription management
- `/packages/cloud/src/services/core/tpa-registration.service.ts`: TPA server registration
- `/packages/cloud/src/models/tpa-server.model.ts`: TPA server registration data model

## Session Types

### UserSession Structure

The system uses an `ExtendedUserSession` type which appears to extend the base `UserSession` interface from the SDK. Key properties include:

- `sessionId`: Unique identifier for the user session
- `userId`: User identifier (email)
- `websocket`: WebSocket connection to the glasses client
- `appConnections`: Map of package names to WebSocket connections for TPAs
- `activeAppSessions`: Array of active TPA package names
- `loadingApps`: Set of package names for TPAs in the process of loading
- `startTime`: When the session was started
- `heartbeatManager`: Manages connection health monitoring
- `displayManager`: Manages display events to glasses
- `logger`: Session-specific logger

## Connection Flow

### Glasses Client Connection

1. Client connects to `/glasses-ws` endpoint
2. `handleGlassesConnection` processes the connection
3. Client sends a `CONNECTION_INIT` message with authentication
4. Server validates the connection and creates a user session
5. Server responds with `CONNECTION_ACK` if successful

### TPA Connection

1. User initiates app start via API or WebSocket message
2. Server calls `startAppSession` method
3. Server looks up app information and adds it to `loadingApps`
4. Server sends webhook to TPA server with session information and WebSocket URL
5. TPA connects to `/tpa-ws` endpoint
6. `handleTpaConnection` processes the connection
7. TPA sends a `TpaConnectionInit` message with:
   - sessionId (format: userSessionId-packageName)
   - packageName
   - apiKey
8. Server validates the API key using `appService.validateApiKey`
9. If valid, server stores the WebSocket connection in `userSession.appConnections`
10. Server sends `TpaConnectionAck` with settings
11. TPA is moved from `loadingApps` to `activeAppSessions`

## Authentication Flow

### TPA Authentication

Current implementation in `handleTpaConnection` and `handleTpaInit`:

```typescript
// Extract from message
const initMessage = message as TpaConnectionInit;
const packageName = initMessage.packageName;
const apiKey = initMessage.apiKey;

// Get client IP address for system app validation
const clientIp = (ws as any)._socket?.remoteAddress || '';

// Validate API key with IP check for system apps
const isValidKey = await appService.validateApiKey(
  packageName,
  apiKey,
  clientIp
);

if (!isValidKey) {
  userSession.logger.error(`Invalid API key for package: ${packageName}`);
  ws.close(1008, 'Invalid API key');
  return;
}
```

The `validateApiKey` method in `app.service.ts` handles:
- Checking if the app exists
- Special validation for system apps (including IP checks)
- Hashing the provided API key and comparing with stored hash

## Message Routing

### From Glasses to TPAs

1. Glasses client sends message to cloud
2. `handleGlassesMessage` processes the message
3. Based on the message type and subscriptions, `broadcastToTpa` is called
4. TPAs that have subscribed to that message type receive the message

### From TPAs to Glasses

1. TPA sends message to cloud
2. `handleTpaMessage` processes the message
3. For display requests, the message is verified and forwarded
4. Messages route through the session's display manager to the glasses client

## TPA Server Registration

The TPA server registration system enables TPAs to recover their sessions after a server restart:

1. TPA servers register via `POST /api/tpa-server/register`
2. Registration includes packageName, apiKey, webhookUrl, and serverUrls
3. System tracks which TPAs are associated with which user sessions
4. When a TPA server restarts, it notifies the system
5. System triggers reconnection to restore the TPA sessions

## Error Handling

Current error handling for TPA connections:

1. API key validation failure:
```typescript
if (!isValidKey) {
  userSession.logger.error(`Invalid API key for package: ${packageName}`);
  ws.close(1008, 'Invalid API key');
  return;
}
```

2. Missing user session:
```typescript
if (!userSession || !userSessionId) {
  logger.error(`User session not found for ${userSessionId}`);
  ws.close(1008, 'No active session');
  return;
}
```

Error responses to TPAs are limited in detail, using WebSocket close codes with brief messages.

## Other Important Components

### HeartbeatManager

Monitors connection health for both glasses clients and TPAs:
- Tracks last activity time for each connection
- Sends ping/pong messages to check connection status
- Automatically closes dead connections
- Provides stats on connection health

### SubscriptionManager

Manages which TPAs are subscribed to which data streams:
- TPAs send subscription updates to specify which events they want
- System routes messages based on these subscriptions
- Supports various stream types (audio, transcription, location, etc.)

### DisplayManager

Handles display events to the glasses:
- Manages what's shown on the glasses display
- Handles multiple TPAs trying to display content
- Enforces throttling and priority rules
- Ensures proper formatting for the glasses display

## Important Details

1. Session Identifiers:
   - User sessions have a unique `sessionId`
   - TPA sessions use a combined ID format: `userSessionId-packageName`

2. WebSocket URL Configuration:
   - System apps connect to internal URLs in containerized environments
   - External TPAs connect to public URLs
   - Development environments use localhost URLs

3. Timeouts:
   - TPA connection timeout: 5000ms (5 seconds)
   - Various other timeouts for different operations

4. Recovery Mechanisms:
   - Auto-restart for TPAs that disconnect unexpectedly
   - TPA server registration for recovering from server restarts
   - Heartbeat monitoring to detect and clean up stale connections

## Current Challenges

1. Error reporting to TPAs is limited, with minimal information provided
2. Authentication happens after the WebSocket connection is established
3. TPAs must provide both packageName and apiKey manually