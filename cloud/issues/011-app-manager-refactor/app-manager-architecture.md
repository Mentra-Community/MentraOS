# AppManager Refactor Architecture

## Current System

### Class Responsibilities

```
AppManager (1613 lines)
├── App Lifecycle
│   ├── startApp() - 230+ lines
│   ├── stopApp() - 130+ lines
│   └── startPreviouslyRunningApps() - 50+ lines
│
├── Connection Handling
│   ├── handleAppInit() - 220+ lines
│   ├── handleAppConnectionClosed() - 100+ lines
│   └── handleAppConnectionClosedFromCallback() - 40+ lines
│
├── Webhook Management
│   ├── triggerAppWebhookInternal() - 90+ lines
│   └── triggerWebhook() - 40+ lines
│
├── State & Messaging
│   ├── sendMessageToApp() - 60+ lines
│   ├── broadcastAppState() - 35+ lines
│   └── refreshInstalledApps() - 25+ lines
│
└── AppSession Management
    ├── getAppSession()
    ├── getOrCreateAppSession()
    └── removeAppSession()

AppSession (820 lines)
├── State Machine
│   ├── state: AppConnectionState
│   └── setState()
│
├── WebSocket Lifecycle
│   ├── handleConnect()
│   ├── handleDisconnect()
│   └── closeHandler
│
├── Heartbeat
│   ├── setupHeartbeat()
│   └── clearHeartbeat()
│
├── Grace Period
│   ├── startGracePeriod()
│   ├── cancelGracePeriod()
│   └── onGracePeriodExpired callback → resurrection
│
├── Subscriptions (single source of truth)
│   ├── subscriptions: Set<ExtendedStreamType>
│   ├── updateSubscriptions() - handles reconnect grace window
│   └── hasSubscription()
│
└── Ownership
    ├── ownershipReleased
    └── handleOwnershipRelease()
```

### Current Data Flow: startApp()

```
AppManager.startApp(packageName)
    │
    ├─ Hardware compatibility check (HardwareCompatibilityService)
    │
    ├─ Get app from database (appService.getAppByPackageName)
    │
    ├─ Get developer for webhook URL (developerService)
    │
    ├─ Create/get AppSession
    │       │
    │       └─ appSession.setState(CONNECTING)
    │
    ├─ Build webhook payload (SessionWebhookRequest)
    │
    ├─ Create pending connection promise
    │       │
    │       └─ pendingConnections.set(packageName, {resolve, reject, timeout})
    │
    ├─ triggerAppWebhookInternal()
    │       │
    │       ├─ Build URL with JWT
    │       ├─ HTTP POST to app server
    │       └─ Handle errors
    │
    ├─ Wait for connection (promise)
    │       │
    │       └─ Resolved by handleAppInit() when app connects
    │
    └─ Return success/failure
```

### Current Data Flow: Reconnection / Resurrection

```
App WebSocket disconnects
    │
    └─ AppSession.handleDisconnect()
            │
            ├─ Check ownershipReleased
            │       │
            │       └─ Yes → STOPPED (no resurrection)
            │
            └─ No → startGracePeriod() (5 seconds)
                    │
                    ├─ SDK reconnects within grace
                    │       │
                    │       └─ handleAppInit() → appSession.handleConnect()
                    │               │
                    │               ├─ cancelGracePeriod()
                    │               ├─ _lastReconnectAt = Date.now()
                    │               └─ State → RUNNING ✅
                    │
                    └─ Grace expires
                            │
                            └─ onGracePeriodExpired → AppManager
                                    │
                                    └─ Trigger resurrection (webhook restart)
```

### Current Subscription Flow

```
SubscriptionManager.updateSubscriptions(packageName, subs)
    │
    ├─ Validate permissions
    │
    └─ appSession.updateSubscriptions(allowedSubs, locationRate)
            │
            ├─ Check reconnect grace window (8 seconds)
            │       │
            │       └─ Empty update within grace → IGNORED (prevents SDK init clearing subs)
            │
            ├─ Update _subscriptions Set (single source of truth)
            │
            └─ Notify onSubscriptionsChanged callback
```

## Proposed System

### Restructured Responsibilities

