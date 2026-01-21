# App Disconnect & Resurrection Spec

## Overview

Mini app WebSocket disconnects are not detected by the cloud when using Bun's native ServerWebSocket. This causes apps to appear "running" in mobile UI when they're actually dead, and prevents the resurrection mechanism from working.

## Problem

### 1. Bun WebSocket Close Handler is Empty

When the cloud migrated from `ws` package to Bun's native ServerWebSocket, the close handler setup was not updated:

```typescript
// packages/cloud/src/services/session/AppSession.ts L327-331
// Only set up event-based close handler for ws package (not Bun's ServerWebSocket)
// Bun's close handling is done in websocketHandlers.close()
if (hasEventEmitter(ws)) {
  ws.on("close", this.closeHandler);
}
```

But `handleAppClose` in `bun-websocket.ts` is empty:

```typescript
// packages/cloud/src/services/websocket/bun-websocket.ts L616-623
function handleAppClose(ws: AppServerWebSocket, code: number, reason: string): void {
  const { userId, packageName } = ws.data;
  logger.info({ userId, packageName, code, reason }, "App WebSocket closed");
  // App disconnect is handled by AppSession's own close handler
  // which is set up when the WebSocket is passed to AppSession  <-- THIS IS FALSE FOR BUN
}
```

**Result**: `AppSession.handleDisconnect()` is never called → grace period never starts → resurrection never triggers.

### 2. Mobile UI Never Updates

Without the disconnect/resurrection flow:
- `stopApp()` is never called internally
- `sendAppStopped()` is never sent to mobile client
- Mobile's `refreshApplets()` is never triggered
- User sees dead app as "running" indefinitely

### 3. No User Connection Check Before Resurrection

Current resurrection logic doesn't verify the user is still connected to THIS cloud:

```typescript
// packages/cloud/src/services/session/AppManager.ts L262-274
private async handleAppSessionGracePeriodExpired(appSession: AppSession): Promise<void> {
  // No check if userSession.websocket is still connected!
  await this.stopApp(packageName, true);
  await this.startApp(packageName);
}
```

If user switched to another cloud, this could "steal" the app back.

### Evidence from Logs

```
22:13:07.144 | App WebSocket closed (code 1006)           <-- Bun detects close
22:13:09.389 | WebSocket not open during heartbeat        <-- Heartbeat notices dead WS
22:13:09.389 | Heartbeat cleared                          <-- But nothing else happens
[... no grace period, no resurrection, no mobile notification ...]
```

Compare to glasses close handler which properly handles disconnect:

```typescript
// packages/cloud/src/services/websocket/bun-websocket.ts L450-493
function handleGlassesClose(ws, code, reason) {
  userSession.disconnectedAt = new Date();
  // Sets up grace period cleanup timer
  userSession.cleanupTimerId = setTimeout(() => {
    userSession.dispose();
  }, RECONNECT_GRACE_PERIOD_MS);
}
```

### Constraints

- **Bun's ServerWebSocket API**: No EventEmitter, close events come through handler config
- **Multi-cloud**: Users can switch clouds; don't want to steal apps from other clouds
- **SDK reconnection**: Mini apps have their own reconnection logic (3 attempts with backoff)
- **Grace period**: 5 seconds for SDK reconnection before resurrection attempt

## Goals

1. **Fix Bun close handler**: `handleAppClose()` must call `AppSession.handleDisconnect()`
2. **Add DORMANT state**: New state for "app should be running but can't resurrect yet (user not connected)"
3. **User connection check**: Before resurrection, verify user is still connected to this cloud
4. **Accept SDK reconnects always**: SDK can reconnect during GRACE_PERIOD or DORMANT regardless of user connection
5. **Mobile notification**: Ensure `app_stopped` is sent when app dies and can't be resurrected
6. **Preserve app state on user disconnect**: Don't kill apps when user disconnects, resurrect when they reconnect

## Non-Goals

- Changing SDK reconnection logic (already works)
- Changing grace period duration (5s)
- Changing mobile UI components
- Adding new message types to the protocol

## Proposed Behavior

### New State: DORMANT

Add a new state to represent: "App should be running, mini app WS is dead, grace period expired, but user isn't connected so we can't resurrect yet."

```
States: CONNECTING, RUNNING, GRACE_PERIOD, DORMANT (new), RESURRECTING, STOPPING, STOPPED
```

### When Mini App WebSocket Closes

1. Bun calls `handleAppClose(ws, code, reason)`
2. `handleAppClose` calls `AppSession.handleDisconnect(code, reason)` 
3. AppSession enters GRACE_PERIOD state, starts 5s timer
4. **SDK can reconnect at any time** (regardless of user connection status)
5. If SDK reconnects within grace period → cancel timer, back to RUNNING
6. If grace period expires:
   - If user connected: attempt resurrection (stop + start)
   - If user NOT connected: mark as DORMANT (wait for user)

### SDK Reconnection (Key Insight)

**SDK reconnection works regardless of user connection status.** If a mini app is trying to reconnect to THIS cloud, it means:
- The mini app server still has state for this user's session
- The mini app hasn't received a new connection from another cloud
- Therefore, this cloud is still the "correct" cloud for this user's app

If user had switched to Cloud B:
- Cloud B would call the mini app's webhook
- Mini app SDK would get a new session
- Mini app SDK would stop trying to reconnect to Cloud A

So we ALWAYS accept SDK reconnection attempts, even while DORMANT.

### When User Reconnects After Being Disconnected

