# System Confusion Points

This document catalogs confusing, unintuitive, or poorly-documented aspects of the SDK/Cloud session and subscription system discovered during the investigation of bugs 005-007.

## Purpose

When making changes to fix the subscription timing bug, we need to be aware of these confusion points to avoid introducing regressions. This serves as a reference for anyone working on this system.

---

## 1. Multiple "Session" Concepts

### The Problem

The word "session" is overloaded across the codebase:

| Term          | Location     | What It Actually Is                                             |
| ------------- | ------------ | --------------------------------------------------------------- |
| `UserSession` | Cloud        | Per-user session on a specific cloud instance                   |
| `AppSession`  | SDK          | Per-user-per-app connection from app server to cloud            |
| `UserSession` | Captions App | Per-user state within the Captions app (different class!)       |
| `sessionId`   | Everywhere   | `userId + "-" + packageName` (NOT unique per session instance!) |

### Why It's Confusing

- A developer might think `sessionId` uniquely identifies a session, but it's deterministic and reused
- Two completely different `UserSession` classes exist (cloud vs Captions app)
- The SDK's `AppSession` is not the same as the cloud's concept of an app session

### Impact

- Cross-environment bugs occur because the same `sessionId` is used for different actual sessions
- Easy to look up the wrong session when using `sessionId` as a key

---

## 2. Where State Lives is Scattered

### The Problem

App session state is spread across multiple managers with no single source of truth:

```
Cloud UserSession
├── runningApps: Set<string>           // Package names of running apps
├── loadingApps: Set<string>           // Package names being started
├── appWebsockets: Map<string, WebSocket>  // Active WebSocket connections
│
├── AppManager
│   ├── connectionStates: Map<string, AppConnectionState>  // RUNNING, GRACE_PERIOD, etc.
│   ├── pendingConnections: Map<string, PendingConnection>
│   ├── heartbeatIntervals: Map<string, NodeJS.Timeout>
│   └── appStartTimes: Map<string, number>
│
└── SubscriptionManager
    ├── subscriptions: Map<string, Set<ExtendedStreamType>>  // Per-app subscriptions
    ├── lastAppReconnectAt: Map<string, number>  // For grace window
    ├── appsWithPCM: Set<string>
    └── appsWithTranscription: Set<string>
```

### Why It's Confusing

- To understand if an app is "really running", you need to check multiple places
- Different managers can have inconsistent state
- No transactional updates across managers

### Impact

- Race conditions between managers
- Hard to debug state inconsistencies
- Easy to update one manager but forget another

---

## 3. Two Connection Paths (JWT vs CONNECTION_INIT)

### The Problem

Apps can connect to the cloud via two different authentication paths:

```typescript
// Path 1: JWT token in WebSocket URL (new SDK)
if (appJwtPayload) {
  await userSession.appManager.handleAppInit(ws, initMessage)
  userSession.subscriptionManager.markAppReconnected(appJwtPayload.packageName)
}

// Path 2: CONNECTION_INIT message (old SDK)
if (message.type === AppToCloudMessageType.CONNECTION_INIT) {
  await userSession.appManager.handleAppInit(ws, initMessage)
  userSession.subscriptionManager.markAppReconnected(initMessage.packageName)
}
```

### Why It's Confusing

- Two code paths to maintain
- Easy to fix a bug in one path but not the other
- Different timing characteristics (JWT parsed before WS open vs after)

### Impact

- The `markAppReconnected` timing issue might affect one path differently than the other
- Testing needs to cover both paths

---

## 4. Webhook vs Auto-Reconnect Creates Different State

### The Problem

When an app connects to the cloud, it can happen via:

1. **Webhook-triggered**: Cloud calls app server webhook → app server creates NEW `AppSession` → connects
2. **Auto-reconnect**: Existing `AppSession` reconnects after WebSocket closure

These create very different state:

