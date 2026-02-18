# Phase 2: OWNERSHIP_RELEASE Protocol Implementation Plan

## Overview

This document provides the concrete implementation plan for Phase 2 of the cross-environment contamination fix. The goal is to enable clean handoffs between cloud instances when a user switches environments.

**Problem Solved**: When a user reconnects to a different cloud instance (e.g., `cloud-debug` → `cloud-prod`), the old instance doesn't know to release the session. It waits for a grace period and may try to resurrect, causing confusion and contamination.

**Solution**: Add an `OWNERSHIP_RELEASE` message that the SDK sends to the old cloud before connecting to a new one, signaling a clean handoff.

---

## Prerequisites

- [x] Phase 1a: Derive subscriptions from handlers (SDK) - DONE
- [x] Phase 1b: Terminated flag to prevent reconnection after session end - DONE

---

## Design Summary

### New Message Type: OWNERSHIP_RELEASE

```typescript
// App → Cloud (sent before intentional disconnect)
interface OwnershipReleaseMessage {
  type: "OWNERSHIP_RELEASE"
  packageName: string
  sessionId: string
  reason: "switching_clouds" | "clean_shutdown" | "user_logout"
  timestamp: string
}
```

### Cloud Behavior

| Scenario | Current Behavior | New Behavior |
|----------|------------------|--------------|
| WebSocket closes + OWNERSHIP_RELEASE received | N/A | Clean up immediately, NO resurrection |
| WebSocket closes + NO OWNERSHIP_RELEASE | Grace period → resurrect | Same (unchanged) |
| OWNERSHIP_RELEASE before disconnect | N/A | Set flag, expect disconnect soon |

### SDK Behavior

| Scenario | Current Behavior | New Behavior |
|----------|------------------|--------------|
| User switches to different cloud | Just connect to new cloud | Send OWNERSHIP_RELEASE to old cloud first |
| Clean app shutdown | Just disconnect | Send OWNERSHIP_RELEASE with reason "clean_shutdown" |
| App server stops | Just disconnect | Send OWNERSHIP_RELEASE with reason "clean_shutdown" |

---

## Implementation Steps

### Step 1: Add Message Types (SDK)

**File**: `cloud/packages/sdk/src/types/messages/app-to-cloud.ts`

```typescript
// Add to AppToCloudMessageType enum
export enum AppToCloudMessageType {
  // ... existing types ...
  OWNERSHIP_RELEASE = "ownership_release",
}

// Add message interface
export interface OwnershipReleaseMessage {
  type: AppToCloudMessageType.OWNERSHIP_RELEASE
  packageName: string
  sessionId: string
  reason: "switching_clouds" | "clean_shutdown" | "user_logout"
  timestamp: string
}

// Add to AppToCloudMessage union type
export type AppToCloudMessage =
  | AppConnectionInit
  | AppSubscriptionUpdate
  // ... existing types ...
  | OwnershipReleaseMessage
```

### Step 2: Add Type Guard (SDK)

**File**: `cloud/packages/sdk/src/types/messages/app-to-cloud.ts`

```typescript
export function isOwnershipRelease(message: any): message is OwnershipReleaseMessage {
  return message?.type === AppToCloudMessageType.OWNERSHIP_RELEASE
}
```

### Step 3: Add AppSession Method (SDK)

**File**: `cloud/packages/sdk/src/app/session/index.ts`

```typescript
/**
 * 🔄 Release ownership of this session to allow clean handoff
 * Call this before connecting to a different cloud instance
 * 
 * @param reason - Why ownership is being released
 */
async releaseOwnership(reason: "switching_clouds" | "clean_shutdown" | "user_logout"): Promise<void> {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
    this.logger.debug(`Cannot release ownership - WebSocket not open`)
    return
  }

  const message: OwnershipReleaseMessage = {
    type: AppToCloudMessageType.OWNERSHIP_RELEASE,
    packageName: this.config.packageName,
    sessionId: this.sessionId || "",
    reason,
    timestamp: new Date().toISOString(),
  }

  this.logger.info(
    { reason, sessionId: this.sessionId },
    `🔄 Releasing ownership: ${reason}`
  )

  this.send(message)

  // Small delay to ensure message is sent before disconnect
  await new Promise(resolve => setTimeout(resolve, 100))
}
```

### Step 4: Update disconnect() to Optionally Release Ownership (SDK)

**File**: `cloud/packages/sdk/src/app/session/index.ts`

```typescript
/**
 * 👋 Disconnect from MentraOS Cloud
 * @param options - Disconnect options
 * @param options.releaseOwnership - If true, send OWNERSHIP_RELEASE before disconnecting
 * @param options.reason - Reason for ownership release (required if releaseOwnership is true)
 */
async disconnect(options?: {
  releaseOwnership?: boolean
  reason?: "switching_clouds" | "clean_shutdown" | "user_logout"
}): Promise<void> {
  // Release ownership if requested
  if (options?.releaseOwnership && options?.reason) {
    await this.releaseOwnership(options.reason)
  }

  // ... existing disconnect logic ...
}
```

