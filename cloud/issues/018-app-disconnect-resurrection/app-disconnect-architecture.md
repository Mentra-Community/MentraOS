# App Disconnect & Resurrection Architecture

## Current System

### WebSocket Close Flow (Broken)

```
Mini App Server crashes
        │
        ▼
Bun detects close ──► handleAppClose() ──► logs message ──► NOTHING
                                                              │
                                                              ▼
                                              AppSession stays RUNNING
                                              Mobile never notified
                                              Resurrection never triggers
```

### Key Code Paths

**Bun WebSocket Handler** - `packages/cloud/src/services/websocket/bun-websocket.ts:616-623`
```typescript
function handleAppClose(ws: AppServerWebSocket, code: number, reason: string): void {
  const { userId, packageName } = ws.data;
  logger.info({ userId, packageName, code, reason }, "App WebSocket closed");
  // THIS IS EMPTY - AppSession.handleDisconnect() is never called
}
```

**AppSession Close Handler Setup** - `packages/cloud/src/services/session/AppSession.ts:327-331`
```typescript
// Only set up for ws package (EventEmitter), NOT for Bun's ServerWebSocket
if (hasEventEmitter(ws)) {
  ws.on("close", this.closeHandler);  // Bun's ServerWebSocket doesn't have .on()
}
```

**Grace Period Handler** - `packages/cloud/src/services/session/AppSession.ts:484-502`
```typescript
private startGracePeriod(): void {
  this.graceTimer = setTimeout(async () => {
    if (this._state === AppConnectionState.GRACE_PERIOD && !this._ownershipReleased) {
      this.setState(AppConnectionState.RESURRECTING);
      await this.onGracePeriodExpired(this);  // Never called because grace period never starts
    }
  }, GRACE_PERIOD_MS);  // 5000ms
}
```

### Problems

1. **Bun handler empty**: `handleAppClose()` doesn't call `AppSession.handleDisconnect()`
2. **No DORMANT state**: No way to represent "app should be running but can't resurrect yet"
3. **No mobile notification**: `app_stopped` never sent when app dies
4. **Heartbeat only clears itself**: Detects dead WS but doesn't trigger disconnect flow

## Proposed System

### New State: DORMANT

We need a new state to represent: "App should be running, mini app WS is dead, grace period expired, but user isn't connected so we can't resurrect yet."

**States:**
- `CONNECTING` - Webhook sent, waiting for mini app to connect
- `RUNNING` - Mini app WS is connected and healthy  
- `GRACE_PERIOD` - Mini app WS died, waiting 5s for SDK to reconnect
- `DORMANT` - Grace expired, user not connected, waiting for user to return
- `RESURRECTING` - Attempting stop+start resurrection
- `STOPPING` - Explicitly stopping the app
- `STOPPED` - App is stopped

### State Transitions

```
CONNECTING ──[app connects]──► RUNNING
CONNECTING ──[timeout/failure]──► STOPPED

RUNNING ──[WS closes]──► GRACE_PERIOD
RUNNING ──[explicit stop]──► STOPPING

GRACE_PERIOD ──[SDK reconnects]──► RUNNING
GRACE_PERIOD ──[5s expires, user connected]──► RESURRECTING
GRACE_PERIOD ──[5s expires, user NOT connected]──► DORMANT

DORMANT ──[SDK reconnects]──► RUNNING (accept late reconnect!)
DORMANT ──[user reconnects]──► RESURRECTING (if SDK didn't reconnect)
DORMANT ──[explicit stop]──► STOPPED
DORMANT ──[UserSession disposes]──► (cleaned up)

RESURRECTING ──[webhook success]──► CONNECTING ──► RUNNING
RESURRECTING ──[webhook failure]──► STOPPED

STOPPING ──[cleanup complete]──► STOPPED

STOPPED ──[start requested]──► CONNECTING
```

### Why SDK Reconnect Works Even When User Disconnected

Key insight: If a mini app is trying to reconnect to THIS cloud, it means:
1. The mini app server still has state for this user's session
2. The mini app hasn't received a new connection from another cloud
3. Therefore, this cloud is still the "correct" cloud for this user's app

If user had switched to Cloud B:
1. Cloud B would call the mini app's webhook
2. Mini app SDK would get a new session for the same user
3. Mini app SDK would stop trying to reconnect the OLD session to Cloud A

So we ALWAYS accept SDK reconnection attempts, regardless of user connection status.

### WebSocket Close Flow (Fixed)

