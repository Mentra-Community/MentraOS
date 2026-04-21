# 089 — App Reconnects After User Explicitly Stops It

## Spike: Investigation & Findings

**Date:** April 6, 2026
**Author:** Isaiah, with Claude
**Status:** Root cause identified — two bugs (SDK + cloud)
**Affects:** All SDK versions (v2 and v3), all mini apps
**Related:** Issue 085 (orphaned streams), Issue 086 (SDK fast shutdown), Issue 087 (dedup cache), Issue 088 (ASG silent drop)

---

## Summary

When a user stops a mini app from the Mentra phone app, the app restarts within
2–3 seconds. The cloud correctly processes the stop — it sends `APP_STOPPED`,
closes the WebSocket, and removes the app from `runningApps`. But two bugs allow
the app to resurrect:

1. **SDK bug:** `_ConnectionManager` doesn't know about `APP_STOPPED`. It treats
   the WebSocket close as an unexpected disconnect and reconnects automatically.
2. **Cloud bug:** The cloud accepts the reconnection even though the app was
   explicitly user-stopped. There's no guard against it.

The result: users cannot stop mini apps. They keep coming back.

---

## How We Found It

A user tapped "Stop" on a mini app in the Mentra phone app. The app stopped
momentarily, then reappeared within 2–3 seconds. Repeatable every time. Checked
the logs and found the SDK was reconnecting immediately after the cloud closed
the connection.

---

## Evidence from Logs

### Terminal output from the mini app process

```
[14:17:12.640] INFO: MentraSession received app_stopped
    reason: "unknown"
[14:17:12.640] INFO: Session stopped for isaiahballah@gmail.com: unknown
[14:17:12.640] WARN: MentraSession transport closed; scheduling reconnect
    attempt: 1, delay: 1000
[14:17:13.933] WARN: MentraSession transport closed; scheduling reconnect
    attempt: 2, delay: 2000
[14:17:16.243] INFO: Session reconnected for isaiahballah@gmail.com
```

### What this tells us

| Timestamp | Event | Problem? |
|-----------|-------|----------|
| 14:17:12.640 | Cloud sends `APP_STOPPED` | ✅ Correct |
| 14:17:12.640 | SDK emits "stopped" event | ✅ Correct |
| 14:17:12.640 | SDK sees WebSocket close, schedules reconnect | ❌ **Bug 1** — should not reconnect |
| 14:17:13.933 | SDK reconnect attempt 2 | ❌ Still trying |
| 14:17:16.243 | SDK reconnects successfully | ❌ **Bug 2** — cloud should reject |

The stop fires correctly, but the SDK immediately reconnects and the cloud lets
it back in.

---

## Root Cause Analysis — TWO Bugs

### Bug 1 — SDK (`_ConnectionManager`)

**File:** `cloud/packages/sdk/src/session/internal/_ConnectionManager.ts`

The `onClose` handler in `_ConnectionManager` checks `this.explicitDisconnect`
to decide whether to reconnect. But `explicitDisconnect` is only set by
`disconnect()` — which is an SDK-initiated close. When the **cloud** closes the
WebSocket after `APP_STOPPED`, `explicitDisconnect` is still `false`.

The close handler sees `permanent = false` and calls `scheduleReconnect()`.

Meanwhile, the `APP_STOPPED` handler in `MentraSession.ts` only emits the
"stopped" event — it never tells `_ConnectionManager` to stop reconnecting:

```typescript
// MentraSession.ts line ~311 — BEFORE fix
register(CloudToAppMessageType.APP_STOPPED, (message) => {
    const reason = message.reason ?? "unknown";
    this.logger.info({ reason }, "MentraSession received app_stopped");
    this.emit("stopped", reason);  // ← emits event but doesn't prevent reconnect
});
```

The sequence:

1. Cloud sends `APP_STOPPED` message over WebSocket
2. `MentraSession` receives it, emits "stopped" event
3. Cloud closes the WebSocket
4. `_ConnectionManager.onClose` fires
5. `this.explicitDisconnect` is `false` (nobody set it)
6. `permanent` evaluates to `false`
7. `scheduleReconnect()` is called
8. SDK reconnects 1–2 seconds later

