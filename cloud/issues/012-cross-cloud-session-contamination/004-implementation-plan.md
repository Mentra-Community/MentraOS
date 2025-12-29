# Implementation Plan: Cross-Cloud Session Contamination Fix

## Overview

This document provides the concrete implementation steps to fix the cross-cloud session contamination bug. The fix is simpler than originally thought: **make sessionId unique per cloud session instance**.

## Root Cause Recap

When user switches from Server A to Server B:
1. Both servers send webhooks with the **same** sessionId (`userId-packageName`)
2. SDK's `handleSessionRequest` overwrites `activeSessions[sessionId]` with new session
3. Old session is **orphaned** but its WebSocket and event handlers are still active
4. When Server A's WebSocket closes (after 60s grace period), orphaned session's cleanup handler fires
5. Cleanup calls `activeSessions.delete(sessionId)` - **deleting the NEW session!**

## The Fix

### Step 1: Generate Unique sessionId (Cloud)

**File**: `packages/cloud/src/services/session/AppManager.ts`

**Current Code** (line ~634):
```typescript
await this.triggerWebhook(webhookURL, {
  type: WebhookRequestType.SESSION_REQUEST,
  sessionId: this.userSession.userId + "-" + packageName,
  userId: this.userSession.userId,
  // ...
});
```

**New Code**:
```typescript
import { randomUUID } from 'crypto';

// In triggerAppWebhookInternal()
const uniqueSessionId = `${this.userSession.userId}-${packageName}-${randomUUID()}`;

await this.triggerWebhook(webhookURL, {
  type: WebhookRequestType.SESSION_REQUEST,
  sessionId: uniqueSessionId,
  userId: this.userSession.userId,
  // ...
});

this.logger.info(
  { sessionId: uniqueSessionId, userId: this.userSession.userId, packageName },
  `[AppManager] Triggering webhook with unique sessionId`
);
```

### Step 2: Fix sessionId Parsing (Cloud)

**File**: `packages/cloud/src/services/session/AppManager.ts`

**Current Code** (line ~751):
```typescript
const enrichedError = Object.assign(error, {
  packageName: payload.sessionId.split("-")[1],  // BUG: Assumes userId-packageName format
  // ...
});
```

**New Code**:
```typescript
const enrichedError = Object.assign(error, {
  packageName: payload.packageName || "unknown",  // Use explicit field instead of parsing
  // ...
});
```

**Note**: Also need to add `packageName` to the webhook payload if not already present.

### Step 3: Clean Up Existing Session (SDK) - Optional but Recommended

**File**: `packages/sdk/src/app/server/index.ts`

In `handleSessionRequest()`, add cleanup before creating new session:

```typescript
private async handleSessionRequest(request: SessionWebhookRequest, res: express.Response): Promise<void> {
  const {sessionId, userId, mentraOSWebsocketUrl, augmentOSWebsocketUrl} = request
  this.logger.info({userId, sessionId}, `🗣️ Received session request for user ${userId}, session ${sessionId}`)

  // NEW: Clean up any existing session for this user to prevent orphaned sessions
  const existingSession = this.activeSessionsByUserId.get(userId);
  if (existingSession) {
    const existingSessionId = existingSession.getSessionId();
    this.logger.info(
      { userId, oldSessionId: existingSessionId, newSessionId: sessionId },
      `🧹 Cleaning up existing session for user before creating new one`
    );
    
    try {
      // Disconnect old session (this will trigger its cleanup, but with different sessionId)
      await existingSession.disconnect();
    } catch (error) {
      this.logger.warn({ error, userId }, `Error disconnecting old session, continuing with new session`);
    }
    
    // Remove from maps
    this.activeSessions.delete(existingSessionId);
    this.activeSessionsByUserId.delete(userId);
  }

  // Create new App session (existing code)
  const session = new AppSession({
    // ...
  });
  
  // ... rest of existing code
}
```

### Step 4: Add getSessionId() Method (SDK)

**File**: `packages/sdk/src/app/session/index.ts`

Ensure `getSessionId()` method exists and is public:

```typescript
/**
 * Get the session ID for this session
 */
getSessionId(): string {
  return this.sessionId;
}
```

---

## Why This Works

With unique sessionIds:

```
Timeline with FIX:
─────────────────────────────────────────────────────────────────────────────

T+0:    User connects to Server A
        → Server A triggers webhook with sessionId: "user-app-uuid1"
        → TPA stores activeSessions["user-app-uuid1"] = AppSession1

T+5:    User switches to Server B  
        → Server B triggers webhook with sessionId: "user-app-uuid2" (DIFFERENT!)
        → TPA cleans up existing session for user (Step 3)
        → TPA stores activeSessions["user-app-uuid2"] = AppSession2

T+65:   Server A grace period expires (if cleanup in Step 3 didn't close it)
        → Server A closes WebSocket with "User session ended"
        → AppSession1's cleanup calls activeSessions.delete("user-app-uuid1")
        → activeSessions["user-app-uuid2"] is UNAFFECTED ✅

Result: New session on Server B continues working normally
```

---

## Files Changed Summary

### Cloud

| File | Changes |
|------|---------|
| `packages/cloud/src/services/session/AppManager.ts` | Generate UUID sessionId, fix parsing |

### SDK

| File | Changes |
|------|---------|
| `packages/sdk/src/app/server/index.ts` | Clean up existing session before creating new one |
| `packages/sdk/src/app/session/index.ts` | Ensure getSessionId() is public |

---

## Testing Plan

### Manual Test: Cross-Cloud Switch

1. Connect to cloud-dev, start captions app
2. Verify transcription working
3. Switch to cloud-debug (in mobile app settings or by restarting with different URL)
4. Verify captions app receives new webhook
5. Verify transcription continues on cloud-debug
6. Wait 60+ seconds for cloud-dev grace period to expire
7. **Verify transcription STILL works on cloud-debug** (this is the bug we're fixing)

### Unit Tests

```typescript
describe("Unique sessionId generation", () => {
  it("should generate different sessionIds for same user/package", async () => {
    const appManager = createAppManager();
    
    const sessionId1 = await appManager.startApp("com.test.app");
    const sessionId2 = await appManager.startApp("com.test.app");
    
    expect(sessionId1).not.toBe(sessionId2);
  });
  
  it("should include userId and packageName in sessionId", async () => {
    const appManager = createAppManager({ userId: "test@example.com" });
    
    const sessionId = await appManager.startApp("com.test.app");
    
    expect(sessionId).toContain("test@example.com");
    expect(sessionId).toContain("com.test.app");
  });
});

describe("AppServer session cleanup", () => {
  it("should clean up existing session before creating new one", async () => {
    const appServer = createAppServer();
    const disconnectSpy = jest.fn();
    
    // First session
    await appServer.handleSessionRequest({
      sessionId: "user-app-uuid1",
      userId: "user@test.com",
      // ...
    }, mockRes);
    
    const firstSession = appServer.activeSessionsByUserId.get("user@test.com");
    firstSession.disconnect = disconnectSpy;
    
    // Second session for same user
    await appServer.handleSessionRequest({
      sessionId: "user-app-uuid2", 
      userId: "user@test.com",
      // ...
    }, mockRes);
    
    expect(disconnectSpy).toHaveBeenCalled();
    expect(appServer.activeSessions.has("user-app-uuid1")).toBe(false);
    expect(appServer.activeSessions.has("user-app-uuid2")).toBe(true);
  });
});
```

---

## Rollback Plan

If issues are found:

### Cloud Rollback
Revert to deterministic sessionId:
```typescript
sessionId: this.userSession.userId + "-" + packageName
```

### SDK Rollback  
Remove the cleanup code in `handleSessionRequest()` (just delete the new cleanup block).

---

## Backward Compatibility

✅ **Fully backward compatible**

- Old SDK receiving UUID sessionId: Works fine (sessionId is opaque string)
- New SDK receiving old sessionId format: Works fine (just a string)
- Mixed versions: Work fine (sessionId is never parsed by SDK)

The only code that parses sessionId is the error enrichment in `AppManager.triggerWebhook()`, which we're fixing in Step 2.

---

## Timeline Estimate

| Task | Estimate |
|------|----------|
| Step 1: UUID sessionId generation | 30 min |
| Step 2: Fix sessionId parsing | 15 min |
| Step 3: SDK session cleanup | 1 hour |
| Step 4: getSessionId() method | 15 min |
| Testing | 2 hours |
| **Total** | **~4 hours** |

---

## Checklist

- [ ] Update `AppManager.triggerAppWebhookInternal()` to generate UUID sessionId
- [ ] Add `packageName` to webhook payload (if needed)
- [ ] Fix `AppManager.triggerWebhook()` error enrichment to not parse sessionId
- [ ] Add session cleanup in `AppServer.handleSessionRequest()`
- [ ] Ensure `AppSession.getSessionId()` is public
- [ ] Write unit tests
- [ ] Manual test cross-cloud switch scenario
- [ ] Deploy to staging and test
- [ ] Monitor production for issues