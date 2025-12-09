# Apps Not Auto-Restarting After Long Disconnection

Previously running apps don't auto-restart when user reconnects after force-quitting the mobile app, even though the session was kept alive through grace period.

## Quick Context

**Current behavior**: User force-quits mobile app → waits >1 minute → reopens app → apps don't auto-start (must manually start from UI)

**Expected behavior**: Previously running apps should auto-restart on reconnection

**Root cause**: Session remains alive indefinitely without disconnect event after certain reconnection patterns, causing reconnections to be treated as "quick reconnects" where apps shouldn't restart.

## The Problem

### User Experience

1. User has Live Captions app running
2. User force-quits mobile app (or experiences network disruption)
3. User waits several minutes
4. User reopens mobile app
5. **Apps don't auto-start** - user must manually start each app from UI
6. Transcription doesn't work until apps are manually restarted

### Why It Happens

The code distinguishes between two types of connections:

```typescript
// New connection: Start apps automatically
if (!reconnection) {
  await userSession.appManager.startPreviouslyRunningApps()
}

// Reconnection: Don't restart apps (assumes they're still running on client)
if (reconnection) {
  // Only rejoin LiveKit, don't restart apps
}
```

**The issue**: After certain reconnection patterns, the session stays alive indefinitely without a disconnect event being registered, so all future connections are treated as "reconnections" even after long periods.

## Evidence from Logs

User: `isaiahballah@gmail.com` on `2025-11-24 22:24-22:34 UTC`

### Sequence of Events

```
22:23:27 - Disconnect (1006)
22:24:33 - Disconnect (1006) - reconnected in between
22:24:53 - Disconnect (1000)
22:24:54 - Reconnect (232ms later!) ← Grace period timer started then immediately cleared
          - disconnectedAt set to null
          - cleanupTimerId cleared
          - Session now thinks it's fully connected

[User force-quits app here - NO DISCONNECT EVENT LOGGED]

[Session sits idle for 9 minutes and 20 seconds]
[No grace period cleanup triggered - no timer was running]
[Session never disposed - still exists in memory]

22:34:13 - User reopens app and reconnects
22:34:13 - "Existing session found" ← Treated as reconnection!
22:34:13 - Apps NOT auto-started (because reconnection=true)
22:34:13 - LiveKit rejoined successfully
22:34:13 - User has to manually start apps from UI
```

### Key Log Evidence

**Session still existed:**

```
22:34:13.256 - "[UserSession:createOrReconnect] Existing session found for isaiahballah@gmail.com"
```

**No grace period cleanup logs between 22:24:54 and 22:34:13:**

- No "Cleanup grace period expired"
- No "User session determined not reconnected, cleaning up"
- No session dispose

**Apps didn't auto-start:**

- No "Starting previously running apps" log
- No AppManager activity after reconnection

## Root Causes

### Root Cause #1: Session Doesn't Receive Disconnect Event on Force-Quit

When user force-quits the mobile app:

- Mobile WebSocket closes
- But no disconnect event is logged/processed on cloud
- Session keeps `disconnectedAt = null`
- No grace period timer started
- Session stays alive indefinitely

**Possible reasons:**

- WebSocket close event not firing
- Close event being swallowed/ignored
- Race condition between rapid reconnects clearing state
- Heartbeat mechanism failing to detect dead connection

### Root Cause #2: Rapid Reconnections Clear Grace Period

```typescript
// In createOrReconnect() for existing sessions:
existingSession.disconnectedAt = null // Clears disconnect state
if (existingSession.cleanupTimerId) {
  clearTimeout(existingSession.cleanupTimerId) // Cancels grace period
  existingSession.cleanupTimerId = undefined
}
```

After rapid reconnection (232ms), the grace period is cleared. If the user then force-quits without a proper disconnect event, the session has:

- No `disconnectedAt` timestamp
- No `cleanupTimerId` running
- Session thinks it's fully connected and never cleans up

### Root Cause #3: No Heartbeat-Based Session Cleanup

The system relies solely on WebSocket disconnect events to trigger cleanup. If disconnect events are missed:

- Session stays alive forever
- No fallback mechanism to detect dead sessions
- No heartbeat timeout to trigger cleanup

## Affected Scenarios

1. **Force-quit after rapid reconnections** (confirmed)
   - User experiences network instability
   - Multiple rapid reconnects (< 1 second)
   - User force-quits app
   - Session stays alive indefinitely

2. **Network-level disconnection without WebSocket close** (suspected)
   - Airplane mode
   - Network switch (WiFi → Cellular)
   - Connection drops without proper close frame
   - Session never receives disconnect event

3. **Mobile app crashes** (suspected)
   - App crashes without closing WebSocket gracefully
   - No disconnect event sent to server
   - Session orphaned

## Impact

- **Frequency**: Happens after certain reconnection patterns, difficult to reproduce consistently
- **Severity**: Medium - Apps don't work until manually restarted, but system is otherwise functional
- **Workaround**: User can manually start apps from UI

