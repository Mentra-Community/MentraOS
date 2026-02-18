# LiveKit Bridge Panic - Send on Closed Channel

## Overview

The livekit-bridge Go service crashes with `panic: send on closed channel` when a session is cleaned up while the LiveKit SDK is still delivering audio packets. This is a **critical bug** that crashes the entire bridge, affecting all connected users.

## Problem

### The Crash

```
livekit-bridge-1  | panic: send on closed channel
livekit-bridge-1  |
livekit-bridge-1  | goroutine 3022 [running]:
livekit-bridge-1  | main.(*LiveKitBridgeService).JoinRoom.func1(...)
livekit-bridge-1  | 	/app/service.go:112 +0x13c
livekit-bridge-1  | github.com/livekit/server-sdk-go/v2.(*Room).OnDataPacket(...)
```

### Root Cause

In `service.go`, the `OnDataPacket` callback sends audio to a channel:

```go
// Line 112 in service.go
case session.audioFromLiveKit <- pcmData:
```

When the session is closed (`session.Close()`), the `audioFromLiveKit` channel is closed:

```go
// Line 266 in session.go
close(s.audioFromLiveKit)
```

**The bug**: The LiveKit SDK's `OnDataPacket` callback runs in its own goroutine (WebRTC data channel read loop). When we call `room.Disconnect()`, pending callbacks can still fire **after** the channel is closed. Sending to a closed channel panics in Go.

### Sequence of Events

From the logs:

1. `StreamAudio send timeout for user@example.com after 2s` - gRPC stream timeout
2. `Cleaning up session... due to stream error` - Triggers `session.Close()`
3. `Closing room session for user...` - Close() begins
4. `Unpublished track 'speaker'...` - Track cleanup
5. `Closed room session for user...` - Close() completes, **channel closed**
6. **PANIC** - LiveKit SDK fires one more `OnDataPacket` after close

### Impact

- **Severity**: Critical
- **Blast radius**: Crashes entire livekit-bridge, disconnecting ALL users
- **Trigger**: Any session cleanup during active audio flow (timeout, error, reconnect)

## Proposed Fix

Add closed-state check before channel operations using the session's context:

```go
OnDataPacket: func(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
    // Check if session is closed before proceeding
    select {
    case <-session.ctx.Done():
        return // Session closed, don't send
    default:
    }

    // ... existing packet processing ...

    // Safe send with context check
    select {
    case <-session.ctx.Done():
        return // Session closed during processing
    case session.audioFromLiveKit <- pcmData:
        // Success - log periodically
        if receivedPackets%100 == 0 {
            // ... logging ...
        }
    default:
        // Channel full, drop frame (backpressure)
        droppedPackets++
        // ... logging ...
    }
}
```

### Why This Works

- `session.ctx` is cancelled in `Close()` before the channel is closed
- The `select` with `ctx.Done()` provides a safe bail-out
- No panic possible because we check context before sending

### Alternative Approaches Considered

1. **Mutex around channel ops** - Too much contention for hot path
2. **Recover from panic** - Masks the bug, doesn't fix it
3. **Don't close channel** - Leaks goroutines waiting on channel

## Files to Change

- `packages/cloud-livekit-bridge/service.go`
  - `JoinRoom()` - Add context check in `OnDataPacket` callback

## Testing

1. Start bridge, connect user with audio flowing
2. Force gRPC timeout or trigger session cleanup
3. Verify no panic, clean shutdown
4. Verify new session can connect after cleanup

## Open Questions

1. **Should we add similar protection to other callbacks?**
   - `OnDisconnected` callback also accesses session state
   - Review all LiveKit callbacks for similar races

2. **Should bridge auto-restart on panic?**
   - Docker/K8s will restart, but adds latency
   - Better to not panic in the first place