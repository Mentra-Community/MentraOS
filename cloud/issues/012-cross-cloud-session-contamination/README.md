# Cross-Cloud Session Contamination

When a user switches between cloud environments (e.g., `cloud-dev` → `cloud-debug`), the old cloud instance can incorrectly trigger `onStop` on the TPA (third-party app), which then disposes the WRONG session - the new active one instead of the old stale one.

## Documents

- **001-problem-analysis.md** - Root cause analysis and evidence from logs
- **002-sessionid-implementation-gap.md** - Analysis of sessionId implementation issues in server/SDK
- **003-ownership-release-protocol.md** - OWNERSHIP_RELEASE protocol design (Phase 2) - **OUTDATED**
- **004-implementation-plan.md** - Concrete patch plan for SDK and Cloud

## Quick Summary

**Current**: `sessionId = userId + "-" + packageName` is deterministic and reused across environments.

**The Bug**:
1. User on Server A, TPA creates `AppSession1` with sessionId `"user@email.com-com.app.captions"`
2. User switches to Server B, webhook triggers TPA to create `AppSession2` with SAME sessionId
3. SDK's `AppServer.handleSessionRequest()` overwrites `activeSessions[sessionId]` with new session
4. **OLD `AppSession1` is orphaned** but still has its WebSocket open and event handlers registered
5. Server A's grace period expires (60s), sends WebSocket close with reason `"User session ended"`
6. **Orphaned `AppSession1`'s close handler fires**, calls `onStop(sessionId, userId, ...)`
7. TPA's `onStop` calls `this.activeSessions.delete(sessionId)` - **deletes the NEW session!**

**Key Insight**: The SDK does NOT maintain two WebSocket connections. The old `AppSession` object is orphaned in memory (its reference in the Map is overwritten), but its WebSocket and event handlers are still active. When the old WebSocket closes, its cleanup handler corrupts the new session's state.

## The Bug Flow (Detailed)

```
Timeline:
─────────────────────────────────────────────────────────────────────────────

T+0:    User connects to Server A
        → Server A triggers webhook to TPA
        → TPA creates AppSession1, stores in activeSessions["user-app"]
        → AppSession1 opens WebSocket to Server A

T+5:    User switches to Server B
        → Server B triggers webhook to TPA (same sessionId!)
        → TPA creates AppSession2
        → activeSessions["user-app"] = AppSession2  ← OVERWRITES reference
        → AppSession2 opens WebSocket to Server B
        → AppSession1 is now ORPHANED (but WebSocket still open!)

T+65:   Server A grace period expires
        → Server A closes AppSession1's WebSocket with "User session ended"
        → AppSession1's closeHandler fires (still registered!)
        → Emits "disconnected" with sessionEnded: true
        → AppServer's cleanupDisconnect handler calls onStop(sessionId, ...)
        → cleanupDisconnect also calls activeSessions.delete(sessionId)
        → THIS DELETES AppSession2 (the current active one)!

Result: TPA thinks session ended, but user is still active on Server B
```

## Root Cause: sessionId Not Unique

```typescript
// In AppManager.triggerAppWebhookInternal()
sessionId: this.userSession.userId + "-" + packageName
// = "isaiah@mentra.glass-com.mentra.captions.beta"

// Same value for:
// - Session on cloud-dev
// - Session on cloud-debug  
// - Any future session for this user/app
```

## Key Files

| File | Issue |
|------|-------|
| `packages/cloud/src/services/session/AppManager.ts` | Generates deterministic sessionId (line 634) |
| `packages/sdk/src/app/server/index.ts` | `handleSessionRequest` overwrites sessions, orphaned session's cleanup corrupts state |
| `packages/sdk/src/app/session/index.ts` | `closeHandler` triggers onStop based on close reason |

## The Simple Fix

**Make sessionId unique per cloud session instance.**

### Cloud Change (AppManager.ts)

```typescript
// Before:
sessionId: this.userSession.userId + "-" + packageName

// After:
sessionId: `${this.userSession.userId}-${packageName}-${crypto.randomUUID()}`
// or just:
sessionId: crypto.randomUUID()
```

### Why This Works

With unique sessionIds:
1. Server A webhook sends `sessionId: "uuid-1"`
2. Server B webhook sends `sessionId: "uuid-2"` (different!)
3. TPA stores `activeSessions["uuid-1"]` then `activeSessions["uuid-2"]`
4. When Server A's WebSocket closes, cleanup calls `activeSessions.delete("uuid-1")`
5. This does NOT affect `activeSessions["uuid-2"]` - the active session is safe!

### SDK Change (Optional but Recommended)

In `AppServer.handleSessionRequest()`, clean up existing session for same user before creating new one:

```typescript
// Check for existing session for this user
const existingSession = this.activeSessionsByUserId.get(userId);
if (existingSession) {
  this.logger.info(`Cleaning up existing session for user ${userId} before creating new one`);
  existingSession.disconnect();
  this.activeSessions.delete(existingSession.getSessionId());
  this.activeSessionsByUserId.delete(userId);
}
```

This ensures the old orphaned session is properly closed before the new one is created.

## What About OWNERSHIP_RELEASE?

The OWNERSHIP_RELEASE protocol (documented in 003) was designed to solve a different problem: telling the cloud not to resurrect a session after intentional disconnect.

For the cross-cloud contamination bug, **simply making sessionId unique is sufficient**. OWNERSHIP_RELEASE is not needed for this fix.

## Status

- [x] Root cause identified (sessionId not unique, orphaned session cleanup corrupts state)
- [x] Phase 1a: Derive subscriptions from handlers (SDK) - prevents empty subscription bug
- [x] Phase 1b: Terminated flag to prevent reconnection after session end
- [x] Phase 2: OWNERSHIP_RELEASE protocol implemented (not needed for this bug)
- [x] Phase 4: AppSession class consolidation on Cloud
- [ ] **sessionId uniqueness**: Make sessionId truly unique (UUID) across clouds
- [ ] **SDK cleanup**: Clean up existing session before creating new one in handleSessionRequest

## Implementation Checklist

### Priority 1: Make sessionId Unique (Cloud)

- [ ] Update `AppManager.triggerAppWebhookInternal()` to generate UUID sessionId
- [ ] Update any code that parses sessionId format (grep for `sessionId.*split`)
- [ ] Test that webhooks send unique sessionIds

### Priority 2: Clean Up Orphaned Sessions (SDK)

- [ ] Update `AppServer.handleSessionRequest()` to disconnect existing session for user
- [ ] Ensure cleanup happens before new session connects
- [ ] Test that old session's WebSocket closes cleanly

### Priority 3: Testing

- [ ] Test cross-cloud switch scenario
- [ ] Verify old session's onStop doesn't affect new session
- [ ] Verify transcription continues after cloud switch

## Related Issues

- **006-captions-and-apps-stopping** - Parent issue with additional context
- **011-sdk-subscription-architecture-mismatch** - Subscription drift fix (Phase 1a)