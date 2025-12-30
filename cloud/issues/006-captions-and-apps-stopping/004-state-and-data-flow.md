# State and Data Flow Analysis

## Overview

This document maps out the current state management, data flows, and interconnections in the app lifecycle system. Understanding these is critical before making any fixes, as changes often have cascading effects.

## State Locations

### 1. In-Memory State (Per Cloud Server)

Each cloud server maintains its own in-memory state per UserSession:

```
UserSession (cloud server)
├── runningApps: Set<string>         // Apps currently running (source of truth for this server)
├── loadingApps: Set<string>         // Apps being started
├── appWebsockets: Map<string, WS>   // WebSocket connections to app servers
├── _reconnectionTimers: Map<string, Timer>  // Grace period timers
└── appConnectionStates: Map<string, State>  // LOADING, RUNNING, GRACE_PERIOD, etc.
```

### 2. Database State (Shared across all servers)

```
User Document (MongoDB)
├── runningApps: string[]            // "Desired state" - what apps SHOULD be running
├── appSettings: Map<string, any>    // Per-app user settings
└── augmentosSettings: object        // System-wide settings
```

**Important**: `user.runningApps` in DB is NOT the source of truth for what's actually running. It's the **desired state** used when a user connects to a new server.

### 3. App Server State (SDK)

```
AppServer (app server like captions-beta.mentraglass.com)
├── activeSessions: Map<sessionId, AppSession>      // Keyed by sessionId
└── activeSessionsByUserId: Map<userId, AppSession> // Keyed by userId (convenience lookup)

AppSession (SDK)
├── ws: WebSocket                    // Connection to cloud server
├── sessionId: string                // userId-packageName (NOT unique per instance!)
├── subscriptions: Set<StreamType>   // What data this session wants
└── reconnectAttempts: number        // For exponential backoff
```

### 4. App-Specific State (e.g., Captions App)

```
Captions App
└── UserSession.userSessions: Map<userId, UserSession>  // Keyed by userId (NOT sessionId!)
    └── UserSession
        ├── appSession: AppSession    // Reference to SDK session
        ├── transcriptionCleanup: () => void  // Cleanup function for subscriptions
        └── ...managers
```

## Key Data Flows

### Flow 1: User Connects to New Cloud Server

```
┌─────────────────────────────────────────────────────────────────────────┐
│ User connects to cloud-debug (phone WebSocket)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. GlassesWebSocketService receives connection                         │
│  2. Creates or finds UserSession for user                               │
│  3. UserSession.startPreviouslyRunningApps() called                     │
│  4. Reads user.runningApps from DB (desired state)                      │
│  5. For each app in DB:                                                 │
│     a. AppManager.startApp(packageName)                                 │
│     b. Triggers SESSION_REQUEST webhook to app server                   │
│     c. App server creates AppSession, connects WS back to cloud         │
│     d. handleAppInit() receives WS, adds to runningApps (in-memory)     │
│     e. user.addRunningApp() updates DB (may be redundant)               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Flow 2: App WebSocket Closes Unexpectedly

```
┌─────────────────────────────────────────────────────────────────────────┐
│ App WebSocket closes (code 1006 or similar)                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Cloud Side (AppManager.handleAppConnectionClosed):                     │
│  1. Removes from appWebsockets                                          │
│  2. Checks if state is STOPPING (if so, expected, return)               │
│  3. Even for code 1000/1001, continues to grace period                  │
│  4. Sets state to GRACE_PERIOD                                          │
│  5. Starts 5-second timer                                               │
│  6. If app reconnects within 5s: back to RUNNING                        │
│  7. If not: resurrection attempt (stopApp + startApp)                   │
│                                                                         │
│  App Server Side (SDK closeHandler):                                    │
│  1. Emits 'disconnected' event                                          │
│  2. If abnormal closure: attempts reconnection with backoff             │
│  3. If "User session ended": emits sessionEnded flag                    │
│  4. AppServer.cleanupDisconnect handler fires                           │
│  5. May call onStop() depending on flags                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Flow 3: stopApp() Called

