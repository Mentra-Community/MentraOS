# 018 - App Disconnect & Resurrection

Mini app WebSocket disconnects are not handled properly in Bun, causing apps to appear "running" in mobile UI when they're actually dead. Additionally, there are SDK-side bugs around multi-cloud session handling.

## Documents

- **app-disconnect-spec.md** - Problem, goals, constraints
- **app-disconnect-architecture.md** - Technical design and fix

## Quick Context

**Current**: When a mini app server crashes/disconnects, the Bun WebSocket close handler does nothing. App stays in RUNNING state, mobile never updates, resurrection never triggers.

**Proposed**: Fix Bun close handler, add new DORMANT state for apps waiting for user reconnect, ensure SDK can always reconnect regardless of user connection status.

## Key Context

The cloud migrated from `ws` package to Bun's native ServerWebSocket. The AppSession close handler was only set up for EventEmitter-style WebSockets (ws package). Bun's handler was left empty with a misleading comment. This breaks the entire grace period → resurrection flow.

**Multi-cloud problem**: We can't resurrect apps when user is disconnected because we don't know if they switched to another cloud. Solution: new DORMANT state that waits for user reconnect before attempting resurrection. SDK reconnects are always accepted (if SDK is reconnecting, it means the mini app server still knows about this session).

## State Flow

```
RUNNING → GRACE_PERIOD → [SDK reconnects] → RUNNING
                       → [grace expires, user connected] → RESURRECTING → RUNNING/STOPPED
                       → [grace expires, user NOT connected] → DORMANT
                                                                  ↓
                                            [SDK reconnects] → RUNNING
                                            [user reconnects] → RESURRECTING → RUNNING/STOPPED

RUNNING → [OWNERSHIP_RELEASE received] → [WS closes] → DORMANT
                                                          ↓
                                        [user reconnects] → RESURRECTING → RUNNING
```

## New Findings: SDK Multi-Cloud Bug

### The Problem

When a user switches from Cloud A to Cloud B:
1. Cloud B sends webhook, SDK creates new session (sessionB)
2. SDK overwrites `activeSessions[sessionId]` with sessionB
3. Old session (sessionA) is **orphaned** - not in maps but WS still open
4. When Cloud A disposes (~1 min later), sessionA's cleanup handler fires
5. Cleanup deletes from maps by key → **deletes sessionB instead!**

### Root Cause

The SDK's cleanup handler deletes by key without checking session identity:
```typescript
// Current (buggy):
this.activeSessions.delete(sessionId)      // Deletes whatever is at this key

// Should be:
if (this.activeSessions.get(sessionId) === session) {
  this.activeSessions.delete(sessionId)    // Only delete if it's MY session
}
```

### SDK Fix Required

In `packages/sdk/src/app/server/index.ts`, the cleanup handler should verify session identity before deleting.

Additionally, the SDK should send `OWNERSHIP_RELEASE` to the old cloud when switching, enabling clean handoff.

## New Finding: Ownership Release Should Mark DORMANT

### The Problem

When SDK sends `OWNERSHIP_RELEASE` (switching clouds), the cloud currently marks the app as `STOPPED`. But:
- All clouds share the same database
- Cloud should NOT modify `user.runningApps` in DB (would break the new cloud)
- If user reconnects to old cloud, apps should restart

### The Fix

On `OWNERSHIP_RELEASE` → mark app as `DORMANT` instead of `STOPPED`:
- DORMANT apps are resurrected when user reconnects
- Database stays unchanged (new cloud will read correct state)
- Symmetric behavior: user can switch between clouds seamlessly

## Status

### Cloud-Side (This PR)
- [x] Root cause identified
- [x] Log analysis confirmed issue
- [x] Add DORMANT state to AppSession
- [x] Fix Bun's handleAppClose to call AppSession.handleDisconnect()
- [x] Update grace expiration to mark DORMANT when user disconnected
- [x] Add resurrectDormantApps() method
- [x] Accept SDK reconnects in DORMANT state
- [x] Call resurrectDormantApps on user reconnect
- [x] Ensure mobile gets app_stopped notification on failure
- [x] **NEW**: On OWNERSHIP_RELEASE, mark DORMANT instead of STOPPED
- [ ] Test full flow end-to-end

### SDK-Side (This PR)
- [x] Fix cleanup handler to verify session identity before deleting
- [x] Send OWNERSHIP_RELEASE when new webhook arrives for existing user
- [x] Explicitly disconnect old session before creating new one

## Architecture Notes

### Why DORMANT for Ownership Release?

DORMANT means: "App should be running, but we can't reach it. Restart when user returns."

This applies to both:
1. **Crash scenario**: App WS died, user not connected, waiting for user
2. **Handoff scenario**: App handed to another cloud, waiting for user to return

The behavior is the same: call webhook to restart when user reconnects.

### Shared Database Constraint

All clouds share the same MongoDB. The `user.runningApps` array represents **user intent** ("I want these apps running"), not "which cloud currently has them."

- Cloud A should NEVER remove apps from DB on ownership release
- Cloud B reads DB to know what apps to start
- If Cloud A removed from DB, Cloud B wouldn't start the app

### Session Identity in SDK

The sessionId is `userId-packageName` (same across all clouds). The SDK tracks sessions in:
- `activeSessions` - Map<sessionId, AppSession>
- `activeSessionsByUserId` - Map<userId, AppSession>

When Cloud B webhook arrives, it overwrites the entry. The fix ensures old session's cleanup doesn't corrupt the new entry.