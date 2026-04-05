# LiveKit Identity Conflict Theory

**Date:** 2025-10-17  
**Status:** 🔍 Theory - Needs Testing  
**Priority:** High

---

## Executive Summary

**Theory:** When a user switches between cloud servers, both servers try to join the same LiveKit room with the same participant identity, causing the old server's bridge to be kicked out. If the user switches back before the session expires (60 second grace period), they rejoin a session where the LiveKit bridge was already kicked out and has no mechanism to rejoin.

---

## The LiveKit Identity Setup

### How Identities Are Generated

**File:** `LiveKitManager.ts:182-185`

```typescript
// mintAgentBridgeToken()
const at = new AccessToken(this.apiKey, this.apiSecret, {
  identity: `cloud-agent:${this.session.userId}`, // ← Same across all servers!
  ttl: "600000m", // 10 minutes
})
```

**Key Facts:**

- **Identity:** `cloud-agent:user@example.com`
- **Room name:** `user@example.com` (same as userId)
- **Identity is the SAME across all servers** for the same user

### LiveKit Room Participant Rules

From LiveKit documentation:

- Each participant in a room must have a **unique identity**
- If a participant joins with an identity that's already in the room, **the previous participant is kicked out**
- The kicked participant receives an `OnDisconnected` event
- **There is no automatic reconnection** - the application must handle reconnection

---

## The Problem Scenario

### Scenario 1: Switch Server A → Server B (Normal Case)

```
Time: T+0s
[User on Server A - cloud-local]
✅ LiveKit bridge connected
   - Identity: cloud-agent:user@example.com
   - Room: user@example.com
   - Status: Connected, receiving audio

Time: T+10s
[User switches to Server B - cloud-prod]
✅ Mobile connects to Server B
✅ Server B creates new session
✅ Server B starts LiveKit bridge

[LiveKit Room]
❌ Server B joins with identity: cloud-agent:user@example.com
❌ LiveKit kicks Server A's bridge out (duplicate identity!)
❌ Server A receives OnDisconnected event

[Server A]
❌ Glasses WebSocket closed (code 1000)
❌ LiveKit bridge kicked out by Server B
❌ Session stays alive (grace period cleanup disabled)
❌ No reconnection logic in Go bridge
```

**Result:** Server A's session is now broken (no LiveKit bridge), but stays alive for 60 seconds.

### Scenario 2: Laptop Sleep/Wake with Token Expiration

```
Time: T+0s
[User on Server A - laptop awake]
✅ LiveKit bridge connected
   - Identity: cloud-agent:user@example.com
   - Token TTL: 10 minutes (600 seconds)
   - Token issued at: T+0s
   - Token expires at: T+600s

Time: T+60s
[Laptop goes to sleep]
❌ Network connections suspended
❌ LiveKit connection frozen (not disconnected, just suspended)
❌ Session stays alive on server

Time: T+660s (11 minutes later - laptop wakes up)
[Laptop wakes, network restores]
✅ LiveKit SDK attempts to resume connection
❌ Token expired (issued at T+0s, expired at T+600s)
❌ Resume fails: "invalid token: token is expired (exp)"
❌ Bridge permanently broken

[Server State]
✅ Session still alive (glasses never explicitly disconnected)
✅ Glasses WebSocket may reconnect successfully
❌ LiveKit bridge: DISCONNECTED (token expired on resume)
❌ No mechanism to detect bridge is down
❌ No mechanism to request new token
❌ No mechanism to rejoin room
```

**Result:** After laptop wakes from sleep, LiveKit bridge is permanently broken due to expired token on resume attempt.

**Log Evidence:**

```
2025/10/18 04:12:27 "msg"="resume connection failed"
"error"="unauthorized: invalid token: ..., error: go-jose/go-jose/jwt:
validation failed, token is expired (exp)"
```

### Scenario 3: Switch Back Before Grace Period Expires

```
Time: T+0s
[User on Server A]
✅ LiveKit bridge connected

Time: T+10s
[User switches to Server B]
✅ Server B LiveKit bridge connects
❌ Server A LiveKit bridge KICKED OUT

Time: T+30s (before 60 second grace period)
[User switches BACK to Server A]
✅ Glasses reconnect to Server A
✅ UserSession.createOrReconnect() finds existing session
✅ Returns { reconnection: true }

[handleConnectionInit with reconnection: true]
❌ Apps NOT restarted (reconnection flag)
❌ LiveKit NOT reinitialized (depends on livekitRequested flag)

[Server A Session State]
✅ Glasses WebSocket: OPEN
❌ LiveKit bridge: DISCONNECTED (was kicked out)
❌ No mechanism to detect bridge is disconnected
❌ No mechanism to rejoin LiveKit room
```

