# Cross-Environment App Subscription Contamination Spec

## Overview

When a user switches between backend environments (e.g., `cloud-dev` → `cloud-debug`), the old environment's session disposal causes apps to send unsubscribe messages that poison the new environment's state. This kills transcription/captions even though the app should still be running.

## Problem

### The Bug

1. User connects to `cloud-dev`, Captions app starts, subscribes to transcription
2. User switches to `cloud-debug`, new session created, Captions app connects there too
3. `cloud-dev` grace period (60s) expires, disposes session
4. `cloud-dev` sends WebSocket close (code 1000) to Captions app
5. Captions app responds by sending subscription update (unsubscribe from transcription)
6. **That unsubscribe goes to `cloud-debug`** (the active environment)
7. `cloud-debug` removes app from transcription subscribers
8. Soniox stream closes, mic turns off
9. User sees: app "running" but no captions

### Evidence Timeline (2025-12-10 00:36-00:37 UTC)

| Time         | Server      | Event                                                         |
| ------------ | ----------- | ------------------------------------------------------------- |
| 00:36:30     | cloud-debug | Transcription working: "Testing, testing, one, two, three..." |
| 00:36:32     | cloud-debug | Display requests successful                                   |
| 00:37:03.800 | cloud-dev   | Grace period expired                                          |
| 00:37:03.802 | cloud-dev   | WebSocket closed to `com.mentra.captions.beta` (code 1000)    |
| 00:37:03.824 | cloud-debug | Received subscription update from Captions app                |
| 00:37:03.843 | cloud-debug | `App removed from transcription set`                          |
| 00:37:03.844 | cloud-debug | `No active subscriptions - closing Soniox stream`             |
| 00:37:04.038 | cloud-debug | `Receiving unauthorized audio - forcing mic off`              |

### Root Cause

The app doesn't track which backend environment it's connected to. It maintains a single connection state and broadcasts subscription changes to whatever WebSocket is currently open.

```
App State:
  - subscriptions: [transcription]
  - websocket: connected (doesn't know to which env)

When ANY websocket closes:
  - App assumes it's disconnected
  - Sends unsubscribe to remaining connections
  - Other envs process the unsubscribe
```

## Constraints

- Apps are third-party code (Captions app runs on `captions-beta.mentraglass.com`)
- We can't easily change app behavior
- Multi-environment usage is common during development
- Grace period exists to handle brief disconnects (can't remove it)
- Environment switching is a valid user action

## Goals

1. Prevent cross-environment state contamination
2. App on env A shouldn't affect app state on env B
3. Graceful handling when user legitimately switches environments

## Non-Goals

- Preventing users from connecting to multiple environments (valid use case)
- Changing the grace period mechanism
- Rewriting third-party apps

## Proposed Solutions

### Option A: Environment-Scoped Session IDs

Include environment identifier in session/connection tracking. App messages are scoped to the environment that spawned them.

```
Before: sessionId = "user@example.com"
After:  sessionId = "user@example.com:debug"
```

**Pros**: Clean separation
**Cons**: Breaking change to session ID format, affects app connection logic

### Option B: Backend Validates Subscription Source

Backend tracks which WebSocket connection owns each subscription. Ignore subscription updates from "stale" connections.

```typescript
// In SubscriptionManager
if (message.connectionId !== app.activeConnectionId) {
  logger.warn("Ignoring subscription update from stale connection")
  return
}
```

**Pros**: No app changes needed
**Cons**: Need to track connection IDs through the stack

### Option C: App-Side Environment Awareness

Apps track which environment they're connected to and scope their state per-environment.

**Pros**: Cleanest long-term solution
**Cons**: Requires app changes, third-party apps won't update immediately

### Option D: Grace Period Sends Soft Close

Instead of closing WebSocket with code 1000, send a "session_ending" message first. App can choose to not react.

```typescript
// Before dispose
app.send({type: "session_ending", reason: "grace_period_expired"})
// Small delay
await sleep(100)
// Then close
```

**Pros**: Apps can handle gracefully
**Cons**: Doesn't prevent the root issue, just gives apps a hint

## Recommended Approach

**Option B (Backend Validates Subscription Source)** is the fastest fix:

1. Generate unique `connectionId` when app WebSocket connects
2. Store `connectionId` with each subscription
3. On subscription update, verify `connectionId` matches
4. Reject updates from mismatched connections

This requires no app changes and prevents the contamination at the source.

## Implementation Plan

### Phase 1: Add Connection ID Tracking

Files to modify:

- `packages/cloud/src/services/websocket/websocket-app.service.ts` - Generate connectionId
- `packages/cloud/src/services/session/subscription/SubscriptionManager.ts` - Track connectionId per subscription
- `packages/cloud/src/services/session/AppManager.ts` - Store activeConnectionId per app

### Phase 2: Validate Subscription Updates

```typescript
// In websocket-app.service.ts handleSubscriptionUpdate
const app = userSession.appManager.getApp(packageName)
if (app.activeConnectionId !== connectionId) {
  this.logger.warn(
    {
      packageName,
      expected: app.activeConnectionId,
      received: connectionId,
    },
    "Rejecting subscription update from stale connection",
  )
  return
}
```

### Phase 3: Add Logging/Metrics

Track when stale updates are rejected:

- How often does this happen?
- Which apps are affected?
- Are there legitimate cases we're breaking?

## Open Questions

1. **Should we notify the app when we reject a stale update?**
   - Probably not, could cause more confusion
   - **Decision**: Silent reject with logging

2. **What about other message types besides subscriptions?**
   - Display requests, settings changes, etc.
   - **Need to audit**: Which messages should be scoped to connectionId?

3. **Race condition on reconnect?**
   - App reconnects, gets new connectionId
   - Old subscription messages in flight get rejected
   - **Probably fine**: New connection will re-subscribe anyway

4. **Does this break legitimate app reconnection?**
   - App disconnects briefly, reconnects, sends subscription update
   - New connectionId won't match old subscriptions
   - **Need to verify**: Does app re-send subscriptions on reconnect?

## Related Issues

- `005-giga-lag/session-grace-period-bug/` - Similar environment-switching symptoms (RESOLVED as expected behavior)
- This issue proves it's NOT just expected behavior when it causes state corruption

## Testing

1. Connect user to env A, start Captions app
2. Switch user to env B (Captions app should work on B)
3. Wait for env A grace period to expire
4. Verify Captions still works on env B
5. Verify transcription still active
6. Verify mic doesn't turn off

## Key Files

- `packages/cloud/src/services/websocket/websocket-app.service.ts`
- `packages/cloud/src/services/session/subscription/SubscriptionManager.ts`
- `packages/cloud/src/services/session/AppManager.ts`
- `packages/cloud/src/services/websocket/websocket-glasses.service.ts` (grace period logic)
