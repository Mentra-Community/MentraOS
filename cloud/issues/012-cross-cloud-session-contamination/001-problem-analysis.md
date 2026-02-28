# Session Lifecycle Bug: Wrong Session Disposed on Environment Switch

## Summary

When a user switches environments (e.g., cloud-dev → cloud-debug), the old environment's session disposal incorrectly disposes the NEW active session instead of the old orphaned one.

## Evidence

From logs (2025-12-10 00:36-00:37 UTC):

| Time         | Source      | Event                                                             |
| ------------ | ----------- | ----------------------------------------------------------------- |
| 00:36:04.684 | cloud-debug | Webhook triggered for com.mentra.captions.beta                    |
| 00:36:04.971 | cloud-debug | App connected and authenticated                                   |
| 00:36:05.019 | cloud-debug | Subscription update received (subscribe)                          |
| 00:37:03.803 | cloud-dev   | Dispose: "Closed connection for com.mentra.captions.beta"         |
| 00:37:03.824 | cloud-debug | "Received subscription update from App: com.mentra.captions.beta" |
| 00:37:03.843 | cloud-debug | "App removed from transcription set"                              |
| 00:37:03.844 | cloud-debug | "No active subscriptions - closing Soniox stream"                 |

Note: The subscription **unsubscribe** at 00:37:03.824 came to **cloud-debug**, not cloud-dev. The disposal on cloud-dev triggered an unsubscribe that affected cloud-debug.

## Root Cause

### The Bug Flow

1. **User connects to cloud-dev**:
   - Cloud-dev triggers SESSION_REQUEST webhook to Captions app server
   - SDK creates `AppSession1` with WebSocket to cloud-dev
   - Captions app creates `UserSession1` with `appSession = AppSession1`
   - `UserSession.userSessions[userId]` = UserSession1

2. **User switches to cloud-debug**:
   - Cloud-debug triggers SESSION_REQUEST webhook to Captions app server
   - SDK creates **NEW** `AppSession2` with WebSocket to cloud-debug
   - Captions app creates **NEW** `UserSession2` with `appSession = AppSession2`
   - `UserSession.userSessions[userId]` = UserSession2 (**overwrites** UserSession1)
   - UserSession1 is orphaned but **NOT disposed**
   - AppSession1's WebSocket to cloud-dev is **still open** (orphaned)

3. **cloud-dev grace period expires (60s later)**:
   - cloud-dev disposes its UserSession
   - cloud-dev's AppManager sends WebSocket close to AppSession1 (code 1000, "User session ended")

4. **SDK receives close on AppSession1**:
   - `cleanupDisconnect` handler fires in AppServer
   - Since `info.sessionEnded === true`, calls `onStop(sessionId, userId, "User session ended")`

5. **Captions app's `onStop` is called**:

   ```typescript
   protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
     UserSession.getUserSession(userId)?.dispose()  // <-- BUG HERE!
   }
   ```

   - `UserSession.getUserSession(userId)` returns **UserSession2** (the CURRENT one, not the old one)
   - UserSession2.dispose() is called

6. **UserSession2.dispose() kills the active session**:

   ```typescript
   dispose() {
     if (this.transcriptionCleanup) {
       this.transcriptionCleanup()  // <-- Calls unsubscribe on AppSession2!
     }
   }
   ```

   - `transcriptionCleanup` belongs to UserSession2, which uses AppSession2
   - This calls `removeHandler()` → `unsubscribe()` → `updateSubscriptions()` on AppSession2's WebSocket
   - AppSession2's WebSocket is connected to **cloud-debug**

7. **cloud-debug receives the unsubscribe**:
   - "App removed from transcription set"
   - Soniox stream closed
   - Microphone turned off

### Why It Happens

Two fundamental design issues:

**Issue 1: `sessionId` is not unique**

```typescript
// In AppManager.triggerAppWebhookInternal:
sessionId: this.userSession.userId + "-" + packageName;
```

`sessionId` is `"isaiah@mentra.glass-com.mentra.captions.beta"` for BOTH sessions. It's deterministic, not a UUID. So when a second webhook comes in, the SDK's `activeSessions` map entry is overwritten.

**Issue 2: Captions app uses `userId` as key, not `sessionId`**