**Result:** User is back on Server A, but LiveKit bridge is broken and never recovers!

### Scenario 4: Token Expiration on Kicked Bridge

```
Time: T+0s
[Server A LiveKit bridge]
✅ Connected with token (TTL: 10 minutes)

Time: T+10s
[Kicked out by Server B]
❌ Disconnected from room

Time: T+11m (11 minutes later - token expired)
[If bridge tried to reconnect]
❌ Token expired
❌ Cannot rejoin room
❌ No mechanism to request new token
```

**Result:** Even if bridge tried to reconnect, token would be expired.

---

## Evidence from Code

### No Reconnection Logic in Go Bridge

**File:** `service.go:125-133`

```go
OnDisconnected: func() {
    log.Printf("Disconnected from LiveKit room: %s", req.RoomName)
    s.bsLogger.LogWarn("Disconnected from LiveKit room", map[string]interface{}{
        "user_id":   req.UserId,
        "room_name": req.RoomName,
    })
}
```

**What's missing:**

- No reconnection attempt when disconnected
- No token refresh mechanism
- No notification to TypeScript cloud that bridge is down
- Session just sits there with broken LiveKit

### No Bridge Health Check

**File:** `LiveKitGrpcClient.ts`

There's no mechanism to:

- Check if Go bridge is still connected to LiveKit
- Detect if bridge was kicked out
- Automatically rejoin if disconnected
- Request new token if current token expired

### Reconnection Skips LiveKit Initialization

**File:** `websocket-glasses.service.ts:564-650`

```typescript
if (!reconnection) {
  // ← Only runs on NEW connections
  await userSession.appManager.startApp(SYSTEM_DASHBOARD_PACKAGE_NAME)
  await userSession.appManager.startPreviouslyRunningApps()
}

// LiveKit initialization
if (livekitRequested) {
  // ← Only if explicitly requested
  const livekitInfo = await userSession.liveKitManager.handleLiveKitInit()
}
```

**Issue:** On reconnection, LiveKit might not be reinitialized even if it was kicked out.

---

## Why This Explains the Observed Behavior

### Observation 1: Apps Keep Disconnecting (Code 1006)

Apps disconnect because:

- LiveKit bridge is disconnected
- No audio flowing through the bridge
- Apps detect the broken state and disconnect
- Apps try to reconnect, but state is still broken
- Cycle repeats

### Observation 2: Local Server Still Getting Audio

After switching to prod:

- Local server's session still alive
- Apps still connected to local server
- But LiveKit bridge was kicked out by prod server
- Audio from mobile goes to prod (working)
- Audio from local bridge is dead (kicked out)

### Observation 3: Repeated Reconnect Cycles

Apps reconnect every ~15-20 seconds because:

- Apps cache the server URL
- They keep trying to reconnect
- Reconnection succeeds initially
- But LiveKit bridge is broken
- Connection fails after ~15 seconds
- Retry cycle continues

---

## What Should Happen vs What Does Happen

### Ideal Flow: Server Switch with Grace Period

```
1. User switches Server A → Server B
2. Server A's glasses WebSocket closes
3. Server A's LiveKit bridge kicked out by Server B
4. Server A's session enters grace period (60s)
5. After 60s, Server A's session disposed ✅
6. If user switches back after 60s:
   - Creates NEW session
   - NEW LiveKit bridge
   - Everything works ✅
```

### Current Broken Flow: Switch Back Before Grace Period

```
1. User switches Server A → Server B
2. Server A's LiveKit bridge kicked out
3. User switches back to Server A (before 60s)
4. Reconnects to EXISTING session
5. LiveKit NOT reinitialized (reconnection flag)
6. Session has broken LiveKit bridge
7. No mechanism to detect or fix
8. Everything broken ❌
```

---

## The Multiple Issues at Play

### Issue 1: Grace Period Cleanup Disabled

```typescript
const GRACE_PERIOD_CLEANUP_ENABLED = false // ← Sessions never expire
```

**Impact:** Zombie sessions stay alive forever, not just 60 seconds.

### Issue 2: Same Identity Across Servers

```typescript
identity: `cloud-agent:${this.session.userId}` // ← Duplicate identity!
```

**Impact:** New server kicks old server out of LiveKit room.

### Issue 3: No Reconnection Logic in Go Bridge

```go
OnDisconnected: func() {
    log.Printf("Disconnected...")
    // ← No reconnection attempt!
}
```

**Impact:** Once kicked out, bridge never rejoins.

### Issue 4: No Bridge Health Monitoring

