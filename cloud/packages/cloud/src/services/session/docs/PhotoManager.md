# PhotoManager Documentation

## Overview

The PhotoManager is a session-level service that handles photo capture requests for Mentra Live glasses within the MentraOS ecosystem. It manages the complete flow from app-initiated photo requests through glasses capture to response delivery, utilizing a direct upload architecture for optimal performance.

## Architecture

### Core Responsibility

- Centralized photo request management for user sessions
- Direct upload coordination between glasses and apps
- Request timeout handling and cleanup
- Integration with app resurrection mechanisms

### File Location

```
/packages/cloud/src/services/session/PhotoManager.ts
```

## Complete Photo Request Flow

### 1. App Initiates Photo Request

**File:** `websocket-app.service.ts`

**Function:** `handleAppMessage()` (Lines 251-268)

```typescript
case AppToCloudMessageType.PHOTO_REQUEST:
  const photoRequestMsg = message as PhotoRequest;
  const requestId = await userSession.photoManager.requestPhoto(photoRequestMsg);
```

**Dependencies:**

- Imports: `PhotoRequest` from `@mentra/sdk`
- Imports: `UserSession` from `../session/UserSession`

### 2. UserSession Integration

**File:** `UserSession.ts`

**Initialization:** (Line 104)

```typescript
this.photoManager = new PhotoManager(this);
```

**Property Declaration:** (Line 71)

```typescript
public photoManager: PhotoManager;
```

**Dependencies:**

- Imports: `PhotoManager` from `./PhotoManager`

### 3. PhotoManager Request Processing

**File:** `PhotoManager.ts`

**Function:** `requestPhoto()` (Lines 65-119)

```typescript
async requestPhoto(appRequest: PhotoRequest): Promise<string> {
  // Get app's webhook URL for direct upload
  const app = this.userSession.installedApps.get(packageName);
  const webhookUrl = app?.publicUrl ? `${app.publicUrl}/photo-upload` : undefined;

  // Create message to glasses
  const messageToGlasses = {
    type: CloudToGlassesMessageType.PHOTO_REQUEST,
    sessionId: this.userSession.sessionId,
    requestId,
    appId: packageName,
    webhookUrl, // Direct upload URL for glasses
    timestamp: new Date(),
  };

  // Send to glasses via WebSocket
  this.userSession.websocket.send(JSON.stringify(messageToGlasses));
}
```

**Key Features:**

- Generates webhook URL: `${app.publicUrl}/photo-upload`
- Stores pending request with 30-second timeout
- Sends direct upload instructions to glasses

### 4. Glasses Response Handling

**File:** `websocket-glasses.service.ts`

**Message Handler:** (Lines 374-377)

```typescript
case GlassesToCloudMessageType.PHOTO_RESPONSE:
  userSession.photoManager.handlePhotoResponse(message as PhotoResponse);
  break;
```

### 5. PhotoManager Response Processing

**File:** `PhotoManager.ts`

**Function:** `handlePhotoResponse()` (Lines 125-139)

```typescript
async handlePhotoResponse(glassesResponse: PhotoResponse): Promise<void> {
  const pendingPhotoRequest = this.pendingPhotoRequests.get(requestId);
  clearTimeout(pendingPhotoRequest.timeoutId);
  this.pendingPhotoRequests.delete(requestId);
  await this._sendPhotoResultToApp(pendingPhotoRequest, glassesResponse);
}
```

**Function:** `_sendPhotoResultToApp()` (Lines 157-169)

```typescript
private async _sendPhotoResultToApp(pendingPhotoRequest, photoResponse) {
  const result = await this.userSession.appManager.sendMessageToApp(packageName, photoResponse);
}
```

## Key Components

### Dependencies

**Imports:**

```typescript
import {
  PhotoRequest,
  PhotoResponse,
  CloudToGlassesMessageType,
} from "@mentra/sdk";
import UserSession from "./UserSession";
import WebSocket from "ws";
import crypto from "crypto";
```

### Interface Definitions

**PendingPhotoRequest:**

```typescript
interface PendingPhotoRequest {
  requestId: string;
  userId: string;
  timestamp: number;
  packageName: string;
  appWebSocket: WebSocket | undefined;
  saveToGallery: boolean;
  timeoutId: NodeJS.Timeout;
}
```

### Core Methods

