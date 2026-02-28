# Sub-Issue 008.6: Apps Not Restarting After Session Reconnection

**Status**: Open  
**Priority**: High  
**Component**: Mobile client, AppManager, session lifecycle

## Problem

When a user's session disconnects and they reconnect, previously running apps don't automatically restart. The user must manually reopen the mobile client to get apps running again.

## Evidence (isaiah@mentra.glass - 2025-12-16)

**Timeline:**

1. **21:03:35** - `com.mentra.captions` started, working normally
2. **21:14:43** - App disconnected (code 1006), auto-resurrected at 21:14:48 ✅
3. **21:27:21** - Phone WebSocket connection closing
4. **21:28:21** - Grace period expired (60 seconds), session disposed
5. **21:28:21** - Apps stopped with code 1000 (User session ended)
6. **21:28:59 - 21:42:59** - 14 minutes of no session
7. **21:43:02** - User reopened mobile client, new session created, apps started

**Key observation**: The captions app was "supposed to be running" but wasn't working until the mobile client was reopened.

## Root Cause

The session disconnect shows:

```
21:27:21.319 - Phone WebSocket connection closing
21:28:21.319 - Cleanup grace period expired for user session: isaiah@mentra.glass
21:28:21.320 - User session isaiah@mentra.glass determined not reconnected, cleaning up session.
```

The 60-second grace period worked correctly. The phone WebSocket disconnected at 21:27:21 and the cloud waited 60 seconds before disposing the session at 21:28:21.

**The phone did not reconnect within the 60-second window.**

**Why apps didn't restart automatically:**

- The cloud has no persistent record of "what apps should be running"
- When session is disposed, all app state is lost
- On reconnection, the mobile client must tell the cloud what to start
- If mobile client doesn't reconnect or doesn't send app list, apps don't start

## Why Mobile Client Didn't Reconnect Within 60 Seconds

Possible scenarios:

1. **Mobile app backgrounded** - iOS/Android killed the WebSocket, app not running to reconnect
2. **Mobile app crashed** - Silent crash, no reconnection attempt
3. **OS killed the app** - Memory pressure or battery optimization
4. **Network interruption** - Phone lost connectivity entirely

When user "reopened" the app (15 minutes later at 21:43):

1. Established new WebSocket connection
2. Sent list of installed/running apps
3. Cloud started the requested apps

## Proposed Solutions

### Option A: Persist Running Apps in Database

Store running apps per user in the database:

```typescript
// On app start
await UserRunningApps.upsert({
  userId,
  packageName,
  startedAt: new Date(),
});

// On session reconnect
const runningApps = await UserRunningApps.find({ userId });
for (const app of runningApps) {
  await this.appManager.startApp(app.packageName);
}
```

**Pros**: Apps auto-restart on any reconnection
**Cons**: Complexity, potential for stale state

### Option B: Mobile Client Background Reconnection

Improve mobile client to maintain connection when backgrounded:

- Use background fetch / background tasks
- Implement WebSocket reconnection with exponential backoff
- Send "heartbeat" to keep connection alive

**Pros**: Addresses root cause
**Cons**: Platform-specific, battery impact

### Option C: Accept Current Behavior (Document It)

The current behavior is:

- Session disconnect = apps stop
- User must reopen app to restart

This is actually reasonable for battery/resource management.

**Pros**: Simple, no changes needed
**Cons**: User experience issue

## Questions to Resolve

1. Should apps persist across session disconnects?
2. How long should "running app" state be remembered?
3. What's the expected mobile client behavior when backgrounded?
4. Is there a related mobile app issue for connection stability?

## Grace Period Configuration

| Component                     | Grace Period | Location                                                 |
| ----------------------------- | ------------ | -------------------------------------------------------- |
| UserSession (phone WebSocket) | 60 seconds   | `websocket-glasses.service.ts:RECONNECT_GRACE_PERIOD_MS` |
| AppSession (individual app)   | 5 seconds    | `AppSession.ts:GRACE_PERIOD_MS`                          |

## Related Issues

- Issue 004: Apps not restarting on reconnection (may be same issue)
- Issue 008: Logging & Observability Cleanup (parent)
- Mobile client background connection handling

## Files to Investigate

- `cloud/packages/cloud/src/services/session/AppManager.ts` - App lifecycle
- `cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts` - Session reconnection (60s grace period)
- `cloud/packages/cloud/src/services/session/AppSession.ts` - App-level grace period (5s)
- `mobile/src/services/WebSocketManager.ts` - Mobile connection handling
