# 087 — Managed Stream Status Not Delivered on App Reconnect

## Spec & Design Doc

**Date:** April 5, 2026
**Author:** Isaiah, with Claude
**Status:** Ready to implement
**Prerequisite:** None — this fix stands alone
**Related:** Issue 085 (orphaned stream lifecycle), Issue 084 (app not running race)

---

## Problem Statement

When a mini app disconnects and reconnects (server restart, deploy, `bun --watch`
reload, crash recovery), the cloud does not deliver managed stream status to the
new connection. The app's `startStream()` call hangs for 30 seconds and times out.
The only recovery is restarting the glasses.

---

## Previous Behavior (Current — Broken)

### What happens today

```
1. App starts managed stream            → cloud provisions Cloudflare → works
2. App disconnects (Ctrl+C, crash)      → cloud keeps stream alive (correct)
3. App reconnects                       → new WebSocket, same UserSession
4. App sends MANAGED_STREAM_REQUEST     → cloud finds existing stream
5. Cloud calls sendManagedStreamStatus()
   → dedup cache: "I already sent this"  → SKIPS sending
6. SDK waits for managed_stream_status  → never arrives → 30s timeout
7. User sees: "Managed stream request timeout"
8. Glasses stuck streaming, LED on, no recovery without reboot
```

### Why it's broken

`ManagedStreamingExtension.sendManagedStreamStatus()` maintains a
`lastSentStatus` deduplication map keyed by `${streamId}:${packageName}`.
The map lives on the `UserSession`, which survives app reconnects. When
the app reconnects and requests the same stream, every field matches the
cached entry, so the status is silently skipped.

The dedup cache was designed to prevent spamming the app during normal
streaming (e.g., duplicate Cloudflare webhooks). It does not account for
the case where the app is a **new connection that has never received any
status**.

### Code location

`cloud/packages/cloud/src/services/streaming/ManagedStreamingExtension.ts`,
`sendManagedStreamStatus()`, around line 1120:

```typescript
const statusKey = `${streamId}:${packageName}`
const lastStatus = this.lastSentStatus.get(statusKey)

if (lastStatus) {
  const isDuplicate =
    lastStatus.status === statusMessage.status &&
    lastStatus.hlsUrl === statusMessage.hlsUrl &&
    lastStatus.dashUrl === statusMessage.dashUrl &&
    lastStatus.webrtcUrl === statusMessage.webrtcUrl &&
    lastStatus.message === statusMessage.message &&
    JSON.stringify(lastStatus.outputs) === JSON.stringify(statusMessage.outputs)

  if (isDuplicate) {
    this.logger.debug("Skipping duplicate managed stream status")
    return // ← SDK never gets the message, promise times out
  }
}
```

---

## Desired Behavior

### Core principle

**Every new app connection must receive the current stream state.** The
deduplication cache exists to reduce noise during a single connection's
lifetime. It must not suppress delivery across connections.

### What should happen

```
1. App starts managed stream            → works (no change)
2. App disconnects                      → stream stays alive (no change)
3. App reconnects                       → new WebSocket, same UserSession
4a. Cloud detects reconnect             → clears dedup cache for this app
4b. Cloud proactively sends stream state → managed_stream_status with full URLs
5. SDK's onStreamStatus fires           → app learns about active stream
6. App can display stream, stop it, or start a new one
```

Two independent mechanisms, either of which solves the problem:

- **4a (reactive):** When the app sends `MANAGED_STREAM_REQUEST` and the
  cloud finds an existing stream, the dedup cache must not block delivery.
