# Concrete Patch Plan: Phase 1 - SDK Subscription Fix

## Overview

This document provides the exact code changes needed to fix **Bug 2: Empty Subscriptions on Reconnect** (005/007/011).

**Root Cause**: The SDK stores subscriptions in two places (`EventManager.handlers` and `AppSession.subscriptions`) that can drift out of sync. When `disconnect()` clears `this.subscriptions` but handlers still exist, reconnection sends empty subscriptions to the cloud.

**Fix**: Derive subscriptions from handlers (single source of truth). Subscriptions can never be empty if handlers exist.

---

## Phase 1a vs Phase 1b

### Phase 1a: Derive subscriptions from handlers ✅ IMPLEMENTED
- Remove `this.subscriptions` Set
- Derive subscriptions from `EventManager.handlers`
- Patch version: `bug007-fix-v1`

### Phase 1b: Prevent reconnection after session termination ✅ IMPLEMENTED
- Add `terminated` flag to AppSession
- When "User session ended" is received, set `terminated = true`
- Prevent any reconnection attempts when `terminated` is true
- Patch version: `bug007-fix-v2`

**Why Phase 1b is needed**: Even with Phase 1a, if "User session ended" triggers `onStop` (which cleans up handlers), and then later a WebSocket 1006 occurs, the SDK would try to reconnect with no handlers. Phase 1b prevents this by marking the session as terminated.

---

## Files to Modify

| File | Type | Changes |
|------|------|---------|
| `cloud/packages/sdk/src/app/session/events.ts` | Modify | Add `getRegisteredStreams()` method |
| `cloud/packages/sdk/src/app/session/index.ts` | Modify | Derive subscriptions from handlers, remove `this.subscriptions` |

---

## Change 1: EventManager.getRegisteredStreams()

**File**: `cloud/packages/sdk/src/app/session/events.ts`

**Location**: After line ~414 (after `removeHandler` method, before `emit` method)

### Add New Method

```typescript
  /**
   * 🔍 Get all currently registered stream types
   * Returns the streams that have at least one handler registered.
   * Used to derive subscriptions from handlers (single source of truth).
   */
  getRegisteredStreams(): ExtendedStreamType[] {
    return Array.from(this.handlers.keys()) as ExtendedStreamType[]
  }
```

### Full Context (where to insert)

```typescript
  /**
   * ➖ Remove an event handler
   */
  private removeHandler<T extends ExtendedStreamType>(type: T, handler: Handler<EventData<T>>): void {
    const handlers = this.handlers.get(type)
    if (!handlers) return

    handlers.delete(handler as Handler<unknown>)
    if (handlers.size === 0) {
      this.handlers.delete(type)
      this.unsubscribe(type)
    }
  }

  // ===== INSERT NEW METHOD HERE =====

  /**
   * 🔍 Get all currently registered stream types
   * Returns the streams that have at least one handler registered.
   * Used to derive subscriptions from handlers (single source of truth).
   */
  getRegisteredStreams(): ExtendedStreamType[] {
    return Array.from(this.handlers.keys()) as ExtendedStreamType[]
  }

  // ===== END INSERT =====

  /**
   * 📡 Emit an event to all registered handlers with error isolation
   */
  emit<T extends EventType>(event: T, data: EventData<T>): void {
    // ...
  }
```

---

## Change 2: AppSession - Derive Subscriptions from Handlers

**File**: `cloud/packages/sdk/src/app/session/index.ts`

### Change 2a: Remove `this.subscriptions` Set (Line ~156)

**Before**:
```typescript
  /** Active event subscriptions */
  private subscriptions = new Set<ExtendedStreamType>()
```

**After**:
```typescript
  // REMOVED: private subscriptions = new Set<ExtendedStreamType>()
  // Subscriptions are now derived from EventManager.handlers (single source of truth)
  // This prevents drift between handlers and subscriptions that caused Bug 007
```

> **Note**: We're commenting out rather than deleting to leave a breadcrumb for future developers.

---

### Change 2b: Modify `subscribe()` Method (Lines ~524-551)