**Impact:** TypeScript doesn't know bridge is disconnected.

### Issue 5: Reconnection Doesn't Reinitialize LiveKit

```typescript
if (!reconnection) {
  // ← Skipped on reconnection
  // Start LiveKit
}
```

**Impact:** Reconnecting to session with dead bridge doesn't fix it.

### Issue 6: Token Expiration (10 minutes)

```typescript
// Token TTL in mintAgentBridgeToken()
ttl: "600000m" // 10 minutes
```

**Impact:**

- Token expires after 10 minutes
- Laptop sleep > 10 minutes = expired token on wake
- Bridge resume fails with "token is expired"
- No mechanism to request new token
- No automatic reconnection

### Issue 7: No Token Refresh on Resume

**Impact:**

- LiveKit SDK tries to resume with old token
- If token expired (sleep > 10 min), resume fails
- Bridge left in broken state permanently

---

## Potential Solutions

### Solution 1: Unique Identity Per Server ✅

```typescript
// Include server identifier in identity
identity: `cloud-agent:${serverName}:${this.session.userId}`
// Example: cloud-agent:cloud-prod:user@example.com
```

**Pros:**

- Each server has unique identity
- No more kicking out other servers
- Multiple servers can coexist in same room (though pointless)

**Cons:**

- Still have zombie sessions
- Multiple bridges in same room is wasteful

### Solution 2: Bridge Reconnection Logic ✅

```go
// In Go bridge
OnDisconnected: func() {
    log.Printf("Disconnected, attempting to rejoin...")

    // Request new token from TypeScript
    newToken := requestNewToken(req.UserId)

    // Reconnect to room
    err := room.Reconnect(newToken)
    if err != nil {
        log.Printf("Failed to reconnect: %v", err)
    }
}
```

**Pros:**

- Bridge automatically rejoins if kicked out
- Handles network disconnects too

**Cons:**

- Need token refresh mechanism
- Need gRPC method for token refresh

### Solution 3: Token Refresh on Resume Failure ✅

```go
// In Go bridge - detect resume failure
OnDisconnected: func() {
    log.Printf("Disconnected from LiveKit room")
}

// Add new callback for connection errors
OnConnectionQualityChanged: func(quality lksdk.ConnectionQuality) {
    if quality == lksdk.ConnectionQualityLost {
        // Request new token from TypeScript
        newToken := requestNewTokenViaGRPC(req.UserId)

        // Rejoin room with fresh token
        err := rejoinRoom(newToken)
    }
}
```

**Or simpler approach in TypeScript:**

```typescript
// Detect bridge health issues and refresh
setInterval(async () => {
  const bridgeHealthy = await grpcBridge.healthCheck()

  if (!bridgeHealthy) {
    logger.warn("Bridge unhealthy, reinitializing...")
    // This creates new bridge with fresh token
    await liveKitManager.handleLiveKitInit()
  }
}, 30000) // Every 30 seconds
```

**Pros:**

- Handles token expiration automatically
- Works for both sleep/wake and kicked scenarios
- Simple to implement on TypeScript side

**Cons:**

- Slight delay before detection/recovery
- Need to dispose old bridge first

### Solution 4: Always Reinitialize LiveKit on Reconnection ✅

```typescript
// Always check/reinitialize LiveKit on reconnection
const shouldInitLiveKit = livekitRequested || userSession.livekitRequested

if (shouldInitLiveKit) {
  // Check if bridge is still connected
  const bridgeConnected = await userSession.liveKitManager.checkBridgeHealth()

  if (!bridgeConnected) {
    // Reinitialize bridge
    await userSession.liveKitManager.handleLiveKitInit()
  }
}
```

**Pros:**

- Fixes broken bridges on reconnection
- User can switch back and forth without issues

**Cons:**

- Might restart bridge unnecessarily

### Solution 5: Enable Grace Period Cleanup ✅ (Already Done)

```typescript
const GRACE_PERIOD_CLEANUP_ENABLED = true
```

**Pros:**

- Zombie sessions die after 60 seconds
- Prevents most multi-server conflicts
- Forces new session on return (with fresh bridge)

**Cons:**

- None (this is the correct behavior)

### Solution 6: Bridge Health Monitoring ✅

```typescript
// Periodically check bridge health
setInterval(async () => {
  const isConnected = await grpcBridge.healthCheck()
  if (!isConnected) {
    logger.warn("Bridge disconnected, reconnecting...")
    await liveKitManager.handleLiveKitInit()
  }
}, 30000) // Check every 30 seconds
```

**Pros:**

- Detects broken bridges automatically
- Can recover without user intervention

**Cons:**

- Additional overhead
- Might be unnecessary with other fixes