```
Mini App WS closes
        │
        ▼
handleAppClose() ──► AppSession.handleDisconnect()
                              │
                              ▼
                     State → GRACE_PERIOD
                     Start 5s timer
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
      SDK reconnects                    Timer expires
      within 5s                               │
          │                     ┌─────────────┴─────────────┐
          ▼                     │                           │
    State → RUNNING       User connected             User disconnected
                                │                           │
                                ▼                           ▼
                          RESURRECTING               State → DORMANT
                                │                           │
                    ┌───────────┴───────────┐               │
                    │                       │               ▼
                    ▼                       ▼         (wait for user
               Success                  Failure        or SDK reconnect)
                    │                       │
                    ▼                       ▼
            State → RUNNING          Send app_stopped
                                     State → STOPPED
```

## Implementation Details

### 1. Fix handleAppClose in bun-websocket.ts

```typescript
function handleAppClose(ws: AppServerWebSocket, code: number, reason: string): void {
  const { userId, packageName } = ws.data;
  logger.info({ userId, packageName, code, reason }, "App WebSocket closed");

  if (!packageName) {
    logger.warn({ userId }, "App WebSocket closed but no packageName - ignoring");
    return;
  }

  const userSession = UserSession.getById(userId);
  if (!userSession) {
    logger.warn({ userId, packageName }, "App WebSocket closed but no UserSession - ignoring");
    return;
  }

  // Delegate to AppManager which owns the AppSession
  userSession.appManager.handleAppConnectionClosed(packageName, code, reason);
}
```

### 2. Add DORMANT State to AppSession

```typescript
// packages/cloud/src/services/session/AppSession.ts

enum AppConnectionState {
  CONNECTING = "connecting",
  RUNNING = "running",
  GRACE_PERIOD = "grace_period",
  DORMANT = "dormant",        // NEW
  RESURRECTING = "resurrecting",
  STOPPING = "stopping",
  STOPPED = "stopped",
}

get isDormant(): boolean {
  return this._state === AppConnectionState.DORMANT;
}

markDormant(): void {
  this.setState(AppConnectionState.DORMANT);
  this.cancelGracePeriod();
}
```

### 3. Update Grace Period Expiration Handler

```typescript
// packages/cloud/src/services/session/AppManager.ts

private async handleAppSessionGracePeriodExpired(appSession: AppSession): Promise<void> {
  const packageName = appSession.packageName;
  
  // Check if user is still connected to THIS cloud
  const userConnected = this.userSession.websocket && 
                        this.userSession.websocket.readyState === WebSocketReadyState.OPEN;
  
  if (!userConnected) {
    // User not connected - can't resurrect, go to DORMANT
    // App will be resurrected when user reconnects (see resurrectDormantApps)
    this.logger.info(
      { packageName },
      "Grace period expired but user not connected - marking DORMANT"
    );
    appSession.markDormant();
    return;
  }
  
  // User is connected - attempt resurrection
  this.logger.info({ packageName }, "Grace period expired, attempting resurrection");
  
  try {
    await this.stopApp(packageName, true);
    await this.startApp(packageName);
  } catch (error) {
    this.logger.error(error, `Resurrection failed for ${packageName}`);
    appSession.markStopped();
    webSocketService.sendAppStopped(this.userSession, packageName);
  }
}
```

### 4. Handle SDK Reconnect in DORMANT State

```typescript
// packages/cloud/src/services/session/AppManager.ts - in handleAppInit()

// Check if app is in loading, running, grace period, OR DORMANT state
const appSession = this.apps.get(packageName);
const isConnecting = appSession?.isConnecting ?? false;
const isRunning = appSession?.isRunning ?? false;
const isInGracePeriod = appSession?.isInGracePeriod ?? false;
const isDormant = appSession?.isDormant ?? false;

if (!isConnecting && !isRunning && !isInGracePeriod && !isDormant) {
  // App not in a state that allows connection
  // ... reject connection
}

// If DORMANT, the SDK is reconnecting after we gave up waiting
// This is great - accept the reconnection!
if (isDormant) {
  this.logger.info(
    { packageName },
    "SDK reconnected while DORMANT - accepting late reconnection"
  );
}

// ... rest of handleAppInit (accepts connection, transitions to RUNNING)
```

### 5. Add resurrectDormantApps Method

