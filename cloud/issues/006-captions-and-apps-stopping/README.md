# Cross-Environment App Subscription Contamination

Apps connected to multiple backend environments can corrupt state when one environment disposes its session. Additionally, SDK reconnection can lose subscription state through an as-yet-unidentified mechanism.

## Documents (Chronological Order)

- **001-captions-stopping-spec.md** - Initial problem analysis, root cause, proposed fixes
- **002-session-lifecycle-bug.md** - Deep dive: wrong session disposed on env switch
- **003-reconnection-system-analysis.md** - Analysis of reconnection/resurrection system and failure modes
- **004-state-and-data-flow.md** - Maps out state locations, data flows, and why naive fixes are dangerous
- **005-sdk-reconnect-empty-subscriptions-bug.md** - SDK sends empty subscriptions on reconnect (symptom documented)
- **006-proposed-architecture-redesign.md** - Proposed architectural changes to fix all issues
- **007-subscription-timing-bug.md** - Ongoing investigation into WHY subscriptions are empty
- **008-system-confusion-points.md** - Catalog of confusing/unintuitive aspects of the system
- **009-architecture-brainstorm.md** - Holistic redesign: AppSession class, OWNERSHIP_RELEASE, coordinated recovery
- **010-subscription-manager-usage-analysis.md** - Analysis of SubscriptionManager usage across codebase
- **011-sdk-subscription-architecture-mismatch.md** - **ROOT CAUSE FOUND**: Dual storage allows handlers/subscriptions to drift
- **012-concrete-patch-plan.md** - **IMPLEMENTATION PLAN**: Exact code changes for Phase 1 SDK fix
- **013-disconnect-analysis.md** - Analysis of `disconnect()` behavior and reconnection design
- **014-mic-on-intermittent-failure.md** - Investigation of mic-on intermittent failure (cross-env contamination)
- **015-phase2-ownership-release-plan.md** - **IMPLEMENTATION PLAN**: Phase 2 OWNERSHIP_RELEASE protocol
- **016-appsession-consolidation-plan.md** - **IMPLEMENTATION PLAN**: Phase 4 AppSession class consolidation

## Quick Context

**Bug 1 (Env Switch)**: When user switches from env A to env B, env A's grace period eventually disposes its session. The `onStop` handler looks up by `userId` but gets the NEW session, disposing the wrong one.

**Bug 2 (SDK Reconnect)**: During SDK reconnection after WebSocket 1006, the SDK sends empty subscriptions to the cloud, killing transcription. **Root cause identified: dual storage of subscription state allows drift (see 011).**

**Result**: App appears running but transcription stops. Mic turns off. User confused.

## Root Cause: Dual Storage Architecture Mismatch (Bug 2)

### The Problem

The SDK stores subscription state in **two separate places**:

1. **`EventManager.handlers`** - Map of stream → handlers (developer's registered callbacks)
2. **`AppSession.subscriptions`** - Set of streams (internal tracking for cloud)

These are supposed to stay in sync, but they can **drift**:

```typescript
// AppSession.disconnect() - CLEARS subscriptions but NOT handlers!
async disconnect(): Promise<void> {
  // ...
  this.subscriptions.clear()  // ← handlers still exist!
}
```

### The Bug

If `this.subscriptions` gets cleared while `handlers` still exist:

- Developer's handlers still exist (they want events!)
- `this.subscriptions` is empty
- On reconnect, `updateSubscriptions()` sends empty array
- Cloud removes subscriptions
- Handlers wait for events that never come

### The Fix

**Derive subscriptions from handlers instead of storing separately:**

```typescript
// Instead of maintaining this.subscriptions Set...
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

## Multiple Failure Modes Identified

1. **Wrong Session Disposed** - Environment switch causes old session's `onStop` to dispose new session (002) ✅ Root cause known
2. **Webhook Unreachable** - Resurrection fails because app server crashed (003)
3. **Subscription Loss Without WS Close** - App loses subscriptions but WebSocket stays open
4. **SDK Empty Subscriptions** - SDK sends `[]` on reconnect ✅ Root cause known: dual storage drift (011)
5. **Orphaned WebSocket Connections** - Old session's WebSocket stays open, causes contamination

## Status

- [x] Root cause identified for env-switch bug (002)
- [x] Root cause identified for SDK reconnect bug (011) - **Dual storage allows drift**
- [x] Reconnection system analyzed (003)
- [x] State/data flow mapped (004)
- [x] System confusion points documented (008)
- [x] Architecture redesign documented (009)
- [x] **Phase 1a**: Derive subscriptions from handlers (SDK) ✅ IMPLEMENTED
- [x] **Phase 1b**: Terminated flag to prevent reconnection after session end ✅ IMPLEMENTED
- [x] **Phase 2**: OWNERSHIP_RELEASE protocol for clean cloud handoffs ✅ IMPLEMENTED
- [ ] **Phase 3**: SDK one-session-per-user enforcement (future)
- [x] **Phase 4a**: Cloud AppSession class created ✅ IMPLEMENTED
- [x] **Phase 4b**: Connection state migrated to AppSession ✅ IMPLEMENTED
- [x] **Phase 4c**: Subscriptions migrated to AppSession ✅ IMPLEMENTED
- [x] **Phase 4d**: UserSession state migrated to AppSession ✅ IMPLEMENTED
- [x] **Phase 4e**: Cleanup and testing ✅ IMPLEMENTED
- [ ] Verify fixes in production

## Implementation Summary

### Phase 1a: Derive Subscriptions from Handlers ✅
- Removed `AppSession.subscriptions` Set
- Added `EventManager.getRegisteredStreams()` method
- `updateSubscriptions()` now derives from handlers (single source of truth)
- **Result**: Subscriptions can never be empty if handlers exist

### Phase 1b: Terminated Flag ✅
- Added `terminated` flag to AppSession
- Set when "User session ended" received
- Prevents reconnection attempts after termination
- **Result**: No reconnection with empty handlers after session end

### Phase 2: OWNERSHIP_RELEASE Protocol ✅
- Added `OWNERSHIP_RELEASE` message type (SDK → Cloud)
- SDK sends before intentional disconnect (clean_shutdown, switching_clouds, user_logout)
- Cloud skips resurrection when ownership was released
- AppServer.cleanup() now releases ownership before disconnecting
- **Result**: Clean handoffs between cloud instances, no accidental resurrections

**Backward Compatible**: Old SDKs don't send OWNERSHIP_RELEASE, so they get existing grace period + resurrection behavior.

### Phase 4a: AppSession Class ✅
- Created `AppSession` class to consolidate per-app state
- Single source of truth for connection state, heartbeat, grace period, ownership release
- Added to AppManager with `getAppSession()`, `getOrCreateAppSession()` methods
- **Result**: Foundation for state consolidation

### Phase 4b: Connection State Migration ✅
- Removed `connectionStates`, `heartbeatIntervals`, `appStartTimes`, `ownershipReleased` Maps from AppManager
- AppSession now manages:
  - Connection state machine (CONNECTING → RUNNING → GRACE_PERIOD → RESURRECTING → STOPPED)
  - Heartbeat intervals internally
  - Grace period timers and resurrection callbacks
  - Ownership release tracking
- Removed old `AppConnectionState` enum, now using `AppSessionState` from AppSession
- **Result**: Single source of truth for app connection lifecycle

### Phase 4c: Subscriptions Migration ✅
- Removed `subscriptions`, `history`, `lastAppReconnectAt` Maps from SubscriptionManager
- SubscriptionManager now delegates per-app subscription storage to AppSession
- AppSession handles empty-subscription grace window internally
- SubscriptionManager still maintains cross-app aggregates (`appsWithPCM`, `appsWithTranscription`, `languageStreamCounts`)
- Added `getAllAppSessions()` method to AppManager for iteration
- **Result**: Single source of truth for per-app subscriptions

### Phase 4d: UserSession State Migration ✅
- Converted `runningApps`, `loadingApps`, `appWebsockets` from stored properties to derived getters
- UserSession now delegates to AppManager which delegates to AppSession
- Added WebSocket management methods to AppManager (`getAppWebSocket()`, `getAllAppWebSockets()`, etc.)
- Updated AppManager to use AppSession for all state checks and WebSocket access
- External code continues to work unchanged (backward compatible getters)
- **Result**: Single source of truth for all per-app state in AppSession

### Phase 4e: Cleanup ✅
- Removed dead `_reconnectionTimers` property from UserSession (grace period now in AppSession)
- Removed initialization and cleanup code for `_reconnectionTimers`
- All tests passing, no TypeScript errors in migrated files
- **Result**: Clean codebase with no dead code from migration

## The Core Problems

### Problem 1: SDK Dual Storage Allows Drift (Bug 005/007) ✅ SOLVED

The SDK has TWO places storing subscription state:

```
EventManager.handlers          AppSession.subscriptions
(developer's callbacks)        (internal Set for cloud)
        │                              │
        │      Should stay in sync     │
        └──────────────────────────────┘
                    BUT
              They can DRIFT!
```

**How they drift:**

```typescript
// disconnect() clears subscriptions but NOT handlers
async disconnect(): Promise<void> {
  this.subscriptions.clear()  // ← Cleared!
  // handlers still exist in EventManager!
}
```

**The fix:** Derive subscriptions from handlers:

```typescript
private updateSubscriptions(): void {
  const subs = this.events.getRegisteredStreams()  // ← Derive from handlers!
  this.send({ type: 'SUBSCRIPTION_UPDATE', subscriptions: subs })
}
```

### Problem 2: sessionId Not Unique

```
sessionId = userId + "-" + packageName
         = "isaiah@mentra.glass-com.mentra.captions.beta"

This is the SAME for:
  - Session on cloud-dev
  - Session on cloud-debug
  - Any future session
```

### Problem 3: State Scattered Across Managers

- AppManager holds: WebSockets, connection states, heartbeats
- SubscriptionManager holds: subscriptions per app
- UserSession holds: runningApps, loadingApps
- No single source of truth for an app's state

## Proposed Fixes

### SDK Fix: Derive Subscriptions from Handlers (Bug 2)

```typescript
// EventManager - add method to expose registered streams
getRegisteredStreams(): ExtendedStreamType[] {
  return Array.from(this.handlers.keys())
}

// AppSession - derive instead of storing
private updateSubscriptions(): void {
  const subs = this.events.getRegisteredStreams()  // Single source of truth!
  this.send({ type: 'SUBSCRIPTION_UPDATE', subscriptions: subs })
}

// disconnect() no longer needs to clear subscriptions
async disconnect(): Promise<void> {
  // Remove: this.subscriptions.clear()
  // Nothing to clear - subscriptions derived from handlers
}
```

### Cloud Fix: AppSession Class + OWNERSHIP_RELEASE (Bug 1)

See **009-architecture-brainstorm.md** for details:

- `AppSession` class consolidates scattered state
- `OWNERSHIP_RELEASE` message coordinates cloud switching
- One AppSession per user on SDK side (enforced)

## Key Files

### SDK (Bug 2 Fix)

| File                                     | Changes Needed                                                  |
| ---------------------------------------- | --------------------------------------------------------------- |
| `packages/sdk/src/app/session/events.ts` | Add `getRegisteredStreams()` method                             |
| `packages/sdk/src/app/session/index.ts`  | Derive subscriptions from handlers, remove `this.subscriptions` |

### Cloud (Bug 1 Fix)

| File                                                             | Changes Needed                           |
| ---------------------------------------------------------------- | ---------------------------------------- |
| `packages/cloud/src/services/session/AppSession.ts`              | NEW: Consolidated app session state      |
| `packages/cloud/src/services/session/AppManager.ts`              | Use `apps: Map<packageName, AppSession>` |
| `packages/cloud/src/services/websocket/websocket-app.service.ts` | Handle `OWNERSHIP_RELEASE` message       |

### SDK (Bug 1 Fix)

| File                                    | Changes Needed                                 |
| --------------------------------------- | ---------------------------------------------- |
| `packages/sdk/src/app/server/index.ts`  | One session per user, transfer on cloud switch |
| `packages/sdk/src/app/session/index.ts` | Add `transferToCloud()`, `OWNERSHIP_RELEASE`   |

## System Confusion Points

See **008-system-confusion-points.md** for a comprehensive list of:

- Multiple "Session" concepts with same names
- Scattered state across managers
- Two connection paths (JWT vs CONNECTION_INIT)
- Webhook vs Auto-Reconnect creating different state
- Three different grace periods (60s, 5s, 8s)
- Resurrection vs Reconnection competing mechanisms
- And more...

Understanding these confusion points is essential for debugging and avoiding regressions.