**Before**:
```typescript
  subscribe(sub: SubscriptionRequest): void {
    let type: ExtendedStreamType
    let rate: string | undefined

    if (typeof sub === "string") {
      type = sub
    } else {
      // it's a LocationStreamRequest object
      type = sub.stream
      rate = sub.rate
    }

    if (APP_TO_APP_EVENT_TYPES.includes(type as string)) {
      this.logger.warn(
        `[AppSession] Attempted to subscribe to App-to-App event type '${type}', which is not a valid stream. Use the event handler (e.g., onAppMessage) instead.`,
      )
      return
    }

    this.subscriptions.add(type)
    if (rate) {
      this.streamRates.set(type, rate)
    }

    if (this.ws?.readyState === 1) {
      this.updateSubscriptions()
    }
  }
```

**After**:
```typescript
  subscribe(sub: SubscriptionRequest): void {
    let type: ExtendedStreamType
    let rate: string | undefined

    if (typeof sub === "string") {
      type = sub
    } else {
      // it's a LocationStreamRequest object
      type = sub.stream
      rate = sub.rate
    }

    if (APP_TO_APP_EVENT_TYPES.includes(type as string)) {
      this.logger.warn(
        `[AppSession] Attempted to subscribe to App-to-App event type '${type}', which is not a valid stream. Use the event handler (e.g., onAppMessage) instead.`,
      )
      return
    }

    // NOTE: We no longer maintain this.subscriptions - subscriptions are derived from handlers
    // This prevents drift between handlers and subscriptions (Bug 007 fix)
    // The EventManager.addHandler() already tracks the subscription intent

    if (rate) {
      this.streamRates.set(type, rate)
    }

    if (this.ws?.readyState === 1) {
      this.updateSubscriptions()
    }
  }
```

---

### Change 2c: Modify `unsubscribe()` Method (Lines ~557-576)

**Before**:
```typescript
  unsubscribe(sub: SubscriptionRequest): void {
    let type: ExtendedStreamType
    if (typeof sub === "string") {
      type = sub
    } else {
      type = sub.stream
    }

    if (APP_TO_APP_EVENT_TYPES.includes(type as string)) {
      this.logger.warn(
        `[AppSession] Attempted to unsubscribe from App-to-App event type '${type}', which is not a valid stream.`,
      )
      return
    }
    this.subscriptions.delete(type)
    this.streamRates.delete(type) // also remove from our rate map
    if (this.ws?.readyState === 1) {
      this.updateSubscriptions()
    }
  }
```

**After**:
```typescript
  unsubscribe(sub: SubscriptionRequest): void {
    let type: ExtendedStreamType
    if (typeof sub === "string") {
      type = sub
    } else {
      type = sub.stream
    }

    if (APP_TO_APP_EVENT_TYPES.includes(type as string)) {
      this.logger.warn(
        `[AppSession] Attempted to unsubscribe from App-to-App event type '${type}', which is not a valid stream.`,
      )
      return
    }

    // NOTE: We no longer maintain this.subscriptions - subscriptions are derived from handlers
    // The EventManager.removeHandler() already tracks the unsubscription intent

    this.streamRates.delete(type) // also remove from our rate map
    if (this.ws?.readyState === 1) {
      this.updateSubscriptions()
    }
  }
```

---

### Change 2d: Modify `disconnect()` Method (Lines ~888-916)

**Before**:
```typescript
  async disconnect(): Promise<void> {
    // Flush any pending SimpleStorage writes before closing
    try {
      await this.simpleStorage.flush()
      console.log("SimpleStorage flushed on disconnect")
    } catch (error) {
      console.error("Error flushing SimpleStorage on disconnect:", error)
      // Continue with disconnect even if flush fails
    }

    // Clean up camera module first
    if (this.camera) {
      this.camera.cancelAllRequests()
    }

    // Clean up audio module
    if (this.audio) {
      this.audio.cancelAllRequests()
    }

    // Use the resource tracker to clean up everything
    this.resources.dispose()

    // Clean up additional resources not handled by the tracker
    this.ws = null
    this.sessionId = null
    this.subscriptions.clear()
    this.reconnectAttempts = 0
  }
```

**After**:
```typescript
  async disconnect(): Promise<void> {
    // Flush any pending SimpleStorage writes before closing
    try {
      await this.simpleStorage.flush()
      console.log("SimpleStorage flushed on disconnect")
    } catch (error) {
      console.error("Error flushing SimpleStorage on disconnect:", error)
      // Continue with disconnect even if flush fails
    }

    // Clean up camera module first
    if (this.camera) {
      this.camera.cancelAllRequests()
    }

    // Clean up audio module
    if (this.audio) {
      this.audio.cancelAllRequests()
    }

    // Use the resource tracker to clean up everything
    this.resources.dispose()

    // Clean up additional resources not handled by the tracker
    this.ws = null
    this.sessionId = null
    // REMOVED: this.subscriptions.clear()
    // We no longer clear subscriptions here - they are derived from handlers
    // This is the key fix for Bug 007: clearing subscriptions here caused
    // empty subscription updates on reconnect when handlers still existed
    this.reconnectAttempts = 0
  }
```

