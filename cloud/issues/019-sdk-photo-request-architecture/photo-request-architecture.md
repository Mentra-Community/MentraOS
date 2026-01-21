# Photo Request Architecture

## Current System

### Request/Response Flow (Broken)

```
Mini App                     AppServer                    ASG/Glasses
    │                            │                            │
    │ camera.requestPhoto()      │                            │
    ├───────────────────────────►│                            │
    │ stores in session.camera   │                            │
    │ .pendingPhotoRequests      │                            │
    │                            │                            │
    │                      [WebSocket disconnects]            │
    │                            │                            │
    │                   session removed from                  │
    │                   activeSessions map                    │
    │                            │                            │
    │                      [WebSocket reconnects]             │
    │                            │                            │
    │                   session NOT re-added                  │
    │                   to activeSessions                     │
    │                            │                            │
    │                            │◄───────────────────────────┤
    │                            │  HTTP POST /photo-upload   │
    │                            │                            │
    │                   findSessionByPhotoRequestId()         │
    │                   iterates activeSessions               │
    │                   → NOT FOUND                           │
    │                            │                            │
    │                   returns 404                           │
    │◄───────────────────────────┤                            │
    │  timeout after 30s         │                            │
```

### Key Code Paths

**Photo request storage** - `packages/sdk/src/app/session/modules/camera.ts:96-102`

```typescript
private pendingPhotoRequests = new Map<
  string,
  {
    resolve: (value: PhotoData) => void
    reject: (reason?: string) => void
  }
>()
```

**Session cleanup on disconnect** - `packages/sdk/src/app/server/index.ts:500-507`

```typescript
// Runs on EVERY disconnect, before reconnection attempt
if (this.activeSessions.get(sessionId) === session) {
  this.activeSessions.delete(sessionId)
}
if (this.activeSessionsByUserId.get(userId) === session) {
  this.activeSessionsByUserId.delete(userId)
}
```

**Photo lookup by iteration** - `packages/sdk/src/app/server/index.ts:813-821`

```typescript
private findSessionByPhotoRequestId(requestId: string): AppSession | undefined {
  for (const [_sessionId, session] of this.activeSessions) {
    if (session.camera.hasPhotoPendingRequest(requestId)) {
      return session
    }
  }
  return undefined
}
```

### Problems

1. **Ownership mismatch**: HTTP endpoint receives response, but pending requests live on session
2. **Session removed prematurely**: Cleanup runs before reconnection, never re-added after
3. **O(n) lookup**: Iterating all sessions instead of direct map lookup
4. **Fragile coupling**: Depends on session being in activeSessions map

## Proposed System

### Request/Response Flow (Fixed)

```
Mini App                     AppServer                    ASG/Glasses
    │                            │                            │
    │ camera.requestPhoto()      │                            │
    ├───────────────────────────►│                            │
    │                            │                            │
    │ registers in AppServer     │                            │
    │ .pendingPhotoRequests      │                            │
    │ [requestId → {session,     │                            │
    │   resolve, reject}]        │                            │
    │                            │                            │
    │                      [WebSocket disconnects]            │
    │                            │                            │
    │                   session STAYS in                      │
    │                   activeSessions (temp disconnect)      │
    │                            │                            │
    │                      [WebSocket reconnects]             │
    │                            │                            │
    │                            │◄───────────────────────────┤
    │                            │  HTTP POST /photo-upload   │
    │                            │                            │
    │                   this.pendingPhotoRequests.get(reqId)  │
    │                   → FOUND (O(1) lookup)                 │
    │                            │                            │
    │                   pending.resolve(photoData)            │
    │◄───────────────────────────┤                            │
    │  Promise resolves ✓        │                            │
```

### Key Changes

1. **Pending requests at AppServer level**: Single source of truth with O(1) lookup
2. **Only remove on permanent disconnect**: Sessions stay in map during reconnection
3. **Direct requestId lookup**: No iteration, immediate access
4. **Clean ownership**: HTTP endpoint owns the pending request map it needs

## Implementation Details

### 1. AppServer Pending Photo Requests Map

```typescript
// packages/sdk/src/app/server/index.ts

interface PendingPhotoRequest {
  userId: string
  sessionId: string
  session: AppSession
  resolve: (photo: PhotoData) => void
  reject: (error: Error) => void
  timestamp: number
  timeoutId?: NodeJS.Timeout
}

export class AppServer {
  // ... existing fields ...

  /** Pending photo requests by requestId - owned by AppServer for HTTP endpoint access */
  private pendingPhotoRequests = new Map<string, PendingPhotoRequest>()
```

