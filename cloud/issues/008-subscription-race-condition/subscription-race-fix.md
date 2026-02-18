# Subscription Race Condition Fix

## Implementation

Serialize subscription update processing per-app using a promise chain owned by `AppSession`.

## Architecture Decision

**Queue location: `AppSession`** (not message handler or SubscriptionManager)

Why AppSession:

- **Per-app state belongs in AppSession** - queue is inherently per-app
- **Automatic cleanup** - queue dies when AppSession.dispose() is called
- **Encapsulation** - callers don't need to know about serialization
- **Single responsibility** - AppSession already manages connection state, subscriptions, heartbeats

Why NOT message handler:

- Handlers should be stateless routing
- Module-level Map requires manual cleanup functions
- Queue management decoupled from the state it's serializing

Why NOT SubscriptionManager:

- SubscriptionManager coordinates across apps, not per-app state
- Would need to maintain Map<packageName, Promise> which is AppSession's job

## Key Changes

### File: `packages/cloud/src/services/session/AppSession.ts`

Add queue and enqueue method:

```typescript
// Add to class properties
private updateQueue: Promise<void> = Promise.resolve();

/**
 * Queue an async operation to be serialized with other updates for this app.
 * Ensures operations complete in the order they arrive.
 *
 * Used to prevent race conditions when multiple subscription updates
 * arrive rapidly (e.g., during app startup).
 */
async enqueue<T>(operation: () => Promise<T>): Promise<T> {
  let result!: T;
  let error: Error | null = null;

  this.updateQueue = this.updateQueue
    .then(async () => {
      try {
        result = await operation();
      } catch (e) {
        error = e as Error;
        this.logger.error({ error: e }, "Queued operation failed");
      }
    });

  await this.updateQueue;

  if (error) throw error;
  return result;
}
```

### File: `packages/cloud/src/services/session/SubscriptionManager.ts`

Wrap updateSubscriptions in enqueue:

```typescript
async updateSubscriptions(
  packageName: string,
  subscriptions: SubscriptionRequest[],
): Promise<void> {
  const appSession = this.userSession.appManager.getOrCreateAppSession(packageName);
  if (!appSession) {
    this.logger.warn({ packageName }, "Cannot update subscriptions - AppManager disposed");
    return;
  }

  // Serialize subscription updates per-app to prevent race conditions.
  // Multiple updates can arrive rapidly during startup and would otherwise
  // process concurrently, causing the wrong final state.
  await appSession.enqueue(async () => {
    await this.processSubscriptionUpdate(appSession, packageName, subscriptions);
  });
}

/**
 * Internal implementation of subscription update processing.
 * Called from the serialized queue to ensure updates are processed in order.
 */
private async processSubscriptionUpdate(
  appSession: AppSession,
  packageName: string,
  subscriptions: SubscriptionRequest[],
): Promise<void> {
  // ... existing updateSubscriptions logic moves here ...
}
```

## Why This Works

```
Before (race condition):
  Message 1 arrives → starts processing ─────────────────────┐
  Message 2 arrives → starts processing ──────────┐          │
  Message 3 arrives → starts processing ──┐       │          │
                                          ↓       ↓          ↓
                                       finish  finish     finish
                                       (3rd)   (1st)      (2nd)
  Final state = Message 1's payload (WRONG - arrived first, finished last)

After (serialized via AppSession.enqueue):
  Message 1 arrives → appSession.enqueue() → processing → done
  Message 2 arrives → appSession.enqueue() ───────────────→ processing → done
  Message 3 arrives → appSession.enqueue() ─────────────────────────────→ processing → done
  Final state = Message 3's payload (CORRECT)
```

## Data Flow

```
WebSocket message arrives
  → app-message-handler.handleSubscriptionUpdate()
    → userSession.subscriptionManager.updateSubscriptions()
      → appSession.enqueue(...)  ← serialization happens here
        → processSubscriptionUpdate()
          → appSession.updateSubscriptions() (state update)
          → syncManagers() (downstream effects)
```

## Cleanup

No explicit cleanup needed. When `AppSession.dispose()` is called:

- The queue promise chain is garbage collected
- Any pending operations will complete or be ignored (session is ending anyway)

## Testing

### Manual Test

1. Deploy fix to cloud-debug
2. Start Recorder dev app for test user
3. Check logs - subscription updates should process in order
4. Verify final state includes both `audio_chunk` AND `transcription:en-US`

### Automated Test

```typescript
describe("AppSession.enqueue", () => {
  it("processes operations in arrival order", async () => {
    const appSession = new AppSession(/* ... */)
    const results: number[] = []

    // Start all operations "simultaneously"
    const ops = [
      appSession.enqueue(async () => {
        await delay(50)
        results.push(1)
      }),
      appSession.enqueue(async () => {
        await delay(10)
        results.push(2)
      }),
      appSession.enqueue(async () => {
        await delay(1)
        results.push(3)
      }),
    ]

    await Promise.all(ops)

    // Despite different delays, should complete in arrival order
    expect(results).toEqual([1, 2, 3])
  })
})

describe("SubscriptionManager", () => {
  it("processes subscription updates in arrival order", async () => {
    const updates = [[], ["audio_chunk"], ["audio_chunk", "transcription:en-US"]]

    // Send all updates rapidly
    await Promise.all(updates.map((subs) => subscriptionManager.updateSubscriptions("test.app", subs)))

    // Final state should be the last update
    const finalState = appSession.getSubscriptions()
    expect(finalState).toEqual(new Set(["audio_chunk", "transcription:en-US"]))
  })
})
```

## Rollout

1. Add `enqueue()` to `AppSession`
2. Refactor `SubscriptionManager.updateSubscriptions()` to use it
3. Remove any queue-related code from `app-message-handler.ts` (if added during debugging)
4. Test on cloud-debug with Recorder dev
5. If stable, deploy to cloud-prod

## Future: SDK Optimization

After cloud fix is deployed, can optionally fix SDK to reduce message count:

```typescript
// In packages/sdk/src/app/session/index.ts handleMessage()
// After CONNECTION_ACK processing:

this.events.emit("connected", this.settingsData)

// REMOVE this line - redundant, handlers aren't set up yet
// this.updateSubscriptions();
```

This reduces subscription messages from 3 to 2 during startup, but is not required for correctness after the cloud fix.
