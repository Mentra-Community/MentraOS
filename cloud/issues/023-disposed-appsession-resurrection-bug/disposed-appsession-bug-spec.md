# Disposed AppSession Resurrection Bug Spec

## Overview

AppSession resurrection fails when attempting to reuse a session that was disposed after an `OWNERSHIP_RELEASE` message. The disposed ResourceTracker throws "Cannot track resources on a disposed ResourceTracker" when the new connection tries to set up heartbeat tracking.

## Problem

When the SDK sends `OWNERSHIP_RELEASE` (e.g., `clean_shutdown`), the cloud-side flow is:

1. `handleDisconnect()` is called
2. Sees `_ownershipReleased` is set
3. Sets state to `DORMANT`
4. Calls `cleanup()` → **disposes ResourceTracker permanently**
5. AppSession stays in `this.apps` map

Later, when resurrection is triggered:

1. `getOrCreateAppSession(packageName)` is called
2. Returns existing AppSession from map (disposed, but still present)
3. `handleConnect()` calls `setupHeartbeat()`
4. `setupHeartbeat()` calls `resources.trackInterval()` → **THROWS**

### Evidence from Logs

```
01:58:42.615 | Ownership released - will not resurrect on disconnect
01:58:42.652 | State transition: running -> dormant
01:58:42.652 | Cleaning up AppSession          <-- ResourceTracker disposed here

02:00:14.730 | Cannot track resources on a disposed ResourceTracker
02:00:27.965 | Cannot track resources on a disposed ResourceTracker
02:00:47.355 | Cannot track resources on a disposed ResourceTracker
```

All resurrection attempts after 01:58:42 fail because the AppSession was disposed but never removed from the map.

### Root Cause

`getOrCreateAppSession()` only checks if a session exists, not if it's disposed:

```typescript
// packages/cloud/src/services/session/AppManager.ts
getOrCreateAppSession(packageName: string): AppSession | undefined {
  let session = this.apps.get(packageName);
  if (!session) {
    session = new AppSession({...});
    this.apps.set(packageName, session);
  }
  return session;  // Returns disposed session!
}
```

### Why This Happens

The DORMANT state is designed to allow late SDK reconnections after grace period expires. The session stays in the map so we can accept reconnections. However, `cleanup()` is also called to free resources, which disposes the ResourceTracker.

This creates a contradiction:

- DORMANT means "keep session for potential reconnection"
- `cleanup()` means "release all resources permanently"

## Constraints

- ResourceTracker disposal is permanent (by design)
- AppSession must stay in map for DORMANT state to work
- Resurrection flow must be able to create new connections
- Multi-cloud handoffs depend on OWNERSHIP_RELEASE → DORMANT flow

## Goals

1. Resurrection should succeed after ownership release
2. Disposed sessions should not be reused
3. DORMANT state should still allow late SDK reconnections
4. No memory leaks from orphaned sessions

## Non-Goals

- Changing ResourceTracker to be resettable (too risky)
- Removing DORMANT state (needed for multi-cloud)
- Changing OWNERSHIP_RELEASE behavior

## Solution

Check for disposed sessions in `getOrCreateAppSession()`:

```typescript
getOrCreateAppSession(packageName: string): AppSession | undefined {
  let session = this.apps.get(packageName);

  // If session is disposed, remove it and create fresh
  if (session?.isDisposed) {
    this.logger.info({packageName},
      `Existing AppSession is disposed, creating fresh session`);
    this.apps.delete(packageName);
    session = undefined;
  }

  if (!session) {
    session = new AppSession({...});
    this.apps.set(packageName, session);
  }
  return session;
}
```

## Reproduction Steps

### What Triggers This Bug

The bug is triggered when the **SDK mini-app server shuts down gracefully** (redeploy, restart, or manual shutdown). During graceful shutdown, the SDK sends `OWNERSHIP_RELEASE: clean_shutdown` to all connected cloud sessions.

### Evidence from Logs

```
01:58:42.408 | 🛑 Shutting down...                           <- SDK app server shutdown
01:58:42.408 | 👋 Closing session ... with ownership release
01:58:42.409 | 🔄 Releasing ownership: clean_shutdown
01:58:42.549 | Cleaning up AppSession                        <- ResourceTracker disposed
01:58:42.549 | State transition: running -> dormant
...
02:00:14.730 | Cannot track resources on a disposed ResourceTracker  <- Resurrection fails
```

