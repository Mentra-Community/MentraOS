# Disposed AppSession Resurrection Bug Architecture

## Current System

### Flow: Ownership Release → Disposed Session

```
SDK sends OWNERSHIP_RELEASE
    ↓
AppMessageHandler.handleOwnershipRelease()
    ↓
AppSession._ownershipReleased = { reason, timestamp }
    ↓
WebSocket closes (code 1000)
    ↓
AppSession.handleDisconnect()
    ↓
Sees _ownershipReleased is set
    ↓
setState(DORMANT) + cleanup()
    ↓
ResourceTracker.dispose() ← PERMANENT
    ↓
AppSession stays in apps Map
```

### Flow: Resurrection Attempt (FAILS)

```
User reconnects or grace period expires
    ↓
AppManager.startApp() or resurrectDormantApps()
    ↓
getOrCreateAppSession(packageName)
    ↓
Returns EXISTING disposed AppSession ← BUG
    ↓
handleConnect(ws)
    ↓
setupHeartbeat()
    ↓
resources.trackInterval() ← THROWS
    ↓
"Cannot track resources on a disposed ResourceTracker"
```

### Key Code Paths

**ResourceTracker disposal** (`packages/cloud/src/utils/resource-tracker.ts:141`):
```typescript
dispose(): void {
  if (this.isDisposed) return;
  // ... cleanup ...
  this.isDisposed = true;  // Permanent flag
}
```

**AppSession cleanup** (`packages/cloud/src/services/session/AppSession.ts:822`):
```typescript
cleanup(): void {
  if (this.disposed) return;
  this.disposed = true;
  this.resources.dispose();  // Disposes ResourceTracker
  // ...
}
```

**handleDisconnect on ownership release** (`packages/cloud/src/services/session/AppSession.ts:398`):
```typescript
if (this._ownershipReleased) {
  this.setState(AppConnectionState.DORMANT);
  this.cleanup();  // ← Disposes ResourceTracker
  return;
}
```

**getOrCreateAppSession (before fix)** (`packages/cloud/src/services/session/AppManager.ts:126`):
```typescript
getOrCreateAppSession(packageName: string): AppSession | undefined {
  let session = this.apps.get(packageName);
  if (!session) {
    session = new AppSession({...});
    this.apps.set(packageName, session);
  }
  return session;  // Returns disposed session!
}
```

## Proposed System

### Fix: Detect Disposed Sessions

Add disposed check in `getOrCreateAppSession()`:

```
getOrCreateAppSession(packageName)
    ↓
session = apps.get(packageName)
    ↓
if session?.isDisposed:
    ↓
    log "Creating fresh session"
    ↓
    apps.delete(packageName)
    ↓
    session = undefined
    ↓
if !session:
    ↓
    session = new AppSession(...)
    ↓
    apps.set(packageName, session)
    ↓
return session
```

### Implementation

**File**: `packages/cloud/src/services/session/AppManager.ts`

```typescript
getOrCreateAppSession(packageName: string): AppSession | undefined {
  // Don't create new AppSessions after disposal
  if (this.disposed) {
    this.logger.warn({ packageName }, `[AppManager] Ignoring getOrCreateAppSession after disposal`);
    return undefined;
  }

  let session = this.apps.get(packageName);

  // Check if existing session is disposed (e.g., after ownership release cleanup)
  // If so, we need to create a fresh AppSession to avoid "Cannot track resources on a disposed ResourceTracker" error
  // This can happen when:
  // 1. SDK sends OWNERSHIP_RELEASE (e.g., clean_shutdown)
  // 2. handleDisconnect() calls cleanup() which disposes the ResourceTracker
  // 3. App is marked DORMANT but stays in the apps map
  // 4. Later, resurrection tries to reuse this disposed session
  if (session?.isDisposed) {
    this.logger.info(
      { packageName },
      `[AppManager] Existing AppSession for ${packageName} is disposed, creating fresh session`,
    );
    // Remove the disposed session
    this.apps.delete(packageName);
    session = undefined;
  }

  if (!session) {
    session = new AppSession({
      packageName,
      logger: this.logger,
      onGracePeriodExpired: async (appSession) => {
        await this.handleAppSessionGracePeriodExpired(appSession);
      },
      onSubscriptionsChanged: (appSession, oldSubs, newSubs) => {
        this.handleAppSessionSubscriptionsChanged(appSession, oldSubs, newSubs);
      },
      onDisconnect: (code: number, reason: string) => {
        if (this.disposed) {
          this.logger.debug({ packageName, code, reason }, 
            `[AppManager] Ignoring onDisconnect callback after disposal`);
          return;
        }
        this.handleAppConnectionClosedFromCallback(packageName, code, reason);
      },
    });
    this.apps.set(packageName, session);
    this.logger.debug({ packageName }, `[AppManager] Created new AppSession for ${packageName}`);
  }
  return session;
}
```