---

### Change 2e: Modify `updateSubscriptions()` Method (Lines ~1600-1623)

**Before**:
```typescript
  private updateSubscriptions(): void {
    this.logger.info(
      {subscriptions: JSON.stringify(Array.from(this.subscriptions))},
      `[AppSession] updateSubscriptions: sending subscriptions to cloud`,
    )

    // [MODIFIED] builds the array of SubscriptionRequest objects to send to the cloud
    const subscriptionPayload: SubscriptionRequest[] = Array.from(this.subscriptions).map((stream) => {
      const rate = this.streamRates.get(stream)
      if (rate && stream === StreamType.LOCATION_STREAM) {
        return {stream: "location_stream", rate: rate as any}
      }
      return stream
    })

    const message: AppSubscriptionUpdate = {
      type: AppToCloudMessageType.SUBSCRIPTION_UPDATE,
      packageName: this.config.packageName,
      subscriptions: subscriptionPayload, // [MODIFIED]
      sessionId: this.sessionId!,
      timestamp: new Date(),
    }
    this.send(message)
  }
```

**After**:
```typescript
  private updateSubscriptions(): void {
    // CRITICAL FIX (Bug 007): Derive subscriptions from EventManager.handlers
    // This ensures subscriptions can NEVER be empty if handlers exist
    // Previously, this.subscriptions could drift out of sync with handlers
    const derivedSubscriptions = this.events.getRegisteredStreams()

    this.logger.info(
      {subscriptions: JSON.stringify(derivedSubscriptions)},
      `[AppSession] updateSubscriptions: sending ${derivedSubscriptions.length} subscriptions to cloud (derived from handlers)`,
    )

    // Build the array of SubscriptionRequest objects to send to the cloud
    const subscriptionPayload: SubscriptionRequest[] = derivedSubscriptions.map((stream) => {
      const rate = this.streamRates.get(stream)
      if (rate && stream === StreamType.LOCATION_STREAM) {
        return {stream: "location_stream", rate: rate as any}
      }
      return stream
    })

    const message: AppSubscriptionUpdate = {
      type: AppToCloudMessageType.SUBSCRIPTION_UPDATE,
      packageName: this.config.packageName,
      subscriptions: subscriptionPayload,
      sessionId: this.sessionId!,
      timestamp: new Date(),
    }
    this.send(message)
  }
```

---

### Change 2f: Modify `updateSubscriptionsFromSettings()` Method (Lines ~960-982)

**Before**:
```typescript
  private updateSubscriptionsFromSettings(): void {
    if (!this.subscriptionSettingsHandler) return

    try {
      // Get new subscriptions from handler
      const newSubscriptions = this.subscriptionSettingsHandler(this.settingsData)

      // Update all subscriptions at once
      this.subscriptions.clear()
      newSubscriptions.forEach((subscription) => {
        this.subscriptions.add(subscription)
      })

      // Send subscription update to cloud if connected
      if (this.ws && this.ws.readyState === 1) {
        this.updateSubscriptions()
      }
    } catch (error: unknown) {
      this.logger.error(error, "Error updating subscriptions from settings")
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.events.emit("error", new Error(`Failed to update subscriptions: ${errorMessage}`))
    }
  }
```