### 2. Photo Request Registration API

```typescript
// packages/sdk/src/app/server/index.ts

/**
 * Register a pending photo request
 * Called by CameraModule when photo is requested
 */
registerPhotoRequest(
  requestId: string,
  request: Omit<PendingPhotoRequest, 'timeoutId'>
): void {
  // Set timeout at AppServer level
  const timeoutMs = 30000 // 30 seconds
  const timeoutId = setTimeout(() => {
    const pending = this.pendingPhotoRequests.get(requestId)
    if (pending) {
      pending.reject(new Error('Photo request timed out'))
      this.pendingPhotoRequests.delete(requestId)
      this.logger.warn({ requestId }, '📸 Photo request timed out')
    }
  }, timeoutMs)

  this.pendingPhotoRequests.set(requestId, {
    ...request,
    timeoutId,
  })

  this.logger.debug({ requestId, userId: request.userId }, '📸 Photo request registered')
}

/**
 * Get a pending photo request by ID
 */
getPhotoRequest(requestId: string): PendingPhotoRequest | undefined {
  return this.pendingPhotoRequests.get(requestId)
}

/**
 * Complete a photo request (success or error)
 */
completePhotoRequest(requestId: string): PendingPhotoRequest | undefined {
  const pending = this.pendingPhotoRequests.get(requestId)
  if (pending) {
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId)
    }
    this.pendingPhotoRequests.delete(requestId)
  }
  return pending
}

/**
 * Clean up all pending requests for a session (on permanent disconnect)
 */
cleanupPhotoRequestsForSession(sessionId: string): void {
  for (const [requestId, pending] of this.pendingPhotoRequests) {
    if (pending.sessionId === sessionId) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId)
      }
      pending.reject(new Error('Session ended'))
      this.pendingPhotoRequests.delete(requestId)
      this.logger.debug({ requestId, sessionId }, '📸 Photo request cleaned up (session ended)')
    }
  }
}
```

### 3. Updated CameraModule

```typescript
// packages/sdk/src/app/session/modules/camera.ts

async requestPhoto(options?: PhotoRequestOptions): Promise<PhotoData> {
  return new Promise((resolve, reject) => {
    const requestId = `photo_req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

    // Register at AppServer level (single source of truth)
    this.session.appServer.registerPhotoRequest(requestId, {
      userId: this.session.userId,
      sessionId: this.sessionId,
      session: this.session,
      resolve,
      reject,
      timestamp: Date.now(),
    })

    // Send request to cloud
    const message: PhotoRequest = {
      type: AppToCloudMessageType.PHOTO_REQUEST,
      packageName: this.packageName,
      sessionId: this.sessionId,
      requestId,
      timestamp: new Date(),
      saveToGallery: options?.saveToGallery || false,
      // ... other options
    }

    this.session.sendMessage(message)
    this.logger.info({ requestId }, '📸 Photo request sent')

    // Custom webhook URL case - resolve immediately
    if (options?.customWebhookUrl) {
      const pending = this.session.appServer.completePhotoRequest(requestId)
      if (pending) {
        pending.resolve({
          buffer: Buffer.from([]),
          mimeType: 'image/jpeg',
          filename: 'photo.jpg',
          requestId,
          size: 0,
          timestamp: new Date(),
        })
      }
    }
  })
}

// Remove pendingPhotoRequests map from CameraModule
// Remove hasPhotoPendingRequest method
// Remove timeout management (now at AppServer level)
```

### 4. Updated Photo Upload Endpoint

```typescript
// packages/sdk/src/app/server/index.ts - setupPhotoUploadEndpoint()

