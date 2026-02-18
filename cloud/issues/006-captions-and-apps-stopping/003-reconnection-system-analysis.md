# Reconnection System Analysis

## Overview

This document analyzes the app reconnection/resurrection system and identifies multiple failure modes that can cause apps to break.

## Current Reconnection Architecture

### App Lifecycle State Machine

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        App Connection States                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   startApp() called                                                     │
│        │                                                                │
│        ▼                                                                │
│   ┌─────────┐    webhook success    ┌─────────┐                        │
│   │ LOADING │ ───────────────────► │ RUNNING │                         │
│   └─────────┘    + WS connected     └────┬────┘                        │
│        │                                 │                              │
│        │ webhook fail                    │ WS closed unexpectedly       │
│        ▼                                 ▼                              │
│   ┌──────────────┐              ┌──────────────┐                       │
│   │ DISCONNECTED │              │ GRACE_PERIOD │  (5 seconds)          │
│   └──────────────┘              └──────┬───────┘                       │
│                                        │                                │
│                          ┌─────────────┴─────────────┐                 │
│                          │                           │                  │
│                    reconnected?                 not reconnected         │
│                          │                           │                  │
│                          ▼                           ▼                  │
│                    ┌─────────┐              ┌──────────────┐           │
│                    │ RUNNING │              │ RESURRECTING │           │
│                    └─────────┘              └──────┬───────┘           │
│                                                    │                    │
│                                          stopApp() + startApp()         │
│                                                    │                    │
│                                      ┌─────────────┴─────────────┐     │
│                                      │                           │      │
│                                 success                      failure    │
│                                      │                           │      │
│                                      ▼                           ▼      │
│                                ┌─────────┐              ┌──────────────┐│
│                                │ RUNNING │              │ DISCONNECTED ││
│                                └─────────┘              └──────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Code Locations

| Component           | File                                                         | Purpose                        |
| ------------------- | ------------------------------------------------------------ | ------------------------------ |
| AppManager          | `packages/cloud/src/services/session/AppManager.ts`          | Manages app lifecycle on cloud |
| AppServer           | `packages/sdk/src/app/server/index.ts`                       | Handles webhooks on app server |
| AppSession          | `packages/sdk/src/app/session/index.ts`                      | SDK-side session management    |
| SubscriptionManager | `packages/cloud/src/services/session/SubscriptionManager.ts` | Tracks app data subscriptions  |

### Reconnection Triggers

1. **SDK Auto-Reconnect**: When app's WebSocket closes abnormally (not code 1000/1001/1008), SDK attempts exponential backoff reconnection
2. **Cloud Grace Period**: When cloud detects app disconnect, waits 5 seconds for reconnection
3. **Cloud Resurrection**: If app doesn't reconnect within grace period, cloud calls `stopApp()` then `startApp()`

## Failure Modes Identified

### Failure Mode 1: Wrong Session Disposed (Environment Switch Bug)

**Documented in**: `session-lifecycle-bug.md`

**Trigger**: User switches between cloud environments (e.g., dev → debug)

**Flow**:

1. User on cloud-dev, captions app running
2. User switches to cloud-debug, new webhook sent
3. App server creates new session, overwrites old session in maps
4. Old session orphaned but WebSocket to cloud-dev still open
5. cloud-dev grace period expires, disposes session
6. `onStop()` called for old session, but looks up by userId
7. Returns NEW session (for cloud-debug), disposes it
8. Unsubscribes from NEW session's WebSocket to cloud-debug
9. cloud-debug sees unsubscribe, kills transcription

**Result**: App appears running but has no subscriptions

### Failure Mode 2: Webhook Unreachable During Resurrection

**Evidence from logs (2025-12-10 00:44)**:

```
00:44:25.427  App com.mentra.captions.beta unexpectedly disconnected (code: 1006)
00:44:30.427  Grace period expired, resurrection starting
00:44:30.517  Error triggering stop webhook
00:44:30.761  Triggering webhook for com.mentra.captions.beta
00:44:31.766  Webhook failed after 2 attempts
00:44:31.767  App connection state changed -> disconnected
```

**Trigger**: App server is down, unreachable, or crashed

**Flow**:

1. App disconnects with 1006 (abnormal closure)
2. Cloud waits 5 seconds, app doesn't reconnect
3. Cloud attempts resurrection: stopApp() + startApp()
4. Both webhooks fail (app server unreachable)
5. App moved to DISCONNECTED state
6. No further attempts made

**Result**: App permanently dead until user manually restarts

**Root Cause in This Case**: The earlier wrong-session disposal (Failure Mode 1) caused the app server's UserSession to be disposed, which likely crashed/broke the app server's ability to respond to new webhooks.

### Failure Mode 3: Subscription Loss Without WebSocket Close

**Trigger**: Spurious subscription update received (e.g., from wrong session)

**Flow**:

1. App running, WebSocket open, has subscriptions
2. Cloud receives subscription update with empty subscriptions
3. SubscriptionManager processes it, removes all subscriptions
4. TranscriptionManager stops Soniox stream
5. MicrophoneManager turns off mic
6. BUT: WebSocket still open, app still in `runningApps`
7. No resurrection triggered because WebSocket is fine