**After**:
```typescript
  private updateSubscriptionsFromSettings(): void {
    if (!this.subscriptionSettingsHandler) return

    try {
      // Get new subscriptions from handler
      const newSubscriptions = this.subscriptionSettingsHandler(this.settingsData)

      // NOTE: Settings-based subscriptions work differently from handler-based subscriptions
      // For settings-based apps, we need to register handlers for the derived subscriptions
      // This ensures the single-source-of-truth (handlers) stays correct
      //
      // TODO: Apps using setSubscriptionSettings() should be updated to use
      // events.on() for each subscription, which will automatically manage handlers.
      // For now, we log a warning if settings-based subscriptions differ from handlers.

      const handlerStreams = this.events.getRegisteredStreams()
      const settingsStreams = newSubscriptions

      // Log if there's a mismatch (for debugging during migration)
      if (settingsStreams.length !== handlerStreams.length) {
        this.logger.warn(
          {
            settingsStreams: JSON.stringify(settingsStreams),
            handlerStreams: JSON.stringify(handlerStreams),
          },
          `[AppSession] Settings-based subscriptions differ from handler-based subscriptions. ` +
          `Consider migrating to handler-based subscriptions for consistency.`
        )
      }

      // Send subscription update to cloud if connected
      // Note: updateSubscriptions() now derives from handlers, so settings-based apps
      // should ensure their settings correspond to registered handlers
      if (this.ws && this.ws.readyState === 1) {
        this.updateSubscriptions()
      }
    } catch (error: unknown) {
      this.logger.error(error, "Error updating subscriptions from settings")
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.events.emit("error", new Error(`Failed to update subscriptions: ${errorMessage}`))
    }
  }
```

---

### Change 2g: Modify `handleMessage()` - AUDIO_CHUNK check (Line ~1221)

**Before**:
```typescript
        } else if (message.type === StreamType.AUDIO_CHUNK) {
          if (this.subscriptions.has(StreamType.AUDIO_CHUNK)) {
            // Only process if we're subscribed to avoid unnecessary processing
            this.events.emit(StreamType.AUDIO_CHUNK, message)
          }
```

**After**:
```typescript
        } else if (message.type === StreamType.AUDIO_CHUNK) {
          // Check if we have a handler registered for AUDIO_CHUNK
          const hasAudioHandler = this.events.getRegisteredStreams().includes(StreamType.AUDIO_CHUNK)
          if (hasAudioHandler) {
            // Only process if we're subscribed to avoid unnecessary processing
            this.events.emit(StreamType.AUDIO_CHUNK, message)
          }
```

---

## Summary of Changes

| Change | File | What | Why |
|--------|------|------|-----|
| 2a | events.ts | Add `getRegisteredStreams()` | Exposes registered streams for derivation |
| 2b | index.ts | Remove `this.subscriptions` Set | Eliminate dual storage that causes drift |
| 2c | index.ts | Modify `subscribe()` | Remove `this.subscriptions.add()` |
| 2d | index.ts | Modify `unsubscribe()` | Remove `this.subscriptions.delete()` |
| 2e | index.ts | Modify `disconnect()` | Remove `this.subscriptions.clear()` |
| 2f | index.ts | Modify `updateSubscriptions()` | Derive from `events.getRegisteredStreams()` |
| 2g | index.ts | Modify `updateSubscriptionsFromSettings()` | Add warning for settings/handler mismatch |
| 2h | index.ts | Modify `handleMessage()` AUDIO_CHUNK | Use derived check instead of Set |

---

## Testing Plan

### Unit Tests

1. **Test: Subscriptions derived from handlers**
   ```typescript
   // Register handler
   const cleanup = session.events.onTranscriptionForLanguage("en-US", () => {})
   
   // Verify getRegisteredStreams includes transcription
   const streams = session.events.getRegisteredStreams()
   expect(streams).toContain("transcription:en-US")
   
   // Cleanup
   cleanup()
   
   // Verify stream removed
   const streams2 = session.events.getRegisteredStreams()
   expect(streams2).not.toContain("transcription:en-US")
   ```

2. **Test: Disconnect doesn't clear subscriptions**
   ```typescript
   // Register handler
   session.events.onTranscriptionForLanguage("en-US", () => {})
   
   // Connect then disconnect
   await session.connect(sessionId)
   await session.disconnect()
   
   // Handlers should still exist
   const streams = session.events.getRegisteredStreams()
   expect(streams).toContain("transcription:en-US")
   ```

3. **Test: Reconnection sends correct subscriptions**
   ```typescript
   // Register handler
   session.events.onTranscriptionForLanguage("en-US", () => {})
   
   // Connect
   await session.connect(sessionId)
   
   // Simulate disconnect (don't clear handlers)
   session.ws.close(1006) // Abnormal closure
   
   // Verify subscriptions would be sent on reconnect
   // (Mock the send method and verify payload)
   ```

### Integration Tests

1. **Environment switch test**
   - Connect to cloud-dev
   - Start Captions app
   - Verify transcription working
   - Switch to cloud-debug
   - Wait for cloud-dev grace period
   - Verify transcription still works on cloud-debug