---

## Recommended Fix Strategy

### Immediate (Critical):

1. ✅ **Enable grace period cleanup** (already done)
   - Sessions expire after 60 seconds
   - Prevents most multi-server conflicts

### Short-term (Important):

2. **Add token refresh / bridge health monitoring**
   - Detect when bridge is disconnected
   - Handle resume failures (expired tokens)
   - Reinitialize bridge automatically

3. **Always reinitialize LiveKit on reconnection**
   - Check if `livekitRequested` was previously true
   - Reinitialize bridge even on reconnections
   - Fixes broken bridges when switching back

### Short-term (Important):

4. **Add bridge health check**
   - Detect when bridge is disconnected
   - Log warnings for visibility
   - Eventually trigger reconnection

### Long-term (Nice to have):

5. **Bridge auto-reconnection logic**
   - Add reconnection logic to Go bridge
   - Add token refresh gRPC method
   - Handle network disconnects gracefully

6. **Unique identity per server** (optional)
   - Prevents kicking out other servers
   - Allows multiple servers in grace period
   - May not be necessary with other fixes

---

## Testing Plan

### Test 1: Switch Server A → Server B → Wait 70s → Switch Back to A

**Expected:** New session, new bridge, everything works ✅

### Test 2: Switch Server A → Server B → Switch Back (within 60s)

**Current:** Broken bridge, apps disconnect repeatedly ❌  
**After Fix:** Bridge reinitialized, everything works ✅

### Test 3: Laptop Sleep > 10 Minutes → Wake Up

**Current:**

- Token expired during sleep
- Resume fails: "token is expired"
- Bridge permanently broken ❌

**After Fix:**

- Bridge health check detects failure
- Reinitializes with fresh token
- Everything works ✅

### Test 4: Stay on One Server, Network Hiccup

**Expected:** Grace period, reconnect, resume ✅  
**Should still work with fixes** ✅

### Test 5: Check Better Stack Logs

**Search for:**

```sql
service:livekit-bridge AND message:"Disconnected from LiveKit room"
```

**Expected:** Should see kicks when servers conflict

---

## Known Scenarios That Break LiveKit

### 1. Server Switch Within Grace Period

- User switches Server A → B → A (within 60s)
- Bridge kicked out, not reinitialized
- **Fix:** Always reinitialize on reconnection

### 2. Laptop Sleep > 10 Minutes

- Token expires during sleep (TTL: 10 min)
- Resume fails with expired token
- **Fix:** Bridge health monitoring + auto-reinitialize

### 3. Network Disconnect > 10 Minutes

- Same as laptop sleep
- Token expires during long disconnect
- **Fix:** Bridge health monitoring + auto-reinitialize

### 4. Multiple Servers Same User

- Identity conflict causes kicks
- **Fix:** Grace period cleanup (done) + reinitialize on reconnection

---

## Open Questions

1. **Does LiveKit SDK have built-in reconnection?**
   - Need to check livekit-server-sdk-go documentation
   - May already handle some reconnections

2. **What happens to audio packets during disconnect?**
   - Are they buffered?
   - Are they dropped?
   - How long until client notices?

3. **Can we detect the "kicked out" vs "network disconnect" scenario?**
   - Different error codes?
   - Different events?
   - Important for deciding whether to reconnect

4. **Should we prevent multiple servers from same user entirely?**
   - Block new connection if session exists elsewhere?
   - Or just handle gracefully?

---

## Related Files

- `LiveKitManager.ts:182` - Identity generation
- `service.go:125` - OnDisconnected callback (no reconnection)
- `websocket-glasses.service.ts:564` - handleConnectionInit (reconnection logic)
- `LiveKitGrpcClient.ts` - gRPC bridge client (no health checks)

---

## Conclusion

The theory explains all observed symptoms:

- ✅ Memory leaks (sessions never expire)
- ✅ Apps disconnecting repeatedly (broken bridge)
- ✅ Local server still getting audio (bridge kicked out by prod)
- ✅ Pattern happens after server switches
- ✅ "resume connection failed" with expired token after laptop sleep

**All scenarios result in:** Broken LiveKit bridge with no automatic recovery mechanism.

The fix is multi-layered:

1. ✅ Enable grace period cleanup (done)
2. 🔴 Add token refresh / bridge health monitoring (critical for laptop sleep)
3. 🔴 Reinitialize LiveKit on reconnection (critical for server switches)
4. 🟡 Add bridge reconnection logic (future enhancement)

**Primary fixes needed:**

1. Bridge health monitoring that detects disconnections and reinitializes
2. Always reinitialize LiveKit on reconnection when it was previously enabled