this.app.post("/photo-upload", upload.single("photo"), async (req, res) => {
  try {
    const {requestId, type, success, errorCode, errorMessage} = req.body
    const photoFile = req.file

    if (!requestId) {
      return res.status(400).json({success: false, error: "No requestId provided"})
    }

    // Direct O(1) lookup
    const pending = this.completePhotoRequest(requestId)
    if (!pending) {
      this.logger.warn({requestId}, "📸 No pending request found for photo")
      return res.status(404).json({success: false, error: "No pending request found"})
    }

    // Handle error response
    if (type === "photo_error" || success === false) {
      pending.reject(new Error(errorMessage || "Photo capture failed"))
      return res.json({success: true, message: "Photo error received"})
    }

    // Handle success
    if (!photoFile) {
      pending.reject(new Error("No photo file provided"))
      return res.status(400).json({success: false, error: "No photo file"})
    }

    pending.resolve({
      buffer: photoFile.buffer,
      mimeType: photoFile.mimetype,
      filename: photoFile.originalname || "photo.jpg",
      requestId,
      size: photoFile.size,
      timestamp: new Date(),
    })

    res.json({success: true, message: "Photo received"})
  } catch (error) {
    this.logger.error(error, "❌ Error handling photo upload")
    res.status(500).json({success: false, error: "Internal server error"})
  }
})
```

### 5. Fixed Session Cleanup Handler

```typescript
// packages/sdk/src/app/server/index.ts - handleSessionRequest()

const cleanupDisconnect = session.events.onDisconnected((info) => {
  // Log disconnect
  if (typeof info === "string") {
    this.logger.info(`👋 Session ${sessionId} disconnected: ${info}`)
  } else {
    this.logger.info(`👋 Session ${sessionId} disconnected: ${info.message} (code: ${info.code})`)
  }

  // Determine if this is a permanent disconnect
  const isPermanent = typeof info === "object" && (info.permanent === true || info.sessionEnded === true)

  if (isPermanent) {
    // Call onStop for permanent disconnections
    if (typeof info === "object" && info.sessionEnded) {
      this.onStop(sessionId, userId, "User session ended").catch((err) => {
        this.logger.error(err, "❌ Error in onStop handler")
      })
    } else if (typeof info === "object" && info.permanent) {
      this.onStop(sessionId, userId, `Connection permanently lost: ${info.reason}`).catch((err) => {
        this.logger.error(err, "❌ Error in onStop handler")
      })
    }

    // Only remove session on permanent disconnect
    if (this.activeSessions.get(sessionId) === session) {
      this.activeSessions.delete(sessionId)
    }
    if (this.activeSessionsByUserId.get(userId) === session) {
      this.activeSessionsByUserId.delete(userId)
    }

    // Clean up pending photo requests for this session
    this.cleanupPhotoRequestsForSession(sessionId)
  } else {
    // Temporary disconnect - session stays in maps
    // SDK will attempt reconnection
    this.logger.debug({sessionId}, "🔄 Temporary disconnect, session stays in maps")
  }
})
```

## Migration Strategy

1. **Add new API**: Add `registerPhotoRequest`, `completePhotoRequest`, `cleanupPhotoRequestsForSession` to AppServer
2. **Update CameraModule**: Remove local `pendingPhotoRequests`, delegate to AppServer
3. **Update endpoint**: Use direct lookup instead of `findSessionByPhotoRequestId`
4. **Fix cleanup**: Only remove session on permanent disconnect
5. **Remove deprecated**: Delete `findSessionByPhotoRequestId` method
6. **Test**: Verify photo capture works during reconnection

## Files to Modify

| File                                             | Change                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/sdk/src/app/server/index.ts`           | Add pending photo requests map, registration API, fix cleanup handler |
| `packages/sdk/src/app/session/modules/camera.ts` | Remove local pending map, delegate to AppServer                       |

## Edge Cases

### Edge Case 1: Photo arrives during reconnection

```
Photo sent → WebSocket disconnects → Photo arrives → Reconnection succeeds
```

**Fixed**: Pending request is at AppServer level, found immediately.

### Edge Case 2: Session permanently ends with pending request

```
Photo sent → User session ends → Photo never arrives
```

**Fixed**: `cleanupPhotoRequestsForSession()` rejects pending promise with clear error.

### Edge Case 3: Timeout during reconnection

```
Photo sent → Reconnection takes 35s → Timeout fires
```

**Fixed**: Timeout is at AppServer level, fires correctly regardless of session state.

### Edge Case 4: Multiple photos from same session

```
Photo 1 sent → Photo 2 sent → Photo 1 arrives → Photo 2 arrives
```

**Works**: Each has unique requestId, direct O(1) lookup.

## Open Questions

1. **Memory limit?** Should we cap the number of pending requests per session?
   - **Proposed**: No explicit cap, timeout handles cleanup

2. **Metrics?** Should we track photo request success/failure rates?
   - **Proposed**: Add logging, metrics can be derived from logs

3. **Retry?** Should failed photo requests auto-retry?
   - **Proposed**: No, let the app decide whether to retry