## Proposed Solutions

### Option 1: Always Restart Apps on Any Connection (Simplest)

```typescript
// Remove the reconnection check - always restart apps
async handleConnectionInit(userSession, reconnection, livekitRequested) {
  // Always restart previously running apps (whether new or reconnection)
  try {
    await userSession.appManager.startPreviouslyRunningApps();
  } catch (error) {
    userSession.logger.error({ error }, `Error starting apps`);
  }

  // ... rest of logic
}
```

**Pros:**

- Simplest fix
- Ensures apps always start
- No edge cases with grace period

**Cons:**

- Wastes resources on quick reconnects (< 5s) where apps are still running
- Duplicate app starts might cause issues

### Option 2: Heartbeat-Based Session Cleanup (Recommended)

Add heartbeat mechanism to detect dead sessions:

```typescript
class UserSession {
  private lastHeartbeat: Date = new Date()
  private heartbeatInterval?: NodeJS.Timeout

  startHeartbeatMonitoring() {
    this.heartbeatInterval = setInterval(() => {
      const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeat.getTime()

      // If no heartbeat for 2 minutes, consider session dead
      if (timeSinceLastHeartbeat > 120000) {
        this.logger.warn("Session heartbeat timeout, disposing")
        this.dispose()
      }
    }, 30000) // Check every 30 seconds
  }

  onHeartbeat() {
    this.lastHeartbeat = new Date()
  }
}
```

**Pros:**

- Catches sessions that miss disconnect events
- Provides fallback cleanup mechanism
- More robust than relying solely on disconnect events

**Cons:**

- More complex
- Requires implementing heartbeat on mobile side

### Option 3: Time-Based Reconnection Detection

Consider connection as "new" if disconnected for >30 seconds:

```typescript
async handleConnectionInit(userSession, reconnection, livekitRequested) {
  // Check if this is really a quick reconnect or a long-term disconnect
  const timeSinceDisconnect = userSession.disconnectedAt
    ? Date.now() - userSession.disconnectedAt.getTime()
    : Infinity;

  const isLongDisconnect = timeSinceDisconnect > 30000; // 30 seconds

  if (!reconnection || isLongDisconnect) {
    // Treat as new connection - restart apps
    await userSession.appManager.startPreviouslyRunningApps();
  }
}
```

**Pros:**

- Balances between quick reconnects and long disconnects
- Simple logic

**Cons:**

- Requires `disconnectedAt` to be set properly (which is the bug!)
- Doesn't solve root cause of missing disconnect events

### Option 4: Mobile-Driven App State

Let mobile tell cloud which apps should be running:

```typescript
// Mobile sends on connection:
{
  type: "connection_init",
  runningApps: ["com.augmentos.livecaptions", "com.mentra.notes"]
}

// Cloud starts only those apps, ignoring server-side state
```

**Pros:**

- Source of truth is on mobile (which actually knows app state)
- No ambiguity about what should be running

**Cons:**

- Requires mobile app changes
- Changes connection protocol

## Recommendation

**Implement Option 2 (Heartbeat) + Option 3 (Time-Based Detection)**

1. **Short term**: Add time-based reconnection detection (30-second threshold)
   - Quick fix that helps most cases
   - Restart apps if disconnected >30 seconds

2. **Medium term**: Implement heartbeat-based session cleanup
   - Ensures orphaned sessions are eventually cleaned up
   - Provides fallback for missed disconnect events

3. **Long term**: Consider Option 4 (mobile-driven state)
   - Most robust solution
   - Requires protocol changes

## Testing Plan

### Reproduce the Bug

1. Connect mobile to development environment
2. Start Live Captions app
3. Toggle WiFi on/off rapidly 3-4 times (create rapid reconnections)
4. Wait for stable connection
5. Force quit mobile app (swipe up)
6. Wait 2+ minutes
7. Reopen mobile app
8. **Expected bug**: Apps don't auto-start

### Verify the Fix

After implementing fix:

1. Same steps as above
2. **Expected behavior**: Apps auto-start after reconnection
3. Check logs: "Starting previously running apps" appears
4. Live Captions starts automatically without manual intervention

### Edge Cases to Test

- [ ] Quick reconnect (<5s): Apps should NOT restart (already running)
- [ ] Medium reconnect (30s): Apps SHOULD restart
- [ ] Long reconnect (5+ minutes): Apps SHOULD restart
- [ ] Force quit: Apps SHOULD restart on reopen
- [ ] Airplane mode: Apps SHOULD restart when reconnect
- [ ] Network switch (WiFi→Cellular): Test behavior

## Related Issues

- [LiveKit Mobile Reconnection Bug](../livekit-mobile-reconnection-bug/README.md) - Similar grace period issues with bridge sessions

## Status

- [x] Bug confirmed via logs
- [x] Root causes identified
- [ ] Solution selected
- [ ] Implementation
- [ ] Testing
- [ ] Deployment