| Aspect               | Webhook-triggered         | Auto-reconnect               |
| -------------------- | ------------------------- | ---------------------------- |
| AppSession object    | NEW (empty subscriptions) | EXISTING (has subscriptions) |
| `onSession()` called | Yes                       | No                           |
| Handlers set up      | Yes (in onSession)        | Already set up               |
| Subscriptions        | Empty → set in onSession  | Preserved                    |

### Why It's Confusing

- The cloud can't easily tell which type of connection it's receiving
- The SDK sends subscriptions in both cases, but with different contents
- A "reconnect" from cloud's perspective might be a "new session" from SDK's perspective

### Impact

- The empty subscriptions bug (007) occurs because webhook-triggered connections send empty subscriptions before onSession runs
- Grace window logic assumes auto-reconnect but gets webhook-triggered connections

---

## 5. Order of Operations in connect() vs onSession()

### The Problem

```typescript
// AppServer.handleSessionRequest()
await session.connect(sessionId);        // Sends subscriptions to cloud!
await this.onSession(session, ...);      // App sets up subscriptions here
```

The SDK sends subscriptions during `connect()`, but apps set up subscriptions in `onSession()` which runs AFTER.

### Why It's Confusing

- Intuition says "set up first, then connect"
- The actual order is "connect first, set up second, then re-send"
- Initial connection works by accident (empty → actual subscriptions)

### Impact

- Bug 007: Empty subscriptions sent before app has a chance to subscribe
- Any resurrection or re-webhook causes momentary subscription loss

---

## 6. EventManager.onTranscriptionForLanguage Auto-Cleanup

### The Problem

```typescript
onTranscriptionForLanguage(language, handler, options) {
  this.lastLanguageTranscriptioCleanupHandler()  // ← Calls PREVIOUS cleanup!
  // ...
  this.lastLanguageTranscriptioCleanupHandler = this.addHandler(streamType, handler)
  return this.lastLanguageTranscriptioCleanupHandler
}
```

Calling `onTranscriptionForLanguage` automatically cleans up the previous handler.

### Why It's Confusing

- Not documented that this is "single handler only"
- Calling it twice doesn't add two handlers, it replaces
- The cleanup is implicit, not explicit

### Impact

- If an app accidentally calls `onTranscriptionForLanguage` twice, first subscription is lost
- Different from other `on*` methods which can have multiple handlers

---

## 7. Three Different Grace Periods

### The Problem

There are multiple grace periods in the system:

| Grace Period        | Duration   | Location                                 | Purpose                                             |
| ------------------- | ---------- | ---------------------------------------- | --------------------------------------------------- |
| Cloud UserSession   | 60 seconds | `UserSession.dispose()`                  | Wait for user to reconnect after glasses disconnect |
| Cloud App Reconnect | 5 seconds  | `AppManager.handleAppConnectionClosed()` | Wait for app to reconnect after WebSocket close     |
| Subscription Grace  | 8 seconds  | `SubscriptionManager.CONNECT_GRACE_MS`   | Ignore empty subscriptions after reconnect          |

### Why It's Confusing

- Different timeouts for different things
- They interact in non-obvious ways
- Hard to reason about what happens when one expires but another hasn't

### Impact

- App reconnect (5s) is shorter than subscription grace (8s) - is that intentional?
- UserSession grace (60s) can trigger resurrection which creates new AppSession

---

## 8. Resurrection vs Reconnection

### The Problem

Two different recovery mechanisms exist:

**Reconnection** (SDK-side):

- SDK detects WebSocket close
- SDK auto-reconnects using existing AppSession
- Subscriptions should be preserved

**Resurrection** (Cloud-side):

- Cloud detects app WebSocket close
- After 5-second grace period, cloud calls `stopApp()` then `startApp()`
- `startApp()` sends NEW webhook
- Creates NEW AppSession with empty subscriptions

### Why It's Confusing

- Both are trying to recover the app connection
- They can race against each other
- Resurrection destroys state that reconnection tries to preserve

### Impact

