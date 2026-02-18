# Architecture Brainstorm: Holistic Redesign

## Why Redesign?

The current system has multiple interacting features that were built incrementally without considering each other:

1. **Subscription Management** - SDK maintains local subscription state, sends full list to cloud
2. **Reconnection** - SDK auto-reconnects after WebSocket drops
3. **Resurrection** - Cloud restarts apps via webhook after grace period (needed for app server crashes)
4. **Multi-Cloud** - Users can switch between cloud environments

These features interact in unexpected ways, causing cascading bugs:

- Subscriptions get lost on reconnect (005, 007)
- Wrong session gets disposed on env switch (002)
- Resurrection races with reconnection (no coordination)
- State is scattered across multiple managers

**The code is begging to be refactored.** Let's think about what that might look like.

---

## Core Problems to Solve

### 1. Identity Crisis

```
Current: sessionId = userId + "-" + packageName
         (deterministic, reused across sessions)

Problem: Can't distinguish between different session instances
         Two clouds think they have the "same" session
```

### 2. Scattered State on Cloud

```
Current:
  Cloud UserSession
  ├── runningApps, loadingApps (Sets)
  ├── appWebsockets (Map)
  ├── AppManager
  │   ├── connectionStates
  │   ├── pendingConnections
  │   └── heartbeatIntervals
  └── SubscriptionManager
      ├── subscriptions (Map<packageName, Set>)
      └── lastAppReconnectAt

Problem: No single source of truth for "is this app running and what does it need?"
```

### 3. Uncoordinated Recovery Mechanisms

```
SDK Reconnection:              Cloud Resurrection:
  WebSocket closes               WebSocket closes
  SDK waits (backoff)            Cloud waits (5s grace)
  SDK reconnects                 Cloud calls stopApp + startApp
  Same AppSession                NEW AppSession via webhook

Problem: They can race. No way for SDK to signal "I'm reconnecting, don't resurrect"
         No way for SDK to signal "I'm switching clouds, clean up"
```

### 4. Subscription Timing

```
Current flow:
  Webhook received
  → new AppSession() created (subscriptions = empty)
  → connect() called
  → CONNECTION_ACK received
  → updateSubscriptions() sends EMPTY subscriptions  ← Bug!
  → onSession() called
  → app subscribes to streams
  → updateSubscriptions() sends ACTUAL subscriptions  ← Too late?
```

### 5. Multi-Cloud Contamination

```
User on cloud-dev, Captions running
User switches to cloud-debug
  → cloud-debug sends webhook
  → App server creates NEW AppSession for debug
  → cloud-dev grace period expires
  → cloud-dev sends onStop webhook
  → App server disposes... which session?

Problem: No explicit ownership transfer
```

---

## When Resurrection is Needed

Resurrection is a **feature**, not a bug. It's needed when:

- App server crashes (loses all in-memory AppSessions)
- App server restarts during development
- SDK can't reconnect because the AppSession object no longer exists

**The problem isn't resurrection existing - it's that resurrection and reconnection aren't coordinated.**

### Two Different Scenarios

**Scenario A: Network hiccup (SDK reconnects)**

```
WebSocket drops (1006)
Same AppSession object exists in memory
SDK auto-reconnects in ~1-2 seconds
Subscriptions SHOULD be preserved
Cloud should NOT resurrect
```

**Scenario B: App server crash (needs resurrection)**

```
App server crashes
All AppSession objects lost
SDK CAN'T reconnect (no object exists)
Cloud SHOULD resurrect via webhook
New AppSession created, onSession called
```

---

## Design Principles

### Principle 1: userId is THE Key

- One AppSession per user on app server (enforced, not accidental)
- Transfer session on cloud switch, don't create duplicate

### Principle 2: Single Source of Truth

- Cloud owns subscription state (via AppSession class)
- SDK sends commands, cloud maintains authoritative state
- One class owns all state for an app connection

### Principle 3: Explicit Ownership Transfer