```typescript
// In UserSession.ts:
static readonly userSessions: Map<string, UserSession> = new Map()
// In constructor:
UserSession.userSessions.set(this.userId, this)
// In onStop:
UserSession.getUserSession(userId)?.dispose()
```

The Captions app tracks one session per user, not per session instance. When a new session starts, the old one is silently overwritten. When `onStop` is called for the OLD session, it looks up by `userId` and gets the NEW session.

## The Session Identity Crisis

```
Current Design:
┌─────────────────────────────────────────────────────────────────────┐
│ sessionId = userId + "-" + packageName                              │
│           = "isaiah@mentra.glass-com.mentra.captions.beta"          │
│                                                                     │
│ This is the SAME for:                                               │
│   - Session on cloud-dev                                            │
│   - Session on cloud-debug                                          │
│   - Any future session for this user/app combo                      │
└─────────────────────────────────────────────────────────────────────┘

What We Need:
┌─────────────────────────────────────────────────────────────────────┐
│ sessionId = UUID per session instance                               │
│           = "a1b2c3d4-5678-90ab-cdef-1234567890ab"                   │
│                                                                     │
│ This would be DIFFERENT for:                                        │
│   - Session on cloud-dev                                            │
│   - Session on cloud-debug                                          │
│   - Any reconnection                                                │
└─────────────────────────────────────────────────────────────────────┘
```

## Proposed Fixes

### Short-term Fix (Captions App)

Check if the session being stopped is the current active one:

```typescript
// In LiveCaptionsApp.onStop():
protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
  const userSession = UserSession.getUserSession(userId)

  // Only dispose if this stop is for the currently active session
  // Compare sessionId (or better, the AppSession reference)
  if (userSession && userSession.appSession.sessionId === sessionId) {
    userSession.dispose()
  } else {
    console.log(`Ignoring stop for stale session ${sessionId}`)
  }
}
```

### Short-term Fix (SDK AppServer)

Clean up old session before creating new one:

```typescript
// In AppServer.handleSessionRequest():
private async handleSessionRequest(request, res) {
  const { sessionId, userId } = request;

  // Clean up existing session for this user BEFORE creating new one
  const existingSession = this.activeSessions.get(sessionId);
  if (existingSession) {
    this.logger.info(`Cleaning up existing session ${sessionId} before creating new one`);
    existingSession.disconnect();
    this.activeSessions.delete(sessionId);
    this.activeSessionsByUserId.delete(userId);
  }

  // Now create new session
  const session = new AppSession({...});
  // ...
}
```

### Medium-term Fix (Cloud)

Generate truly unique sessionIds:

```typescript
// In AppManager.triggerAppWebhookInternal():
sessionId: `${this.userSession.userId}-${packageName}-${crypto.randomUUID()}`;
// or
sessionId: crypto.randomUUID();
```

This requires updating:

1. How the cloud generates sessionId
2. How the SDK tracks sessions
3. How apps track sessions
4. Any persistence that uses sessionId

### Long-term Architecture Fix

1. **Environment-scoped sessions**: Each cloud environment should use isolated session identifiers
2. **Stop webhook includes origin**: Include `cloudServerId` or `environmentId` in stop webhooks so receivers can validate
3. **Session lifecycle events**: Explicit "session_starting", "session_ending" events that apps can handle atomically

## Files to Modify

### SDK

- `packages/sdk/src/app/server/index.ts` - Clean up old session in handleSessionRequest
- `packages/sdk/src/app/session/index.ts` - Consider adding sessionId comparison utilities

### Cloud

- `packages/cloud/src/services/session/AppManager.ts` - Generate unique sessionIds

### Captions App

- `packages/apps/captions/src/app/index.ts` - Validate sessionId in onStop
- `packages/apps/captions/src/app/session/UserSession.ts` - Consider keying by sessionId

## Testing

1. Connect user to env A, start Captions app
2. Switch user to env B (new webhook should start new session)
3. Verify Captions works on env B
4. Wait for env A grace period to expire (triggers dispose)
5. Verify Captions STILL works on env B
6. Verify transcription still active on env B
7. Verify mic doesn't turn off

## Related

- Issue 006 main README
- `captions-stopping-spec.md` - Original problem analysis
