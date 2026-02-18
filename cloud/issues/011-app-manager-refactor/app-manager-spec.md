# AppManager Refactor Spec

## Overview

Refactor AppManager from a 1613-line god class into a thin orchestrator (~400 lines) by moving per-app operations to AppSession. AppSession already owns per-app state; it should also own per-app operations.

## Problem

### 1. AppManager Is a God Class

AppManager handles too many concerns:

```typescript
// AppManager.ts - 1613 lines
class AppManager {
  // Lifecycle orchestration
  async startApp() {
    /* 230+ lines */
  }
  async stopApp() {
    /* 130+ lines */
  }

  // Connection handling
  async handleAppInit() {
    /* 220+ lines */
  }
  async handleAppConnectionClosed() {
    /* 100+ lines */
  }

  // Webhook handling
  private async triggerAppWebhookInternal() {
    /* 90+ lines */
  }
  private async triggerWebhook() {
    /* 40+ lines */
  }

  // State management
  async broadcastAppState() {
    /* 35+ lines */
  }
  async refreshInstalledApps() {
    /* 25+ lines */
  }
  async startPreviouslyRunningApps() {
    /* 50+ lines */
  }

  // Message routing
  async sendMessageToApp() {
    /* 60+ lines */
  }
}
```

### 2. Methods Do Too Much

`startApp()` (230+ lines) does:

1. Hardware compatibility check
2. Database lookup for app info
3. State validation
4. Webhook construction
5. Webhook HTTP call
6. Promise for connection wait
7. Timeout handling
8. Error handling for all of the above

This violates Single Responsibility - starting an app shouldn't require understanding webhook protocols, HTTP calls, and hardware compatibility in one method.

`handleAppInit()` (220+ lines) does:

1. JWT verification
2. Package name validation
3. API key validation
4. AppSession creation
5. WebSocket attachment
6. Connection acknowledgment
7. Subscription restoration
8. State broadcasting

### 3. AppSession Exists But Is Underutilized

AppSession was created to consolidate per-app state:

- WebSocket connection
- Connection state machine
- Heartbeat management
- Subscriptions
- Grace period handling

But per-app _operations_ still live in AppManager. This creates awkward patterns:

```typescript
// AppManager calls AppSession for state, then does operations itself
const appSession = this.getOrCreateAppSession(packageName)
appSession.setState(AppConnectionState.CONNECTING)
// ... 200 lines of logic that should be in AppSession
appSession.handleConnect(ws)
```

### Constraints

- **No behavior change**: External API stays the same
- **No mobile changes**: Wire protocol unchanged
- **Incremental migration**: Can move methods one at a time
- **Test coverage**: Existing tests must pass

## Goals

### 1. AppSession Owns Per-App Operations

Move from AppManager to AppSession:

| Operation        | Current Location                       | New Location                |
| ---------------- | -------------------------------------- | --------------------------- |
| Authentication   | AppManager.handleAppInit()             | AppSession.authenticate()   |
| Webhook trigger  | AppManager.triggerAppWebhookInternal() | AppSession.triggerWebhook() |
| Start logic      | AppManager.startApp()                  | AppSession.start()          |
| Stop logic       | AppManager.stopApp()                   | AppSession.stop()           |
| Connection close | AppManager.handleAppConnectionClosed() | AppSession.handleClose()    |

### 2. AppManager Becomes Orchestrator

AppManager should only:

- Create/destroy AppSession instances
- Route messages to correct AppSession
- Handle multi-app operations (broadcast, startPreviouslyRunningApps)
- Coordinate between AppSessions

### 3. Clear Separation of Concerns

```
AppManager (orchestration)
    │
    ├─ "Start app X" → appSession.start()
    ├─ "Stop app Y" → appSession.stop()
    ├─ "Message for Z" → appSession.send(message)
    └─ "Broadcast state" → iterate all AppSessions

AppSession (per-app operations)
    │
    ├─ start() - check hardware, trigger webhook, wait for connection
    ├─ stop() - cleanup, optionally restart
    ├─ authenticate() - verify JWT, setup connection
    └─ [existing] state, heartbeat, subscriptions
```

## Non-Goals

- **Changing AppSession's state machine** - Keep existing states
- **Changing wire protocol** - Messages stay the same
- **Extracting services** - Not creating AppWebhookService, etc. (keep it simple)
- **Changing subscription system** - SubscriptionManager unchanged

## Success Metrics

| Metric                       | Current              | Target    |
| ---------------------------- | -------------------- | --------- |
| AppManager.ts lines          | 1613                 | ~400      |
| AppSession.ts lines          | 820                  | ~1000     |
| Largest method in AppManager | 230 lines (startApp) | <50 lines |
| Methods in AppManager        | 20+                  | ~10       |

## Migration Strategy

### Phase 1: Move Authentication

1. Create `AppSession.authenticate(ws, initMessage)`
2. Move JWT verification logic from handleAppInit()
3. Move connection acknowledgment logic
4. AppManager.handleAppInit() becomes thin wrapper

### Phase 2: Move Webhook Logic

1. Create `AppSession.triggerWebhook(payload)`
2. Move HTTP call logic
3. Move retry/timeout logic
4. AppManager.startApp() calls appSession.triggerWebhook()

### Phase 3: Move Start/Stop

1. Create `AppSession.start()` - orchestrates the start sequence
2. Create `AppSession.stop()` - orchestrates cleanup
3. AppManager methods become thin wrappers

### Phase 4: Cleanup

1. Remove dead code from AppManager
2. Update tests to test AppSession directly
3. Verify no behavior change

## Open Questions

1. **Should AppSession call external services directly?**
   - Option A: AppSession calls appService, developerService directly
   - Option B: Pass services as dependencies to AppSession
   - **Leaning**: Option A for simplicity (same pattern as other managers)

2. **Error handling ownership?**
   - Should AppSession throw and AppManager catch?
   - Or should AppSession return Result types?
   - **Leaning**: Throw + catch (consistent with existing codebase)

3. **Hardware compatibility check location?**
   - Currently in AppManager.startApp()
   - Move to AppSession.start() or keep external?
   - **Leaning**: Move to AppSession - it's per-app logic

4. **Pending connection promise handling?**
   - Currently AppManager tracks pending connections
   - Move tracking to AppSession?
   - **Leaning**: Yes, AppSession should own its connection state entirely
