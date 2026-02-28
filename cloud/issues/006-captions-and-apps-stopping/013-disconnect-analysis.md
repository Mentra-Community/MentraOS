# disconnect() Analysis & Reconnection Design Issues

## Current State: When is `disconnect()` Called?

### Call Sites in SDK

| Location | Trigger | Intent |
|----------|---------|--------|
| `AppServer.onStop()` | Stop webhook OR permanent disconnection event | Clean up session completely |
| `AppServer.cleanup()` | Server shutdown (SIGINT/SIGTERM) | Clean up all sessions |
| Example apps | Manual cleanup | Developer-initiated cleanup |

### The Flow Chart

```
                         WebSocket closes
                               │
                               ▼
                    ┌──────────────────────┐
                    │ closeHandler fires   │
                    │ emits "disconnected" │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
        code 1006         code 1000        code 1000
        (abnormal)     "App stopped"   "User session ended"
              │                │                │
              ▼                ▼                ▼
     handleReconnection()   nothing      emits ANOTHER
              │                │         "disconnected"
              │                │         with sessionEnded=true
              │                │                │
              ▼                │                ▼
      attempts reconnect      │         AppServer catches it
      (up to 3x)              │         calls onStop()
              │                │                │
              ▼                │                ▼
      if all fail:            │         onStop() calls
      emits "disconnected"    │         disconnect()
      with permanent=true     │                │
              │                │                │
              ▼                │                │
      AppServer catches it    │                │
      calls onStop()          │                │
              │                │                │
              ▼                │                │
      onStop() calls ─────────┴────────────────┘
      disconnect()
              │
              ▼
      disconnect() clears:
      - ws = null
      - sessionId = null
      - subscriptions.clear()  ← THE PROBLEM!
      - reconnectAttempts = 0
```

## The Core Problem

### `disconnect()` Does Two Things That Shouldn't Be Combined

1. **Cleans up WebSocket connection** (necessary for reconnection)
2. **Clears subscription state** (destroys intent for reconnection)

```typescript
async disconnect(): Promise<void> {
  // ... flush storage, cancel requests ...
  
  this.resources.dispose()
  this.ws = null
  this.sessionId = null
  this.subscriptions.clear()  // ← DESTROYS subscription intent!
  this.reconnectAttempts = 0
}
```

### The Intent Mismatch

| Scenario | Intent | What `disconnect()` Does | Result |
|----------|--------|--------------------------|--------|
| App stopped by user | Clean up everything | Clears subscriptions | ✅ Correct |
| User session ended | Clean up everything | Clears subscriptions | ✅ Correct |
| Server shutdown | Clean up everything | Clears subscriptions | ✅ Correct |
| WebSocket breaks (1006) | Reconnect with same state | **Should NOT clear subscriptions** | ❌ Wrong design |
| Reconnection attempt | Reconnect with same state | **Should NOT clear subscriptions** | ❌ Wrong design |

## Why This Design Exists (Historical Context)

The SDK was originally designed **without reconnection in mind**:

1. **Original model**: WebSocket closes → app stops → user restarts manually
2. **`disconnect()` was terminal**: If called, the session was done
3. **No concept of "temporary disconnection"**: Every disconnect was permanent

Then reconnection was **retrofitted**:

1. Added `handleReconnection()` after abnormal closures
2. But `connect()` calls `this.subscriptions.clear()` path wasn't audited
3. And various code paths might call `disconnect()` during reconnection flow

## The Confusion Points

### 1. `disconnect()` is Public but Has Side Effects

Developers might call `disconnect()` thinking it just closes the WebSocket:
```typescript
// Developer thinks: "I'll disconnect and reconnect with new URL"
await session.disconnect()
session.config.mentraOSWebsocketUrl = newUrl
await session.connect(sessionId)
// SURPRISE: subscriptions are gone!
```

### 2. Reconnection Doesn't Call `disconnect()` But `connect()` Might Clear State

```typescript
async connect(sessionId: string): Promise<void> {
  // ...
  if (this.ws) {
    // Don't call full dispose() as that would clear subscriptions
    if (this.ws.readyState !== 3) {
      this.ws.close()
    }
    this.ws = null
  }
  // ...
}
```

