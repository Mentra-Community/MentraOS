# 089 — Design: Prevent App Reconnection After User Stop

**Status:** Layer 1 applied, Layer 2 ready to implement
**Author:** Isaiah, with Claude
**Date:** April 6, 2026

---

## Problem

User stops a mini app from the Mentra phone app → the app restarts within 2–3
seconds. Two-layer failure:

1. **SDK reconnects when it shouldn't.** `_ConnectionManager` sees the
   cloud-initiated WebSocket close as an unexpected disconnect and fires
   `scheduleReconnect()`.
2. **Cloud accepts when it shouldn't.** `handleAppInit()` / `handleReconnect()`
   lets the reconnecting app back in even though the user explicitly stopped it.

The result: users cannot stop mini apps. They keep coming back.

## Desired Behavior

- User taps "Stop" in phone app → app stops and **stays stopped**
- The app only starts again when the user explicitly launches it
- Server restarts, crashes, network blips should still allow reconnection
  (those are NOT user stops)
- Old SDK versions (v2) that don't have the SDK fix should also stay stopped
  (the cloud must enforce)

## Solution — Two Layers of Defense

Both layers are needed. Layer 1 is the fast path (SDK doesn't reconnect at all).
Layer 2 is the safety net (cloud rejects even if the SDK does reconnect). This
covers all SDK versions, including v2 apps already deployed.

---

## Layer 1: SDK Fix (already applied)

**File:** `cloud/packages/sdk/src/session/MentraSession.ts`

When `APP_STOPPED` is received from the cloud, call
`this._lifecycleManager.disconnect()` before emitting the stopped event. This
sets `explicitDisconnect = true` on `_ConnectionManager`, which prevents the
`onClose` handler from calling `scheduleReconnect()`.

### Before (broken)

```typescript
// MentraSession.ts — APP_STOPPED handler
register(CloudToAppMessageType.APP_STOPPED, (message) => {
    const reason = message.reason ?? "unknown";
    this.logger.info({ reason }, "MentraSession received app_stopped");
    this.emit("stopped", reason);  // ← emits event but doesn't prevent reconnect
});
```

The stop fires, the event emits, but nobody tells `_ConnectionManager` to stand
down. The subsequent WebSocket close (from the cloud) hits the `onClose` handler
with `explicitDisconnect = false`. The handler sees `permanent = false` and
calls `scheduleReconnect()`. The app is back in 1–2 seconds.

### After (fixed)

```typescript
// MentraSession.ts — APP_STOPPED handler
register(CloudToAppMessageType.APP_STOPPED, (message) => {
    const reason = message.reason ?? "unknown";
    this.logger.info({ reason }, "MentraSession received app_stopped");
    this._lifecycleManager.disconnect();  // ← prevents reconnect
    this.emit("stopped", reason);
});
```

`this._lifecycleManager.disconnect()` does three things:
1. Sets `explicitDisconnect = true` on `_ConnectionManager`
2. Clears all reconnect timers
3. Closes the transport cleanly

When the `onClose` handler fires, it sees `permanent = true` and does NOT
reconnect. The app stays stopped.

This handles v3 SDK going forward. But v2 SDKs (and any v3 SDK before this fix)
will still reconnect. That's what Layer 2 is for.

---

## Layer 2: Cloud Fix (not yet implemented)

**File:** `cloud/packages/cloud/src/services/session/AppManager.ts`

The cloud must reject reconnection attempts for apps that were explicitly stopped
by the user. Two changes are needed.

### Change 1: Track user-initiated stops on AppSession

**File:** `cloud/packages/cloud/src/services/session/AppSession.ts`

Add a `userStopped` flag that distinguishes "user explicitly stopped this app"
from "app crashed / timed out / server restarted."

```typescript
// In AppSession
private _userStopped = false;

/**
 * Mark this app as explicitly stopped by the user (from the phone app).
 * Prevents the app from reconnecting — the cloud will reject any
 * reconnection attempts until the user explicitly starts the app again.
 */
markUserStopped(): void {
    this._userStopped = true;
    this.markStopped();
}

get wasUserStopped(): boolean {
    return this._userStopped;
}

/**
 * Clear the user-stopped flag. Called when the user explicitly starts
 * the app again (not on reconnection — on fresh start).
 */
clearUserStopped(): void {
    this._userStopped = false;
}
```

In `stopApp()`, when the stop is user-initiated (not a restart, not a grace
period expiry):

```typescript
// In stopApp()
if (!restart) {
    appSession.markUserStopped();  // instead of just markStopping()
}
```

The flag lives on the `AppSession` object in memory. It does NOT need to be
persisted to the database — if the cloud process restarts, all `AppSession`
objects are gone and the app would need a fresh `startApp()` webhook anyway
(which clears the flag). The in-memory flag is sufficient.

### Change 2: Reject reconnection for user-stopped apps

In `handleAppInit()` and `handleReconnect()`, check the flag before accepting
the connection:

```typescript
// At the top of handleAppInit() / handleReconnect()
const appSession = this.apps.get(packageName);
if (appSession?.wasUserStopped) {
    this.logger.info(
        { packageName, userId: this.userSession.userId },
        "Rejecting app reconnection — app was stopped by user",
    );

    ws.send(JSON.stringify({
        type: CloudToAppMessageType.RECONNECT_REJECTED,
        code: "USER_STOPPED",
        message: "App was stopped by user",
        timestamp: new Date(),
    }));
    ws.close(1000, "App was stopped by user");
    return;
}
```

The `RECONNECT_REJECTED` message is a new message type. Old SDKs will ignore it
(unknown message types are silently dropped). The important part is the
`ws.close()` — that's what actually prevents the app from running.

### Change 3: Clear the flag on explicit start

When the user launches the app again (via the phone app), `startApp()` fires.
The flag must be cleared so the app can connect:

```typescript
// In startApp(), before sending the webhook
const existingSession = this.apps.get(packageName);
if (existingSession?.wasUserStopped) {
    existingSession.clearUserStopped();
    this.logger.info(
        { packageName },
        "Cleared user-stopped flag — user is explicitly starting the app",
    );
}
```

---

## Backward Compatibility

| Scenario | SDK v2 (published) | SDK v3 (without fix) | SDK v3 (with fix) |
|----------|-------------------|---------------------|-------------------|
| User stops app | SDK reconnects → cloud **REJECTS** (Layer 2) | SDK reconnects → cloud **REJECTS** (Layer 2) | SDK does NOT reconnect (Layer 1) + cloud would reject anyway (Layer 2) |
| Server restart | SDK reconnects → cloud **ACCEPTS** (not user-stopped) | SDK reconnects → cloud **ACCEPTS** | SDK reconnects → cloud **ACCEPTS** |
| Network blip | SDK reconnects → cloud **ACCEPTS** (grace period) | SDK reconnects → cloud **ACCEPTS** | SDK reconnects → cloud **ACCEPTS** |
| Cloud deploy | SDK reconnects → cloud **ACCEPTS** (fresh process, no flag) | SDK reconnects → cloud **ACCEPTS** | SDK reconnects → cloud **ACCEPTS** |
| App crash | SDK reconnects → cloud **ACCEPTS** (not user-stopped) | SDK reconnects → cloud **ACCEPTS** | SDK reconnects → cloud **ACCEPTS** |
| User starts app again | Cloud clears flag → webhook fires → app connects normally | Same | Same |

The key insight: the `userStopped` flag is ONLY set by the explicit user stop
action. Every other stop reason (crash, timeout, grace period, deploy) does NOT
set the flag. So reconnection works normally for everything except user stops.

---

## Why Both Layers Are Needed

**Layer 1 alone is not enough.** Old SDK versions (v2 and pre-fix v3) don't have
the fix. They will reconnect after user stop. The cloud must reject them.

**Layer 2 alone is not enough.** It works, but it's wasteful — the SDK
reconnects, establishes a WebSocket, sends an init message, and then gets
rejected. Layer 1 prevents the reconnection attempt entirely. No wasted
connections, no extra round trip, no log noise.

Together they provide defense in depth:

```
User taps Stop
│
├── Cloud sends APP_STOPPED to app
├── Cloud closes WebSocket
├── Cloud sets userStopped = true on AppSession
│
├── Layer 1 (SDK v3 with fix):
│   ├── APP_STOPPED handler calls _lifecycleManager.disconnect()
│   ├── explicitDisconnect = true
│   ├── onClose sees permanent = true
│   └── Does NOT reconnect ← STOPPED HERE
│
├── Layer 1 fails (SDK v2 / old v3):
│   ├── APP_STOPPED handler only emits event
│   ├── explicitDisconnect = false
│   ├── onClose sees permanent = false
│   └── scheduleReconnect() fires
│       │
│       ├── Layer 2 (Cloud):
│       │   ├── SDK reconnects, sends APP_INIT
│       │   ├── Cloud checks: appSession.wasUserStopped? → true
│       │   ├── Sends RECONNECT_REJECTED
│       │   └── Closes WebSocket ← STOPPED HERE
│       │
│       └── SDK sees close, may retry once more
│           └── Cloud rejects again ← STOPPED HERE
```

After 1–2 rejections, the SDK's exponential backoff and max-retry limit kick in.
The app gives up.

---

## Files to Change

| File | Change | Layer |
|------|--------|-------|
| `sdk/src/session/MentraSession.ts` | Call `disconnect()` on APP_STOPPED | Layer 1 (**DONE**) |
| `cloud/src/services/session/AppSession.ts` | Add `userStopped` flag, `markUserStopped()`, `wasUserStopped`, `clearUserStopped()` | Layer 2 |
| `cloud/src/services/session/AppManager.ts` → `stopApp()` | Call `markUserStopped()` for user-initiated stops | Layer 2 |
| `cloud/src/services/session/AppManager.ts` → `handleAppInit()` | Reject if `wasUserStopped` | Layer 2 |
| `cloud/src/services/session/AppManager.ts` → `handleReconnect()` | Reject if `wasUserStopped` | Layer 2 |
| `cloud/src/services/session/AppManager.ts` → `startApp()` | Clear `userStopped` on explicit start | Layer 2 |

## Files NOT Changed

| File | Why |
|------|-----|
| `sdk/src/session/internal/_ConnectionManager.ts` | No changes needed — the `explicitDisconnect` mechanism already works, we just need to set it |
| Database / MongoDB | The flag is in-memory only — no persistence needed |
| Message type definitions | `RECONNECT_REJECTED` is new but old SDKs ignore unknown types |
| ASG client (glasses) | Not involved — this is an app↔cloud issue |

---

## Testing Plan

### 1. User stops app → app stays stopped

1. Start a mini app from the phone
2. Tap "Stop" in the phone app
3. Watch logs for 30 seconds
4. **Expected:** App stops, no reconnection attempts in logs (Layer 1)
5. **Expected:** If SDK is v2, reconnection attempt appears but is rejected (Layer 2)

### 2. User starts app after stopping → app starts normally

1. Stop app from phone (test 1)
2. Wait 5 seconds
3. Tap the app again in the phone app to start it
4. **Expected:** App starts normally, `userStopped` flag cleared

### 3. Server restart → app reconnects (NOT a user stop)

1. Start a mini app, verify it's running
2. Ctrl+C the cloud server
3. Restart the cloud server
4. **Expected:** App reconnects automatically within grace period
5. **Expected:** `userStopped` flag is false (server restart = fresh process, no flag)

### 4. Network blip → app reconnects

1. Start a mini app, verify it's running
2. Simulate network blip (disconnect WiFi briefly, or kill the WebSocket)
3. Wait for SDK to reconnect (1–2 seconds)
4. **Expected:** App reconnects, session resumes, no rejection

### 5. Test with v2 SDK app

1. Deploy Layer 2 cloud fix
2. Run a v2 SDK mini app
3. Stop app from phone
4. Watch logs — SDK will attempt reconnection
5. **Expected:** Cloud rejects with `RECONNECT_REJECTED`, app does not restart

### Edge cases

- **Double stop:** User taps stop twice quickly → should not crash, second stop
  is a no-op (app already stopped)
- **Stop during grace period:** App is in TRANSPORT_DOWN, user taps stop →
  `userStopped` should be set, app should not resurrect when transport comes back
- **Stop then start rapidly:** User stops then immediately starts → `clearUserStopped()`
  fires, app starts normally

---

## Related Issues

| Issue | Relationship |
|-------|-------------|
| **085** — Orphaned stream cleanup | Stream lifecycle across disruptions — streams should die on user stop |
| **086** — SDK fast shutdown | Signal handling for clean SDK shutdown (different from user stop) |
| **087** — Dedup cache blocks reconnected apps | Reconnection issues — dedup cache must not block legitimate reconnects |
| **088** — ASG client silently drops START_STREAM | Same debugging session, different failure mode |