```typescript
// packages/cloud/src/services/session/AppManager.ts

/**
 * Resurrect apps that became dormant while the user was disconnected from this cloud.
 * 
 * ## Why This Method Exists
 * 
 * When a mini app's WebSocket to the cloud breaks (e.g., mini app server crashes),
 * we enter a grace period to allow the SDK to reconnect. If the grace period expires
 * and the user isn't connected, we mark the app as DORMANT instead of resurrecting.
 * 
 * When the user reconnects, we call this method to resurrect any DORMANT apps that
 * the SDK didn't manage to reconnect on its own.
 * 
 * ## The Multi-Cloud Problem
 * 
 * Users can be connected to multiple clouds (e.g., switching regions, failover).
 * If we resurrected apps immediately when grace period expires, we could "steal" an
 * app that the user intentionally moved to another cloud:
 * 
 * 1. User connected to Cloud A, running AppX
 * 2. User switches to Cloud B, starts AppX there  
 * 3. AppX on Cloud A loses its WS connection (mini app now talking to Cloud B)
 * 4. Cloud A's grace period expires
 * 5. BAD: Cloud A resurrects AppX, stealing it back from Cloud B
 * 
 * ## The Solution
 * 
 * - Grace period: Always wait 5s for SDK reconnect (works regardless of user connection)
 * - If SDK reconnects: Great, back to RUNNING
 * - If grace expires + user connected: Resurrect immediately
 * - If grace expires + user NOT connected: Mark DORMANT, wait for user
 * - When user reconnects: Call resurrectDormantApps() to revive any DORMANT apps
 * 
 * This ensures we only trigger webhooks for users actively using THIS cloud.
 * If the user switched clouds, they'll never reconnect here, and the DORMANT apps
 * get cleaned up when the UserSession disposes.
 * 
 * ## Note on SDK Late Reconnection
 * 
 * The SDK has 3 reconnect attempts with exponential backoff (1s, 2s, 4s = ~7s total).
 * Our grace period is 5s. So the SDK's last attempt might arrive while we're DORMANT.
 * We accept these late reconnections! If the SDK is still trying, the mini app server
 * is still alive and knows about this session - let it reconnect.
 * 
 * @returns Array of package names that were attempted to resurrect
 */
async resurrectDormantApps(): Promise<string[]> {
  const resurrected: string[] = [];
  const dormantApps = this.getDormantApps();
  
  if (dormantApps.length === 0) {
    return resurrected;
  }
  
  this.logger.info(
    { dormantApps, count: dormantApps.length },
    "Resurrecting dormant apps after user reconnect"
  );
  
  // Sequential resurrection to avoid webhook spam
  for (const packageName of dormantApps) {
    const appSession = this.apps.get(packageName);
    
    // Double-check still dormant (SDK might have reconnected in the meantime)
    if (!appSession?.isDormant) {
      this.logger.debug({ packageName }, "App no longer dormant, skipping resurrection");
      continue;
    }
    
    try {
      this.logger.info({ packageName }, "Resurrecting dormant app");
      await this.stopApp(packageName, true);  // restart=true marks as RESURRECTING
      await this.startApp(packageName);
      resurrected.push(packageName);
    } catch (error) {
      this.logger.error(error, `Failed to resurrect dormant app ${packageName}`);
      appSession.markStopped();
      webSocketService.sendAppStopped(this.userSession, packageName);
    }
  }
  
  // Broadcast updated app state to mobile
  if (resurrected.length > 0) {
    await this.broadcastAppState();
  }
  
  return resurrected;
}

/**
 * Get list of apps in DORMANT state.
 * These are apps whose mini app WS died, grace period expired, and user wasn't connected.
 */
private getDormantApps(): string[] {
  const dormant: string[] = [];
  
  for (const [packageName, session] of this.apps) {
    if (session.isDormant) {
      dormant.push(packageName);
    }
  }
  
  return dormant;
}
```

### 6. Call resurrectDormantApps on User Reconnect

```typescript
// In bun-websocket.ts - handleGlassesOpen or handleGlassesConnectionInit

async function handleGlassesReconnection(userSession: UserSession): Promise<void> {
  // ... existing reconnect logic (LiveKit, etc.) ...
  
  // Resurrect any apps that went dormant while user was disconnected
  // See AppManager.resurrectDormantApps() for detailed explanation
  const resurrected = await userSession.appManager.resurrectDormantApps();
  
  if (resurrected.length > 0) {
    userSession.logger.info(
      { resurrected, count: resurrected.length },
      "Resurrected dormant apps after user reconnect"
    );
  }
}
```

## Edge Cases

### Edge Case 1: SDK reconnects during grace period (user connected)
```
RUNNING → GRACE_PERIOD → [SDK reconnects] → RUNNING
```
Normal flow, works today (once we fix handleAppClose).