```
┌─────────────────────────────────────────────────────────────────────────┐
│ AppManager.stopApp(packageName, restart?)                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. Check if app in runningApps or loadingApps (or restart=true)        │
│  2. Set state to STOPPING (or RESURRECTING if restart)                  │
│  3. Remove from runningApps (in-memory)                                 │
│  4. Remove from loadingApps                                             │
│  5. Trigger STOP webhook to app server                                  │
│  6. Remove subscriptions via SubscriptionManager                        │
│  7. Broadcast app state change to phone                                 │
│  8. Close WebSocket to app (send APP_STOPPED, then close 1000)          │
│  9. user.removeRunningApp() - UPDATE DB                                 │
│  10. Clean up display state                                             │
│  11. Clean up dashboard content                                         │
│  12. Track PostHog event                                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Flow 4: User Session Disposed (Grace Period Expired)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ UserSession.dispose() called (60s after user disconnects)               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  AppManager.dispose():                                                  │
│  1. Clear pending connections                                           │
│  2. Clear reconnection timers                                           │
│  3. Clear heartbeat intervals                                           │
│  4. Track PostHog app_stop events for all running apps                  │
│  5. For each app WebSocket:                                             │
│     a. Send APP_STOPPED message                                         │
│     b. Close WebSocket (1000, "User session ended")                     │
│  6. Clear appWebsockets map                                             │
│  7. Clear runningApps set                                               │
│  8. Clear loadingApps set                                               │
│                                                                         │
│  NOTE: Does NOT call user.removeRunningApp() - preserves DB state!      │
│  This allows apps to auto-start when user reconnects later.             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Critical Interconnections

### sessionId Format

```
sessionId = userId + "-" + packageName
         = "isaiah@mentra.glass-com.mentra.captions.beta"
```

**Problem**: This is deterministic, NOT unique per session instance. Multiple concurrent sessions (on different cloud servers) have the SAME sessionId.

### How State is Linked

```
┌─────────────────────┐     sessionId      ┌─────────────────────┐
│ Cloud Server        │◄──────────────────►│ App Server (SDK)    │
│ appWebsockets[pkg]  │     WebSocket      │ activeSessions[id]  │
│ runningApps.has(pkg)│                    │ activeSessionsBy... │
└─────────────────────┘                    └─────────────────────┘
         │                                          │
         │ user.addRunningApp(pkg)                  │ UserSession.set(userId)
         │ user.removeRunningApp(pkg)               │ (app-specific, e.g. Captions)
         ▼                                          ▼
┌─────────────────────┐                    ┌─────────────────────┐
│ MongoDB             │                    │ App UserSession     │
│ user.runningApps[]  │                    │ keyed by userId     │
└─────────────────────┘                    └─────────────────────┘
```

### Race Conditions and Conflicts

#### Scenario: User switches cloud-dev → cloud-debug

| Time     | cloud-dev                             | cloud-debug                   | App Server                              | MongoDB                   |
| -------- | ------------------------------------- | ----------------------------- | --------------------------------------- | ------------------------- |
| T0       | UserSession active, app running       | -                             | Session1 active                         | runningApps=[app]         |
| T1       | User disconnects, grace period starts | -                             | -                                       | runningApps=[app]         |
| T2       | -                                     | UserSession created           | -                                       | runningApps=[app]         |
| T3       | -                                     | startPreviouslyRunningApps()  | Webhook received                        | runningApps=[app]         |
| T4       | -                                     | App WS connected              | Session2 created, overwrites Session1   | addRunningApp (no-op)     |
| T5 (60s) | dispose(), close app WS               | -                             | Session1's close handler fires          | (no DB change in dispose) |
| T6       | -                                     | -                             | onStop() called, disposes WRONG session | -                         |
| T7       | -                                     | Receives spurious unsubscribe | Session2 unsubscribes                   | -                         |

#### Why `existing.disconnect()` is Dangerous

If we add `existing.disconnect()` in handleSessionRequest:

| Time | cloud-dev                       | cloud-debug       | App Server                                     | MongoDB               |
| ---- | ------------------------------- | ----------------- | ---------------------------------------------- | --------------------- |
| T0   | UserSession active, app running | -                 | Session1 active                                | runningApps=[app]     |
| T3   | -                               | Webhook triggers  | **existing.disconnect()** closes Session1's WS | runningApps=[app]     |
| T4   | Receives close (1000)           | -                 | -                                              | runningApps=[app]     |
| T5   | Grace period starts (5s)        | App WS connecting | Session2 created                               | runningApps=[app]     |
| T6   | -                               | App WS connected  | Session2 active                                | runningApps=[app]     |
| T10  | Resurrection: stopApp()         | -                 | -                                              | **removeRunningApp!** |
| T11  | Resurrection: startApp()        | -                 | **Webhook → Session3!**                        | addRunningApp         |

Now we have:

- cloud-debug thinks Session2 is active
- cloud-dev just created Session3
- App server has Session2 AND Session3 for same user
- Both clouds trying to manage the same app

## Subscription State

### SubscriptionManager State

```
SubscriptionManager (per UserSession)
├── subscriptions: Map<packageName, Set<StreamType>>  // What each app wants
├── updateChainsByApp: Map<packageName, Promise>      // Serializes updates per app
└── lastAppReconnectAt: Map<packageName, number>      // For grace window
```

### Subscription Update Flow

```
App sends SUBSCRIPTION_UPDATE message
    │
    ▼