```
AppManager (~400 lines) - Orchestrator
├── Factory
│   ├── getOrCreateAppSession()
│   └── removeAppSession()
│
├── Multi-App Operations
│   ├── broadcastAppState()
│   ├── startPreviouslyRunningApps()
│   └── refreshInstalledApps()
│
├── Message Routing
│   └── sendMessageToApp() → appSession.send()
│
└── Event Handlers (thin wrappers)
    ├── handleAppInit() → appSession.authenticate()
    ├── handleAppConnectionClosed() → already delegates
    └── onGracePeriodExpired() → appSession.resurrect()

AppSession (~1000 lines) - Per-App Operations + State
├── [Existing] State & Lifecycle
│   ├── state machine (CONNECTING, RUNNING, GRACE_PERIOD, etc.)
│   ├── handleConnect(), handleDisconnect()
│   ├── heartbeat
│   ├── grace period + resurrection trigger
│   └── subscriptions (single source of truth)
│
├── [New] Start/Stop
│   ├── start(userSession) - full start sequence
│   ├── stop(restart?) - cleanup, optional restart
│   └── resurrect() - restart after grace period
│
├── [New] Authentication
│   ├── authenticate(ws, initMessage, userSession)
│   ├── verifyApiKey()
│   └── sendConnectionAck()
│
├── [New] Webhook
│   ├── triggerWebhook(type)
│   ├── loadAppInfo()
│   └── buildWebhookPayload()
│
└── [New] Messaging
    ├── send(message)
    └── sendWithResurrection(message) - retry if disconnected
```

### Proposed Data Flow: startApp()

```
AppManager.startApp(packageName)
    │
    └─ appSession = getOrCreateAppSession(packageName)
           │
           └─ return appSession.start(userSession)
                  │
                  ├─ checkHardwareCompatibility()
                  │
                  ├─ loadAppInfo() - cache app/developer from DB
                  │
                  ├─ setState(CONNECTING)
                  │
                  ├─ triggerWebhook('session-start')
                  │
                  └─ waitForConnection() - promise resolved by authenticate()
```

### Proposed Data Flow: handleAppInit()

```
AppManager.handleAppInit(ws, initMessage)
    │
    ├─ Parse and validate sessionId
    │
    └─ appSession = getOrCreateAppSession(packageName)
           │
           └─ return appSession.authenticate(ws, initMessage, userSession)
                  │
                  ├─ verifyApiKey()
                  │
                  ├─ handleConnect(ws) - existing, handles grace period
                  │
                  ├─ sendConnectionAck()
                  │
                  ├─ resolvePendingStart() - signal start() promise
                  │
                  └─ trackAnalytics()
```

### Proposed Data Flow: Resurrection (unchanged logic, moved location)

```
Grace period expires
    │
    └─ onGracePeriodExpired callback
           │
           └─ AppManager.handleGracePeriodExpired(appSession)
                  │
                  └─ appSession.resurrect()
                         │
                         ├─ setState(RESURRECTING)
                         │
                         ├─ triggerWebhook('session-start')
                         │
                         └─ waitForConnection()
```

## Implementation Details

### Phase 1: Move Authentication to AppSession

```typescript
// AppSession.ts - new method

async authenticate(
  ws: WebSocket,
  initMessage: AppConnectionInit,
  userSession: UserSession
): Promise<{ success: boolean; error?: string }> {
  // Verify API key
  const isValid = await this.verifyApiKey(initMessage.apiKey);
  if (!isValid) {
    return { success: false, error: "Invalid API key" };
  }

  // Connect (existing method - handles grace period cancellation)
  this.handleConnect(ws, initMessage);

  // Send ack
  await this.sendConnectionAck(userSession);

  // Resolve pending start if waiting
  this.resolvePendingStart(true);

  return { success: true };
}

private async verifyApiKey(apiKey: string): Promise<boolean> {
  if (!this.appInfo) {
    await this.loadAppInfo();
  }
  return this.appInfo?.apiKey === apiKey;
}

private async sendConnectionAck(userSession: UserSession): Promise<void> {
  const ack = {
    type: CloudToAppMessageType.CONNECTION_ACK,
    sessionId: `${userSession.userId}-${this.packageName}`,
    userId: userSession.userId,
    capabilities: userSession.getCapabilities(),
    mentraosSettings: await this.getMentraosSettings(userSession),
    timestamp: new Date(),
  };
  this._webSocket?.send(JSON.stringify(ack));
}
```

```typescript
// AppManager.ts - slimmed down

async handleAppInit(ws: WebSocket, initMessage: AppConnectionInit): Promise<void> {
  const { packageName, sessionId } = initMessage;
  const userId = sessionId.split("-")[0];

  if (userId !== this.userSession.userId) {
    ws.close(1008, "User ID mismatch");
    return;
  }

  const appSession = this.getOrCreateAppSession(packageName);
  if (!appSession) {
    ws.close(1011, "Failed to create session");
    return;
  }

  const result = await appSession.authenticate(ws, initMessage, this.userSession);
  if (!result.success) {
    ws.close(1008, result.error);
    return;
  }

  await this.broadcastAppState();
}
```

