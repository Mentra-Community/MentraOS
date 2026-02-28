# Mic-On Intermittent Failure Investigation

## Issue Summary

**Date**: ~12:42-45pm PST (reported ~1 hour after occurrence)
**SDK Version**: 2.1.30-beta.1
**Apps Involved**:
- `flash.flash.flash` (captions app running locally)
- `com.mentra.captions.beta` (captions running on porter/cloud)

**Key Difference from Previous Issues**: Mic was ON (previous Bug 005/007 was about empty subscriptions on reconnect)

## Symptoms

1. Something was "off" briefly - exact symptom unclear (transcription stopped? audio not flowing?)
2. Turning on/off the app (at least `com.mentra.captions.beta`) didn't immediately fix it
3. Self-recovered after leaving it running for a few minutes
4. User was switching between the two apps

## Context: What's Different Here

| Aspect | Previous Bug (005/007) | This Issue |
|--------|------------------------|------------|
| Mic state | Off/irrelevant | ON |
| Subscriptions | Empty on reconnect | Unknown - possibly present but wrong? |
| Recovery | Required manual intervention | Self-recovered after minutes |
| Trigger | Reconnection after 1006 | App switching |
| Fix applied | Phase 1a+1b (derive from handlers + terminated flag) | Same SDK version |

## Hypotheses

### Hypothesis 1: Subscription Update Race Condition

When switching between two apps rapidly, subscription updates might race:

```
Timeline:
t0: User has com.mentra.captions.beta active with AUDIO_CHUNK subscription
t1: User switches to flash.flash.flash
t2: Cloud processes app switch, starts cleaning up beta's session
t3: flash.flash.flash sends its subscription update
t4: Beta's cleanup completes, might affect shared state?
t5: User switches back to beta
t6: Beta reconnects but subscription state is inconsistent
```

**Why self-recovery?**: Eventually a correct subscription update comes through

### Hypothesis 2: Cross-Environment Session Contamination (Bug 001 variant)

Since both apps are different instances:
- `flash.flash.flash` is LOCAL (localhost cloud)
- `com.mentra.captions.beta` is PORTER (cloud-debug or cloud-dev)

They shouldn't share state, BUT:
- If both connect to the same cloud instance (unlikely but possible with config)
- Or if the mobile app's session management conflates them

**Why self-recovery?**: Cloud's periodic state sync eventually corrects it

### Hypothesis 3: Terminated Flag Set Incorrectly

The Phase 1b `terminated` flag is set when "User session ended" is received:

```typescript
if (isUserSessionEnded) {
  this.terminated = true
  this.logger.info(
    `🛑 [${this.config.packageName}] User session ended - marking as terminated, no reconnection allowed`,
  )
}
```

If the terminated flag gets set during an app switch but the AppSession instance is reused:
- New connection attempts are blocked
- No reconnection happens
- App appears stuck

**Why self-recovery?**: A new session instance is eventually created by the AppServer

### Hypothesis 4: Audio Relay Timing Gap

The AudioManager checks subscriptions before relaying:

```typescript
const subscribedPackageNames =
  this.userSession.subscriptionManager.getSubscribedApps(
    StreamType.AUDIO_CHUNK,
  );

if (subscribedPackageNames.length === 0) {
  // Audio not relayed
  return;
}
```

If there's a brief window where:
1. WebSocket is connected
2. But subscriptions haven't propagated yet
3. Audio chunks are dropped

**Why self-recovery?**: Subscription update eventually arrives

### Hypothesis 5: Reconnect Grace Window Edge Case

The SubscriptionManager has an 8-second grace window:

```typescript
if (
  processed.length === 0 &&
  now - lastReconnect <= this.CONNECT_GRACE_MS
) {
  this.logger.warn(
    { userId: this.userSession.userId, packageName },
    "Ignoring empty subscription update within reconnect grace window",
  );
  return; // Skip applying empty update
}
```

Edge case: What if a NON-empty but WRONG subscription update arrives during the grace window? It would be applied, potentially overwriting correct state.

**Why self-recovery?**: Next subscription update after grace window corrects it

## Investigation Steps

### Step 1: Gather Logs

Need logs from the incident timeframe (~12:42-45pm PST) for:

1. **Cloud logs (porter)**:
   - Subscription updates for `com.mentra.captions.beta`
   - App lifecycle events (start/stop/switch)
   - `hasPCMTranscriptionSubscriptions` results
   - AudioManager relay decisions

2. **SDK logs (from both apps)**:
   - Reconnection attempts
   - Subscription derivation (`derived from handlers`)
   - WebSocket state changes
   - Terminated flag state

