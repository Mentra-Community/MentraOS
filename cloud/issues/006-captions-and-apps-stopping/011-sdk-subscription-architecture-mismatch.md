# SDK Subscription Architecture Mismatch

## Executive Summary

The SDK stores subscription state in **two separate places** that can drift out of sync, causing the "empty subscriptions" bug. This is the likely root cause of Bug 2 (005/007).

**The Problem:**

- `EventManager.handlers` stores registered callbacks (developer's intent)
- `AppSession.subscriptions` stores streams to subscribe to (internal tracking)
- These are supposed to stay in sync, but they can drift

**The Fix:**

- Derive subscriptions from handlers, don't store them separately
- Subscriptions can never be "empty" if handlers exist

---

## How Subscriptions Currently Work

### Developer Writes:

```typescript
// Captions UserSession.initialize()
this.transcriptionCleanup = this.appSession.events.onTranscriptionForLanguage("en-US", (data) =>
  this.transcripts.handleTranscription(data),
)
```

### What Happens Internally:

```
Developer calls onTranscriptionForLanguage("en-US", handler)
    │
    ▼
EventManager.addHandler(stream, handler)
    │
    ├──► handlers.set(stream, handlerSet)     // Store 1: EventManager
    │
    └──► this.subscribe(stream)               // Calls AppSession.subscribe
             │
             ▼
         AppSession.subscribe(stream)
             │
             ├──► this.subscriptions.add(stream)  // Store 2: AppSession
             │
             └──► updateSubscriptions()           // Send to cloud
```

### Two Separate Stores:

| Store           | Location       | Contains                        | Purpose                          |
| --------------- | -------------- | ------------------------------- | -------------------------------- |
| `handlers`      | `EventManager` | `Map<StreamType, Set<Handler>>` | Developer's registered callbacks |
| `subscriptions` | `AppSession`   | `Set<StreamType>`               | Streams to send to cloud         |

---

## The Sync Mechanism

These stores are SUPPOSED to stay in sync:

```typescript
// EventManager.addHandler()
private addHandler(type, handler): () => void {
  const handlers = this.handlers.get(type) ?? new Set()

  if (handlers.size === 0) {
    this.handlers.set(type, handlers)
    this.subscribe(type)  // ← Syncs to AppSession.subscriptions
  }
  handlers.add(handler)
  return () => this.removeHandler(type, handler)
}

// EventManager.removeHandler()
private removeHandler(type, handler): void {
  const handlers = this.handlers.get(type)
  if (!handlers) return

  handlers.delete(handler)
  if (handlers.size === 0) {
    this.handlers.delete(type)
    this.unsubscribe(type)  // ← Syncs to AppSession.subscriptions
  }
}
```

**If all modifications go through addHandler/removeHandler, they stay in sync.**

---

## How They Can Drift

### Drift Point 1: `AppSession.disconnect()`

```typescript
async disconnect(): Promise<void> {
  // ... cleanup code ...

  this.subscriptions.clear()  // ← CLEARS subscriptions!

  // But does NOT clear EventManager.handlers!
}
```

After `disconnect()`:

- `EventManager.handlers` still has handlers (developer's intent exists!)
- `AppSession.subscriptions` is empty

If `connect()` is called later:

- `updateSubscriptions()` sends `this.subscriptions` (empty!)
- Cloud clears subscriptions
- But handlers still exist, waiting for events that never come

### Drift Point 2: `updateSubscriptionsFromSettings()`

```typescript
private updateSubscriptionsFromSettings(): void {
  // Get new subscriptions from handler
  const newSubscriptions = this.subscriptionSettingsHandler(this.settingsData)

  // Update all subscriptions at once
  this.subscriptions.clear()  // ← CLEARS subscriptions!
  newSubscriptions.forEach((sub) => this.subscriptions.add(sub))

  // Does NOT modify EventManager.handlers!
}
```

This replaces `subscriptions` without going through `addHandler`/`removeHandler`.

### Drift Point 3: Direct Modification

Any code that directly modifies `this.subscriptions` without going through EventManager can cause drift.

---

## The Bug Scenario

```
Timeline:
─────────────────────────────────────────────────────────────────────────────
T0  │ App running
    │   handlers = { "transcription:en-US": [handler] }
    │   subscriptions = { "transcription:en-US" }
    │   ✓ In sync
    │
T1  │ Something clears subscriptions (disconnect? race condition? unknown)
    │   handlers = { "transcription:en-US": [handler] }  ← Still has handler!
    │   subscriptions = { }  ← Empty!
    │   ✗ OUT OF SYNC
    │
T2  │ WebSocket closes (1006)
    │
T3  │ SDK reconnects
    │   connect() → receives CONNECTION_ACK → updateSubscriptions()
    │   Sends: subscriptions = []  ← Sends the empty set!
    │
T4  │ Cloud receives empty subscriptions
    │   Removes transcription subscription
    │   Mic turns off
    │
T5  │ Developer's handler still exists, but never receives events
    │   App appears "running" but broken
─────────────────────────────────────────────────────────────────────────────
```

---

## The Right Design

### Principle: Handlers ARE Subscriptions

If a handler exists for a stream, we want that stream.
If no handler exists, we don't want it.

**Subscriptions should be DERIVED from handlers, not stored separately.**

### Proposed Change:

```typescript
class EventManager {
  private handlers: Map<ExtendedStreamType, Set<Handler>>

  // NEW: Expose registered streams
  getRegisteredStreams(): ExtendedStreamType[] {
    return Array.from(this.handlers.keys())
  }
}

class AppSession {
  // REMOVE: private subscriptions = new Set<ExtendedStreamType>()

  // NEW: Derive from EventManager
  private getActiveSubscriptions(): ExtendedStreamType[] {
    return this.events.getRegisteredStreams()
  }

  // CHANGE: Send derived subscriptions
  private updateSubscriptions(): void {
    const subs = this.getActiveSubscriptions() // Derive from handlers!

    const subscriptionPayload = subs.map((stream) => {
      const rate = this.streamRates.get(stream)
      if (rate && stream === StreamType.LOCATION_STREAM) {
        return {stream: "location_stream", rate}
      }
      return stream
    })

    this.send({
      type: AppToCloudMessageType.SUBSCRIPTION_UPDATE,
      subscriptions: subscriptionPayload,
      // ...
    })
  }

  // CHANGE: subscribe() just triggers update, doesn't store
  subscribe(sub: SubscriptionRequest): void {
    // Rate handling for location streams
    if (typeof sub !== "string" && sub.rate) {
      this.streamRates.set(sub.stream as ExtendedStreamType, sub.rate)
    }

    // Don't need to add to this.subscriptions - it's derived from handlers!

    if (this.ws?.readyState === 1) {
      this.updateSubscriptions()
    }
  }

  // CHANGE: unsubscribe() just triggers update
  unsubscribe(sub: SubscriptionRequest): void {
    const type = typeof sub === "string" ? sub : sub.stream
    this.streamRates.delete(type as ExtendedStreamType)

    // Don't need to remove from this.subscriptions - it's derived from handlers!

    if (this.ws?.readyState === 1) {
      this.updateSubscriptions()
    }
  }

  // CHANGE: disconnect() doesn't need to clear subscriptions
  async disconnect(): Promise<void> {
    // ... cleanup code ...

    this.ws = null
    this.sessionId = null
    // REMOVE: this.subscriptions.clear()  // No longer needed!
    this.reconnectAttempts = 0
  }
}
```

### Why This Fixes The Bug:

1. **Subscriptions can never be empty if handlers exist**
   - `getActiveSubscriptions()` derives from `handlers`
   - If developer registered handlers, they'll be included

2. **No drift possible**
   - There's only ONE source of truth: `EventManager.handlers`
   - No separate `subscriptions` Set to get out of sync

3. **`disconnect()` can't break subscriptions**
   - Nothing to clear
   - On reconnect, just derive from handlers again

4. **Reconnection automatically works**
   - `connect()` → `CONNECTION_ACK` → `updateSubscriptions()`
   - `updateSubscriptions()` derives from handlers
   - Handlers still exist → correct subscriptions sent

---

## Implementation Notes

### Keeping `streamRates`

We still need `streamRates` for location stream rate options:

```typescript
private streamRates = new Map<ExtendedStreamType, string>()
```

This is separate from subscription tracking and can stay as-is.

### Settings-Based Subscriptions

`updateSubscriptionsFromSettings()` currently clears and rebuilds subscriptions. With the new design:

```typescript
private updateSubscriptionsFromSettings(): void {
  if (!this.subscriptionSettingsHandler) return

  // Get desired subscriptions from settings
  const newSubscriptions = this.subscriptionSettingsHandler(this.settingsData)

  // These should be registered as handlers, not just stored
  // The app using settings-based subscriptions needs to call
  // events.on() for each subscription, not just set them directly

  // Or: we need a different mechanism for settings-based subscriptions
  // that registers/unregisters handlers
}
```

This needs more thought - settings-based subscriptions may need to work differently.

### Direct `subscribe()` Calls

Some code might call `session.subscribe()` directly without using EventManager:

```typescript
// Direct subscription without handler
session.subscribe("some_stream")
```

With the new design, this wouldn't work - you need a handler. This is probably correct behavior (why subscribe without a handler?), but could break existing code.

**Options:**

1. Keep a separate set for "direct subscriptions" without handlers
2. Require all subscriptions to go through handlers (breaking change)
3. Auto-create a no-op handler for direct subscriptions

---

## Migration Path

### Phase 1: Add `getRegisteredStreams()` to EventManager

```typescript
class EventManager {
  getRegisteredStreams(): ExtendedStreamType[] {
    return Array.from(this.handlers.keys())
  }
}
```

### Phase 2: Log Comparison

Add logging to compare handlers vs subscriptions:

```typescript
private updateSubscriptions(): void {
  const fromHandlers = this.events.getRegisteredStreams()
  const fromSet = Array.from(this.subscriptions)

  if (fromHandlers.length !== fromSet.length) {
    this.logger.warn({
      fromHandlers,
      fromSet,
    }, 'SUBSCRIPTION DRIFT DETECTED: handlers and subscriptions out of sync!')
  }

  // Send fromSet (current behavior)
}
```

This will confirm drift is happening and help identify when.

### Phase 3: Switch to Derived Subscriptions

Change `updateSubscriptions()` to use derived subscriptions:

```typescript
private updateSubscriptions(): void {
  // NEW: Derive from handlers instead of using this.subscriptions
  const subs = this.events.getRegisteredStreams()
  // ... send subs ...
}
```

### Phase 4: Remove `this.subscriptions`

Once derived subscriptions are working, remove the redundant Set.

---

## Testing Plan

1. **Unit Test: Drift Detection**
   - Register handler
   - Call `disconnect()`
   - Verify subscriptions would be derived from handlers (not empty)

2. **Unit Test: Reconnection**
   - Register handler
   - Simulate disconnect + reconnect
   - Verify correct subscriptions sent

3. **Integration Test: Full Flow**
   - Start Captions app
   - Verify transcription working
   - Force WebSocket 1006
   - Verify subscriptions preserved through reconnect

4. **Regression Test: Settings-Based Subscriptions**
   - Apps using `setSubscriptionSettings()` still work

---

## Files to Modify

| File                                     | Changes                                                |
| ---------------------------------------- | ------------------------------------------------------ |
| `packages/sdk/src/app/session/events.ts` | Add `getRegisteredStreams()` method                    |
| `packages/sdk/src/app/session/index.ts`  | Change `updateSubscriptions()` to derive from handlers |
| `packages/sdk/src/app/session/index.ts`  | Update `subscribe()`, `unsubscribe()`, `disconnect()`  |
| `packages/sdk/src/app/session/index.ts`  | Remove or deprecate `this.subscriptions` Set           |

---

## Summary

**Root Cause:** Dual storage of subscription state (handlers + subscriptions Set) allows drift.

**Evidence:** `disconnect()` clears `subscriptions` but not `handlers`.

**Fix:** Derive subscriptions from handlers. Single source of truth = no drift.

**Impact:** Eliminates entire class of subscription-related bugs, not just Bug 2.