### Phase 2: Move Webhook to AppSession

```typescript
// AppSession.ts - new methods

private appInfo: AppI | null = null;
private developerInfo: DeveloperProfile | null = null;

async loadAppInfo(): Promise<boolean> {
  this.appInfo = await appService.getAppByPackageName(this.packageName);
  if (!this.appInfo) return false;

  if (this.appInfo.developerId) {
    this.developerInfo = await developerService.getDeveloperById(
      this.appInfo.developerId.toString()
    );
  }
  return true;
}

async triggerWebhook(
  type: "session-start" | "session-stop",
  userSession: UserSession
): Promise<{ success: boolean; error?: string }> {
  if (!this.developerInfo?.webhookURL) {
    return { success: false, error: "No webhook URL" };
  }

  const url = `${this.developerInfo.webhookURL}/${type}`;
  const payload = this.buildWebhookPayload(type, userSession);

  try {
    await axios.post(url, payload, { timeout: 5000 });
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
```

### Phase 3: Move Start/Stop to AppSession

```typescript
// AppSession.ts - new methods

private pendingStart: {
  resolve: (success: boolean) => void;
  timeout: NodeJS.Timeout;
} | null = null;

async start(userSession: UserSession): Promise<{ success: boolean; error?: string }> {
  if (this._state === AppConnectionState.RUNNING) {
    return { success: true };
  }

  // Hardware check
  const hw = await HardwareCompatibilityService.checkCompatibility(
    this.packageName,
    userSession.deviceManager.getGlassesModel()
  );
  if (!hw.compatible) {
    return { success: false, error: hw.reason };
  }

  // Load app info
  const loaded = await this.loadAppInfo();
  if (!loaded) {
    return { success: false, error: "App not found" };
  }

  this.setState(AppConnectionState.CONNECTING);
  this._startTime = new Date();

  // Trigger webhook
  const webhookResult = await this.triggerWebhook("session-start", userSession);
  if (!webhookResult.success) {
    this.setState(AppConnectionState.STOPPED);
    return { success: false, error: `Webhook failed: ${webhookResult.error}` };
  }

  // Wait for connection
  return this.waitForConnection();
}

private waitForConnection(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      this.pendingStart = null;
      this.setState(AppConnectionState.STOPPED);
      resolve({ success: false, error: "Connection timeout" });
    }, APP_SESSION_TIMEOUT_MS);

    this.pendingStart = {
      resolve: (success) => {
        clearTimeout(timeout);
        this.pendingStart = null;
        resolve({ success, error: success ? undefined : "Connection failed" });
      },
      timeout,
    };
  });
}

private resolvePendingStart(success: boolean): void {
  if (this.pendingStart) {
    clearTimeout(this.pendingStart.timeout);
    this.pendingStart.resolve(success);
    this.pendingStart = null;
  }
}

async stop(restart: boolean = false): Promise<void> {
  this.markStopping();

  // Close WebSocket
  if (this._webSocket?.readyState === WebSocket.OPEN) {
    this._webSocket.close(1000, restart ? "Restarting" : "Stopped");
  }

  // Trigger webhook
  await this.triggerWebhook("session-stop", this.userSession);

  this.cleanup();
  this.markStopped();
}

async resurrect(userSession: UserSession): Promise<{ success: boolean; error?: string }> {
  this.logger.info("Resurrecting app after grace period");
  this.setState(AppConnectionState.RESURRECTING);

  // Re-trigger start sequence
  const result = await this.triggerWebhook("session-start", userSession);
  if (!result.success) {
    this.setState(AppConnectionState.STOPPED);
    return { success: false, error: result.error };
  }

  return this.waitForConnection();
}
```

```typescript
// AppManager.ts - slimmed down

async startApp(packageName: string): Promise<AppStartResult> {
  const appSession = this.getOrCreateAppSession(packageName);
  if (!appSession) {
    return { success: false, error: { stage: "INTERNAL_ERROR", message: "Failed to create session" } };
  }

  const result = await appSession.start(this.userSession);
  if (result.success) {
    await this.broadcastAppState();
  }
  return { success: result.success, error: result.error ? { stage: "CONNECTION", message: result.error } : undefined };
}

async stopApp(packageName: string, restart?: boolean): Promise<void> {
  const appSession = this.getAppSession(packageName);
  if (!appSession) return;

  await appSession.stop(restart);
  await this.broadcastAppState();
}

private async handleAppSessionGracePeriodExpired(appSession: AppSession): Promise<void> {
  this.logger.info({ packageName: appSession.packageName }, "Grace period expired, resurrecting");
  await appSession.resurrect(this.userSession);
}
```