### Fixed Flow: Resurrection After Ownership Release

```
User reconnects or grace period expires
    ↓
AppManager.startApp() or resurrectDormantApps()
    ↓
getOrCreateAppSession(packageName)
    ↓
session = apps.get(packageName)
    ↓
session.isDisposed === true ← NEW CHECK
    ↓
apps.delete(packageName)
    ↓
session = new AppSession(...) ← FRESH SESSION
    ↓
apps.set(packageName, session)
    ↓
return session
    ↓
handleConnect(ws)
    ↓
setupHeartbeat()
    ↓
resources.trackInterval() ← WORKS
```

## Alternative Approaches Considered

### Option A: Don't call cleanup() for DORMANT

```typescript
if (this._ownershipReleased) {
  this.setState(AppConnectionState.DORMANT);
  // Don't call cleanup() - keep resources alive
  return;
}
```

**Rejected**: Memory leak risk. DORMANT sessions could stay forever if user never returns.

### Option B: Make ResourceTracker resettable

```typescript
class ResourceTracker {
  reset(): void {
    this.dispose();
    this.isDisposed = false;
    this.cleanupFunctions = [];
  }
}
```

**Rejected**: Violates disposal semantics. Too risky - could leave zombie resources.

### Option C: Remove session from map on cleanup

```typescript
cleanup(): void {
  this.disposed = true;
  this.resources.dispose();
  // Also remove from parent's map somehow
}
```

**Rejected**: AppSession doesn't have reference to AppManager. Would need callback injection.

### Option D: Check in handleConnect (chosen + getOrCreate)

We could add a guard in `handleConnect()`:

```typescript
handleConnect(ws: IWebSocket): void {
  if (this.disposed) {
    throw new Error("Cannot connect to disposed AppSession");
  }
  // ...
}
```

**Partial**: Good for safety, but getOrCreateAppSession is the right fix point. Added check there instead.

## Migration Strategy

1. Deploy fix to `getOrCreateAppSession()` ← DONE
2. Monitor logs for "Existing AppSession is disposed, creating fresh session"
3. Verify resurrection succeeds in logs
4. Add unit test for disposed session detection

## Testing

### Manual Test

1. Start app
2. Send `OWNERSHIP_RELEASE` from SDK
3. Wait for DORMANT state
4. Trigger resurrection (reconnect user or wait for grace period)
5. Verify app starts successfully (no ResourceTracker error)

### Expected Log Sequence (After Fix)

```
[timestamp] | Ownership released - will not resurrect on disconnect
[timestamp] | State transition: running -> dormant
[timestamp] | Cleaning up AppSession
... later ...
[timestamp] | Existing AppSession for com.example.app is disposed, creating fresh session
[timestamp] | Created new AppSession for com.example.app
[timestamp] | App connected
[timestamp] | State transition: connecting -> running
```

## Open Questions

1. **Should we add a metric for disposed session recreation?**
   - Useful for monitoring multi-cloud handoff frequency
   - Low priority, can add later

2. **Should handleConnect also check for disposed state?**
   - Defense in depth
   - Could throw clearer error
   - **Decision**: Not needed if getOrCreate is fixed, but could add as safety net