### Step 5: Handle OWNERSHIP_RELEASE on Cloud

**File**: `cloud/packages/cloud/src/services/websocket/websocket-app.service.ts`

Add to `handleAppMessage` switch statement:

```typescript
case AppToCloudMessageType.OWNERSHIP_RELEASE:
  await this.handleOwnershipRelease(appWebsocket, userSession, message)
  break
```

Add handler method:

```typescript
/**
 * Handle OWNERSHIP_RELEASE message from app
 * Sets a flag so that when the WebSocket closes, we don't try to resurrect
 */
private async handleOwnershipRelease(
  appWebsocket: WebSocket,
  userSession: UserSession,
  message: OwnershipReleaseMessage
): Promise<void> {
  const { packageName, reason } = message

  userSession.logger.info(
    { packageName, reason },
    `📤 Received OWNERSHIP_RELEASE from ${packageName}: ${reason}`
  )

  // Mark in AppManager that this app has released ownership
  userSession.appManager.markOwnershipReleased(packageName, reason)
}
```

### Step 6: Add Ownership Tracking to AppManager

**File**: `cloud/packages/cloud/src/services/session/AppManager.ts`

Add new tracking:

```typescript
// Track apps that have released ownership (won't be resurrected)
private ownershipReleased = new Map<string, { reason: string; timestamp: Date }>()

/**
 * Mark an app as having released ownership
 * When the connection closes, we won't try to resurrect it
 */
markOwnershipReleased(packageName: string, reason: string): void {
  this.ownershipReleased.set(packageName, {
    reason,
    timestamp: new Date()
  })
  
  this.logger.info(
    { packageName, reason },
    `[AppManager] App ${packageName} released ownership: ${reason}`
  )
}

/**
 * Check if an app has released ownership
 */
hasReleasedOwnership(packageName: string): boolean {
  return this.ownershipReleased.has(packageName)
}

/**
 * Clear ownership release flag (called when app reconnects)
 */
clearOwnershipRelease(packageName: string): void {
  this.ownershipReleased.delete(packageName)
}
```

### Step 7: Update Connection Close Handler

**File**: `cloud/packages/cloud/src/services/session/AppManager.ts`

In the WebSocket close handler, check the ownership flag:

```typescript
// In handleAppConnectionClose or similar
private handleAppConnectionClose(packageName: string, code: number, reason: string): void {
  // Check if ownership was released
  if (this.hasReleasedOwnership(packageName)) {
    this.logger.info(
      { packageName, code, reason },
      `[AppManager] App ${packageName} closed after ownership release - no resurrection`
    )
    
    // Clean up immediately, no grace period, no resurrection
    this.cleanupApp(packageName, "ownership_released")
    this.ownershipReleased.delete(packageName)
    return
  }

  // ... existing grace period / resurrection logic for abnormal closures ...
}
```

### Step 8: Update AppServer for Clean Shutdown (SDK)

**File**: `cloud/packages/sdk/src/app/server/index.ts`

Update the cleanup/stop method:

```typescript
/**
 * 🛑 Stop the server and clean up all sessions
 */
async stop(): Promise<void> {
  this.logger.info("🛑 Stopping app server...")

  // Release ownership for all active sessions before disconnecting
  for (const [sessionId, session] of this.activeSessions) {
    try {
      await session.releaseOwnership("clean_shutdown")
      await session.disconnect()
    } catch (error) {
      this.logger.error(error, `Error stopping session ${sessionId}`)
    }
  }

  this.activeSessions.clear()
  this.activeSessionsByUserId.clear()
  
  this.logger.info("✅ App server stopped")
}
```

### Step 9: Handle Cloud Switch in SDK (Future - Phase 3)

This is the full implementation for when SDK tracks cloud URL and handles switches:

**File**: `cloud/packages/sdk/src/app/session/index.ts`

```typescript
/**
 * 🔄 Transfer session to a new cloud instance
 * Releases ownership from current cloud and connects to new one
 */
async transferToCloud(newCloudUrl: string, sessionId: string): Promise<void> {
  const oldUrl = this.config.mentraOSWebsocketUrl

  if (oldUrl === newCloudUrl) {
    this.logger.debug("Same cloud URL, no transfer needed")
    return
  }

  this.logger.info(
    { from: oldUrl, to: newCloudUrl },
    "🔄 Transferring session to new cloud"
  )

  // Release ownership from old cloud
  await this.releaseOwnership("switching_clouds")

  // Update config and connect to new cloud
  this.config.mentraOSWebsocketUrl = newCloudUrl
  
  // Reset terminated flag for fresh start
  this.terminated = false
  
  await this.connect(sessionId)
}
```

---

## Files Changed Summary

### SDK (`cloud/packages/sdk/`)

