# TPA JWT Authentication System Design

## Problem Statement

The current TPA authentication system has several issues that impact developer experience:

1. **Authentication Complexity**: Developers must manage and correctly provide both `packageName` and `apiKey` separately during the WebSocket handshake.

2. **Poor Error Messaging**: When authentication fails, developers receive generic errors or stack traces without clear indication of the problem.

3. **Late Authentication**: Authentication happens after the WebSocket connection is established via a message-based handshake, making it harder to debug connection issues.

4. **Unclear Error States**: Developers cannot easily distinguish between different error scenarios (invalid API key, non-existent package name, etc.).

## Current Implementation

### Files Involved

- `/packages/cloud/src/services/core/websocket.service.ts`: Handles WebSocket connections and authentication
- `/packages/cloud/src/services/core/app.service.ts`: Validates API keys
- `/packages/sdk/src/types/messages/tpa-to-cloud.ts`: Defines TPA connection message format
- `/packages/sdk/src/tpa/session/index.ts`: Client-side TPA session management

### Current Authentication Flow

1. User initiates app start through the API or WebSocket message
2. Server sends a webhook to the TPA server with session information and WebSocket URL
3. TPA connects to the provided WebSocket URL
4. After connection, TPA sends a `TpaConnectionInit` message with:
   ```json
   {
     "type": "tpa_connection_init",
     "sessionId": "userSessionId-packageName",
     "packageName": "org.example.myapp",
     "apiKey": "api-key-value"
   }
   ```
5. Server validates the API key and package name:
   ```typescript
   // Get client IP address for system app validation
   const clientIp = (ws as any)._socket?.remoteAddress || '';

   // Validate API key with IP check for system apps
   const isValidKey = await appService.validateApiKey(
     initMessage.packageName,
     initMessage.apiKey,
     clientIp
   );

   if (!isValidKey) {
     userSession.logger.error(`Invalid API key for package: ${initMessage.packageName}`);
     ws.close(1008, 'Invalid API key');
     return;
   }
   ```
6. The server sends a `TpaConnectionAck` on success or closes the connection with a generic error on failure

### Current Error Handling

1. API key validation failures:
   ```typescript
   if (!isValidKey) {
     userSession.logger.error(`Invalid API key for package: ${initMessage.packageName}`);
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
3. The client receives minimal information from these closures and often has to rely on server logs for debugging

## Proposed Solution

### 1. JWT-Based Authentication

Replace separate packageName and apiKey with a single JWT token that contains both pieces of information.

#### JWT Format

```json
{
  "packageName": "org.example.myapp",
  "apiKey": "original-api-key-value"
}
```

The JWT will be signed with the server's secret, but will not have an expiration time.

### 2. Header-Based Authentication

Move authentication from the message-based handshake to the WebSocket connection headers, similar to how glasses clients authenticate.

#### New Connection Flow

TPAs will include the JWT in the WebSocket connection request:
```
GET /tpa-ws HTTP/1.1
Host: cloud.mentra.glass
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### 3. Enhanced Error Response Mechanism

Improve error handling to provide more descriptive error messages and codes.

#### Error Categories

1. Authentication errors (401)
   - Invalid JWT format
   - Invalid signature
   - Missing required fields

2. Authorization errors (403)
   - API key doesn't match package name
   - API key incorrect for this package

3. Not found errors (404)
   - Package name doesn't exist
   - Please register in developer console

4. Session errors (410)
   - Session expired
   - Session not found

### 4. Backwards Compatibility

Maintain support for the existing message-based authentication flow while encouraging migration to the JWT method.

## Implementation Plan

### 1. JWT Token Generation

**Files to modify**:
- `/packages/cloud/src/routes/developer.routes.ts`: Add endpoint to generate JWT for TPAs
- `/packages/cloud/src/services/core/app.service.ts`: Add JWT generation method

**New methods**:
- `generateTpaJwt(packageName, apiKey)`: Generates a JWT containing packageName and apiKey

### 2. Connection Authentication

**Files to modify**:
- `/packages/cloud/src/services/core/websocket.service.ts`: Update WebSocket upgrade handling
- `/packages/sdk/src/tpa/session/index.ts`: Update client connection logic

**Changes**:
- Modify WebSocket server to authenticate using Authorization header
- Extract JWT from request headers
- Verify JWT signature and extract packageName and apiKey
- Continue with existing validation logic using the extracted values

### 3. Error Handling Improvements

**Files to modify**:
- `/packages/cloud/src/services/core/websocket.service.ts`: Enhance error responses
- `/packages/sdk/src/tpa/session/index.ts`: Improve client-side error handling

**New Error Response Format**:
```json
{
  "type": "tpa_connection_error",
  "code": "INVALID_API_KEY",
  "message": "The API key provided does not match the stored API key for this package",
  "timestamp": "2023-05-11T12:34:56.789Z",
  "details": {
    "packageName": "org.example.myapp"
  }
}
```

**Error Codes**:
- `JWT_INVALID`: JWT format or signature is invalid
- `PACKAGE_NOT_FOUND`: Package name doesn't exist in the system
- `INVALID_API_KEY`: API key doesn't match the stored key
- `SESSION_NOT_FOUND`: User session not found
- `SESSION_EXPIRED`: Session has expired

### 4. Developer SDK Updates

**Files to modify**:
- `/packages/sdk/src/tpa/session/index.ts`: Update connection logic
- `/packages/sdk/src/tpa/token/index.ts`: Add JWT support

**New Methods**:
- `connectWithJwt(jwt, sessionId)`: Connect to MentraOS using JWT token
- `parseConnectionError(error)`: Helper to extract meaningful information from connection errors

### 5. Documentation

**Files to create/modify**:
- `/packages/sdk/docs/AUTHENTICATION.md`: Update authentication documentation
- `/packages/sdk/README.md`: Add section on JWT authentication

## Migration Path

1. Phase 1: Add JWT support while maintaining backward compatibility
   - Developers can use either method
   - Encourage new apps to use JWT method

2. Phase 2: Deprecate message-based authentication
   - Log warnings when message-based authentication is used
   - Set timeline for removal

3. Phase 3: Remove support for message-based authentication
   - Only JWT-based authentication is supported

## Potential Refactoring: WebSocket Service Splitting

The current `websocket.service.ts` file is very large and handles multiple responsibilities. As part of this work, we should consider splitting it into multiple files:

1. **websocket.service.ts**: Core WebSocket functionality, server setup, and shared utilities
2. **websocket-tpa.service.ts**: TPA-specific connection handling and authentication
3. **websocket-client.service.ts**: Glasses client connection handling

This refactoring would make the code more maintainable and allow for better separation of concerns, especially as we implement the new JWT authentication system.

## Benefits

1. **Simpler Developer Experience**: Single token instead of two separate values
2. **Earlier Authentication**: Auth happens at connection time, not after
3. **Better Error Messages**: Clear, specific error messages with codes
4. **Improved Security**: Standard JWT authentication with better error isolation
5. **Consistent Pattern**: Uses same header-based auth pattern as glasses client