# Photo Request Architecture Spec

## Overview

Photo requests from mini apps fail when the SDK session reconnects during capture. The response arrives via HTTP but can't find the session because it was temporarily removed from the lookup map during reconnection.

## Problem

### 1. Ownership Mismatch

Pending photo requests are stored on `CameraModule` (per-session), but responses arrive via HTTP at `AppServer`:

```
Request:  AppSession.camera.requestPhoto() → stores in session.camera.pendingPhotoRequests
Response: HTTP POST /photo-upload → AppServer → iterates ALL sessions to find request
```

For WebSocket-based responses (audio, direct messages), this works because the same session object handles both request and response. For HTTP-based responses, the receiving component (`AppServer`) has no direct access to the session's pending requests.

### 2. Session Removed on Every Disconnect

The cleanup handler removes sessions from `activeSessions` on **every** disconnect, even temporary ones:

```typescript
// packages/sdk/src/app/server/index.ts
session.events.onDisconnected((info) => {
  // Runs BEFORE reconnection attempt!
  if (this.activeSessions.get(sessionId) === session) {
    this.activeSessions.delete(sessionId) // Gone immediately
  }
})
```

Timeline:

1. WebSocket closes (code 1006)
2. `disconnected` event fires
3. Session removed from `activeSessions`
4. `handleReconnection()` called
5. Reconnection succeeds 1s later
6. Session is NOT re-added to `activeSessions`

### 3. O(n) Lookup by Iteration

Current lookup iterates all sessions:

```typescript
// packages/sdk/src/app/server/index.ts
private findSessionByPhotoRequestId(requestId: string): AppSession | undefined {
  for (const [_sessionId, session] of this.activeSessions) {
    if (session.camera.hasPhotoPendingRequest(requestId)) {
      return session
    }
  }
  return undefined
}
```

This is both inefficient (O(n) instead of O(1)) and fragile (depends on session being in map).

### Evidence from Logs

```
17:32:29.626Z | 📸 Photo request sent (requestId: photo_req_1767461549626_3moe9cu)
17:32:31.722Z | 📸 Received photo response (same requestId)
17:32:31.722Z | ⚠️ No active session found for photo request
17:32:59.627Z | 📸 Photo request timed out
```

Photo arrived 2 seconds after request, but session wasn't in map.

### Constraints

- **HTTP endpoint**: ASG/glasses upload directly to mini app's `/photo-upload` endpoint
- **Session reconnection**: SDK automatically reconnects on abnormal WebSocket close
- **Same session object**: Reconnection reuses the same `AppSession` instance
- **No new webhook**: Reconnection doesn't trigger new webhook (no re-registration in maps)

## Goals

1. **O(1) lookup**: Direct `requestId → request` mapping at AppServer level
2. **Survive reconnection**: Pending requests persist through session reconnects
3. **Single source of truth**: One place for pending photo requests, not duplicated
4. **Clean ownership**: Component receiving response owns the pending request map

## Non-Goals

- Changing how ASG uploads photos (HTTP POST to mini app webhook)
- Changing the photo request message format
- Fixing other pending request systems (audio, etc. work fine via WebSocket)

## Proposed Solution

### 1. Move Pending Photo Requests to AppServer

```typescript
// AppServer level - single source of truth
private pendingPhotoRequests = new Map<string, {
  userId: string,
  sessionId: string,
  session: AppSession,
  resolve: (photo: PhotoData) => void,
  reject: (error: Error) => void,
  timestamp: number
}>()
```

### 2. CameraModule Delegates to AppServer

```typescript
// CameraModule.requestPhoto()
const requestId = generateRequestId()
this.session.appServer.registerPhotoRequest(requestId, {
  userId: this.session.userId,
  sessionId: this.sessionId,
  session: this.session,
  resolve,
  reject,
  timestamp: Date.now(),
})
```

### 3. Direct Lookup on Photo Upload

```typescript
// /photo-upload endpoint
const pending = this.pendingPhotoRequests.get(requestId)
if (!pending) {
  return res.status(404).json({error: "Unknown request"})
}
pending.resolve(photoData)
this.pendingPhotoRequests.delete(requestId)
```

### 4. Only Remove Session on Permanent Disconnect

```typescript
session.events.onDisconnected((info) => {
  const isPermanent = typeof info === "object" && (info.permanent === true || info.sessionEnded === true)

  if (isPermanent) {
    // Only then remove from maps
    if (this.activeSessions.get(sessionId) === session) {
      this.activeSessions.delete(sessionId)
    }
    // Also clean up any pending photo requests for this session
    this.cleanupPhotoRequestsForSession(sessionId)
  }
})
```

## Open Questions

1. **Timeout ownership**: Should photo request timeout be managed at AppServer level too, or stay in CameraModule?
   - **Proposed**: AppServer level, since it owns the pending map

2. **Cleanup on session end**: When session permanently disconnects, reject all pending requests?
   - **Proposed**: Yes, with clear error message

3. **Memory concerns**: Map grows with pending requests, need cleanup on timeout
   - **Proposed**: AppServer manages timeouts, cleans up on expiry

## Related Systems

| System          | Response Channel | Pending Storage  | Bug Risk |
| --------------- | ---------------- | ---------------- | -------- |
| **Photo**       | HTTP             | Session (broken) | **HIGH** |
| Audio           | WebSocket        | Session          | Low      |
| Direct Messages | WebSocket        | Session          | Low      |
| User Discovery  | WebSocket        | Session          | Low      |

Only photo has this issue because it's the only one using HTTP for responses.