The comment shows awareness of the problem! But `this.subscriptions` is still vulnerable to being cleared elsewhere.

### 3. The `onDisconnected` Event is Overloaded

The `disconnected` event means different things:
- Temporary WebSocket drop (reconnectable)
- Permanent disconnection (not reconnectable)
- User session ended (not reconnectable)
- Max reconnection attempts exceeded (not reconnectable)

All trigger the same event handler in `AppServer`, which always removes from `activeSessions`.

## Proposed Design: Reconnection-First Architecture

### Principle: Separate "Connection" from "Session"

```
Session State (persistent)          Connection State (transient)
─────────────────────────           ─────────────────────────────
- userId                            - WebSocket instance
- packageName                       - reconnectAttempts
- handlers (subscriptions intent)   - connectionState enum
- settings                          - heartbeat timer
- capabilities
```

### New State Machine

```
                    ┌─────────────────────────────────────────────┐
                    │              AppSession States               │
                    ├─────────────────────────────────────────────┤
                    │                                             │
  new AppSession()  │                                             │
        │           │   ┌──────────┐      connect()     ┌─────────┴───┐
        └───────────┼──►│INITIALIZED├──────────────────►│  CONNECTING │
                    │   └──────────┘                    └──────┬──────┘
                    │                                          │
                    │                            CONNECTION_ACK │
                    │                                          ▼
                    │                                   ┌───────────┐
                    │              ┌────────────────────┤ CONNECTED │
                    │              │                    └─────┬─────┘
                    │              │                          │
                    │    abnormal close (1006)          normal close
                    │    no sessionEnded flag           OR sessionEnded
                    │              │                          │
                    │              ▼                          ▼
                    │   ┌───────────────────┐          ┌───────────┐
                    │   │   RECONNECTING    │          │  STOPPED  │
                    │   └────────┬──────────┘          └───────────┘
                    │            │                           ▲
                    │    ┌───────┴───────┐                   │
                    │    │               │                   │
                    │ success        max attempts            │
                    │    │           exceeded                │
                    │    ▼               │                   │
                    │ CONNECTED          └───────────────────┘
                    │                                             
                    └─────────────────────────────────────────────┘
```

### Proposed Method Split

Instead of one `disconnect()`, have explicit methods:

```typescript
class AppSession {
  /**
   * Close WebSocket but preserve session state (for reconnection)
   * Called internally during reconnection flow
   */
  private closeConnection(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close()
    }
    this.ws = null
    // NOTE: Do NOT clear subscriptions, sessionId, or handlers
  }

  /**
   * Fully terminate the session - clean up everything
   * Called when app is intentionally stopped
   */
  async terminate(): Promise<void> {
    await this.simpleStorage.flush()
    this.camera?.cancelAllRequests()
    this.audio?.cancelAllRequests()
    this.resources.dispose()
    this.closeConnection()
    this.sessionId = null
    // Handlers remain registered - they're the developer's intent
    // But we could clear them here if desired:
    // this.events.clearAllHandlers()
    this.reconnectAttempts = 0
    this.connectionState = 'stopped'
  }

  /**
   * @deprecated Use terminate() for intentional stop, 
   * or let reconnection handle temporary disconnects
   */
  async disconnect(): Promise<void> {
    // For backward compatibility, alias to terminate()
    await this.terminate()
  }
}
```

### The Key Insight: Handlers ARE the Subscription Intent

With the fix from `012-concrete-patch-plan.md`:

```typescript
// Subscriptions are DERIVED from handlers
private updateSubscriptions(): void {
  const subscriptions = this.events.getRegisteredStreams()
  // ...send to cloud...
}
```

