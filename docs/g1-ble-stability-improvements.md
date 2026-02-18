# G1 BLE Connection Stability Improvements

## Problem Statement

The Even Realities G1 glasses experience frequent BLE disconnections, particularly on the right glass, leading to:
- Failed command delivery (ACK timeouts)
- Command queue buildup during reconnection
- Commands sent before connection is fully stable
- Poor user experience with display updates

### Observed Issues (from logs)

1. **Frequent right glass disconnections**
   - `@@@@@ RIGHT PERIPHERAL DISCONNECTED @@@@@`
   - Happens during normal operation, not just during silence/activate

2. **Commands sent to disconnected peripheral**
   - `⚠️ peripheral/characteristic not found, resuming immediately`
   - Retry attempts fail because peripheral isn't ready

3. **ACK timeouts during reconnection**
   - `⚠️ ACK timeout for L after 320ms`
   - Commands queued before connection is stable

4. **Low battery correlation**
   - Left glass at 20% when issues occur
   - May trigger aggressive power management

## Current Architecture

### Connection Flow
```
1. Bluetooth scan discovers peripherals
2. Connect to stored UUIDs (left + right)
3. Discover services/characteristics
4. Set "ready" flag
5. Start sending commands
```

### Command Queue
- Commands are queued and sent with ACK/retry logic
- No queue clearing on disconnect
- No connection state validation before sending
- Retry logic doesn't check if peripheral is still connected

## Proposed Solutions

### 1. Connection State Management

**Goal**: Ensure commands are only sent when connection is truly stable

**Design**:
```swift
enum ConnectionState {
    case disconnected
    case connecting
    case discovering      // Services/characteristics discovery
    case stabilizing      // Brief delay after discovery
    case ready           // Stable and ready for commands
}

class PeripheralState {
    var left: ConnectionState = .disconnected
    var right: ConnectionState = .disconnected
    
    var isFullyReady: Bool {
        return left == .ready && right == .ready
    }
}
```

**Implementation Points**:
- Add `stabilizing` state with 500ms delay after characteristic discovery
- Block all command sends unless `isFullyReady`
- Log state transitions for debugging

### 2. Command Queue Management

**Goal**: Prevent command buildup and stale commands

**Design**:
```swift
class CommandQueue {
    private var queue: [Command] = []
    private var inFlight: Command?
    
    func clear() {
        queue.removeAll()
        inFlight = nil
    }
    
    func clearStaleCommands(olderThan: TimeInterval) {
        let cutoff = Date().timeIntervalSince1970 - olderThan
        queue.removeAll { $0.timestamp < cutoff }
    }
    
    func pause() {
        // Stop processing queue
    }
    
    func resume() {
        // Resume processing
    }
}
```

**Implementation Points**:
- Clear queue on disconnect
- Add timestamps to all commands
- Remove commands older than 5 seconds
- Pause queue during reconnection
- Resume only after `stabilizing` → `ready` transition

### 3. Reconnection Strategy

**Goal**: Reduce reconnection thrashing and allow BLE to stabilize

**Current Behavior**:
- Immediate reconnection attempt on disconnect
- Multiple rapid retries
- Commands sent during reconnection

**Proposed Behavior**:
```swift
class ReconnectionManager {
    private var attemptCount = 0
    private var lastAttempt: Date?
    
    func shouldAttemptReconnection() -> Bool {
        guard let last = lastAttempt else { return true }
        
        let delays = [1.0, 2.0, 5.0, 10.0] // seconds
        let delay = delays[min(attemptCount, delays.count - 1)]
        
        return Date().timeIntervalSince(last) >= delay
    }
    
    func recordAttempt() {
        attemptCount += 1
        lastAttempt = Date()
    }
    
    func reset() {
        attemptCount = 0
        lastAttempt = nil
    }
}
```

**Implementation Points**:
- Exponential backoff: 1s, 2s, 5s, 10s
- Clear command queue before reconnection
- Don't send commands until `ready` state
- Reset backoff on successful stable connection (30s without disconnect)

### 4. Battery-Aware Behavior

**Goal**: Adjust behavior based on battery levels

**Design**:
```swift
enum BatteryMode {
    case normal      // > 30%
    case low         // 15-30%
    case critical    // < 15%
}

func adjustForBattery(_ level: Int) -> BatteryMode {
    switch level {
    case 0..<15: return .critical
    case 15..<30: return .low
    default: return .normal
    }
}
```

**Behavior Adjustments**:
- **Low battery (15-30%)**:
  - Increase stabilization delay to 1000ms
  - Reduce command retry attempts from 4 to 2
  - Show warning to user
  