### Steps to Reproduce

**Method 1: Redeploy the mini-app**

1. Start an app (e.g., MentraAI) running on the cloud
2. **Restart/redeploy the mini-app SDK server** (the app's backend)
3. The SDK automatically sends `OWNERSHIP_RELEASE: clean_shutdown` before closing
4. Wait for the SDK to come back online
5. Try to reconnect or trigger resurrection
6. Observe: "Cannot track resources on a disposed ResourceTracker"

**Method 2: Manual simulation**

1. Have an app running with an active WebSocket connection
2. From the SDK, send an `OWNERSHIP_RELEASE` message with reason `clean_shutdown`
3. Close the WebSocket connection normally (code 1000)
4. Try to start the app again via `startApp()` or trigger resurrection
5. Observe the error

**Method 3: SDK API call**

1. Have an app running
2. Call `session.stop()` or `session.disconnect()` from the SDK with clean shutdown
3. Try to reconnect
4. Observe the error

### Scenarios That Trigger This

- SDK server restarts/redeploys (most common)
- SDK process termination with SIGTERM (graceful shutdown handler)
- SDK calling `session.stop()` or `session.disconnect()`
- Any graceful SDK shutdown that sends `OWNERSHIP_RELEASE`

### Why It Doesn't Happen on Abnormal Disconnects

If the SDK crashes or loses connection without sending `OWNERSHIP_RELEASE`:

- `handleDisconnect()` doesn't see `_ownershipReleased` set
- Goes into grace period instead of calling `cleanup()`
- ResourceTracker stays alive
- Resurrection works fine

The bug is **specific to graceful shutdowns** that send `OWNERSHIP_RELEASE`.

## Root Cause Analysis: Why Does Shutdown Send OWNERSHIP_RELEASE?

### The Real Bug

The disposed AppSession issue is a **symptom**. The **root cause** is that the SDK incorrectly sends `OWNERSHIP_RELEASE: clean_shutdown` when the mini-app server shuts down.

### Original Design Intent

`OWNERSHIP_RELEASE` was designed for **multi-cloud handoffs**:

1. **`switching_clouds`** - When SDK receives a NEW webhook for the same user from a DIFFERENT cloud, it releases ownership of the OLD connection. This tells the old cloud: "don't resurrect, the user moved to another cloud." ✅ Correct

2. **`clean_shutdown`** - Currently sent when SDK server shuts down gracefully. This tells the cloud: "don't resurrect." ❌ Wrong!

### Why `clean_shutdown` Is Wrong

When the SDK server shuts down (redeploy/restart):

- It's going to come back up
- The cloud SHOULD resurrect the app (trigger webhook)
- The user expects their app to keep running

**But** sending `OWNERSHIP_RELEASE: clean_shutdown` tells the cloud "don't resurrect", which is the **opposite** of what we want.

### Current Broken Flow

```
SDK server redeploys
    ↓
cleanup() sends OWNERSHIP_RELEASE: clean_shutdown to all sessions
    ↓
Cloud receives OWNERSHIP_RELEASE → marks ownershipReleased = true
    ↓
WebSocket closes
    ↓
handleDisconnect() sees ownershipReleased → calls cleanup() → disposes ResourceTracker
    ↓
State → DORMANT (but ResourceTracker is dead)
    ↓
SDK comes back up, webhook triggered
    ↓
getOrCreateAppSession() returns disposed session
    ↓
💥 "Cannot track resources on a disposed ResourceTracker"
```

### Correct Flow (Without OWNERSHIP_RELEASE on shutdown)

```
SDK server redeploys
    ↓
cleanup() just closes WebSocket (no OWNERSHIP_RELEASE)
    ↓
Cloud detects close → State → GRACE_PERIOD
    ↓
Grace period expires, user connected → RESURRECTING
    ↓
stopApp() + startApp() → triggers webhook
    ↓
SDK responds, connects fresh
    ↓
✅ App running
```

## Two-Part Fix Required

### Fix 1: AppManager.getOrCreateAppSession() (Implemented)

Detect disposed sessions and create fresh ones. This handles the symptom and prevents crashes.

### Fix 2: SDK cleanup() Should NOT Send OWNERSHIP_RELEASE (Not Yet Implemented)

```typescript
// packages/sdk/src/app/server/index.ts

private async cleanup(): Promise<void> {
  for (const [sessionId, session] of this.activeSessions) {
    try {
      // DON'T release ownership on clean_shutdown
      // Let the cloud resurrect when we come back up
      await session.disconnect({
        releaseOwnership: false,  // Changed from true
      })
    } catch (error) {
      // ...
    }
  }
}
```

### When OWNERSHIP_RELEASE Should Be Sent

| Reason             | Send OWNERSHIP_RELEASE? | Why                                        |
| ------------------ | ----------------------- | ------------------------------------------ |
| `switching_clouds` | ✅ Yes                  | User moved to another cloud, don't compete |
| `user_logout`      | ⚠️ Maybe                | Mobile WS disconnects anyway on logout     |
| `clean_shutdown`   | ❌ No                   | Server restarting, cloud should resurrect  |

## Analysis: Do We Still Need OWNERSHIP_RELEASE?

### The Question

The cloud already checks if mobile-to-cloud WebSocket is connected before resurrecting:

```typescript
const userConnected = this.userSession.websocket && this.userSession.websocket.readyState === WebSocketReadyState.OPEN

if (!userConnected) {
  // Don't resurrect, go to DORMANT
}
```

Can we just use mobile WS connection as the source of truth and remove OWNERSHIP_RELEASE entirely?

### Why `switching_clouds` OWNERSHIP_RELEASE Is Still Needed

**The race condition during cloud transitions:**

Without OWNERSHIP_RELEASE:

1. User connected to Cloud A, app running
2. User switches to Cloud B, starts same app
3. Cloud A's mini-app WS breaks (SDK now talking to Cloud B)
4. Cloud A starts 5-second grace period
5. Cloud A checks: is mobile WS open? **YES** (still connected during transition!)
6. Cloud A resurrects! Now BOTH clouds are fighting for the app.

With OWNERSHIP_RELEASE:

1. User connected to Cloud A, app running
2. User switches to Cloud B, webhook triggers SDK
3. SDK sees existing session for Cloud A, sends `OWNERSHIP_RELEASE: switching_clouds`
4. Cloud A receives OWNERSHIP_RELEASE → goes to DORMANT
5. Cloud A won't resurrect even if mobile WS is still briefly connected
6. Clean handoff to Cloud B

**Key insight:** During cloud transitions, the user may be briefly connected to BOTH clouds. OWNERSHIP_RELEASE tells the old cloud to stand down before the race condition occurs.

### Summary: What to Keep vs Remove

| Scenario             | OWNERSHIP_RELEASE | Mobile WS Check       | Recommendation                           |
| -------------------- | ----------------- | --------------------- | ---------------------------------------- |
| SDK restart/redeploy | ❌ Don't send     | Cloud resurrects      | **Fixed** - removed                      |
| SDK crash            | N/A (can't send)  | Cloud resurrects      | Works correctly                          |
| User switches clouds | ✅ Send           | Race condition!       | **Keep** - prevents both clouds fighting |
| User logs out        | ⚠️ Optional       | Mobile WS disconnects | Could remove, but harmless               |

### Conclusion

**Keep OWNERSHIP_RELEASE for `switching_clouds` only.** It solves a real race condition that the mobile WS check cannot handle alone.

The mobile WS check is necessary but not sufficient - it handles the "user disconnected" case but not the "user moved to another cloud while still briefly connected to both" case.

## Open Questions

1. **Should we avoid calling cleanup() for DORMANT sessions?**
   - Alternative: Only dispose on full removal, not on DORMANT transition
   - Risk: Memory leaks if sessions stay DORMANT forever
   - **Decision**: Keep cleanup(), detect disposed in getOrCreate (safer)

2. **Should disposed detection be in AppSession.handleConnect() instead?**
   - Could throw clearer error
   - But getOrCreate is the right place (single point of control)
   - **Decision**: Keep in getOrCreateAppSession()

3. **Should we fix the SDK cleanup() as well?**
   - Yes, this is the root cause fix
   - The getOrCreateAppSession fix is a safety net
   - **Decision**: Implement both fixes ✅

4. **Can we remove OWNERSHIP_RELEASE entirely?**
   - No - still needed for `switching_clouds` to prevent race condition
   - Mobile WS check is necessary but not sufficient
   - **Decision**: Keep for `switching_clouds`, remove for `clean_shutdown` ✅
