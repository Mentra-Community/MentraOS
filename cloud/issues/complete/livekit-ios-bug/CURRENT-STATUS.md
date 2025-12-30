# LiveKit iOS Bug - Current Status

**Date:** 2025-10-17  
**Status:** 🔍 Root Cause Identified - Ready for Implementation  
**Priority:** Critical

---

## What We Know (Confirmed)

### 1. Grace Period Cleanup Was Disabled ✅ Fixed

```typescript
// Before:
const GRACE_PERIOD_CLEANUP_ENABLED = false; // Sessions never expired

// After:
const GRACE_PERIOD_CLEANUP_ENABLED = true; // Sessions expire after 60s
```

**Impact:** Sessions now properly dispose after 60 seconds when glasses disconnect.

### 2. LiveKit Identity Conflict (Theory - Needs Testing)

**Problem:** All servers use the same LiveKit identity for the same user:

```typescript
identity: `cloud-agent:user@example.com`;
```

**What happens:**

1. User on Server A with LiveKit bridge connected
2. User switches to Server B
3. Server B joins LiveKit room with SAME identity
4. LiveKit kicks Server A's bridge out (duplicate identity rule)
5. Server A's session stays alive (up to 60s grace period)
6. If user switches back to Server A before 60s, rejoins broken session
7. LiveKit bridge is disconnected and has no reconnection logic

### 3. No Bridge Reconnection Logic

**File:** `service.go:125-133`

```go
OnDisconnected: func() {
    log.Printf("Disconnected from LiveKit room: %s", req.RoomName)
    // ← No reconnection attempt!
}
```

**Impact:** Once kicked out, bridge never rejoins automatically.

### 4. Reconnection Doesn't Reinitialize LiveKit

**File:** `websocket-glasses.service.ts:577-590`

```typescript
if (!reconnection) {
  // ← Only runs on NEW connections
  await userSession.appManager.startPreviouslyRunningApps();
}

if (livekitRequested) {
  // ← Only if explicitly requested in THIS connection
  const livekitInfo = await userSession.liveKitManager.handleLiveKitInit();
}
```

**Impact:** Reconnecting to existing session doesn't reinitialize broken LiveKit bridge.

---

## What We Fixed

### ✅ Grace Period Cleanup Enabled

- **File:** `websocket-glasses.service.ts:43`
- **Change:** `GRACE_PERIOD_CLEANUP_ENABLED = true`
- **Impact:** Sessions now expire 60 seconds after glasses disconnect

### ✅ Better Stack Logging for Go Bridge

- **Files:**
  - `logger/betterstack.go` - HTTP logger for Go
  - `main.go` - Integrated logger
  - `service.go` - Added logging to JoinRoom/LeaveRoom
  - `docker-compose.dev.yml` - Added env vars
- **Impact:** Can now see what's happening in Go bridge via Better Stack

### ❌ Reverted: Glasses WebSocket Checks

- **Why:** Would break grace period functionality
- **Correct behavior:** Sessions SHOULD stay alive during grace period even if glasses WS is closed

---

## What We Need to Fix

### Priority 1: Bridge Health Monitoring + Auto-Reinitialize (CRITICAL)

**Problem:** Token expires after 10 minutes. If laptop sleeps > 10 minutes, bridge resume fails.

**Log Evidence:**

```
2025/10/18 04:12:27 "msg"="resume connection failed"
"error"="unauthorized: invalid token: ..., token is expired (exp)"
```

**Solution:** Detect broken bridge and reinitialize automatically

```typescript
// In UserSession or LiveKitManager
setInterval(async () => {
  if (!this.livekitRequested) return; // Skip if LiveKit not enabled

  const isHealthy = await this.liveKitManager.checkBridgeHealth();
  if (!isHealthy) {
    this.logger.warn("Bridge unhealthy, reinitializing with fresh token...");
    await this.liveKitManager.handleLiveKitInit(); // Creates new bridge
  }
}, 30000); // Every 30 seconds
```

**Why Critical:**

- Handles laptop sleep/wake (token expiration)
- Handles server switches (bridge kicked out)
- Handles network disconnects > 10 minutes
- Single fix solves multiple scenarios

### Priority 2: Always Reinitialize LiveKit on Reconnection (If Previously Enabled)

**File:** `websocket-glasses.service.ts:handleConnectionInit()`

**Current logic:**

```typescript
if (livekitRequested) {
  // Only if requested in current connection
  await userSession.liveKitManager.handleLiveKitInit();
}
```

**Should be:**

```typescript
// Check if LiveKit was previously enabled OR is being requested now
const shouldInitLiveKit = livekitRequested || userSession.livekitRequested;

if (shouldInitLiveKit) {
  // Always reinitialize (creates new bridge if old one was kicked out)
  const livekitInfo = await userSession.liveKitManager.handleLiveKitInit();
  // ...
}
```

**Why:** When user switches back to a server within grace period, the session exists but the LiveKit bridge was kicked out. We need to rejoin the room.