1. User reconnects to same cloud
2. Cloud calls `appManager.resurrectDormantApps()`
3. For each app in DORMANT state (that SDK didn't reconnect):
   - Attempt resurrection (stop + start)
   - If fails, mark STOPPED and notify mobile

### Mobile Notification

- When app enters GRACE_PERIOD: no notification (SDK might reconnect)
- When app enters DORMANT: no notification (user is disconnected anyway)
- When SDK reconnects (GRACE_PERIOD or DORMANT): no notification (seamless)
- When resurrection succeeds: no notification (app continues)
- When resurrection fails: send `app_stopped`

## Open Questions

1. **What if resurrection keeps failing?**
   - Mini app server is down, webhook keeps timing out
   - Retry limit? Exponential backoff?
   - **Proposed**: 3 attempts, then mark STOPPED

2. **DORMANT timeout?**
   - Should DORMANT apps eventually give up?
   - **Proposed**: No separate timeout, rely on UserSession disposal

3. **Resources during DORMANT?**
   - DORMANT apps hold: AppSession object (~few KB), no WS, no subscriptions
   - **Proposed**: Acceptable cost, cleaned up when UserSession disposes

4. **SDK reconnect timing**
   - SDK has 3 reconnect attempts with backoff (1s, 2s, 4s = ~7s total)
   - Cloud grace period is 5s
   - SDK's last attempt may arrive while DORMANT
   - **Proposed**: Accept late SDK reconnects even in DORMANT state

---

## New Finding: SDK Multi-Cloud Session Bug

### Problem

When a user switches from Cloud A to Cloud B, the SDK has a bug that corrupts session tracking:

1. User on Cloud A, SDK has `activeSessions["user-app"] = sessionA`
2. Cloud B sends webhook, SDK creates sessionB
3. SDK does `activeSessions["user-app"] = sessionB` (overwrites)
4. sessionA is now **orphaned** - not in maps, but WS still open, handlers still registered
5. ~1 minute later, Cloud A disposes, closes sessionA's WebSocket
6. sessionA's cleanup handler fires:
   ```typescript
   this.activeSessions.delete(sessionId)      // DELETES sessionB!
   this.activeSessionsByUserId.delete(userId) // DELETES sessionB!
   ```
7. sessionB (the active Cloud B connection) is now removed from tracking

### Root Cause

The cleanup handler deletes by key without verifying session identity:

```typescript
// Current (buggy) - in packages/sdk/src/app/server/index.ts
const cleanupDisconnect = session.events.onDisconnected((info) => {
  // ...
  this.activeSessions.delete(sessionId)      // Deletes whatever is at this key
  this.activeSessionsByUserId.delete(userId)
})
```

### SDK Fix Required

```typescript
// Fixed - verify session identity before deleting
const cleanupDisconnect = session.events.onDisconnected((info) => {
  // ...
  if (this.activeSessions.get(sessionId) === session) {
    this.activeSessions.delete(sessionId)
  }
  if (this.activeSessionsByUserId.get(userId) === session) {
    this.activeSessionsByUserId.delete(userId)
  }
})
```

This works because `===` compares object references in JavaScript. Each `new AppSession()` creates a unique reference, and the closure captures the specific session that registered the handler.

### Additional SDK Enhancement: Clean Handoff

When a new webhook arrives for an existing user, the SDK should:

1. Send `OWNERSHIP_RELEASE` to the old cloud (prevents resurrection ping-pong)
2. Disconnect the old session explicitly
3. Create the new session

```typescript
// In handleSessionRequest, before creating new session:
const existingSession = this.activeSessions.get(sessionId)
if (existingSession) {
  existingSession.send({ type: "OWNERSHIP_RELEASE", reason: "switching_clouds" })
  existingSession.disconnect()
  this.activeSessions.delete(sessionId)
  this.activeSessionsByUserId.delete(userId)
}
// Now create new session
```

---

## New Finding: Ownership Release Should Mark DORMANT

### Problem

When the cloud receives `OWNERSHIP_RELEASE` from the SDK (user switching clouds), it currently marks the app as `STOPPED`. This is incorrect because:

1. **Shared Database**: All clouds share the same MongoDB
2. **Don't Touch DB**: Cloud should NOT remove app from `user.runningApps` (would break new cloud)
3. **User May Return**: If user reconnects to old cloud, apps should restart

### Current Behavior (Wrong)

```typescript
// AppSession.handleDisconnect()
if (this._ownershipReleased) {
  this.setState(AppConnectionState.STOPPED)  // ← Wrong!
  this.cleanup()
  return
}
```

With `STOPPED`:
- `resurrectDormantApps()` ignores it (only looks at DORMANT)
- If user reconnects, app doesn't restart
- User has to manually start app again

### Correct Behavior

```typescript
if (this._ownershipReleased) {
  this.setState(AppConnectionState.DORMANT)  // ← Mark DORMANT instead
  this.cleanup()
  return
}
```

With `DORMANT`:
- `resurrectDormantApps()` will restart it when user reconnects
- Symmetric behavior: user can switch between clouds seamlessly
- Database stays unchanged (correct for shared DB)

### Why DORMANT is Correct

DORMANT means: "App should be running, but we can't reach it. Restart when user returns."

This applies to both scenarios:
1. **Crash**: App WS died, user not connected → restart when user returns
2. **Handoff**: App handed to another cloud → restart when user returns to THIS cloud

The behavior is identical: call webhook to restart when user reconnects.

### The Multi-Cloud Dance

```
User on Cloud A          User switches to B       User returns to A
     │                         │                        │
     ▼                         ▼                        ▼
Apps RUNNING            Apps DORMANT             Apps RUNNING
                       (ownership released)      (resurrected)
                              │
                              ▼
                       Cloud B: Apps RUNNING
                              │
                       (user returns to A)
                              ▼
                       Cloud B: Apps DORMANT
                       (ownership released)
```

Each cloud marks apps DORMANT when ownership is released, and resurrects them when the user returns. The database (`user.runningApps`) is never modified during handoffs - it represents user intent, not current cloud ownership.