3. **Mobile app logs**:
   - Session switching events
   - App activation/deactivation

### Step 2: Reproduce

Try to reproduce by:

1. Run both apps simultaneously
2. Rapidly switch between them
3. Observe:
   - Does transcription stop?
   - Does audio relay stop?
   - What do logs show for subscription state?

### Step 3: Add Instrumentation

If can't reproduce with current logging, add:

```typescript
// In SubscriptionManager.updateSubscriptions()
this.logger.info({
  packageName,
  incoming: subscriptions,
  current: this.subscriptions.get(packageName),
  gracePeriodActive: now - lastReconnect <= this.CONNECT_GRACE_MS,
  timeSinceReconnect: now - lastReconnect,
}, "Subscription update received (detailed)");
```

```typescript
// In AudioManager.relayAudioToApps()
if (subscribedPackageNames.length === 0) {
  this.logger.warn({
    allSubscriptions: Object.fromEntries(
      this.userSession.subscriptionManager.subscriptions
    ),
    runningApps: this.userSession.runningApps,
  }, "AUDIO_CHUNK: no subscribers - dumping state");
}
```

## Relationship to Other Bugs

| Bug | Status | Relationship |
|-----|--------|--------------|
| 001 (Wrong Session Disposed) | Root cause known | Could be related - env switch |
| 002 (Session Lifecycle) | Analyzed | Could be contributing |
| 005/007 (Empty Subscriptions) | Fixed (Phase 1a) | Different - mic was off |
| 011 (Dual Storage Drift) | Fixed (Phase 1a) | Fix should prevent this |
| Phase 1b (Terminated Flag) | Implemented | Could be incorrectly blocking |

## Questions to Answer

1. **What exactly was "off"?** 
   - Transcription not appearing?
   - Audio not flowing to app?
   - App UI frozen?
   - Something else?

2. **What does "turning on and off the app" mean?**
   - Toggling in mobile app's app list?
   - Stopping and starting the app server?
   - Closing and reopening the connection?

3. **What was the recovery trigger?**
   - Did it happen automatically?
   - Did the user do something?
   - Did an external event (webhook, restart) occur?

4. **Were both apps running simultaneously?**
   - Or was it switch from one to the other?
   - What was the switching mechanism?

## Key System Findings

### No Periodic Subscription Refresh

The SDK does **not** have a periodic mechanism to resend subscriptions. Subscriptions are only sent:
1. On initial connect (`updateSubscriptions()` called after `CONNECTION_ACK`)
2. When a handler is added/removed (`subscribe()`/`unsubscribe()`)
3. On reconnection (derived from handlers - Phase 1a fix)

### Cloud-Side Heartbeat

The cloud has heartbeat mechanisms but they're WebSocket ping/pong only:
- **Glasses**: 10-second ping interval with 30-second pong timeout
- **Apps**: 10-second ping interval

These heartbeats do NOT trigger subscription updates.

### Subscription Update Flow

```
SDK                         Cloud
 │                            │
 │  SUBSCRIPTION_UPDATE       │
 │  {subscriptions: [...]}    │
 │ ─────────────────────────► │
 │                            │
 │                            ├─► SubscriptionManager.updateSubscriptions()
 │                            │    ├─► Permission check
 │                            │    ├─► Apply delta to subscriptions map
 │                            │    ├─► syncManagers() (transcription, translation, location, calendar)
 │                            │    └─► microphoneManager.handleSubscriptionChange()
 │                            │
```

### Self-Recovery Hypothesis: Webhook Re-invocation

Given that there's no periodic refresh, the most likely self-recovery mechanism is:

1. **Cloud-initiated app restart**: If the cloud detected an issue, it may have sent a webhook to restart the app
2. **New session created**: `onSession` would be called fresh, new handlers registered, new subscriptions sent
3. **This explains the delay**: Webhook retry logic or cloud health checks might have triggered after a few minutes

### Subscription Debouncing

The cloud has a 500ms debounce for subscription changes:

```typescript
private readonly SUBSCRIPTION_DEBOUNCE_MS = 500; // 500ms debounce
```

And an 8-second reconnect grace window:

```typescript
private readonly CONNECT_GRACE_MS = 8000; // 8 seconds for slower reconnects
```

This debouncing could potentially delay or coalesce updates in edge cases.

## Potential Fixes (Pending Investigation)

### If Hypothesis 1 (Race Condition)

Add subscription update debouncing or sequencing per app

### If Hypothesis 2 (Cross-Environment)

Implement OWNERSHIP_RELEASE protocol (Phase 2)

### If Hypothesis 3 (Terminated Flag)