| File | Changes |
|------|---------|
| `src/types/messages/app-to-cloud.ts` | Add `OWNERSHIP_RELEASE` message type and interface |
| `src/app/session/index.ts` | Add `releaseOwnership()`, update `disconnect()`, add `transferToCloud()` |
| `src/app/server/index.ts` | Update `stop()` to release ownership before disconnect |

### Cloud (`cloud/packages/cloud/`)

| File | Changes |
|------|---------|
| `src/services/websocket/websocket-app.service.ts` | Handle `OWNERSHIP_RELEASE` message |
| `src/services/session/AppManager.ts` | Add ownership tracking, update close handler |

---

## Testing Plan

### Unit Tests

```typescript
describe("OWNERSHIP_RELEASE", () => {
  describe("SDK", () => {
    it("should send OWNERSHIP_RELEASE message with correct format", async () => {
      // Setup mock WebSocket
      // Call releaseOwnership("clean_shutdown")
      // Verify message sent
    })

    it("should not send OWNERSHIP_RELEASE if WebSocket not open", async () => {
      // Setup session with closed WebSocket
      // Call releaseOwnership()
      // Verify no error thrown, no message sent
    })

    it("should release ownership before disconnect when option set", async () => {
      // Call disconnect({ releaseOwnership: true, reason: "clean_shutdown" })
      // Verify OWNERSHIP_RELEASE sent before close
    })
  })

  describe("Cloud", () => {
    it("should mark app as ownership released when message received", async () => {
      // Send OWNERSHIP_RELEASE message
      // Verify markOwnershipReleased called
    })

    it("should not resurrect app that released ownership", async () => {
      // Send OWNERSHIP_RELEASE
      // Close WebSocket
      // Verify no resurrection triggered
    })

    it("should still resurrect app that didn't release ownership", async () => {
      // Close WebSocket abnormally (code 1006)
      // Verify resurrection triggered after grace period
    })
  })
})
```

### Integration Tests

1. **Clean Shutdown Flow**
   - Start app server
   - Connect session
   - Stop app server
   - Verify OWNERSHIP_RELEASE sent
   - Verify cloud doesn't resurrect

2. **Cloud Switch Flow**
   - Connect to cloud-debug
   - Call transferToCloud(cloud-prod-url)
   - Verify OWNERSHIP_RELEASE sent to cloud-debug
   - Verify connected to cloud-prod
   - Verify cloud-debug session cleaned up immediately

3. **Backward Compatibility**
   - Use old SDK without OWNERSHIP_RELEASE
   - Close connection
   - Verify cloud still does grace period + resurrection

---

## Rollback Plan

If issues are found:

1. **Cloud-side**: Remove OWNERSHIP_RELEASE handling - all connections go back to grace period behavior
2. **SDK-side**: Remove releaseOwnership() calls - SDK just disconnects without notification

The protocol is designed to be backward compatible:
- Old SDKs don't send OWNERSHIP_RELEASE → Cloud uses existing behavior
- New SDKs send OWNERSHIP_RELEASE → Cloud cleans up immediately

---

## Success Metrics

1. **No cross-environment contamination**: When user switches clouds, old session cleans up immediately
2. **No accidental resurrections**: Apps that intentionally disconnect aren't resurrected
3. **Crash recovery still works**: Apps that crash (no OWNERSHIP_RELEASE) still get resurrected
4. **Clean shutdown**: `stop()` on app server releases all sessions cleanly

---

## Timeline Estimate

| Task | Estimate |
|------|----------|
| Step 1-2: Add message types | 30 min |
| Step 3-4: SDK releaseOwnership() | 1 hour |
| Step 5-7: Cloud handler + AppManager | 2 hours |
| Step 8: AppServer stop() | 30 min |
| Step 9: transferToCloud() | 1 hour |
| Testing | 2 hours |
| **Total** | **~7 hours** |

---

## Open Questions

### Q1: Should we send OWNERSHIP_RELEASE from onStop handler?

**Current thinking**: No. The `onStop` handler is called when the cloud tells the app to stop, so the cloud already knows. OWNERSHIP_RELEASE is for SDK-initiated disconnects.

### Q2: What if OWNERSHIP_RELEASE is sent but WebSocket doesn't close?

**Suggestion**: Set a timeout on cloud side. If no disconnect within 5 seconds of OWNERSHIP_RELEASE, log warning but don't clean up until actual disconnect.

### Q3: Should Phase 3 (SDK one-session-per-user) be combined with Phase 2?

**Suggestion**: Keep them separate. Phase 2 is the protocol, Phase 3 is SDK architecture change. Can ship Phase 2 independently.

---

## Next Steps After Phase 2

1. **Phase 3**: SDK one-session-per-user enforcement
   - Change AppServer.sessions to Map<userId, AppSession>
   - Webhook handler checks for existing session and transfers

2. **Phase 4**: Cloud AppSession class consolidation (optional)
   - Move scattered state into AppSession class
   - Simplify SubscriptionManager to delegate to AppSession