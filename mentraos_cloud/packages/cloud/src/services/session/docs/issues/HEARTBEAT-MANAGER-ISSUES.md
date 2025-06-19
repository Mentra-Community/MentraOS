# HeartbeatManager Issues

## Current Problems

### 1. **Critical Bug in Connection Registration**

**Location**: `HeartbeatManager.ts:113-137`

**Issue**: The `registerConnection()` method has a severe logic error:

```typescript
private registerConnection(ws: WebSocket, packageName?: string): void {
  const tpaStats: ConnectionStats = {
    sessionId: this.userSession.sessionId, // ❌ Wrong for glasses!
    packageName, // TPA package name
    // ...
  };

  const glassesStats: ConnectionStats = {
    sessionId: this.userSession.userId, // ❌ Wrong field!
    packageName: undefined, // Glasses
    // ...
  };

  this.connectionStats.set(ws, tpaStats); // ❌ Always uses tpaStats!
  // ...
}
```

**Problems**:
1. TPA connections get `sessionId`, but glasses connections get `userId` 
2. Both connection types are stored with the same `tpaStats` object
3. No logic to differentiate between TPA and glasses connections

### 2. **Ping/Pong Logic Errors**

**Issues**:
- **Line 297-298**: Missed pings incremented BEFORE checking if limit exceeded
- **Line 305**: Ping sent even when `missedPings >= MAX_MISSED_PINGS`  
- **Line 244**: Latency tracking fails if `lastPing` is undefined

**Impact**: Connections might not be terminated when they should be, or false positives.

### 3. **Race Conditions**

**Issues**:
- No synchronization between multiple connections registering simultaneously
- Connection state modified while heartbeat intervals are running
- Timer disposal without checking if new timers were created

**Impact**: Inconsistent connection state, memory leaks, undefined behavior.

### 4. **Competing Connection Management**

**Current Managers**:
- **HeartbeatManager**: Session-scoped ping/pong (45s timeout)
- **AppManager**: App-specific reconnection timers (60s grace period)  
- **WebSocketManager (Android)**: Client-side exponential backoff (1s-30s)
- **WebSocket Services**: Connection-specific handling

**Issue**: These systems interfere with each other, creating race conditions:

1. Client briefly loses network
2. HeartbeatManager terminates connection after 45s
3. Client reconnects with valid token
4. Server creates NEW session instead of resuming
5. All app state lost

### 5. **No State Coordination**

**Issue**: Each manager tracks state independently:
- UserSession tracks connection state
- AppManager tracks app state  
- HeartbeatManager tracks connection health
- No centralized coordination

**Impact**: State inconsistencies, competing decisions, hard to debug.

## Analysis

### Why HeartbeatManager is Failing

1. **Fundamental Design Flaw**: Trying to handle both glasses and TPA connections with the same logic
2. **Timing Conflicts**: 45s heartbeat timeout conflicts with other systems
3. **State Management**: No coordination with other connection managers
4. **Race Conditions**: Multiple timers and state modifications without synchronization

### Why Removal Makes Sense

1. **AppManager Already Has Connection Logic**: 60s grace periods, reconnection timers
2. **Android Client Has Heartbeat**: 30s ping intervals with network monitoring
3. **WebSocket Services Handle Low-Level**: Connection management, authentication
4. **Redundant Functionality**: Duplicates existing connection health checks

### Alternative Approaches

#### Option 1: Fix HeartbeatManager
- Fix the registration logic bugs
- Add proper synchronization  
- Coordinate with other managers
- Differentiate glasses vs TPA handling

#### Option 2: Remove HeartbeatManager (Recommended)
- Let AppManager handle TPA connection health via messaging attempts
- Let WebSocket services handle low-level connection issues
- Use Android client heartbeat for glasses connections
- Simplify architecture by removing redundant layer

#### Option 3: Consolidate Connection Management  
- Make HeartbeatManager the single source of truth
- Move all connection logic from other managers
- Significant refactoring required

## Recommendation: Remove HeartbeatManager

### Rationale
1. **Current implementation is too buggy** to fix easily
2. **Functionality is redundant** with existing systems
3. **Creates more problems than it solves** 
4. **Architecture is simpler without it**

### Migration Plan
1. **Remove HeartbeatManager from UserSession**
2. **Enhance AppManager messaging** to detect dead connections
3. **Use messaging attempts as health checks** instead of ping/pong
4. **Rely on Android client heartbeat** for glasses health
5. **Add proper error handling** in WebSocket services

### Benefits of Removal
- **Eliminates race conditions** between multiple connection managers
- **Simplifies debugging** - fewer moving parts
- **Reduces resource usage** - no additional ping/pong overhead
- **More reliable** - use actual message sending as health check
- **Easier to maintain** - one less system to coordinate

## Connection Health Alternative

Instead of heartbeat pings, use **service message attempts** as health checks:

1. **Services try to send messages** via AppManager
2. **AppManager detects connection failures** during send attempts  
3. **Trigger resurrection immediately** on send failure
4. **No additional network overhead** for health checks
5. **Real-world health testing** - if we can't send data, connection is truly unhealthy

This approach is more practical because:
- **Tests actual functionality** instead of just connectivity
- **Immediate failure detection** when services need to send
- **No unnecessary network traffic** for ping/pong
- **Natural integration** with resurrection logic

## Next Steps

1. **Plan HeartbeatManager removal** from UserSession
2. **Design AppManager connection health detection** via message sending
3. **Update all services** to use AppManager messaging
4. **Test resurrection logic** without HeartbeatManager interference
5. **Verify Android client heartbeat** is sufficient for glasses health