| Method                                     | Purpose                   | Returns                       |
| ------------------------------------------ | ------------------------- | ----------------------------- |
| `requestPhoto(appRequest)`                 | Process app photo request | `Promise<string>` (requestId) |
| `handlePhotoResponse(response)`            | Handle glasses response   | `Promise<void>`               |
| `_sendPhotoResultToApp(request, response)` | Send result to app        | `Promise<void>`               |
| `_handlePhotoRequestTimeout(requestId)`    | Handle request timeout    | `void`                        |

## Message Flow Diagram

```
┌─────────────┐    PhotoRequest     ┌──────────────────┐
│     App     │ ──────────────────► │ websocket-app    │
└─────────────┘                     │ .service.ts      │
                                    └──────────────────┘
                                            │
                                            ▼
                                    ┌──────────────────┐
                                    │ PhotoManager     │
                                    │ .requestPhoto()  │
                                    └──────────────────┘
                                            │
                                            ▼
┌─────────────┐   PHOTO_REQUEST     ┌──────────────────┐
│   Glasses   │ ◄─────────────────── │ WebSocket to     │
│             │                     │ Glasses          │
└─────────────┘                     └──────────────────┘
      │
      │ Direct Upload
      ▼
┌─────────────┐    POST /photo-upload
│ App Server  │ ◄─────────────────── Glasses uploads
│ /photo-upload│                     photo directly
└─────────────┘
      │
      │ Photo delivered
      ▼
┌─────────────┐
│ App Code    │ ← Promise resolved with PhotoData
│ (SDK)       │
└─────────────┘
```

## Direct Upload Architecture

### Key Benefits

- **Performance:** Photos bypass cloud storage for faster delivery
- **Scalability:** Apps handle their own photo processing
- **Efficiency:** Reduces cloud bandwidth usage
- **Real-time:** Direct glasses-to-app communication

### Webhook URL Generation

```typescript
const webhookUrl = app?.publicUrl ? `${app.publicUrl}/photo-upload` : undefined;
```

Apps receive photos at their own `/photo-upload` endpoint with:

- Multipart form data with photo file
- Request correlation via `requestId`
- Immediate promise resolution in SDK

## Timeout Management

**Default Timeout:** 30 seconds (`PHOTO_REQUEST_TIMEOUT_MS_DEFAULT`)

**Timeout Handling:**

```typescript
timeoutId: setTimeout(
  () => this._handlePhotoRequestTimeout(requestId),
  PHOTO_REQUEST_TIMEOUT_MS_DEFAULT,
);
```

Automatic cleanup prevents memory leaks and hanging promises.

## Integration Points

### App Manager Integration

- Uses `userSession.appManager.sendMessageToApp()` for response delivery
- Automatic app resurrection if connection is lost
- Centralized message routing

### WebSocket Integration

- Direct communication with glasses via `userSession.websocket`
- Message type: `CloudToGlassesMessageType.PHOTO_REQUEST`
- Response type: `GlassesToCloudMessageType.PHOTO_RESPONSE`

### Session Management

- Integrated with UserSession lifecycle
- Automatic cleanup on session end
- Request tracking per session

## Legacy vs Current Architecture

### ❌ Deprecated Files (Not Used)

```
/packages/cloud/src/services/core/photo-request.service.ts
// Line 1: "This file is deprecated and not used"

/packages/cloud/src/routes/photos.routes.ts
// Legacy cloud-based upload route (bypassed)
```

### ✅ Current Active Flow

```
App → PhotoManager → Glasses → Direct Upload to App
```

The current implementation eliminates cloud-based photo storage in favor of direct upload architecture while maintaining the same SDK interface for developers.

## Error Handling

### Request Validation

- Validates glasses WebSocket connection
- Validates app installation and webhook URL
- Validates pending request existence

### Timeout Protection

- 30-second automatic timeout
- Cleanup of pending requests
- Prevention of memory leaks

### Connection Resilience

- Integration with app resurrection mechanism
- Automatic retry through AppManager
- Graceful handling of connection failures

## Security Considerations

### Request Correlation

- Unique request IDs prevent request confusion
- Timeout-based cleanup prevents resource exhaustion
- Session-scoped request tracking

### Direct Upload Security

- Apps control their own photo endpoints
- No cloud-based photo storage
- Request validation at multiple layers