### Priority 3: Bridge Auto-Reconnection in Go (Future Enhancement)

Add reconnection logic to Go bridge:

```go
OnDisconnected: func() {
    log.Printf("Disconnected, attempting to rejoin...")

    // TODO: Request new token from TypeScript via gRPC
    // TODO: Reconnect to room with new token
}
```

**Requires:**

- New gRPC method for token refresh
- Token refresh logic in TypeScript

---

## Testing Plan

### Test 1: Switch A → B → Wait 70s → Switch Back to A

**Expected:**

- Server A session expires after 60s
- Switching back creates NEW session
- Fresh LiveKit bridge
- Everything works ✅

### Test 2: Switch A → B → Switch Back (within 60s)

**Current behavior:**

- Rejoin existing session
- LiveKit bridge is dead (was kicked out)
- Apps disconnect repeatedly ❌

**After Priority 1 & 2 fixes:**

- Health check detects broken bridge
- Reinitializes with fresh token
- Everything works ✅

### Test 3: Stay on One Server, Brief Network Hiccup

**Expected:**

- Grace period (glasses WS closed temporarily)
- Reconnect within 60s
- Resume existing session
- Everything works ✅

**Should still work after fixes** ✅

### Test 4: Laptop Sleep > 10 Minutes → Wake Up

**Current behavior:**

- Token expired during sleep (TTL: 10 min)
- Bridge resume fails: "token is expired"
- Bridge permanently broken ❌

**After Priority 1 fix:**

- Health check detects failed bridge
- Reinitializes with fresh token
- Everything works ✅

### Test 5: Monitor Bridge Disconnections via Better Stack

```sql
-- Check for LiveKit disconnections
service:livekit-bridge AND message:"Disconnected from LiveKit room"

-- Check for token expiration on resume
service:livekit-bridge AND error:*token is expired*

-- Check for identity conflicts (if they exist)
service:livekit-bridge AND error:*duplicate*
```

### Test 6: Long Network Disconnect (> 10 minutes)

**Expected:** Same as laptop sleep scenario - health check should recover ✅

---

## Open Questions

1. **Does LiveKit SDK have built-in reconnection?**
   - Check livekit-server-sdk-go documentation
   - May already handle some scenarios

2. **Should we use unique identity per server?**
   - `cloud-agent:server-name:user@example.com`
   - Prevents kicks, but multiple bridges in same room is wasteful
   - Probably not needed if Priority 1 fix works

3. **What happens to audio during bridge disconnect?**
   - Is it buffered?
   - How long until client notices?
   - Need to test actual user experience

4. **Is there a way to detect "kicked out" vs "network disconnect"?**
   - Different error codes or events?
   - Would help decide reconnection strategy

---

## Known Breaking Scenarios

### 1. Laptop Sleep > 10 Minutes 🔴 CRITICAL

- Token expires (TTL: 10 min)
- Resume fails with expired token
- Bridge permanently broken
- **Fix:** Priority 1 (health monitoring)

### 2. Server Switch Within Grace Period 🔴 CRITICAL

- Bridge kicked out by other server
- Not reinitialized on reconnection
- Bridge permanently broken
- **Fix:** Priority 1 + Priority 2

### 3. Network Disconnect > 10 Minutes 🔴 CRITICAL

- Same as laptop sleep
- Token expires during disconnect
- **Fix:** Priority 1 (health monitoring)

### 4. Server Switch After Grace Period 🟢 WORKS

- Session expires, creates new session
- Fresh bridge created
- **Already working** with grace period cleanup enabled

---

## Next Steps

1. **Implement Priority 1** (Bridge health monitoring + auto-reinitialize) - CRITICAL
   - Solves laptop sleep, network disconnect, token expiration
2. **Implement Priority 2** (Always reinitialize on reconnection if previously enabled)
   - Solves server switch within grace period
3. **Test all scenarios** (sleep, switch, network disconnect)
4. **Monitor Better Stack logs** for "resume connection failed" and "token is expired"
5. **Consider Priority 3** (Go bridge auto-reconnection) as future enhancement

---

## Related Documentation

- [LIVEKIT-IDENTITY-CONFLICT-THEORY.md](./LIVEKIT-IDENTITY-CONFLICT-THEORY.md) - Detailed theory
- [TOKEN-EXPIRATION-ANALYSIS.md](./TOKEN-EXPIRATION-ANALYSIS.md) - Token lifetime issues
- [README.md](./README.md) - Original bug report
- [QUICK-START.md](../../packages/cloud-livekit-bridge/QUICK-START.md) - Better Stack setup

---

## Summary

**The Core Issues:**

1. **Token expiration** (laptop sleep > 10 min) - bridge resume fails, no recovery
2. **Identity conflict** (server switches) - bridge kicked out, not reinitialized
3. **No health monitoring** - broken bridges go undetected

**The Primary Fixes:**

1. **Bridge health monitoring** - detect failures, auto-reinitialize with fresh token
2. **Always reinitialize on reconnection** - handle server switch scenarios

**Status:** Ready to implement and test.