**The fix:** Call `this._lifecycleManager.disconnect()` before emitting the
stopped event. This sets `explicitDisconnect = true` on `_ConnectionManager`,
stops all timers, and closes the transport. The subsequent `onClose` sees
`permanent = true` and does NOT reconnect.

### Bug 2 — Cloud (`AppManager`)

**File:** `cloud/packages/cloud/src/services/session/AppManager.ts`

When the SDK reconnects 1–2 seconds after being stopped, the cloud's
`handleAppInit()` or `handleReconnect()` processes the new connection. The
`AppSession` is in `STOPPED` state and the app was removed from `runningApps`
in the database. But the cloud doesn't check for this — it creates a new
session and sends a webhook, effectively restarting the app.

The cloud should reject reconnection attempts for apps that were explicitly
stopped by the user. Currently there's no distinction in the `STOPPED` state
between "user stopped it" and "crashed/timed out."

The sequence:

1. User taps Stop → cloud calls `stopApp()` → `AppSession` marked STOPPED
2. Cloud sends `APP_STOPPED`, closes WebSocket, removes from `runningApps`
3. SDK reconnects (Bug 1)
4. Cloud receives new WebSocket connection for the app
5. `handleAppInit()` runs — no check for "was this app user-stopped?"
6. New `AppSession` created, webhook sent, app starts again
7. User sees the app come back to life

---

## Impact

| Impact | Severity |
|--------|----------|
| Users cannot stop mini apps — they keep coming back | **High** |
| Battery drain — unwanted apps keep running on glasses | **High** |
| Developer confusion — hard to test stop/start lifecycle | **Medium** |
| Affects ALL SDK versions (v2 and v3) since the cloud doesn't guard against it | **Wide blast radius** |

---

## Why Both Bugs Matter

Either bug alone would cause the problem. Both need to be fixed:

| Scenario | SDK fix only (Layer 1) | Cloud fix only (Layer 2) | Both fixes |
|----------|----------------------|------------------------|------------|
| v3 SDK (with fix) | ✅ SDK doesn't reconnect | ✅ Cloud would reject anyway | ✅ Double protection |
| v3 SDK (without fix) | ❌ SDK reconnects, cloud accepts | ✅ Cloud rejects | ✅ Cloud catches it |
| v2 SDK (published, can't patch) | ❌ SDK reconnects, cloud accepts | ✅ Cloud rejects | ✅ Cloud catches it |

The cloud fix (Layer 2) is essential for backward compatibility. Old SDK versions
that are already published and deployed will never get the SDK fix. The cloud
must be the final authority on whether a reconnection is allowed.

---

## Reproducing

### Steps

1. Start any mini app (connect glasses, run the app)
2. Open the Mentra phone app
3. Tap "Stop" on the running mini app
4. Watch the terminal output from the mini app process

### Expected

App stops. Terminal shows "stopped" event. No reconnection.

### Actual

App stops momentarily. Terminal shows "stopped" event, then reconnect attempts,
then "Session reconnected." App is running again within 2–3 seconds.

### Environment

- Any mini app using the SDK
- Any cloud instance (local, debug, prod)
- Any SDK version (v2 or v3)

---

## Related Issues

| Issue | Relationship |
|-------|-------------|
| **085** — Orphaned stream cleanup | Stream lifecycle across disruptions — same theme of things surviving when they shouldn't |
| **086** — SDK fast shutdown | Signal handling on shutdown — related to clean disconnect semantics |
| **087** — Dedup cache blocks reconnected apps | Different reconnection bug — dedup cache rejecting legitimate reconnects |
| **088** — ASG client silently drops START_STREAM | Another case where the system silently does the wrong thing |

---

## Next Steps

1. **SDK fix (Layer 1):** Already applied — call `disconnect()` on `APP_STOPPED` in `MentraSession.ts`
2. **Cloud fix (Layer 2):** Not yet implemented — design doc covers the approach (see `design.md`)
3. **Testing:** Need to verify both layers independently and together