### Edge Case 2: SDK reconnects during grace period (user disconnected)
```
RUNNING → GRACE_PERIOD → [SDK reconnects] → RUNNING
```
Same flow! SDK reconnect works regardless of user connection status.

### Edge Case 3: Grace expires, user connected, resurrection succeeds
```
RUNNING → GRACE_PERIOD → RESURRECTING → CONNECTING → RUNNING
```
User gets continuous service.

### Edge Case 4: Grace expires, user connected, resurrection fails
```
RUNNING → GRACE_PERIOD → RESURRECTING → STOPPED
Mobile receives: app_stopped
```
User sees app stopped in UI. Correct behavior.

### Edge Case 5: Grace expires, user disconnected
```
RUNNING → GRACE_PERIOD → DORMANT → [user reconnects] → RESURRECTING → RUNNING
```
App resumes when user returns.

### Edge Case 6: DORMANT, SDK reconnects before user
```
RUNNING → GRACE_PERIOD → DORMANT → [SDK reconnects] → RUNNING
```
Accept late SDK reconnection. No resurrection needed.

### Edge Case 7: User switches clouds
```
Cloud A: RUNNING → GRACE_PERIOD → DORMANT → [user never returns] → [UserSession disposes] → cleanup
Cloud B: User starts same app, works normally
```
No stealing. Correct behavior.

### Edge Case 8: Rapid user disconnect/reconnect during grace
```
RUNNING → GRACE_PERIOD → [user disconnects] → [user reconnects within 5s] → 
  [grace expires] → RESURRECTING (user is now connected)
```
Grace period timer continues running. Final state check happens at expiration.

### Edge Case 9: App dies, user already disconnected
```
RUNNING → GRACE_PERIOD (not DORMANT directly!)
  [SDK might reconnect within 5s]
  [5s expires] → DORMANT
```
Always give SDK a chance to reconnect first.

### Edge Case 10: Ownership release (user switches clouds)
```
Cloud A: RUNNING → [OWNERSHIP_RELEASE received] → [WS closes] → DORMANT
         [user returns to Cloud A] → RESURRECTING → RUNNING
Cloud B: [webhook] → CONNECTING → RUNNING
         [user leaves] → [OWNERSHIP_RELEASE received] → [WS closes] → DORMANT
```
Symmetric behavior. App becomes DORMANT on ownership release, resurrected if user returns.
Database (`user.runningApps`) is never modified during handoffs.

### Edge Case 11: SDK multi-cloud session corruption (BUG - needs SDK fix)
```
Cloud A: SDK has sessionA in activeSessions["user-app"]
Cloud B: [webhook] → SDK creates sessionB, overwrites activeSessions["user-app"]
         sessionA is now orphaned (WS still open!)
Cloud A: [disposes after 1 min] → sessionA cleanup fires
         → DELETES sessionB from maps (BUG!)
```
SDK fix required: verify session identity before deleting from maps.

## Files to Modify

| File | Change |
|------|--------|
| `packages/cloud/src/services/websocket/bun-websocket.ts` | Fix `handleAppClose()` to call `AppSession.handleDisconnect()`, call `resurrectDormantApps()` on glasses reconnect |
| `packages/cloud/src/services/session/AppSession.ts` | Add `DORMANT` state, `isDormant` getter, `markDormant()` method |
| `packages/cloud/src/services/session/AppManager.ts` | Update `handleAppSessionGracePeriodExpired()` to check user connection, add `resurrectDormantApps()` and `getDormantApps()`, update `handleAppInit()` to accept DORMANT connections |
| `packages/sdk/src/app/server/index.ts` | **(SDK-side)** Fix cleanup handler to verify session identity before deleting; send OWNERSHIP_RELEASE on cloud switch |

## Migration Strategy

1. **Phase 1**: Add DORMANT state to AppSession (no behavior change yet)
2. **Phase 2**: Fix `handleAppClose()` to call `handleDisconnect()` - enables grace period
3. **Phase 3**: Update grace expiration to use DORMANT when user disconnected
4. **Phase 4**: Add `resurrectDormantApps()` and call on user reconnect
5. **Phase 5**: Update `handleAppInit()` to accept SDK reconnects while DORMANT

All changes are backward compatible. No protocol changes. No mobile changes needed.

## Testing

### Manual Test Cases