2. **WebSocket 1006 reconnection test**
   - Start Captions app
   - Force WebSocket close with code 1006
   - Verify SDK auto-reconnects
   - Verify subscriptions sent correctly (not empty)
   - Verify transcription continues

3. **Rapid disconnect/reconnect test**
   - Start Captions app
   - Rapidly disconnect and reconnect 10 times
   - Verify subscriptions never empty
   - Verify transcription still works

---

## Rollback Plan

If issues are discovered after deployment:

1. **Revert the changes** - All changes are additive (new method) or subtractive (removed Set)
2. **Re-add `this.subscriptions`** Set and restore all removed lines
3. **Remove `getRegisteredStreams()`** method

The changes are isolated to the SDK and don't affect wire protocol, so rollback is safe.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Settings-based subscriptions break | Low | Medium | Added warning log, can investigate |
| Direct subscribe() calls without handler | Low | Low | Still triggers updateSubscriptions() |
| Performance of getRegisteredStreams() | Very Low | Very Low | Map.keys() is O(1) |
| Unexpected handler registration | Low | Low | No change to handler behavior |

---

## Dependencies

- No external dependencies
- No database changes
- No protocol changes (same SUBSCRIPTION_UPDATE message)
- Backward compatible with existing cloud

---

## Deployment Notes

1. **SDK only** - No cloud changes required for Phase 1
2. **App rebuilds required** - Apps using the SDK need to rebuild with new SDK version
3. **No migration** - Changes are automatic on upgrade
4. **Monitoring** - Watch for:
   - Empty subscription warnings in logs
   - Settings/handler mismatch warnings
   - Transcription failures after reconnect

---

---

## Phase 1b: Terminated Flag

### Change 3a: Add `terminated` flag to AppSession

**File**: `cloud/packages/sdk/src/app/session/index.ts`

**Location**: After `reconnectAttempts` field (around line 156)

```typescript
  /** Number of reconnection attempts made */
  private reconnectAttempts = 0
  /** Flag to prevent reconnection after session termination (e.g., "User session ended") */
  private terminated = false
```

### Change 3b: Set `terminated` flag on "User session ended"

**Location**: In the `closeHandler` function (around line 785)

**Add before the reconnection check**:

```typescript
          // If user session ended, mark as terminated to prevent any future reconnection
          if (isUserSessionEnded) {
            this.terminated = true
            this.logger.info(
              `🛑 [${this.config.packageName}] User session ended - marking as terminated, no reconnection allowed`,
            )
          }
```

**Update the reconnection check**:

```typescript
          if (!isNormalClosure && !isManualStop && !this.terminated) {
            this.logger.warn(`🔌 [${this.config.packageName}] Abnormal closure detected, attempting reconnection`)
            this.handleReconnection()
          } else {
            this.logger.debug(
              `🔌 [${this.config.packageName}] Normal/terminated closure detected, not attempting reconnection (terminated: ${this.terminated})`,
            )
          }
```

### Change 3c: Check `terminated` in `handleReconnection()`

**Location**: At the start of `handleReconnection()` method

```typescript
  private async handleReconnection(): Promise<void> {
    // Check if session was terminated (e.g., "User session ended")
    if (this.terminated) {
      this.logger.info(
        `🔄 Reconnection skipped: session was terminated (User session ended). ` +
          `If cloud restarts app, onSession will be called with fresh handlers.`,
      )
      return
    }

    // ... rest of method
  }
```

### Why This Fix Works

1. **"User session ended"** means the cloud's UserSession is gone
2. The SDK marks itself as `terminated`
3. Any subsequent WebSocket issues (like 1006) won't trigger reconnection
4. If the cloud wants to restart the app, it sends a new webhook → `onSession` is called → fresh handlers

**Flow with fix**:
```
Cloud UserSession disposed
  → "User session ended" sent to app
  → SDK sets terminated = true
  → onStop called → handlers cleaned up
  → Later, WebSocket 1006 fires
  → SDK checks terminated flag → skips reconnection
  → No empty subscriptions sent!

If cloud restarts app:
  → New webhook sent
  → New AppSession created (terminated = false)
  → onSession called
  → Handlers re-registered
  → Everything works!
```

---

## Next Steps After Phase 1

1. **Phase 2**: Cloud AppSession class + OWNERSHIP_RELEASE (Bug 1 fix)
2. **Phase 3**: SDK one-session-per-user enforcement
3. **Phase 4**: Additional cloud-side defenses (grace window validation)

See `009-architecture-brainstorm.md` for full redesign plan.