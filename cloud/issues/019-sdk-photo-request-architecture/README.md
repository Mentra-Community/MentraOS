# 019 - SDK Photo Request Architecture

Photo requests from mini apps fail silently when SDK session reconnects during capture.

## Documents

- **photo-request-spec.md** - Problem, goals, constraints
- **photo-request-architecture.md** - Technical design and fix

## Quick Context

**Current**: Photo requests stored on `CameraModule` (per-session). Response arrives via HTTP to `AppServer`. AppServer iterates all sessions to find matching request. If session reconnected, it's not in `activeSessions` map → 404 → timeout.

**Proposed**: Move pending photo requests to `AppServer` level with direct `requestId` lookup. Also fix session cleanup to only remove on permanent disconnect.

## Key Context

The fundamental issue is **ownership mismatch**: HTTP responses arrive at `AppServer`, but pending requests live on `AppSession`. When sessions reconnect, they're temporarily removed from the lookup map, breaking the request→response chain.

This pattern is correct for WebSocket-based responses (same session object handles both), but wrong for HTTP-based responses (different component receives response).

## Root Cause

```
1. Photo request sent, stored in session.camera.pendingPhotoRequests
2. WebSocket disconnects (code 1006)
3. "disconnected" event fires BEFORE reconnection attempt
4. Cleanup handler removes session from activeSessions map
5. Reconnection succeeds 1s later
6. Photo upload arrives at /photo-upload endpoint
7. findSessionByPhotoRequestId() iterates activeSessions → session not there
8. Returns 404, request times out after 30s
```

## Evidence from Logs

```
17:32:29.626Z | 📸 Photo request sent (requestId: photo_req_xxx)
17:32:31.722Z | 📸 Received photo response (same requestId)
17:32:31.722Z | ⚠️ No active session found for photo request
17:32:59.627Z | 📸 Photo request timed out
```

## Status

- [x] Root cause identified
- [x] Log evidence collected
- [x] Move pendingPhotoRequests to AppServer level
- [x] Fix cleanup handler to only remove on permanent disconnect
- [x] Remove findSessionByPhotoRequestId iteration
- [ ] Test reconnection + photo capture flow

## Implementation Summary (Completed)

### AppServer Changes (`packages/sdk/src/app/server/index.ts`)

1. Added `registerPhotoRequest()` - stores pending request with timeout at AppServer level
2. Added `getPhotoRequest()` - O(1) lookup by requestId
3. Added `completePhotoRequest()` - clears timeout and removes from map
4. Added `cleanupPhotoRequestsForSession()` - cleans up on permanent disconnect
5. Updated `/photo-upload` endpoint to use direct lookup instead of iteration
6. Removed `findSessionByPhotoRequestId()` method
7. Fixed disconnect handler to only remove session from maps on **permanent** disconnect

### CameraModule Changes (`packages/sdk/src/app/session/modules/camera.ts`)

1. Removed local `pendingPhotoRequests` map
2. Updated `requestPhoto()` to register at AppServer level via `registerPhotoRequest()`
3. Removed `handlePhotoReceived()` and `handlePhotoError()` (now handled by AppServer)
4. Deprecated `hasPhotoPendingRequest()` and `cancelPhotoRequest()` (delegate to AppServer)
5. Updated `cancelAllPhotoRequests()` to be a no-op (cleanup at AppServer level)