websocket-app.service receives it
    │
    ▼
SubscriptionManager.updateSubscriptions(packageName, subscriptions)
    │
    ├─► Validates permissions
    ├─► Computes delta (added/removed)
    ├─► Updates subscriptions map
    ├─► Calls syncManagers() → updates TranscriptionManager, etc.
    └─► MicrophoneManager.handleSubscriptionChange()
```

### The Unsubscribe Problem

When a subscription update with empty subscriptions arrives:

1. `updateSubscriptions(pkg, [])` is called
2. All subscriptions for that app are removed
3. TranscriptionManager stops streams
4. MicrophoneManager turns off mic (if no other subscribers)
5. BUT: App is still "running" (in runningApps, WebSocket open)
6. No recovery triggered because WebSocket is fine

## Database as "Desired State"

### user.runningApps Purpose

```
user.runningApps is NOT "what's actually running"
user.runningApps IS "what SHOULD be running when user connects"
```

### When DB is Modified

| Operation                        | Modifies DB?           | Effect                  |
| -------------------------------- | ---------------------- | ----------------------- |
| App connects (handleAppInit)     | Yes (addRunningApp)    | Marks as desired        |
| App explicitly stopped (stopApp) | Yes (removeRunningApp) | Marks as not desired    |
| App times out during start       | Yes (removeRunningApp) | Marks as not desired    |
| User session disposed            | **NO**                 | Preserves desired state |
| App disconnects unexpectedly     | **NO**                 | Wants it to restart     |

### Implication for Fixes

Any fix that triggers `stopApp()` will modify the DB, potentially removing apps that should auto-restart.

## What Needs to Be Preserved

1. **DB desired state**: Don't remove from DB unless user explicitly stops app
2. **Cross-server continuity**: User switching servers should seamlessly continue
3. **Resurrection capability**: Crashed apps should restart
4. **Subscription integrity**: Subscriptions should match actual running state

## Risks of Various Fixes

### Fix: Clean up old session on new webhook

**Risk**: Old cloud's resurrection modifies DB, removes desired app.

### Fix: Validate sessionId in onStop

**Risk**: Need to track sessionId-to-AppSession mapping, currently not done.

### Fix: Generate unique sessionIds

**Risk**: Breaking change affecting session tracking, DB queries, reconnection logic.

### Fix: Connection ID for subscriptions

**Risk**: Complexity in tracking connection ownership across reconnections.

## Questions to Answer Before Fixing

1. Should `stopApp()` during resurrection modify the DB?
2. Should the app server track multiple sessions per user (one per cloud)?
3. How do we distinguish "user switched servers" from "app crashed"?
4. Should subscriptions be scoped to connection/session ID?
5. What's the desired behavior when two clouds try to run the same app?

## Related Files

| File                       | Purpose                     |
| -------------------------- | --------------------------- |
| `AppManager.ts`            | Cloud-side app lifecycle    |
| `UserSession.ts`           | Cloud-side user session     |
| `SubscriptionManager.ts`   | Subscription tracking       |
| `websocket-app.service.ts` | App WebSocket handling      |
| `sdk/app/server/index.ts`  | App server webhook handling |
| `sdk/app/session/index.ts` | SDK session management      |
| `user.model.ts`            | DB model with runningApps   |
