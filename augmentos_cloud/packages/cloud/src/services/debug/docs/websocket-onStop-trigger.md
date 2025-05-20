# WebSocket onStop Trigger Documentation

## Problem

When WebSocket connections are terminated abruptly (e.g., by the HealthMonitorService or due to network issues), TPAs were not properly cleaning up resources because the TPA Server's `onStop` method was never called. This caused issues like:

1. The Dashboard TPA continuing to try to update displays even after its connection was terminated
2. Resources like interval timers not being cleared, potentially causing memory leaks
3. No proper cleanup when connections failed to reconnect after multiple attempts

## Root Cause Analysis

We identified two key gaps in the system design:

1. **Missing Failure Detection**: When reconnection attempts were exhausted, there was no mechanism to trigger resource cleanup
2. **Incomplete Event Flow**: The `disconnected` event didn't carry enough information to distinguish between temporary and permanent disconnections
3. **Missing Link**: The TpaServer didn't respond to permanent disconnections by calling `onStop`

## Solution

We implemented a complete end-to-end solution that ensures proper resource cleanup when WebSocket connections are permanently lost:

1. **Enhanced Disconnection Event**:
   - Added a `permanent` flag to the `disconnected` event in the event system
   - This flag indicates when a disconnection is permanent (no further reconnection attempts)

2. **Modified Reconnection Handler**:
   - Enhanced the `handleReconnection` method in TpaSession to emit a specially marked 'permanent' disconnection event when maximum reconnection attempts are reached
   - Added a secondary check after the last failed reconnection attempt

3. **Updated TpaServer Disconnect Handler**:
   - Modified the disconnection event handler in TpaServer to check for the permanent flag
   - When permanent disconnection is detected, it automatically calls `onStop` with an appropriate reason

## Benefits

This solution ensures:

1. TPAs automatically clean up resources after failed reconnection attempts
2. The Dashboard TPA correctly stops updating displays when connections are permanently lost
3. No code changes are required in individual TPAs - they get proper cleanup behavior automatically
4. The solution is backward compatible with existing TPAs

## Implementation Details

### TpaSession Event Interface

```typescript
// in events.ts
interface SystemEvents {
  'disconnected': string | {
    message: string;     // Human-readable close message
    code: number;        // WebSocket close code
    reason: string;      // Reason provided by server
    wasClean: boolean;   // Whether this was a clean closure
    permanent?: boolean; // Whether this is a permanent disconnection
  };
  // other events...
}
```

### TpaSession Reconnection Handler

In the `handleReconnection` method, we now emit a special disconnection event when max attempts are reached:

```typescript
// When maximum reconnection attempts are reached
if (this.reconnectAttempts >= maxAttempts) {
  this.events.emit('disconnected', {
    message: `Connection permanently lost after ${maxAttempts} failed reconnection attempts`,
    code: 4000, // Custom code for max reconnection attempts
    reason: 'Maximum reconnection attempts exceeded',
    wasClean: false,
    permanent: true // Flag this as a permanent disconnection
  });
  return;
}
```

### TpaServer Disconnect Handler

The TpaServer now checks for the permanent flag and calls `onStop` accordingly:

```typescript
session.events.onDisconnected((info) => {
  // Check if this is a permanent disconnection
  if (typeof info === 'object' && info.permanent === true) {
    console.log(`🛑 Permanent disconnection detected for session ${sessionId}, calling onStop`);
    this.onStop(sessionId, userId, `Connection permanently lost: ${info.reason}`);
  }
  
  // Remove from active sessions
  this.activeSessions.delete(sessionId);
});
```

## Notes on Health Monitor

The HealthMonitorService continues to use `ws.terminate()` (rather than `ws.close()`) because:

1. It's dealing with unresponsive/stale connections that need to be forcibly removed
2. We don't want to send a normal close frame for connections that are actually problematic
3. Even with `terminate()`, our enhanced reconnection system now ensures proper cleanup

## Testing

This solution should be tested in the following scenarios:

1. When the health monitor terminates a TPA connection
2. When network issues cause connection loss
3. When a TPA server restarts and the cloud service detects the stale connection
4. When a TPA makes the maximum number of reconnection attempts and fails

## Future Improvements

Consider expanding this solution in the future:

1. Add telemetry to track reconnection attempts and permanent disconnections
2. Implement connection quality metrics to proactively manage connection issues
3. Add a central registry of connections in the health monitor to better coordinate closures