**Result**: App appears running but produces no output

**Evidence**: From 00:37:03 to 00:44:25 (7 minutes), captions app had no subscriptions but was still "running" with open WebSocket.

### Failure Mode 4: Race Condition in Session Replacement

**Trigger**: Rapid environment switches or reconnections

**Flow**:

1. Session A established
2. New webhook comes in, Session B created
3. Session A's cleanup events fire asynchronously
4. Events processed out of order
5. Session B's state corrupted by Session A's cleanup

**Risk Areas**:

- `activeSessions.set(sessionId, session)` overwrites without cleanup
- `activeSessionsByUserId.set(userId, session)` overwrites without cleanup
- Event handlers registered per-session but keyed by userId

### Failure Mode 5: Orphaned WebSocket Connections

**Trigger**: New session created without closing old session's WebSocket

**Flow**:

1. Session A has WebSocket to cloud-dev
2. Session B created, connects to cloud-debug
3. Session A's WebSocket remains open to cloud-dev
4. cloud-dev still thinks app is connected
5. cloud-dev eventually disposes, sends close
6. Close event fires on orphaned Session A
7. Handler incorrectly affects Session B

**Current Code Gap**:

```typescript
// In handleSessionRequest(), no cleanup of existing session:
const session = new AppSession({...});  // Creates new
this.activeSessions.set(sessionId, session);  // Overwrites old
// Old session's WebSocket still open!
```

## What the System Monitors vs. Doesn't Monitor

### Monitored (Triggers Recovery)

| Signal            | Detection           | Action                      |
| ----------------- | ------------------- | --------------------------- |
| WebSocket close   | `ws.on('close')`    | Grace period → Resurrection |
| Heartbeat timeout | (Not found in code) | Unknown                     |
| App crash         | Exit code detection | Unknown                     |

### NOT Monitored (Silent Failures)

| Signal                              | Issue                                          |
| ----------------------------------- | ---------------------------------------------- |
| Subscription state vs running state | App can be "running" with no subscriptions     |
| Transcription health                | Soniox can fail without app restart            |
| App producing output                | App can appear running but be dead             |
| Wrong session disposal              | No validation that disposed session is correct |

## Why Didn't cloud-debug Restart Captions?

In the original bug scenario, cloud-debug didn't restart captions because:

1. **WebSocket was still open**: The app's WebSocket to cloud-debug remained open
2. **App was still in `runningApps`**: Cloud thought app was running fine
3. **Only subscriptions were removed**: The unsubscribe only affected SubscriptionManager
4. **No health check**: No mechanism to detect "app running but broken"

The WebSocket only closed 7 minutes later (00:44:25) with code 1006, likely due to:

- The app server's UserSession being disposed (wrong one)
- The app server crashing or becoming unresponsive
- Some keep-alive timeout finally triggering

## Recommendations

### Short-term Fixes

1. **Validate session in `onStop`** (App side):

   ```typescript
   protected async onStop(sessionId: string, userId: string, reason: string) {
     const userSession = UserSession.getUserSession(userId)
     if (userSession?.appSession.sessionId === sessionId) {
       userSession.dispose()
     }
   }
   ```

2. **Clean up existing session before creating new** (SDK):

   ```typescript
   // In handleSessionRequest():
   const existing = this.activeSessions.get(sessionId)
   if (existing) {
     existing.disconnect()
     this.activeSessions.delete(sessionId)
   }
   ```

3. **Add subscription sanity check** (Cloud):
   ```typescript
   // When receiving empty subscriptions from a "running" app
   if (newSubscriptions.length === 0 && this.userSession.runningApps.has(packageName)) {
     this.logger.warn(`Running app ${packageName} sent empty subscriptions - suspicious`)
     // Consider: restart app, or at least log for debugging
   }
   ```

### Medium-term Fixes

1. **Unique session IDs**: Generate UUID per session instance, not userId+packageName
2. **Connection ID tracking**: Track which WebSocket connection owns which subscriptions
3. **Include origin in stop events**: Stop webhook includes `cloudServerId` to validate source

### Long-term Architecture

1. **Session health monitoring**: Periodic check that running apps are actually producing expected output
2. **Subscription-to-running consistency**: If app has no subscriptions for X seconds, consider it broken
3. **Explicit session lifecycle**: Session start/end events that apps must acknowledge
4. **Multi-environment awareness**: SDK tracks multiple connections, scopes state per environment

## Related Issues

- `session-lifecycle-bug.md` - The wrong session disposal bug
- `captions-stopping-spec.md` - Original problem analysis
- Issue 004: Apps not restarting on reconnection

## Test Scenarios Needed

1. **Environment switch recovery**: User switches env, old env disposes, app continues on new env
2. **Rapid reconnection**: WebSocket closes and reconnects within grace period
3. **Resurrection success**: App fails to reconnect, cloud successfully restarts it
4. **Resurrection failure**: App server down, cloud handles gracefully
5. **Subscription loss detection**: App loses subscriptions without WebSocket close
6. **Concurrent sessions**: Multiple environments try to run same app simultaneously