## File Changes Summary

| File            | Before     | After       | Change      |
| --------------- | ---------- | ----------- | ----------- |
| `AppManager.ts` | 1613 lines | ~400 lines  | -1200 lines |
| `AppSession.ts` | 820 lines  | ~1000 lines | +180 lines  |

### Methods Moved

| Method                        | From       | To                          |
| ----------------------------- | ---------- | --------------------------- |
| `handleAppInit()` auth logic  | AppManager | AppSession.authenticate()   |
| `triggerAppWebhookInternal()` | AppManager | AppSession.triggerWebhook() |
| `triggerWebhook()`            | AppManager | AppSession.triggerWebhook() |
| `startApp()` main logic       | AppManager | AppSession.start()          |
| `stopApp()` main logic        | AppManager | AppSession.stop()           |
| Resurrection logic            | AppManager | AppSession.resurrect()      |
| Pending connection tracking   | AppManager | AppSession                  |

### Methods Staying in AppManager

| Method                         | Reason                            |
| ------------------------------ | --------------------------------- |
| `broadcastAppState()`          | Multi-app operation               |
| `startPreviouslyRunningApps()` | Multi-app operation               |
| `refreshInstalledApps()`       | Multi-app operation               |
| `getOrCreateAppSession()`      | Factory                           |
| `removeAppSession()`           | Factory                           |
| `sendMessageToApp()`           | Routing (delegates to AppSession) |

## Preserved Behaviors

### Reconnection During Grace Period ✅

- `AppSession.handleConnect()` still cancels grace period
- `_lastReconnectAt` still set for subscription grace window
- "SDK reconnected during grace period" log preserved

### Subscription Grace Window ✅

- `AppSession.updateSubscriptions()` unchanged
- Empty updates within 8 seconds of reconnect still ignored
- Single source of truth in AppSession preserved

### Resurrection Flow ✅

- Grace period expiration still triggers resurrection
- Just moved from AppManager callback to AppSession.resurrect()
- Webhook re-triggered, waitForConnection() reused

### Ownership Release ✅

- `AppSession.handleOwnershipRelease()` unchanged
- Checked in handleDisconnect() before starting grace period
- No resurrection if ownership was released

## Testing Strategy

### Unit Tests for AppSession

```typescript
describe("AppSession.start()", () => {
  it("should check hardware compatibility")
  it("should load app info from database")
  it("should trigger webhook")
  it("should wait for connection")
  it("should timeout if no connection")
  it("should return success when authenticate() called")
})

describe("AppSession.authenticate()", () => {
  it("should verify API key")
  it("should cancel grace period if reconnecting")
  it("should send CONNECTION_ACK")
  it("should resolve pending start")
})

describe("AppSession.resurrect()", () => {
  it("should set state to RESURRECTING")
  it("should trigger webhook")
  it("should wait for reconnection")
})
```

### Integration Tests

```typescript
describe("App lifecycle", () => {
  it("should start app via webhook and connection")
  it("should reconnect during grace period without resurrection")
  it("should resurrect after grace period expires")
  it("should not resurrect if ownership released")
  it("should preserve subscriptions across reconnection")
})
```

## Migration Steps

1. **Phase 1**: Add `authenticate()` to AppSession, update AppManager to delegate
2. **Phase 2**: Add `triggerWebhook()` to AppSession, update AppManager
3. **Phase 3**: Add `start()`, `stop()`, `resurrect()` to AppSession
4. **Phase 4**: Remove dead code from AppManager
5. **Phase 5**: Update tests

Each phase can be deployed independently with no behavior change.

## Open Questions

1. **UserSession reference in AppSession?**
   - Option A: Pass userSession to each method (current proposal)
   - Option B: Store userSession reference in AppSession constructor
   - **Leaning**: Option A - avoids circular reference complexity

2. **App/Developer info caching?**
   - Cache in AppSession after first load?
   - Or load fresh each time?
   - **Leaning**: Cache after loadAppInfo(), clear on stop()

3. **Error types?**
   - Keep simple `{ success, error }` returns?
   - Or create typed error classes?
   - **Leaning**: Simple returns for now, match existing patterns