1. **Basic disconnect**: Kill mini app server, verify grace period starts, resurrection triggers
2. **SDK reconnect**: Kill mini app server, restart within 5s, verify SDK reconnects (no resurrection)
3. **User disconnected**: Kill mini app server while user disconnected, verify DORMANT state, reconnect user, verify resurrection
4. **Late SDK reconnect**: Kill mini app server, wait for DORMANT, restart server, verify SDK reconnects
5. **Cross-cloud**: User switches clouds, verify old cloud doesn't steal app back
6. **Resurrection failure**: Kill mini app server permanently, verify mobile gets `app_stopped`

### Log Verification

Should see in logs:
```
App WebSocket closed (code 1006)
App disconnected - starting grace period
[either] SDK reconnected during grace period
[or] Grace period expired - user connected - attempting resurrection
[or] Grace period expired - user not connected - marking DORMANT
[later] User reconnected - resurrecting dormant apps
[or] SDK reconnected while DORMANT - accepting late reconnection
```

## Open Questions

1. **Resurrection retry limit?**
   - If resurrection keeps failing (webhook timeout), how many times to retry?
   - **Proposed**: 3 attempts with exponential backoff, then STOPPED

2. **DORMANT timeout?**
   - Should DORMANT apps eventually give up and mark STOPPED?
   - **Proposed**: No separate timeout, rely on UserSession disposal (existing grace period)

3. **Resources during DORMANT?**
   - DORMANT apps hold: AppSession object (~few KB), no WS, no subscriptions
   - Acceptable memory cost while waiting for user

---

## Addendum: Ownership Release Handling

### Previous Behavior (Incorrect)

When SDK sent `OWNERSHIP_RELEASE`, the cloud marked the app as `STOPPED`:
```typescript
if (this._ownershipReleased) {
  this.setState(AppConnectionState.STOPPED)  // Wrong!
}
```

Problems:
- `resurrectDormantApps()` only looks at DORMANT apps, ignores STOPPED
- If user returns to this cloud, app doesn't restart
- User has to manually restart the app

### New Behavior (Correct)

On `OWNERSHIP_RELEASE`, mark as `DORMANT`:
```typescript
if (this._ownershipReleased) {
  this.setState(AppConnectionState.DORMANT)  // Correct!
}
```

Benefits:
- `resurrectDormantApps()` will restart it when user returns
- Symmetric behavior across clouds
- Database stays unchanged (critical for shared DB)

### Why This Matters for Multi-Cloud

All clouds share the same MongoDB. The `user.runningApps` array represents **user intent** ("I want these apps running"), not "which cloud currently has them."

- Cloud A should NEVER remove apps from DB on ownership release
- Cloud B reads DB to know what apps to start
- If Cloud A removed from DB, Cloud B wouldn't start the app

By marking as DORMANT instead of STOPPED:
1. Database is untouched
2. If user returns to Cloud A, app resurrects automatically
3. If user stays on Cloud B, Cloud A's DORMANT app gets cleaned up when UserSession eventually disposes

---

## Addendum: SDK Multi-Cloud Bug

### The Bug

When user switches from Cloud A to Cloud B:
1. SDK creates sessionB, overwrites `activeSessions[sessionId]`
2. sessionA is orphaned (not in maps, but WS still open)
3. ~1 min later, Cloud A disposes, closes sessionA's WebSocket
4. sessionA's cleanup handler fires: `this.activeSessions.delete(sessionId)`
5. **This deletes sessionB!** (the active Cloud B connection)

### Root Cause

Cleanup handler deletes by key without verifying session identity:
```typescript
// In packages/sdk/src/app/server/index.ts
this.activeSessions.delete(sessionId)      // Deletes whatever is at this key
this.activeSessionsByUserId.delete(userId)
```

### SDK Fix Required

```typescript
// Verify this session is still the active one before deleting
if (this.activeSessions.get(sessionId) === session) {
  this.activeSessions.delete(sessionId)
}
if (this.activeSessionsByUserId.get(userId) === session) {
  this.activeSessionsByUserId.delete(userId)
}
```

This works because `===` compares object references. Each `new AppSession()` has a unique reference, and the closure captures the specific session that registered the handler.

### Additional Enhancement: Clean Handoff

When new webhook arrives for existing user:
```typescript
const existingSession = this.activeSessions.get(sessionId)
if (existingSession) {
  existingSession.send({ type: "OWNERSHIP_RELEASE", reason: "switching_clouds" })
  existingSession.disconnect()
  this.activeSessions.delete(sessionId)
  this.activeSessionsByUserId.delete(userId)
}
// Now create new session
```

This ensures:
1. Old cloud gets OWNERSHIP_RELEASE → marks DORMANT (not resurrection ping-pong)
2. Old session is explicitly cleaned up
3. No orphaned sessions