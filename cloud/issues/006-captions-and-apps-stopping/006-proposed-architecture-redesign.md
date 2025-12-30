# Proposed Architecture Redesign

## Overview

This document captures the design discussions and proposed architectural changes to address the multiple failure modes identified in this issue. The goal is to create a more robust, less error-prone system for app session management.

## Current Problems Summary

1. **sessionId is not unique** - `userId-packageName` format means multiple cloud servers use the same sessionId
2. **State scattered across managers** - AppManager, SubscriptionManager, UserSession all hold related state
3. **No ownership concept** - When user switches clouds, no explicit handoff occurs
4. **Subscriptions not tied to sessions** - Any connection can modify subscriptions
5. **SDK auto-reconnect loses state** - Subscriptions can be lost during reconnection
6. **App servers track by userId** - Can't distinguish between sessions from different clouds

## Proposed Changes

### 1. sessionId Tied to UserSession Lifecycle

**Current**: `sessionId = userId + "-" + packageName` (deterministic, never unique)

**Proposed**: `sessionId = userSession.id` where `userSession.id` is a UUID generated when UserSession is created on the cloud.

```typescript
// Cloud: UserSession creation
class UserSession {
  readonly id: string;  // UUID, unique per instance

  constructor(userId: string) {
    this.id = crypto.randomUUID();
    this.userId = userId;
  }
}

// Webhook payload
{
  type: "SESSION_REQUEST",
  sessionId: userSession.id,  // UUID
  userId: "user@example.com",
  mentraOSWebsocketUrl: "wss://debug.cloud/app-ws"
}
```

**Benefits**:

- Each UserSession has unique identifier
- Different clouds = different sessionIds
- App server can track which cloud owns which session
- Reconnection within same UserSession uses same sessionId

**Note**: We decided NOT to append packageName to sessionId. The current `userId-packageName` pattern was a bad idea that we don't want to continue. The cloud already knows which app is which from WebSocket auth.

### 2. New AppSession Class on Cloud

**Current**: AppManager holds all state for all apps in Maps:

- `appWebsockets: Map<packageName, WebSocket>`
- `connectionStates: Map<packageName, State>`
- `heartbeatIntervals: Map<packageName, Timer>`
- SubscriptionManager holds `subscriptions: Map<packageName, Set>`

**Proposed**: Create a dedicated `AppSession` class that owns its own state:

```typescript
// packages/cloud/src/services/session/AppSession.ts

class AppSession {
  readonly packageName: string;
  readonly userSession: UserSession;

  // Own state (moved from AppManager)
  private ws: WebSocket | null = null;
  private connectionState: AppConnectionState = AppConnectionState.DISCONNECTED;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectionTimer: NodeJS.Timeout | null = null;
  private startTime: number | null = null;

  // Own subscriptions (moved from SubscriptionManager)
  private subscriptions: Set<ExtendedStreamType> = new Set();

  // Lifecycle
  async start(): Promise<AppStartResult> { ... }
  async stop(reason: string): Promise<void> { ... }

  // WebSocket management
  setWebSocket(ws: WebSocket): void { ... }

  // Subscription management
  updateSubscriptions(subs: SubscriptionRequest[]): void { ... }
  getSubscriptions(): Set<ExtendedStreamType> { ... }
  hasSubscription(type: ExtendedStreamType): boolean { ... }

  dispose(): void { ... }
}
```

**Simplified AppManager**:

```typescript
class AppManager {
  private appSessions: Map<string, AppSession> = new Map(); // keyed by packageName

  getAppSession(packageName: string): AppSession | undefined { ... }

  async startApp(packageName: string): Promise<AppStartResult> {
    let session = this.appSessions.get(packageName);
    if (!session) {
      session = new AppSession(packageName, this.userSession);
      this.appSessions.set(packageName, session);
    }
    return session.start();
  }
}
```

**Simplified SubscriptionManager**:

```typescript
class SubscriptionManager {
  // Now just aggregates from AppSessions
  hasPCMTranscriptionSubscriptions(): boolean {
    for (const session of this.userSession.appManager.getAllSessions()) {
      if (session.hasTranscriptionSubscription()) return true
    }
    return false
  }
}
```

**Benefits**:

- Each app's state is encapsulated
- Easier to reason about lifecycle
- Subscriptions are tied to the app session
- Less cross-contamination risk

### 3. Ownership Transfer Mechanism

**Current**: When user switches clouds, old cloud doesn't know. It eventually disposes after 60s grace period, which can corrupt state on new cloud.

**Proposed**: Explicit ownership transfer message:

```typescript
// New message type
interface OwnershipTransferMessage {
  type: "OWNERSHIP_TRANSFER"
  userId: string
  targetCloudUrl: string
  timestamp: Date
}

// New connection state
enum AppConnectionState {
  DISCONNECTED,
  LOADING,
  RUNNING,
  GRACE_PERIOD,
  RESURRECTING,
  STOPPING,
  TRANSFERRED, // NEW: ownership transferred to another cloud
}
```

**SDK Flow**:

```typescript
// In AppServer.handleSessionRequest()
private async handleSessionRequest(request, res) {
  const { userId, mentraOSWebsocketUrl } = request;

  const existing = this.activeSessionsByUserId.get(userId);
  if (existing) {
    // Same user, different cloud - transfer ownership
    this.logger.info(`Transferring ownership for ${userId} to ${mentraOSWebsocketUrl}`);
    await existing.transferOwnership(mentraOSWebsocketUrl);
    res.status(200).json({ status: "success" });
    return;
  }

  // New user - create new session
  // ...
}

// In AppSession
async transferOwnership(newCloudUrl: string): Promise<void> {
  // Tell old cloud we're transferring
  if (this.ws?.readyState === WebSocket.OPEN) {
    this.ws.send(JSON.stringify({
      type: AppToCloudMessageType.OWNERSHIP_TRANSFER,
      userId: this.userId,
      targetCloudUrl: newCloudUrl,
      timestamp: new Date()
    }));
  }

  // Close old connection gracefully
  this.ws?.close(1000, "Ownership transferred");

  // Connect to new cloud
  this.config.mentraOSWebsocketUrl = newCloudUrl;
  await this.reconnect();
}
```

**Cloud Handling**:

```typescript
// In websocket-app.service.ts or AppSession class
handleOwnershipTransfer(message: OwnershipTransferMessage): void {
  this.logger.info(`App transferring for ${message.userId} to ${message.targetCloudUrl}`);

  // Mark as transferred - don't trigger resurrection
  this.connectionState = AppConnectionState.TRANSFERRED;

  // Clean up without modifying DB (user still wants app running)
  this.cleanup({ modifyDb: false, triggerResurrection: false });
}
```

**Benefits**:

- Explicit handoff, no ambiguity
- Old cloud knows not to resurrect
- DB state preserved (user still wants app running)
- New cloud takes over cleanly

### 4. One Session Per User on App Server

**Current**: App servers (like Captions) key state by userId, but SDK tracks by sessionId. Confusion when multiple sessions exist.

**Proposed**: Clarify that from app developer perspective, **one user = one session at a time**.

```typescript
// SDK AppServer
class AppServer {
  // Primary key is userId, not sessionId
  private activeSessionsByUserId: Map<string, AppSession> = new Map()

  // sessionId is now just for validation, not primary key
  private sessionIds: Map<string, string> = new Map() // userId -> sessionId
}
```

**App developer mental model**:

- One user has one active session
- When user switches clouds, session transfers (same object, new WebSocket)
- App state per user is preserved across cloud switches

### 5. Subscription Preservation Through Reconnection

**Problem**: SDK sends empty subscriptions on auto-reconnect (bug 005).

**Proposed**: Multiple layers of protection:

**Layer 1: SDK preserves subscriptions**

```typescript
// In handleReconnection()
private async handleReconnection(): Promise<void> {
  const savedSubscriptions = new Set(this.subscriptions);

  await this.connect(this.sessionId);

  // Restore if cleared unexpectedly
  if (this.subscriptions.size === 0 && savedSubscriptions.size > 0) {
    this.logger.warn("Restoring subscriptions that were cleared during reconnect");
    savedSubscriptions.forEach(sub => this.subscriptions.add(sub));
  }
}
```

**Layer 2: Cloud validates subscription source**

```typescript
// In AppSession (cloud)
updateSubscriptions(subs: SubscriptionRequest[], connectionId: string): void {
  if (connectionId !== this.activeConnectionId) {
    this.logger.warn("Rejecting subscription update from stale connection");
    return;
  }
  // Process subscriptions
}
```

**Layer 3: Cloud grace window for empty subscriptions**

```typescript
// In SubscriptionManager
if (newSubscriptions.length === 0) {
  const timeSinceConnect = Date.now() - this.lastConnectionTime
  if (timeSinceConnect < this.CONNECT_GRACE_MS) {
    this.logger.warn("Ignoring empty subscriptions within grace window")
    return
  }
}
```

## Migration Path

### Phase 1: Add New sessionId Format

1. Cloud generates UUID for UserSession
2. Include both old and new sessionId in webhook
3. App servers accept both formats
4. Monitor for issues

### Phase 2: Add AppSession Class

1. Create AppSession class with all state
2. Refactor AppManager to use AppSession
3. Move subscription state into AppSession
4. Keep SubscriptionManager as aggregator

### Phase 3: Add Ownership Transfer

1. Add OWNERSHIP_TRANSFER message type
2. SDK sends transfer message on new webhook
3. Cloud handles transfer gracefully
4. Remove resurrection for TRANSFERRED state

### Phase 4: Fix SDK Reconnection

1. Add subscription preservation in handleReconnection
2. Add logging for subscription changes
3. Add grace window for empty subscriptions
4. Test with various disconnect scenarios

## Questions Still to Answer

1. **Should DB state change during transfer?** - Probably not, user still wants app running
2. **What if transfer fails?** - Need timeout and fallback
3. **How long is transfer grace period?** - Probably short, 5-10 seconds
4. **Should we support multiple sessions per user?** - No, simplify to one
5. **How do we handle rapid cloud switching?** - Queue transfers, process in order

## Related Documents

- **001**: Initial problem analysis
- **002**: Environment-switch wrong session bug
- **003**: Reconnection system analysis
- **004**: State and data flow mapping
- **005**: SDK empty subscriptions bug

## Status

- [x] Architecture discussion completed
- [x] Key changes identified
- [ ] Detailed implementation plan
- [ ] Phase 1 implementation
- [ ] Phase 2 implementation
- [ ] Phase 3 implementation
- [ ] Phase 4 implementation