- **Critical battery (<15%)**:
  - Increase stabilization delay to 2000ms
  - Disable auto-reconnection (require manual reconnect)
  - Show critical warning to user

### 5. Diagnostic Logging

**Goal**: Better visibility into connection issues

**Add Structured Logs**:
```swift
struct ConnectionEvent {
    let timestamp: Date
    let peripheral: String  // "left" or "right"
    let event: String       // "connected", "disconnected", "ready"
    let batteryLevel: Int?
    let rssi: Int?
}

class ConnectionDiagnostics {
    private var events: [ConnectionEvent] = []
    
    func log(_ event: ConnectionEvent) {
        events.append(event)
        if events.count > 100 {
            events.removeFirst()
        }
    }
    
    func getDisconnectionRate(window: TimeInterval) -> Double {
        // Calculate disconnects per minute
    }
    
    func exportDiagnostics() -> String {
        // Export for debugging
    }
}
```

## Implementation Plan

### Phase 1: Foundation (High Priority)
1. Add `ConnectionState` enum and state tracking
2. Implement command queue clearing on disconnect
3. Add stabilization delay after characteristic discovery
4. Block commands when not in `ready` state

**Success Criteria**:
- No "peripheral/characteristic not found" errors
- Commands only sent when fully connected

### Phase 2: Reconnection (High Priority)
1. Implement exponential backoff reconnection
2. Clear queue before reconnection attempts
3. Add connection stability timer (30s without disconnect = stable)

**Success Criteria**:
- Fewer reconnection attempts
- Successful reconnection rate > 90%

### Phase 3: Battery Awareness (Medium Priority)
1. Track battery levels for both glasses
2. Adjust timeouts based on battery mode
3. Add user warnings for low battery

**Success Criteria**:
- User warned before critical battery issues
- Reduced disconnections in low battery scenarios

### Phase 4: Diagnostics (Low Priority)
1. Add structured connection event logging
2. Implement diagnostics export
3. Add connection health metrics to UI

**Success Criteria**:
- Easy to diagnose connection issues from logs
- Users can see connection health

## Testing Strategy

### Unit Tests
- Connection state transitions
- Command queue clearing logic
- Reconnection backoff timing
- Battery mode calculations

### Integration Tests
- Simulate disconnect during command send
- Verify queue clearing on disconnect
- Test reconnection with various backoff scenarios
- Verify commands blocked during non-ready states

### Manual Testing Scenarios
1. **Normal operation**: Verify stable connection for 5+ minutes
2. **Intentional disconnect**: Remove glasses, verify clean reconnection
3. **Low battery**: Test with <20% battery, verify warnings
4. **Rapid disconnect/reconnect**: Verify no command buildup
5. **Firmware silence/activate**: Verify app handles gracefully

## Metrics to Track

- **Disconnection rate**: disconnects per hour
- **Reconnection success rate**: successful reconnects / total attempts
- **Command success rate**: ACKed commands / total commands
- **Time to stable connection**: time from connect to ready state
- **Queue depth**: max commands in queue during operation

## Rollout Plan

1. **Development**: Implement Phase 1 & 2
2. **Internal testing**: Test with team's G1 glasses for 1 week
3. **Beta release**: Deploy to beta testers
4. **Monitor metrics**: Track disconnection rates and success rates
5. **Iterate**: Adjust timeouts and delays based on real-world data
6. **Production release**: Roll out to all users

## Open Questions

1. **What is the root cause of right glass disconnections?**
   - Hardware issue?
   - Firmware power management?
   - BLE interference?
   - Need more diagnostic data

2. **Should we implement a "connection quality" indicator?**
   - Show RSSI strength to user?
   - Warn when connection is weak?

3. **What's the acceptable disconnection rate?**
   - Define SLA for connection stability
   - < 1 disconnect per hour?

4. **Should we add a "force reconnect" button?**
   - Allow user to manually trigger reconnection
   - Useful for debugging

5. **How do we handle the SILENCED/ACTIVATED firmware events?**
   - Should app pause operations during SILENCED?
   - Should we clear display when silenced?

## References

- Current implementation: `mobile/modules/core/ios/Source/sgcs/G1.swift`
- Command queue: Lines 474-1400
- Reconnection logic: Lines 1100-1150
- Connection handling: Lines 600-800

## Success Definition

**This implementation is successful when**:
- Right glass disconnection rate < 1 per hour during normal use
- Reconnection success rate > 95%
- No "peripheral/characteristic not found" errors in logs
- Command ACK success rate > 98%
- User-reported connection issues reduced by 80%