- **4b (proactive):** When an app connects (fresh or resurrected), the cloud
  sends active stream state immediately after `CONNECTION_ACK`, before the
  app even asks. (This is the 085 spec's `deliverActiveStreamState()`.)

Both should be implemented. 4a is the bug fix. 4b is the UX improvement.

### Backward compatibility

All changes use existing message types (`managed_stream_status`,
`stream_status`, `rtmp_stream_status`). Every SDK version already handles
these. No new message types, no protocol changes, no client-side updates
required.

---

## Proposed Solution

### Fix 1: Clear dedup cache on app reconnect

**Where:** `AppManager.attachAppSocket()` — right after sending `CONNECTION_ACK`

**What:** Clear `lastSentStatus` entries for the connecting app's package name
so that subsequent `sendManagedStreamStatus()` calls are not suppressed.

```typescript
// In AppManager.attachAppSocket(), after sending CONNECTION_ACK:

ws.send(JSON.stringify(ackMessage))
metricsService.incrementMiniappMessagesOut()
this.userSession.deviceManager.sendFullStateSnapshot(ws)

// Clear dedup cache for this app — new connection, new slate.
// Without this, sendManagedStreamStatus() skips delivery because
// lastSentStatus still has the entry from the previous connection.
// See: cloud/issues/087
this.userSession.managedStreamingExtension.clearLastSentStatus(packageName)
```

**New method on `ManagedStreamingExtension`:**

```typescript
/**
 * Clear the deduplication cache for a specific app.
 * Must be called when an app reconnects so that stream status
 * is delivered fresh to the new connection.
 *
 * See: cloud/issues/087-managed-stream-status-not-delivered-on-reconnect
 */
clearLastSentStatus(packageName: string): void {
  for (const key of this.lastSentStatus.keys()) {
    if (key.endsWith(`:${packageName}`)) {
      this.lastSentStatus.delete(key);
    }
  }
}
```

This is the minimal, surgical fix. It doesn't change the dedup logic itself —
it just ensures the cache is fresh for each connection.

### Fix 2: Proactive stream state delivery on connect

**Where:** `AppManager.attachAppSocket()` — after clearing the dedup cache

**What:** Check for active streams and send their status immediately, so the
app doesn't need to call `startStream()` or `checkExistingStream()` to learn
about them.

```typescript
// In AppManager.attachAppSocket(), after clearing dedup cache:

this.deliverActiveStreamState(packageName, ws)
```

See the full `deliverActiveStreamState()` implementation in the
[085 spec](../085-orphaned-stream-cleanup/spec.md). It checks both
`managedStreamingExtension` and `unmanagedStreamingExtension` for active
streams and sends the appropriate status messages.

This is the UX improvement. Even without it, Fix 1 alone resolves the
timeout bug (the app can call `startStream()` and the dedup cache won't
block delivery). But with it, the app receives stream state automatically
on connect — zero developer code required.

### Fix 3: Guard status relay for TRANSPORT_DOWN apps

**Where:** The code path that relays stream status messages to app WebSockets

**What:** When the cloud tries to send a stream status message to an app
whose transport is down (WebSocket disconnected, grace period active), drop
the message instead of triggering `handleAppConnectionClosed`.

```typescript
if (appSession.transportState === "down") {
  this.logger.debug({packageName, streamId}, "Skipping stream status relay — app transport is down")
  return
}
```

This prevents the reconnection storm described in the 085 spike. The dedup
cache clear (Fix 1) and proactive delivery (Fix 2) ensure the app gets
the status when it reconnects.

---

## Files to Change

| File                                  | Change                                              | Risk                                           |
| ------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| `ManagedStreamingExtension.ts`        | Add `clearLastSentStatus(packageName)` method       | Low — new method, no existing behavior changed |
| `AppManager.ts` → `attachAppSocket()` | Call `clearLastSentStatus()` after `CONNECTION_ACK` | Low — additive, runs after existing code       |
| `AppManager.ts` → `attachAppSocket()` | Call `deliverActiveStreamState()` (from 085 spec)   | Low — sends existing message types             |
| `AppManager.ts` or relay path         | Guard status relay for `TRANSPORT_DOWN`             | Low — changes error to silent drop             |

## Files NOT Changed

| File                                    | Why                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------- |
| SDK (`packages/sdk/`)                   | Existing handlers already process `managed_stream_status`               |
| Message type definitions                | No new types — using existing `managed_stream_status` / `stream_status` |
| ASG client (glasses)                    | Out of scope — separate release cycle                                   |
| `sendManagedStreamStatus()` dedup logic | Preserved as-is — the cache is useful during a connection's lifetime    |

---

## Why Not Just Remove the Dedup Cache?

The dedup cache serves a real purpose: during normal streaming, Cloudflare
webhooks and keep-alive cycles can trigger multiple `sendManagedStreamStatus()`
calls with identical content. Without dedup, the app would receive redundant
messages every 15 seconds. The cache prevents this noise.

The fix preserves the cache's value by scoping it correctly: clear on
reconnect, keep within a connection's lifetime. This is the narrowest change
that fixes the bug without introducing new problems.

---

## Why Not Fix It in the SDK Instead?

The SDK could work around this by:

- Listening for `websocket_error` and rejecting the pending promise
- Calling `checkExistingStream()` before `startStream()`
- Retrying `startStream()` on timeout

But these are all workarounds for a cloud bug. The cloud should deliver the
status when asked. Fixing it at the source is simpler, more reliable, and
benefits every SDK version (including v2 apps already published).

The stream-test app already has `checkExistingStream()` wired up as a
belt-and-suspenders fallback. It will continue to work and becomes
redundant (but harmless) once this cloud fix ships.

---

## Testing Plan

### 1. Verify the fix (manual)

1. Start stream-test app, connect glasses, start managed stream
2. Verify stream is live (WebRTC player shows video)
3. Ctrl+C the app
4. Restart the app
5. **Expected:** App reconnects, receives `managed_stream_status` within
   2-3 seconds, UI shows "● Streaming" with correct URLs
6. Click "Stop Stream" — LED turns off, stream stops
7. Click "Start Stream" — new stream starts, video plays

### 2. Verify dedup still works (manual)

1. Start a managed stream, let it run for 60+ seconds
2. Watch cloud logs — `managed_stream_status` should NOT repeat every
   15 seconds (dedup still active within the connection)
3. Trigger a real status change (e.g., viewer joins/leaves)
4. **Expected:** Status IS sent (dedup correctly detects the change)

### 3. Verify backward compat (v2 SDK)

1. Deploy cloud fix to debug
2. Connect a v2 SDK app that uses `startManagedStream()`
3. Start stream, restart app, verify `onManagedStreamStatus` fires
4. **Expected:** Identical behavior — v2 handlers receive the status

### 4. Edge cases

| Case                                                                        | Expected                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| App reconnects, no active stream                                            | No extra messages, normal behavior                                                                                              |
| App reconnects, stream died during disconnect                               | Status delivered with stale URLs, WHEP returns 409, player shows error and gives up (already handled in WHEPClient retry limit) |
| Two apps streaming for same user                                            | Each gets their own stream state                                                                                                |
| App sends MANAGED_STREAM_REQUEST while already receiving proactive delivery | Dedup cache (now populated by proactive delivery) correctly deduplicates, no double message                                     |

---

## Sequence Diagram

### Before (broken)

```
App restarts → connects WebSocket → CONNECTION_ACK
    │
    ├── App calls startStream()
    │   └── SDK sends MANAGED_STREAM_REQUEST
    │
    ├── Cloud: startManagedStream()
    │   ├── Found existing stream → createOrJoinManagedStream()
    │   └── sendManagedStreamStatus()
    │       ├── Dedup check: lastSentStatus has entry
    │       ├── All fields match → "Skipping duplicate"
    │       └── return (nothing sent)                        ← BUG
    │
    ├── SDK: waiting for managed_stream_status...
    │   └── 30 seconds pass → "Managed stream request timeout"
    │
    └── User: stuck, glasses LED still on, must restart glasses
```

### After (fixed)

```
App restarts → connects WebSocket → CONNECTION_ACK
    │
    ├── Cloud: clearLastSentStatus("dev.mentra.streamtest")  ← FIX 1
    │
    ├── Cloud: deliverActiveStreamState()                    ← FIX 2
    │   ├── Found active managed stream
    │   └── Sends managed_stream_status { status: "active", hlsUrl, webrtcUrl, ... }
    │
    ├── SDK: onStreamStatus fires
    │   └── App learns about existing stream immediately
    │
    ├── If app calls startStream() anyway:
    │   ├── SDK sends MANAGED_STREAM_REQUEST
    │   ├── Cloud: sendManagedStreamStatus()
    │   ├── Dedup check: cache was cleared → NOT a duplicate
    │   └── Sends managed_stream_status → SDK resolves promise
    │
    └── User: sees "● Streaming" with live video, can stop/restart
```