- When switching clouds, SDK signals clean handoff
- Cloud knows not to resurrect after clean handoff
- Distinguish crash (resurrect) from intentional disconnect (don't resurrect)

### Principle 4: Coordinated Recovery

- SDK reconnection and cloud resurrection work together
- OWNERSHIP_RELEASE signal coordinates handoffs
- Grace period only leads to resurrection if no signal received

---

## Proposed Architecture

### New Protocol Message: OWNERSHIP_RELEASE

```typescript
// App → Cloud (sent before intentional disconnect)
{
  type: "OWNERSHIP_RELEASE",
  reason: "switching_clouds" | "clean_shutdown" | "user_logout"
}
```

**Cloud behavior:**

- Receives `OWNERSHIP_RELEASE` → Clean up immediately, NO resurrection
- WebSocket closes WITHOUT `OWNERSHIP_RELEASE` → Start grace period → Resurrect if no reconnect

This distinguishes:

- **Clean handoff**: OWNERSHIP_RELEASE sent → no resurrection
- **Crash/network issue**: No OWNERSHIP_RELEASE → wait → resurrect if needed

### Cloud Side: AppSession Class in AppManager

```typescript
class UserSession {
  // ... existing fields ...
  appManager: AppManager
}

class AppManager {
  private userSession: UserSession

  // CONSOLIDATED STATE - single source of truth per app
  apps: Map<packageName, AppSession>

  // Methods delegate to AppSession instances
  async startApp(packageName: string): Promise<AppStartResult>
  async stopApp(packageName: string): Promise<void>
  async handleAppInit(ws: WebSocket, initMessage: AppConnectionInit): Promise<void>

  getAppSession(packageName: string): AppSession | undefined
}

// NEW CLASS - consolidates scattered state
class AppSession {
  readonly packageName: string
  readonly userSession: UserSession

  // All state in ONE place
  webSocket: WebSocket | null
  state: AppConnectionState // 'connecting' | 'running' | 'grace_period' | 'stopped'

  // SUBSCRIPTIONS OWNED BY CLOUD
  subscriptions: Set<ExtendedStreamType>

  // Timing
  connectedAt: Date | null
  disconnectedAt: Date | null
  heartbeatInterval: NodeJS.Timeout | null
  graceTimer: NodeJS.Timeout | null

  // Ownership tracking
  ownershipReleased: boolean = false

  // Connection handling
  handleConnect(ws: WebSocket): void {
    this.cancelGracePeriod()
    this.webSocket = ws
    this.state = "running"
    this.connectedAt = new Date()
    this.ownershipReleased = false
    this.setupHeartbeat()
    // Subscriptions already here from previous connection - don't need from SDK
  }

  handleDisconnect(code: number, reason: string): void {
    this.disconnectedAt = new Date()
    this.clearHeartbeat()

    if (this.ownershipReleased) {
      // Clean handoff - no resurrection
      this.state = "stopped"
      this.cleanup()
    } else {
      // Might be crash or network issue - start grace period
      this.state = "grace_period"
      this.startGracePeriod()
    }
  }

  handleOwnershipRelease(reason: string): void {
    this.ownershipReleased = true
    this.logger.info(`Ownership released: ${reason} - will not resurrect`)
  }

  // Subscription management - CLOUD IS SOURCE OF TRUTH
  updateSubscriptions(newSubs: ExtendedStreamType[]): void {
    const oldSubs = this.subscriptions
    this.subscriptions = new Set(newSubs)
    this.onSubscriptionsChanged(oldSubs, this.subscriptions)
  }

  addSubscription(stream: ExtendedStreamType): void {
    this.subscriptions.add(stream)
    this.onSubscriptionAdded(stream)
  }

  removeSubscription(stream: ExtendedStreamType): void {
    this.subscriptions.delete(stream)
    this.onSubscriptionRemoved(stream)
  }

  getSubscriptions(): ExtendedStreamType[] {
    return Array.from(this.subscriptions)
  }

  // Grace period handling
  private startGracePeriod(): void {
    this.graceTimer = setTimeout(() => {
      this.onGracePeriodExpired()
    }, 5000) // 5 second grace
  }

  private cancelGracePeriod(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  private onGracePeriodExpired(): void {
    if (this.state === "grace_period" && !this.ownershipReleased) {
      // No reconnect, no ownership release - trigger resurrection
      this.triggerResurrection()
    }
  }

  private triggerResurrection(): void {
    this.logger.info(`Grace period expired, triggering resurrection for ${this.packageName}`)
    // ... existing resurrection logic (webhook to app server)
  }
}
```

### SDK Side: One AppSession Per User + Ownership Transfer

```typescript
class AppServer {
  // ONE AppSession per user - ENFORCED
  private sessions: Map<userId, AppSession>

  async handleWebhook(request: WebhookRequest): Promise<void> {
    const {userId, cloudUrl, sessionId} = request

    const existing = this.sessions.get(userId)

    if (existing) {
      if (existing.getCloudUrl() !== cloudUrl) {
        // User switched clouds - TRANSFER ownership
        this.logger.info(`User ${userId} switching from ${existing.getCloudUrl()} to ${cloudUrl}`)
        await existing.transferToCloud(cloudUrl, sessionId)
      } else {
        // Same cloud - reconnection or resurrection after crash
        // AppSession handles reconnect internally
        await existing.handleReconnect(sessionId)
      }
      return res.status(200).json({status: "success"})
    }

    // New user - create session
    const session = new AppSession({
      packageName: this.config.packageName,
      apiKey: this.config.apiKey,
      cloudUrl,
      appServer: this,
      userId,
    })
    this.sessions.set(userId, session)
    await session.connect(sessionId)
    await this.onSession(session, sessionId, userId)

    return res.status(200).json({status: "success"})
  }

  async handleStopWebhook(request: StopWebhookRequest): Promise<void> {
    const {userId, reason} = request

    const session = this.sessions.get(userId)
    if (session) {
      await this.onStop(session.getSessionId(), userId, reason)
      session.disconnect()
      this.sessions.delete(userId)
    }
  }
}

class AppSession {
  private cloudUrl: string
  private sessionId: string

  // When switching clouds - EXPLICIT OWNERSHIP TRANSFER
  async transferToCloud(newCloudUrl: string, newSessionId: string): Promise<void> {
    this.logger.info(`Transferring ownership to ${newCloudUrl}`)

    // Signal clean handoff to old cloud - DON'T RESURRECT
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        type: AppToCloudMessageType.OWNERSHIP_RELEASE,
        reason: "switching_clouds",
        timestamp: new Date(),
      })
    }

    // Close old connection
    this.ws?.close(1000, "Ownership transferred")
    this.ws = null

    // Update to new cloud
    this.cloudUrl = newCloudUrl
    this.config.mentraOSWebsocketUrl = newCloudUrl

    // Connect to new cloud
    // Subscriptions are preserved in this.subscriptions
    await this.connect(newSessionId)
  }

  // When app server shuts down cleanly
  async shutdown(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        type: AppToCloudMessageType.OWNERSHIP_RELEASE,
        reason: "clean_shutdown",
        timestamp: new Date(),
      })
    }
    this.ws?.close(1000, "Clean shutdown")
  }

  getCloudUrl(): string {
    return this.cloudUrl
  }
}
```

---

## Flow Diagrams

### Flow 1: Cloud Switch (Clean Handoff)

```
1. User on cloud-dev, app running
2. User switches to cloud-debug
3. cloud-debug sends webhook to app server
4. App server: "I have AppSession for this user on cloud-dev"
5. App server sends OWNERSHIP_RELEASE to cloud-dev
6. App server closes connection to cloud-dev
7. cloud-dev receives OWNERSHIP_RELEASE
8. cloud-dev: "Clean handoff, not resurrecting"
9. cloud-dev cleans up AppSession state
10. App server updates AppSession to point to cloud-debug
11. App server connects to cloud-debug
12. Subscriptions preserved and sent to cloud-debug
```

### Flow 2: App Server Crash (Resurrection Needed)

```
1. User on cloud-dev, app running
2. App server crashes (no OWNERSHIP_RELEASE sent)
3. cloud-dev detects WebSocket close
4. cloud-dev: "No OWNERSHIP_RELEASE, starting grace period"
5. Grace period: 5 seconds
6. No reconnect, no OWNERSHIP_RELEASE received
7. cloud-dev: "Grace period expired, triggering resurrection"
8. cloud-dev sends webhook to app server
9. App server (restarted) receives webhook
10. App server: "No existing session for this user"
11. App server creates new AppSession
12. onSession called, app sets up subscriptions fresh
```

### Flow 3: Network Hiccup (SDK Reconnects)

```
1. User on cloud-dev, app running
2. WebSocket drops (1006) - no OWNERSHIP_RELEASE
3. cloud-dev: "No OWNERSHIP_RELEASE, starting grace period"
4. SDK: "Abnormal closure, attempting reconnection"
5. SDK waits 1 second (backoff)
6. SDK reconnects to cloud-dev
7. cloud-dev: "Reconnection received, canceling grace period"
8. AppSession.handleConnect() called
9. State: grace_period → running
10. Subscriptions: already in cloud AppSession, preserved
11. No resurrection needed
```

---

## State Machine: Cloud AppSession

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
┌──────────┐   handleConnect()   ┌─────────┐            │
│connecting│ ──────────────────► │ running │            │
└──────────┘                     └─────────┘            │
                                      │                  │
                                      │ handleDisconnect()
                                      │ (no OWNERSHIP_RELEASE)
                                      ▼                  │
                                ┌────────────┐           │
                                │grace_period│           │
                                └────────────┘           │
                                   │      │              │
                    reconnect      │      │ grace expired
                    received       │      │ (no reconnect)
                                   │      │              │
                    ┌──────────────┘      └──────────────┼───────┐
                    │                                    │       │
                    │                                    │       ▼
                    │                              ┌─────────┐  trigger
                    └─────────────────────────────►│ stopped │◄─resurrection
                                                   └─────────┘
                                                        ▲
                                                        │
                    handleDisconnect()                  │
                    (with OWNERSHIP_RELEASE) ───────────┘
```

---

## What This Fixes

| Problem                           | Solution                                                   |
| --------------------------------- | ---------------------------------------------------------- |
| Multiple AppSessions per user     | Enforce one per user, transfer on cloud switch             |
| Scattered state on cloud          | AppSession class owns all state (ws, state, subscriptions) |
| Wrong session disposed            | Explicit ownership transfer via OWNERSHIP_RELEASE          |
| Resurrection vs reconnection race | OWNERSHIP_RELEASE coordinates - clean handoff vs crash     |
| Empty subscriptions on reconnect  | Cloud owns subscriptions, doesn't need from SDK            |
| sessionId collision               | userId is session key, sessionId is just connection ID     |

---

## Subscription Management Changes

### Current: SDK Sends Full List

```typescript
// SDK maintains subscriptions locally
this.subscriptions.add(stream)
// Sends full list to cloud
this.send({
  type: "SUBSCRIPTION_UPDATE",
  subscriptions: Array.from(this.subscriptions), // Can be empty!
})
```

**Problem**: If SDK's local state is wrong (empty), cloud gets wrong state.

### Proposed: Cloud is Source of Truth

**Option A: Keep SUBSCRIPTION_UPDATE but cloud validates**

```typescript
// Cloud AppSession
updateSubscriptions(newSubs: ExtendedStreamType[]): void {
  // Ignore empty updates during grace period
  if (newSubs.length === 0 && this.state === 'grace_period') {
    this.logger.warn('Ignoring empty subscription update during grace period')
    return
  }
  this.subscriptions = new Set(newSubs)
}
```

**Option B: Additive commands (SUBSCRIBE/UNSUBSCRIBE)**

```typescript
// New protocol messages
{ type: 'SUBSCRIBE', stream: 'transcription:en-US' }
{ type: 'UNSUBSCRIBE', stream: 'transcription:en-US' }

// Cloud AppSession
addSubscription(stream): void {
  this.subscriptions.add(stream)
}
removeSubscription(stream): void {
  this.subscriptions.delete(stream)
}
```

**Option A is easier to implement**, keeps backward compatibility.
**Option B is cleaner**, eliminates "empty list" problem entirely.

**Recommendation**: Start with Option A (validation), migrate to Option B later.

---

## Migration Path

### Phase 1: Cloud AppSession Class

- Create AppSession class in AppManager
- Move state from scattered locations to AppSession
- Keep existing protocol, add validation
- AppManager.apps: Map<packageName, AppSession>

### Phase 2: OWNERSHIP_RELEASE Protocol

- Add OWNERSHIP_RELEASE message type
- Cloud handles it (sets ownershipReleased flag)
- SDK sends on cloud switch and clean shutdown

### Phase 3: SDK One-Session-Per-User

- Change AppServer.sessions to Map<userId, AppSession>
- Add transferToCloud() method
- Webhook handler checks for existing session

### Phase 4: Subscription Protocol (Optional)

- Add SUBSCRIBE/UNSUBSCRIBE messages
- Cloud supports both old and new
- SDK migrates to new commands
- Deprecate SUBSCRIPTION_UPDATE

---

## Files to Modify

### Cloud Side

| File                                          | Changes                                                        |
| --------------------------------------------- | -------------------------------------------------------------- |
| `services/session/AppManager.ts`              | Add `apps: Map<packageName, AppSession>`, refactor to delegate |
| `services/session/AppSession.ts`              | NEW FILE - consolidated state and methods                      |
| `services/session/SubscriptionManager.ts`     | Simplify - delegate to AppSession                              |
| `services/session/UserSession.ts`             | Minor - use appManager.apps                                    |
| `services/websocket/websocket-app.service.ts` | Handle OWNERSHIP_RELEASE message                               |

### SDK Side

| File                   | Changes                                               |
| ---------------------- | ----------------------------------------------------- |
| `app/server/index.ts`  | Change to Map<userId, AppSession>, add transfer logic |
| `app/session/index.ts` | Add transferToCloud(), shutdown(), OWNERSHIP_RELEASE  |
| Protocol types         | Add OWNERSHIP_RELEASE message type                    |

---

## Open Questions

### Q1: Grace period duration?

Currently 5 seconds for app reconnect. Is this enough?

**Suggestion**: Keep 5s for now, make configurable. SDK reconnects typically take 1-3 seconds.

### Q2: What about apps on both clouds simultaneously?

User has glasses connected to cloud-dev AND cloud-debug?

**Suggestion**: Not supported. User should be on one cloud at a time. Transfer is explicit switch.

### Q3: How does SubscriptionManager interact with new AppSession?

Currently SubscriptionManager has its own state.

**Suggestion**: SubscriptionManager becomes a thin coordinator that reads from AppSession.subscriptions. Or merge into AppSession entirely.

### Q4: Backward compatibility?

Old SDKs won't send OWNERSHIP_RELEASE.

**Suggestion**: That's fine - they'll get resurrection on cloud switch (current behavior). New SDKs get clean handoff.

---

## Next Steps

1. **Understand current SubscriptionManager usage** - Who reads/writes subscriptions?
2. **Design AppSession class interface** - What methods, what state?
3. **Implement Phase 1** - Cloud AppSession class
4. **Implement Phase 2** - OWNERSHIP_RELEASE protocol
5. **Implement Phase 3** - SDK one-session-per-user
6. **Test all flows** - Cloud switch, crash, reconnect
7. **Document new architecture** - For future developers

---

## How Redesign Addresses Each Bug

### Bug 1: Env Switch - Wrong Session Disposed (002) ✅ CLEARLY FIXED

**Current Problem:**

```
1. User on cloud-dev, Captions running (AppSession A)
2. User switches to cloud-debug
3. cloud-debug sends webhook → App server creates AppSession B
4. activeSessionsByUserId.set(userId, B)  // Overwrites A!
5. cloud-dev grace period expires → sends onStop webhook
6. App server: onStop looks up by userId → gets B (wrong one!)
7. B.dispose() called → Captions on cloud-debug breaks
```

**How Redesign Fixes It:**

```
1. User on cloud-dev, Captions running (single AppSession)
2. User switches to cloud-debug
3. cloud-debug sends webhook
4. App server: "Already have AppSession for this userId"
5. App server sends OWNERSHIP_RELEASE to cloud-dev
6. cloud-dev receives OWNERSHIP_RELEASE → cleans up, NO onStop webhook sent
7. App server transfers AppSession to cloud-debug
8. Single AppSession continues with subscriptions intact
```

**Why it works:**

- OWNERSHIP_RELEASE tells cloud-dev "don't send onStop, I'm intentionally leaving"
- One-session-per-user means no wrong session to dispose
- Transfer preserves subscriptions

---

### Bug 2: Empty Subscriptions on Reconnect (005/007) ✅ ROOT CAUSE FOUND

**Current Problem:**

```
1. App running, SDK this.subscriptions = ["transcription:en-US"]
2. WebSocket closes (1006)
3. SDK auto-reconnects (same AppSession object)
4. SDK sends SUBSCRIPTION_UPDATE with subscriptions = []  ← WHY EMPTY?
5. Cloud applies empty subscriptions
6. Transcription stops, mic turns off
```

**Root Cause (see 011-sdk-subscription-architecture-mismatch.md):**

The SDK stores subscriptions in TWO places that can drift:

- `EventManager.handlers` - developer's registered callbacks
- `AppSession.subscriptions` - internal Set sent to cloud

```typescript
// disconnect() clears subscriptions but NOT handlers!
async disconnect(): Promise<void> {
  this.subscriptions.clear()  // ← Cleared!
  // But EventManager.handlers still has the handlers!
}
```

If these drift out of sync, `updateSubscriptions()` sends the empty `this.subscriptions` Set even though handlers exist.

**The Fix (SDK-side):**

Derive subscriptions from handlers instead of storing separately:

```typescript
// EventManager
getRegisteredStreams(): ExtendedStreamType[] {
  return Array.from(this.handlers.keys())
}

// AppSession
private updateSubscriptions(): void {
  // DERIVE from handlers - single source of truth!
  const subs = this.events.getRegisteredStreams()
  this.send({ type: 'SUBSCRIPTION_UPDATE', subscriptions: subs })
}
```

**Why this works:**

- Subscriptions can NEVER be empty if handlers exist
- No separate Set to drift out of sync
- `disconnect()` can't break subscriptions (nothing to clear)
- Reconnection automatically sends correct subscriptions

**How Cloud Redesign Also Helps (Defense in Depth):**

1. **Cloud AppSession preserves subscriptions on disconnect:**
   - Even if SDK sends bad data, cloud has backup during grace period

2. **Cloud can validate/ignore suspicious updates:**
   - Ignore empty updates shortly after reconnect

---

### Summary of Bug Fix Coverage

| Bug                | Root Cause Known? | Redesign Fixes? | How                                           |
| ------------------ | ----------------- | --------------- | --------------------------------------------- |
| Bug 1 (Env Switch) | ✅ Yes            | ✅ Fully        | OWNERSHIP_RELEASE + one-session-per-user      |
| Bug 2 (Empty Subs) | ✅ Yes            | ✅ Fully        | SDK derives subscriptions from handlers (011) |

**Bug 2 Fix Implementation:**

1. Add `getRegisteredStreams()` to EventManager
2. Change `updateSubscriptions()` to derive from handlers
3. Remove `this.subscriptions` Set
4. Cloud redesign provides additional defense in depth

---

## Summary

The core insight: **these aren't separate bugs, they're symptoms of architectural mismatch.**

By redesigning with these principles:

- One AppSession per user (enforced)
- Cloud owns subscription state (AppSession class)
- Explicit ownership transfer (OWNERSHIP_RELEASE)
- Coordinated recovery (resurrection only when needed)

We can eliminate entire classes of bugs rather than playing whack-a-mole with symptoms.

**Bug 2's root cause is now known** (see 011): dual storage allows handlers and subscriptions to drift. The fix is to derive subscriptions from handlers, eliminating the drift. The cloud redesign provides additional defense in depth.