- If SDK reconnection takes > 5 seconds, resurrection kicks in and creates new AppSession
- The "fix" (resurrection) makes the problem worse (loses subscriptions)

---

## 9. Static Maps in Captions UserSession

### The Problem

```typescript
// Captions app UserSession
class UserSession {
  static readonly userSessions: Map<string, UserSession> = new Map()

  constructor(appSession: AppSession) {
    UserSession.userSessions.set(this.userId, this) // ← Overwrites!
  }
}
```

The Captions app stores UserSessions by userId in a static map. New sessions overwrite old ones.

### Why It's Confusing

- Old UserSession still exists (not garbage collected if referenced elsewhere)
- No explicit cleanup of old session
- Two UserSessions can exist for same user temporarily

### Impact

- Environment switch creates new UserSession, orphans old one
- Old AppSession's handlers might still reference old UserSession
- Memory leak potential

---

## 10. Subscription Update Serialization

### The Problem

```typescript
// SubscriptionManager.updateSubscriptions()
const previous = this.updateChainsByApp.get(packageName) || Promise.resolve()
const chained = previous.then(async () => {
  // ... do update ...
})
this.updateChainsByApp.set(packageName, chained)
await chained
```

Subscription updates are serialized per-app using promise chaining.

### Why It's Confusing

- Not obvious from the API that updates are queued
- Errors in the chain need careful handling
- The grace window check happens inside the chained promise, not before

### Impact

- If two updates arrive quickly, second waits for first
- Grace window timing might be affected by queue wait time

---

## 11. `runningApps` in DB vs Memory

### The Problem

```typescript
// Cloud UserSession
public runningApps: Set<string>  // In-memory

// Database (User model)
user.runningApps  // Persisted
```

The same concept exists in two places with different lifecycles.

### Why It's Confusing

- DB `runningApps` is "desired state" (what should run on reconnect)
- Memory `runningApps` is "current state" (what's actually running)
- They can be out of sync

### Impact

- After cloud restart, DB says app should run but memory doesn't have it
- `startPreviouslyRunningApps()` tries to reconcile but adds complexity

---

## 12. WebSocket Close Codes and Their Meanings

### The Problem

Different close codes trigger different behavior:

```typescript
const isNormalClosure = code === 1000 || code === 1001 || code === 1008
const isManualStop = reason && reason.includes("App stopped")
const isUserSessionEnded = reason && reason.includes("User session ended")
```

### Why It's Confusing

- 1006 (abnormal) triggers reconnection
- 1000 (normal) doesn't trigger reconnection
- But 1000 with "App stopped" reason has special handling
- 1008 is treated as "normal" (usually auth error, but here means session ended)

### Impact

- Hard to know what close code to send for what situation
- Reconnection behavior depends on close code interpretation

---

## Recommendations

1. **Create a glossary** of session-related terms with precise definitions
2. **Consolidate state** into a single AppSession class on the cloud
3. **Document the connection flow** with sequence diagrams
4. **Add state machine diagrams** for app lifecycle
5. **Unify grace periods** or document why they differ
6. **Add integration tests** that cover the confusing edge cases
7. **Add logging** at state transitions to aid debugging

---

## Files Most Affected by Confusion

| File                                                             | Confusion Points |
| ---------------------------------------------------------------- | ---------------- |
| `packages/cloud/src/services/session/AppManager.ts`              | 2, 4, 7, 8       |
| `packages/cloud/src/services/session/SubscriptionManager.ts`     | 2, 7, 10         |
| `packages/cloud/src/services/session/UserSession.ts`             | 1, 2, 11         |
| `packages/sdk/src/app/server/index.ts`                           | 1, 4, 5          |
| `packages/sdk/src/app/session/index.ts`                          | 1, 4, 5, 12      |
| `packages/sdk/src/app/session/events.ts`                         | 6                |
| `packages/apps/captions/src/app/session/UserSession.ts`          | 1, 9             |
| `packages/cloud/src/services/websocket/websocket-app.service.ts` | 3, 4             |
