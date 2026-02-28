# SDK Reconnect Sends Empty Subscriptions Bug

> **STATUS**: Root cause NOT yet confirmed. See **007-subscription-timing-bug.md** for ongoing investigation.

## Summary

During SDK reconnection (after WebSocket 1006 closure), the SDK sends an empty subscriptions array to the cloud, causing transcription to stop and the microphone to turn off. The exact mechanism by which subscriptions become empty is still under investigation.

## Discovery

Found during live debugging on 2025-12-10 ~21:30 UTC while investigating why captions stopped working for user `isaiah@mentra.glass` on `cloud-debug` without any server switching.

## Evidence

### Timeline from BetterStack Logs

| Time                | Event                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------- |
| 21:30:43.800        | Transcription working: "Has H." (FINAL)                                                      |
| 21:30:45.762        | App WebSocket closed (code 1006)                                                             |
| 21:30:45.763        | "App com.mentra.captions.beta unexpectedly disconnected (code: 1006), starting grace period" |
| 21:30:46.179-46.797 | Multiple "Failed to send transcription data to App" warnings                                 |
| 21:30:47.095        | App reconnected, API key validated                                                           |
| 21:30:47.126        | **"App connected (not from startApp) - moved to runningApps"**                               |
| 21:30:47.192        | **Received subscription update with EMPTY array**                                            |
| 21:30:47.225        | "App removed from transcription set"                                                         |
| 21:30:47.225        | "No active subscriptions - all streams cleaned up"                                           |
| 21:30:47.330        | "Receiving unauthorized audio - forcing mic off immediately"                                 |

### Critical Evidence: "not from startApp"

The log `"App connected (not from startApp)"` proves:

- There was **NO** pending connection from `startApp()`
- This was **NOT** a resurrection webhook
- This was a direct SDK auto-reconnect using the **SAME AppSession object**

This disproves our initial theory that a new AppSession with empty subscriptions was created.

### Raw Message Proof

The cloud logged the exact message received from the SDK:

```json
{
  "type": "subscription_update",
  "packageName": "com.mentra.captions.beta",
  "subscriptions": [],
  "sessionId": "isaiah@mentra.glass-com.mentra.captions.beta",
  "timestamp": "2025-12-10T21:30:47.162Z"
}
```

**The SDK sent `subscriptions: []` - an empty array!**

### SubscriptionManager Delta Log

```
applyDelta called:
  packageName: com.mentra.captions.beta
  oldCount: 1
  newCount: 0
  oldSubs: ["transcription:en-US"]
  newSubs: []
```

The cloud had `transcription:en-US` for this app, but the SDK sent empty subscriptions, causing removal.

## The Mystery

If it's the same AppSession reconnecting (not a new one from webhook), **why is `this.subscriptions` empty?**

The SDK's `connect()` method explicitly preserves subscriptions:

```typescript
if (this.ws) {
  // Don't call full dispose() as that would clear subscriptions
  if (this.ws.readyState !== 3) {
    this.ws.close()
  }
  this.ws = null
}
```

### Places That Could Clear Subscriptions

```typescript
// 1. AppSession.disconnect() - explicitly clears
async disconnect(): Promise<void> {
  this.subscriptions.clear()
}

// 2. AppSession.updateSubscriptionsFromSettings() - clears and rebuilds
private updateSubscriptionsFromSettings(): void {
  this.subscriptions.clear()
  newSubscriptions.forEach((sub) => this.subscriptions.add(sub))
}

// 3. Individual unsubscribe() calls via cleanup handlers
unsubscribe(sub: SubscriptionRequest): void {
  this.subscriptions.delete(type)
}
```

### What We've Ruled Out

| Possibility                         | Ruled Out? | Reason                                            |
| ----------------------------------- | ---------- | ------------------------------------------------- |
| Resurrection webhook                | ✅ Yes     | Log says "not from startApp"                      |
| `updateSubscriptionsFromSettings()` | ✅ Yes     | Captions doesn't use settings-based subscriptions |
| `disconnect()` called               | ❓ Unknown | No log evidence either way                        |
| Captions `dispose()` called         | ❓ Unknown | Would call `transcriptionCleanup()`               |
| `onStop` called unexpectedly        | ❓ Unknown | Would trigger `dispose()`                         |

## This Bug vs Environment-Switch Bug

| Aspect                 | Environment-Switch Bug (002)    | This Bug (005)             |
| ---------------------- | ------------------------------- | -------------------------- |
| Trigger                | User switches cloud servers     | WebSocket 1006 + reconnect |
| Webhook involved       | Yes (new webhook to new cloud)  | **No** (same AppSession)   |
| New AppSession created | Yes (on new cloud)              | **No** (same object)       |
| Subscriptions          | Sent to wrong cloud             | Sent empty to same cloud   |
| Root cause             | `onStop` disposes wrong session | **Unknown**                |

## Impact

- Affects **any** app using SDK auto-reconnection
- WebSocket 1006 errors are common (network hiccups, proxy timeouts)
- App appears "running" but produces no output
- User must manually restart app to recover

## Investigation Needed

### 1. Add Logging to Track Subscription Modifications

```typescript
// In AppSession
subscribe(sub): void {
  this.logger.debug(`subscribe() called: ${sub}, count: ${this.subscriptions.size}`)
  // ...
}

unsubscribe(sub): void {
  this.logger.debug(`unsubscribe() called: ${sub}, count: ${this.subscriptions.size}`)
  // ...
}

disconnect(): void {
  this.logger.warn(`disconnect() called - will clear subscriptions!`)
  // ...
}
```

### 2. Log Subscription Count in updateSubscriptions()

```typescript
private updateSubscriptions(): void {
  this.logger.info(`updateSubscriptions: count=${this.subscriptions.size}`)
  // ...
}
```

### 3. Track Captions dispose() Calls

```typescript
// Captions UserSession
dispose() {
  console.log(`[Captions] dispose() called for user ${this.userId}`)
  // ...
}
```

## Questions to Answer

1. Is `disconnect()` being called somewhere during auto-reconnection?
2. Is the Captions app's `onDisconnected` handler doing something unexpected?
3. Is there a race condition between close handler and reconnection?
4. Why does the grace window in SubscriptionManager not catch this?
5. Is `onStop` being called unexpectedly for non-permanent disconnections?

## Related Files

- `packages/sdk/src/app/session/index.ts` - AppSession with subscriptions
- `packages/sdk/src/app/session/events.ts` - EventManager subscription handling
- `packages/sdk/src/app/server/index.ts` - AppServer onDisconnected handling
- `packages/apps/captions/src/app/session/UserSession.ts` - Captions subscription setup
- `packages/cloud/src/services/session/SubscriptionManager.ts` - Cloud subscription handling

## Status

- [x] Bug identified and documented
- [x] Evidence collected from logs
- [x] Resurrection theory disproven by "not from startApp" log
- [ ] Root cause confirmed (need more investigation)
- [ ] Diagnostic logging added
- [ ] Bug reproduced with enhanced logging
- [ ] Fix implemented
- [ ] Fix verified

## Related Documents

- **007-subscription-timing-bug.md** - Ongoing investigation into root cause
- **008-system-confusion-points.md** - System complexity that makes debugging hard
- **002-session-lifecycle-bug.md** - Environment switch bug (different issue)