This means:
- **Handlers persist** across reconnection (they're developer-registered callbacks)
- **Subscriptions are derived** when needed
- **No separate state to clear** = no drift possible

## Immediate Fix vs. Full Redesign

### Immediate Fix (Phase 1 - in `012-concrete-patch-plan.md`)

1. Derive subscriptions from handlers
2. Remove `this.subscriptions` Set
3. Remove `this.subscriptions.clear()` from `disconnect()`

This **works** because handlers persist and subscriptions are derived.

### Full Redesign (Phase 2+)

1. Rename `disconnect()` to `terminate()` with clear semantics
2. Add explicit `connectionState` enum
3. Separate "connection lost" events from "session ended" events
4. Add `closeConnection()` for internal use during reconnection
5. Consider: Should `terminate()` also clear handlers?

## Questions to Decide

### Q1: Should `terminate()` clear handlers?

**Option A: Yes, clear handlers**
- Clean slate after termination
- Developer must re-register handlers on new session
- Cleaner mental model

**Option B: No, preserve handlers**
- Handlers represent developer's declared intent
- Could reconnect with same handlers later
- More flexible but potentially confusing

**Recommendation**: Option A - clear handlers on `terminate()`. A terminated session is done.

### Q2: What should happen if `connect()` is called on a terminated session?

**Option A: Throw error**
```typescript
if (this.connectionState === 'stopped') {
  throw new Error('Cannot connect a terminated session. Create a new AppSession.')
}
```

**Option B: Allow it (current behavior)**
- Reconnect with whatever handlers exist
- Potentially confusing

**Recommendation**: Option A - make it explicit that terminated sessions are done.

### Q3: Should we emit different events for different disconnect types?

Current: All disconnects emit `disconnected` with flags
```typescript
{ permanent: true, sessionEnded: true }  // User session ended
{ permanent: true }                       // Max reconnect attempts
{ permanent: false }                      // Temporary, will reconnect
```

Proposed: Separate events
```typescript
events.emit('connectionLost', { code, reason })      // Temporary, will reconnect
events.emit('sessionEnded', { reason })              // User's cloud session ended
events.emit('terminated', { reason })                // App was stopped
events.emit('reconnectFailed', { attempts })         // Gave up reconnecting
```

**Recommendation**: Keep current approach for now, but improve documentation. Separate events would be a breaking change.

## Summary

| Problem | Root Cause | Fix |
|---------|------------|-----|
| Empty subscriptions on reconnect | `disconnect()` clears subscriptions, handlers still exist | Derive subscriptions from handlers (Phase 1) |
| Confusing `disconnect()` semantics | One method does both "close connection" and "terminate session" | Rename to `terminate()`, add internal `closeConnection()` (Phase 2) |
| Overloaded `disconnected` event | Same event for temp/perm disconnects | Better documentation OR separate events (Phase 2+) |

## Files Affected by Full Redesign

| File | Changes |
|------|---------|
| `sdk/src/app/session/index.ts` | Add `terminate()`, `closeConnection()`, deprecate `disconnect()` |
| `sdk/src/app/session/events.ts` | Consider adding `clearAllHandlers()` method |
| `sdk/src/app/server/index.ts` | Update `onStop()` to call `terminate()` |
| All example apps | Update to use `terminate()` |

## Recommendation

1. **Do Phase 1 now** (derive subscriptions from handlers) - this fixes the immediate bug
2. **Plan Phase 2** (better disconnect/terminate semantics) - this prevents future confusion
3. **Document the current behavior** clearly in the meantime

---

## Future Work: Phase 2+ Design Notes

> **Status**: Deferred. Phase 1 fixes the immediate bug. Phase 2 is about code clarity and will be designed more thoughtfully later.

### Ideas to Explore

- Rename `disconnect()` → `terminate()` with clear "session is done" semantics
- Add internal `closeConnection()` for reconnection flow
- Consider explicit `connectionState` enum for clarity
- Possibly separate event types for different disconnect scenarios
- Think about whether handlers should be cleared on terminate

### Why We're Deferring

The Phase 2 suggestions in this doc are a starting point, but we can do better. The reconnection architecture deserves more careful design rather than a quick refactor. Phase 1 (derive from handlers) is a clean, minimal fix that solves the immediate problem without over-engineering.

### When to Revisit

- When we tackle Bug 1 (cross-environment contamination) with OWNERSHIP_RELEASE
- When we add more sophisticated multi-cloud support
- If we see more reconnection-related bugs in the future