Add mechanism to clear terminated flag on explicit reconnect:

```typescript
async connect(sessionId: string): Promise<void> {
  // Clear terminated flag on explicit connect call
  if (this.terminated) {
    this.logger.info('Clearing terminated flag for explicit reconnect');
    this.terminated = false;
  }
  // ...
}
```

### If Hypothesis 4 (Audio Relay Gap)

Add subscription verification before processing audio:

```typescript
// Wait for subscriptions to be confirmed before starting audio relay
```

### If Hypothesis 5 (Grace Window Edge Case)

Modify grace window to only ignore EMPTY updates, not all updates

### Add SDK-Side Periodic Subscription Sync (New)

Add a periodic subscription sync to prevent drift:

```typescript
// In AppSession, after connection established
private startSubscriptionSync(): void {
  const SYNC_INTERVAL = 60000; // 60 seconds
  
  this.resources.setInterval(() => {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const currentSubs = this.events.getRegisteredStreams();
      this.logger.debug({
        subscriptions: currentSubs,
        count: currentSubs.length
      }, 'Periodic subscription sync');
      this.updateSubscriptions();
    }
  }, SYNC_INTERVAL);
}
```

This would:
- Ensure subscriptions are re-sent periodically
- Catch any drift that occurred
- Provide self-healing capability

## Next Steps

1. [ ] Get exact symptom description from user
2. [ ] Collect logs from incident timeframe
3. [ ] Attempt reproduction
4. [ ] Add instrumentation if needed
5. [ ] Identify root cause
6. [ ] Implement fix
7. [ ] Consider adding periodic subscription sync to SDK

## Quick Diagnostic Questions for User

To help narrow down the issue:

1. **What exactly stopped working?**
   - [ ] Transcription text not appearing on glasses
   - [ ] Audio not flowing to app (no `onAudioChunk` callbacks)
   - [ ] App UI completely frozen
   - [ ] Something else: ___

2. **How was "turning on and off the app" done?**
   - [ ] Toggle switch in MentraOS mobile app
   - [ ] Stopping app server process and restarting
   - [ ] Other: ___

3. **What triggered recovery?**
   - [ ] Happened automatically after waiting
   - [ ] Did something specific (describe): ___
   - [ ] Cloud-side restart visible in logs

4. **App switching pattern:**
   - [ ] Both apps running simultaneously
   - [ ] One at a time (switching between)
   - [ ] Local vs cloud pointing to same or different cloud instances

---

## Log Queries to Run

### Better Stack / Cloud Logs

```sql
-- Subscription updates around incident time
SELECT timestamp, message, packageName, subscriptions
FROM logs
WHERE timestamp BETWEEN '2024-XX-XX 20:42:00' AND '2024-XX-XX 20:50:00'
  AND (message LIKE '%subscription%' OR message LIKE '%AUDIO_CHUNK%')
  AND packageName IN ('flash.flash.flash', 'com.mentra.captions.beta')
ORDER BY timestamp
```

```sql
-- Check for webhook invocations (would indicate cloud-triggered restart)
SELECT timestamp, message, packageName, type
FROM logs
WHERE timestamp BETWEEN '2024-XX-XX 20:42:00' AND '2024-XX-XX 20:50:00'
  AND (message LIKE '%webhook%' OR message LIKE '%onSession%' OR message LIKE '%app start%')
ORDER BY timestamp
```

```sql
-- Check heartbeat/connection state
SELECT timestamp, message, packageName
FROM logs
WHERE timestamp BETWEEN '2024-XX-XX 20:42:00' AND '2024-XX-XX 20:50:00'
  AND (message LIKE '%ping%' OR message LIKE '%pong%' OR message LIKE '%heartbeat%')
  AND packageName IN ('flash.flash.flash', 'com.mentra.captions.beta')
ORDER BY timestamp
```

### Things to Look For in Logs

1. `"Ignoring empty subscription update within reconnect grace window"` - grace window triggered
2. `"AUDIO_CHUNK: no subscribed apps"` - audio not being relayed
3. `"User session ended - marking as terminated"` - terminated flag set
4. `"Updated subscriptions successfully"` - subscription changes
5. `"Reconnection attempt"` - SDK reconnection attempts
6. `"derived from handlers"` - Phase 1a working correctly
7. `"webhook"` or `"onSession"` - Cloud-triggered app restart (would explain recovery)
8. `"Language subscriptions changed"` - Subscription changes being processed
9. `"Applying debounced transcription stream update"` - Debounced update applied
10. `"##SUBSCRIPTION_ERROR##"` - Subscription update failures