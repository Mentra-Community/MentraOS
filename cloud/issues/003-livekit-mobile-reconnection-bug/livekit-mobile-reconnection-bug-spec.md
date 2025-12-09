# LiveKit Mobile Reconnection Bug - Spec

## Overview

Transcription stops completely after mobile client reconnects following a WebSocket 1006 error. The bridge rejects JoinRoom with "session already exists" because the old session wasn't cleaned up during the brief disconnect. Additionally, GetStatus RPC is missing from the proto definition, preventing proper session health checks.

## Problem

Users experience broken transcription after network interruptions (WebSocket 1006/1001 errors):

1. **Symptom**: User speaks, no captions appear after reconnection. Soniox keeps sending keepalives but no audio chunks flow.
2. **Trigger**: Mobile WebSocket disconnect + quick reconnect to **same backend** (< 60s grace period)
3. **Duration**: Permanent until session cleanup (60s grace period expires) or app restart
4. **Frequency**: Rare - only when reconnecting within grace period to same backend instance

### Evidence

**From Better Stack logs** for `israelov+test2@mentra.glass` on `2025-11-20 23:10:17-23:10:23 UTC` (Staging environment):

**First disconnect (23:10:17):**

```
23:10:17.797 - WebSocket closes (code 1001 - normal closure)
23:10:17.797 - "Phone WebSocket closed, marking connections as disconnected"
```

**First reconnection (23:10:23.411 - 6 seconds later):**

```
23:10:23.411 - "Glasses WebSocket connection" (reconnected to SAME backend)
23:10:23.411 - Calls getBridgeStatus()
23:10:23.411 - ERROR: "GetStatus threw"
              Error: "this.client.getStatus is not a function"
              Reason: GetStatus RPC NOT DEFINED IN PROTO!
23:10:23.411 - "Bridge status fetched" {connected: false, last_disconnect_reason: "exception"}
23:10:23.411 - "Reconnect: bridge status" (proceeds despite error)
23:10:23.411 - Mints agent bridge token
23:10:23.411 - "Calling JoinRoom RPC" (first attempt)
23:10:23.412 - ERROR: "JoinRoom returned failure"
              Response: {success: false, error: "session already exists for this user"}
23:10:23.412 - "Bridge rejoin failed"
23:10:23.412 - "Reconnect: bridge rejoin attempted"
23:10:23.418 - "gRPC client initialized" (creates fresh client, retries)
23:10:23.423 - "Calling JoinRoom RPC" (second attempt)
23:10:23.426 - ERROR: "JoinRoom returned failure" (same error!)
23:10:23.426 - ERROR: "Failed to start bridge subscriber"
23:10:23.426 - "Returning LiveKit info" (gives up, returns info anyway)
23:10:23.426 - "Included LiveKit info in CONNECTION_ACK"
23:10:23.426 - "Sent CONNECTION_ACK" ← Mobile thinks it's connected!
```

**Second reconnection (23:10:23.445 - 34ms later - duplicate connection):**

```
23:10:23.445 - Another "Glasses WebSocket connection" (why?)
23:10:23.445 - GetStatus throws same error
23:10:23.446 - "Skipping rejoin due to backoff window" (rate limited!)
23:10:23.450 - Creates fresh gRPC client anyway
23:10:23.452 - JoinRoom fails AGAIN: "session already exists"
23:10:23.457 - "Sent CONNECTION_ACK" (again!)
```

**After reconnection:**

```
23:10:33+ - Soniox keeps sending keepalives every 15s (alive but starving)
23:10:33+ - TranscriptionManager says "Stream already exists and is healthy"
23:10:33+ - NO "AudioManager received PCM chunk" logs (audio pipeline broken!)
23:11:23  - Second WebSocket disconnect (code 1006)
```

**Before the issue (working state):**

```
23:08:02 - "AudioManager received PCM chunk" ✅
23:08:06 - "AudioManager received PCM chunk" ✅
```

**Critical findings:**

1. **GetStatus RPC missing from proto** - `this.client.getStatus is not a function`
2. **Same backend reconnection** - User reconnected to same backend/bridge instance
3. **Bridge session not cleaned up** - Still in memory after 6 seconds
4. **JoinRoom rejects** - Bridge's `sessions.Load(userId)` check blocks new connection
5. **CONNECTION_ACK sent despite failure** - Mobile thinks connected but no StreamAudio
6. **Audio pipeline broken** - PCM chunks stop flowing, Soniox starves
7. **False healthy signal** - TranscriptionManager keeps Soniox alive, reports "healthy"

### Architecture

**Deployment**:

```
Each Backend Instance:
  Cloud VM (Node.js) ←→ Bridge Process (Go) ←→ LiveKit Server

Multiple backends can exist in same environment (load balanced)

Shared Across Backends:
  - LiveKit Server URL (wss://mentraos-ixrso50o.livekit.cloud)
  - Database (userId is same across all backends)

LiveKit Room Names:
  - Just userId (e.g., "israelov+test2@mentra.glass")
  - NOT environment-specific (mobile doesn't know backend)

Bridge Participant Identity:
  - "cloud-agent:{userId}" (e.g., "cloud-agent:israelov+test2@mentra.glass")
```

**Key insight**: Each backend has its own bridge process with separate in-memory session maps. Bug occurs when reconnecting to **SAME backend** where the old session is still in the bridge's map.

**How LeaveRoom works**:

```go
func (s *LiveKitBridgeService) LeaveRoom(req *LeaveRoomRequest) {
    session := s.sessions.Load(userId)
    session.Close()  // Calls room.Disconnect() → tells LiveKit SFU participant left
    s.sessions.Delete(userId)  // Removes from bridge's local map
}
```

LeaveRoom DOES tell LiveKit SFU to disconnect the participant, so cross-backend takeovers would work fine. The issue is same-backend reconnection before grace period cleanup.

### Actual Bug Sequence (from logs)

```
23:08:00  User connected to Staging backend, transcription working
          Bridge has session: sessions[userId] = { room, connected: true }
          Audio flowing: "AudioManager received PCM chunk" every few seconds

23:10:17  Mobile WebSocket closes (code 1001 - normal closure)
          Cloud: Detects close, logs "Phone WebSocket closed"
          Cloud: Sets disconnectedAt timestamp
          Cloud: Starts 60s grace period timer
          Cloud: Does NOT call bridge.LeaveRoom() (waiting for reconnect)
          Bridge: Session still in s.sessions map (Go memory)
          Bridge: room.Disconnect() NOT called yet

23:10:23  Mobile reconnects (6 seconds later, well within grace period)
          Cloud: New WebSocket established on SAME backend instance
          Cloud: handleConnectionInit(reconnection=true)
          Cloud: Calls getBridgeStatus()
          Cloud: ERROR - "this.client.getStatus is not a function"
                 Root cause: GetStatus RPC not defined in livekit_bridge.proto!
          Cloud: Returns status {connected: false, last_disconnect_reason: "exception"}
          Cloud: Proceeds with rejoin attempt despite error
          Cloud: Mints fresh agent bridge token
          Cloud → Bridge: JoinRoom(userId, roomName, token)
          Bridge: Checks "if _, exists := s.sessions.Load(userId); exists" → TRUE
          Bridge: Returns {success: false, error: "session already exists for this user"}
          Cloud: "JoinRoom returned failure", "Bridge rejoin failed"
          Cloud: Creates fresh gRPC client, retries
          Cloud → Bridge: JoinRoom(userId) again
          Bridge: Still has session in map, rejects again with same error
          Cloud: "Failed to start bridge subscriber"
          Cloud: Gives up on bridge rejoin
          Cloud: "Returning LiveKit info", "Sent CONNECTION_ACK" ← BUG!
          Mobile: Receives ACK, thinks it's connected ✅
          Bridge: No new session created, no StreamAudio goroutine running ❌
          Result: Audio pipeline broken

23:10:33+ Soniox keeps sending keepalives (WebSocket still alive)
          TranscriptionManager reports "Stream already exists and is healthy"
          BUT: No "AudioManager received PCM chunk" logs
          PCM audio never reaches AudioManager → Soniox starves
          User speaks but no captions appear

23:11:23  Second WebSocket disconnect (code 1006) - user gives up
```

**Why it stays broken:**

- Bridge session not cleaned up during 6 second disconnect
- Cloud's 60s grace period doesn't trigger bridge cleanup
- GetStatus RPC throws error (missing from proto) - can't check if session is stale
- JoinRoom checks session existence but not health (no `lastActivity` check)
- No force-replace logic for dead/disconnected sessions
- Cloud sends CONNECTION_ACK despite bridge failure (WebSocket connected but LiveKit broken)
- Mobile has no indication transcription is dead (no error message sent)
- Soniox keeps running, creating false "healthy" signal

### Root Causes

**Root Cause #1: GetStatus RPC Missing from Proto (Critical)**

The GetStatus RPC is implemented in Go but **not defined in the proto file**:

```go
// service.go line 523 - EXISTS in Go bridge
func (s *LiveKitBridgeService) GetStatus(...) {...}
```

```protobuf
// livekit_bridge.proto - MISSING!
service LiveKitBridge {
  rpc JoinRoom(...) returns (...);
  rpc LeaveRoom(...) returns (...);
  // rpc GetStatus(...) returns (...);  ← NOT DEFINED!
  rpc HealthCheck(...) returns (...);
}
```

When TypeScript tries to call it:

```typescript
// LiveKitGrpcClient.ts
this.client.getStatus(req, callback)
// ↑ ERROR: this.client.getStatus is not a function
```

**Impact**: Cloud cannot check if bridge session is healthy/stale before attempting JoinRoom. The check always throws an error, making reconnection blind.

**Root Cause #2: Bridge Session Existence Check Too Strict**

```go
// service.go line 63
func (s *LiveKitBridgeService) JoinRoom(req *pb.JoinRoomRequest) {
    if _, exists := s.sessions.Load(req.UserId); exists {
        return &pb.JoinRoomResponse{
            Success: false,
            Error:   "session already exists for this user",
        }
    }
    // Create new session...
}
```

**The problem**: Check only verifies existence, not health:

- Doesn't check if `session.connected == false` (disconnected)
- Doesn't check if `session.room == nil` (cleaned up)
- Doesn't check if `time.Since(lastActivity) > 30s` (stale)
- No force-replace logic for dead sessions

**Why the check exists**: Prevents duplicate sessions from corrupting audio streams. Works correctly for true duplicates (concurrent connections), but breaks legitimate reconnections.

**Root Cause #3: Broken Audio Pipeline Not Detected**

After JoinRoom fails:

1. Cloud sends CONNECTION_ACK to mobile ✅
2. Mobile thinks connected ✅
3. But: No StreamAudio goroutine running ❌
4. PCM audio from LiveKit → nowhere ❌
5. AudioManager never receives chunks ❌
6. Soniox WebSocket stays alive (keepalives) ✅
7. TranscriptionManager reports "healthy" ✅
8. User has NO indication transcription is broken ❌

**The false healthy signal**: Soniox keepalives succeed even though no audio flows, making the system think transcription is working when the audio pipeline is broken at the bridge layer.

**Architecture Insights**:

**Why CONNECTION_ACK must be sent regardless of LiveKit**:

- WebSocket is the primary connection (for messages, app communication, etc.)
- LiveKit is just one feature (audio/transcription)
- Client needs to know WebSocket is up to function
- Audio failure shouldn't block entire connection

**Why LeaveRoom can't be called immediately**:

- If user switches backends during disconnect, old backend's LeaveRoom would tell LiveKit to disconnect "cloud-agent:userId"
- But new backend might already have joined with same identity
- LeaveRoom calls `room.Disconnect()` which tells LiveKit SFU
- Would kick out the new session
- Therefore: Grace period required before cleanup

**Why this is same-backend issue, not cross-backend**:

- Each backend has separate bridge process with own `s.sessions` map
- User reconnects to **same backend** → same bridge → same map → session exists
- If user reconnected to **different backend** → different bridge → empty map → would succeed
- LiveKit itself has no duplicate identity protection per room (allows reconnection)

## Constraints

### Technical

- **Each backend has own bridge**: Bridge is per-backend, not singleton (each Cloud VM has a Go bridge process)
- **No session affinity**: Load balancer doesn't track which backend has which user
- **Grace period required**: Can't immediately call LeaveRoom on disconnect (might kick new session on different backend)
- **GetStatus RPC missing**: Cannot check bridge session health before reconnecting
- **WebSocket must succeed regardless**: LiveKit failure can't block WebSocket connection (used for more than audio)
- **No cross-backend coordination**: Backends/bridges don't communicate with each other
- **Existing sessions must not break**: Fix can't disrupt working connections
  </text>

### Operational

- **Zero downtime deployment**: Can't restart all sessions
- **Backward compatible**: Old backends must work with new bridge (or vice versa)
- **No data loss**: Audio during reconnection must not corrupt stream
- **Fast recovery**: Transcription should resume within 5 seconds of reconnect

### Deployment

Current infrastructure:

- 4 backend servers in production (us-east)
- 2 backend servers in staging
- 1 bridge per region (shared by all backends)
- Load balancer: AWS ALB with least connections algorithm

## Goals

1. **Enable reconnection to same environment**: Mobile can reconnect after network drop without "session exists" error
2. **Enable cross-environment switching**: User can switch from Prod to Staging without bridge conflicts
3. **Immediate session replacement**: When JoinRoom is called with existing session, replace it immediately
4. **No delayed cleanup issues**: No grace period that could kick out a new session
5. **Proper error handling**: Cloud should not send CONNECTION_ACK if bridge rejoin fails
6. **Fast recovery**: Transcription should resume within 2-3 seconds of reconnect

### Success Criteria

- Mobile reconnects after 1006 disconnect, transcription resumes within 3 seconds
- No "session already exists" errors on legitimate reconnection
- User can switch from Prod to Staging without bridge blocking
- Old session immediately replaced when new JoinRoom arrives
- Cloud properly detects bridge rejoin failure and reports error to mobile
- No false CONNECTION_ACK when bridge is not actually connected
- No delayed LeaveRoom that could affect new sessions

## Non-Goals

- **Not removing grace period entirely**: May still be useful for very fast reconnects (<1s)
- **Not supporting concurrent sessions**: One session per user (for now)
- **Not changing room naming**: Environment-specific rooms work fine
- **Not preventing all brief transcription gaps**: 2-3 second pause during reconnect is acceptable

## Approach Options

### Option 1: Add GetStatus to Proto (Required First)

**Critical**: GetStatus RPC must be added to proto definition before any reconnection logic can work properly.

**Change**: Add GetStatus RPC to `livekit_bridge.proto`:

```protobuf
service LiveKitBridge {
  rpc StreamAudio(stream AudioChunk) returns (stream AudioChunk);
  rpc JoinRoom(JoinRoomRequest) returns (JoinRoomResponse);
  rpc LeaveRoom(LeaveRoomRequest) returns (LeaveRoomResponse);
  rpc GetStatus(GetStatusRequest) returns (GetStatusResponse);  // ← ADD THIS
  rpc PlayAudio(PlayAudioRequest) returns (stream PlayAudioEvent);
  rpc StopAudio(StopAudioRequest) returns (StopAudioResponse);
  rpc HealthCheck(HealthCheckRequest) returns (HealthCheckResponse);
}

message GetStatusRequest {
  string user_id = 1;
}

message GetStatusResponse {
  bool connected = 1;
  string participant_id = 2;
  int32 participant_count = 3;
  int64 last_disconnect_at = 4;
  string last_disconnect_reason = 5;
  string server_version = 6;
}
```

**Why this is critical**:

- Cloud needs to check if bridge session is healthy before reconnecting
- Without GetStatus, cloud operates blind (can't distinguish healthy vs stale sessions)
- Currently throws "this.client.getStatus is not a function" error
- Go implementation exists (service.go line 523), just needs proto definition

**Implementation steps**:

1. Add GetStatus messages to proto file
2. Regenerate gRPC code: `protoc --go_out=. --go-grpc_out=. livekit_bridge.proto`
3. Rebuild bridge: `go build -o cloud-livekit-bridge`
4. TypeScript client will automatically pick up new RPC method
5. Test: `getBridgeStatus()` should return status instead of throwing

### Option 2: Always Replace Existing Sessions (Recommended)

**Change**: Remove "session exists" rejection entirely. Always replace any existing session on JoinRoom.

```go
func (s *LiveKitBridgeService) JoinRoom(req *pb.JoinRoomRequest) (*pb.JoinRoomResponse, error) {
  log.Printf("JoinRoom: userId=%s, room=%s", req.UserId, req.RoomName)

  // Always replace existing session if present
  if existingVal, exists := s.sessions.Load(req.UserId); exists {
    s.bsLogger.LogInfo("Replacing existing bridge session", map[string]interface{}{
      "user_id": req.UserId,
      "room_name": req.RoomName,
      "reason": "new_join_request",
    })

    existingSession := existingVal.(*RoomSession)
    existingSession.Close()  // Calls room.Disconnect(), closes goroutines
    s.sessions.Delete(req.UserId)
  }

  // Create new session
  session := NewRoomSession(req.UserId)

  // Connect to LiveKit room
  // LiveKit will handle kicking old "cloud-agent:userId" participant if still present
  room, err := lksdk.ConnectToRoomWithToken(
    req.LivekitUrl,
    req.Token,
    roomCallback,
    lksdk.WithAutoSubscribe(false),
  )
  if err != nil {
    s.bsLogger.LogError("Failed to connect to LiveKit room", err, map[string]interface{}{
      "user_id": req.UserId,
      "room_name": req.RoomName,
    })
    return &pb.JoinRoomResponse{
      Success: false,
      Error:   fmt.Sprintf("failed to connect to room: %v", err),
    }, nil
  }

  session.room = room
  s.sessions.Store(req.UserId, session)

  log.Printf("Successfully joined room: userId=%s, participantId=%s",
    req.UserId, room.LocalParticipant.Identity())

  return &pb.JoinRoomResponse{
    Success: true,
    ParticipantId: string(room.LocalParticipant.Identity()),
    ParticipantCount: int32(len(room.GetRemoteParticipants())) + 1,
  }, nil
}
```

**Why this is the best approach**:

1. **Solves all scenarios**:
   - Quick reconnects (<5s): Old session replaced ✅
   - Slow reconnects (>60s): Old session replaced ✅
   - Cross-backend switches: Old session on different backend replaced ✅
   - Zombie sessions (from crashes): Orphaned sessions replaced ✅

2. **No false positives**:
   - Health checks can fail: zombie sessions with `connected=true, room!=nil` but cloud is gone
   - Activity checks are fragile: what's the right timeout? 30s? 60s?
   - Always-replace is deterministic: no edge cases

3. **Matches user expectation**:
   - Calling `JoinRoom` should always let you join
   - Similar to how `login()` works: previous session is replaced
   - User doesn't care about old sessions, they want to connect now

4. **LiveKit handles duplicates naturally**:
   - If old "cloud-agent:userId" participant still in room, LiveKit kicks it
   - No race conditions or corruption
   - Room state is eventually consistent

5. **Simplest implementation**:
   - Remove ~10 lines of health check logic
   - Add ~3 lines of unconditional close
   - No new fields needed (lastActivity, etc.)
   - No protocol changes beyond GetStatus

**Zombie session problem this solves**:

- **Problem**: Cloud crashes/restarts, bridge keeps session in memory forever
- **Evidence**: Users hitting "session already exists" on FIRST connection (not reconnection)
- **Frequency**: 375 failures in 7 days, 212 for one dev user alone
- **Why health checks fail**: Zombie has `connected=true, room!=nil` but cloud is gone
- **Solution**: Always replace = zombie gets cleaned up on next connection

**Edge cases handled**:

- Two backends call JoinRoom simultaneously: Last one wins (acceptable)
- User rapidly reconnects: Each reconnection replaces previous (correct behavior)
- Legitimate concurrent devices: Not supported anyway (one session per userId)

**Cons (acceptable trade-offs)**:

- Removes protection against accidental double-JoinRoom from same backend
  - But: This would be a bug in cloud code, should be caught in testing
  - But: Even if it happens, last-one-wins is reasonable
- Slightly more aggressive than health-check approach
  - But: Simpler and more reliable
  - But: No false positives from zombie sessions

### Option 3: Don't Change CONNECTION_ACK Behavior (Current Behavior is Correct)

**Important**: CONNECTION_ACK should **ALWAYS** be sent when WebSocket connects, regardless of LiveKit/bridge status.

**Why**:

- WebSocket is the primary connection (messages, app communication, display updates)
- LiveKit is just one feature (audio/transcription)
- Client needs to know WebSocket is up to function properly
- Audio failure shouldn't block entire connection
- Apps that don't use audio still need to work

**Current behavior is correct**:

```typescript
// After WebSocket connects:
1. Send CONNECTION_ACK immediately ✅
2. Try to connect LiveKit async (don't block) ✅
3. If LiveKit fails, send ERROR message to client ✅
   (This is what's missing - error notification)
```

**What needs to change**:

- Add error notification when bridge fails (so user knows transcription is broken)
- Don't change CONNECTION_ACK behavior (it's correct as-is)

### Recommendation: Option 1 (Add GetStatus) + Option 2 (Always Replace)

**Implementation order**:

1. **First: Add GetStatus to proto** (Required)
   - Without this, cloud cannot check session health
   - Currently throws "this.client.getStatus is not a function"
   - Trivial change: add proto messages, regenerate
2. **Second: Always-replace existing sessions in bridge** (Core fix)
   - Remove "session exists" check entirely
   - Always close old session and create new one
   - Single file change in `service.go`, ~5 lines
3. **Third: Add error notification to mobile** (User visibility)
   - When bridge rejoin fails, send error message to mobile
   - User knows transcription is broken
   - Can manually retry or reconnect

**Why always-replace is the right choice**:

- **Solves zombie session problem**: 375 failures in 7 days from orphaned sessions
- **No false positives**: Health checks fail for zombies with `connected=true, room!=nil`
- **Simplest and most reliable**: No complex logic, no edge cases
- **Matches user expectation**: JoinRoom should always let me join
- **CONNECTION_ACK stays the same**: WebSocket must succeed regardless of LiveKit

**Evidence this is needed**:

- Users hitting "session already exists" on **FIRST connection** (not reconnection!)
- Zombie sessions from cloud crashes/restarts never get cleaned up
- Health checks would fail: zombie appears healthy but cloud is gone
- Development users hit it constantly (212 failures for mentradevphone@gmail.com)

**Edge cases handled**:

- Zombie sessions from crashes: Replaced on next connection ✅
- Quick reconnects (<5s): Old session replaced ✅
- Slow reconnects (>60s): Old session replaced ✅
- Cross-backend switch: Each backend has own map ✅
- Concurrent JoinRoom from two backends: Last one wins (acceptable) ✅
- LiveKit participant conflicts: LiveKit kicks old participant naturally ✅

**Implementation**: Two file changes (proto + service.go), ~10 lines total

## Open Questions

1. **Should CONNECTION_ACK be sent when bridge fails?**
   - **Answer**: YES - WebSocket must succeed regardless of LiveKit status
   - WebSocket is primary connection (messages, apps, display)
   - LiveKit is one feature (audio/transcription)
   - Apps that don't use audio still need to work
   - **Change needed**: Add error notification after CONNECTION_ACK when bridge fails

2. **What defines a "healthy" session?**
   - `session.connected == true` (marked as connected)
   - `session.room != nil` (LiveKit room object exists)
   - Optional: `time.Since(lastActivity) < 30s` (recent activity)
   - **Decision**: Use `connected && room != nil` for now, add lastActivity if needed

3. **What if two backends call JoinRoom simultaneously?**
   - Both check health, both see stale session, both try to replace
   - sync.Map operations are atomic, one will win
   - Loser's JoinRoom will see winner's new session, reject it (healthy)
   - **Decision**: Race is acceptable, retry logic in cloud will handle it

4. **Should we track which backend owns a session?**
   - Could add `backendId` to session metadata
   - Useful for debugging cross-backend issues
   - Not required for core functionality
   - **Decision**: Add as optional field for observability, don't enforce

5. **What happens if GetStatus returns "connected=true" but session is dead?**
   - False positive: session marked connected but actually broken
   - JoinRoom will see "healthy", reject the new join
   - User stuck until grace period expires (60s)
   - **Mitigation**: Add `lastActivity` check to health definition
   - **Decision**: Monitor in production, add lastActivity check if needed

6. **Should we log when sessions are replaced?**
   - Yes, at INFO level for visibility (not WARN, it's expected behavior)
   - Include userId, was_connected, reason
   - Helps debugging reconnection issues
   - **Decision**: Add structured logging with Better Stack

7. **What about session metrics?**
   - Track `bridge_sessions_replaced_total` counter (how often replacement happens)
   - Track `bridge_sessions_active` gauge (current active sessions)
   - Track `bridge_sessions_created_total` counter (total creations)
   - Monitor for unexpected patterns (high replacement rate = problem)
   - **Decision**: Add Prometheus metrics in follow-up PR

8. **Should grace period be reduced?**
   - Currently 60s in cloud before LeaveRoom is called
   - With always-replace, grace period is no longer critical
   - Could reduce to 10-15s for faster cleanup, or remove entirely
   - **Decision**: Keep 60s for now, consider removing in follow-up after monitoring

9. **Won't always-replace cause issues with concurrent connections?**
   - We don't support multiple devices per user (one session per userId)
   - If someone tries: last connection wins (expected behavior)
   - Similar to how most services handle login: previous session is replaced
   - **Decision**: This is acceptable behavior, document as intentional

## Testing Plan

### Unit Tests

```go
func TestBackendTakeover(t *testing.T) {
  service := setupTestService()

  // Backend A joins
  resp1 := service.JoinRoom(&pb.JoinRoomRequest{
    UserId: "user1",
    BackendId: "backend-a",
  })
  assert.True(t, resp1.Success)

  // Backend B joins (different backend)
  resp2 := service.JoinRoom(&pb.JoinRoomRequest{
    UserId: "user1",
    BackendId: "backend-b",
  })
  assert.True(t, resp2.Success) // Should succeed, force takeover

  // Verify old session cleaned up
  _, exists := service.sessions.Load("user1")
  assert.True(t, exists) // New session exists
  // Verify backendId is "backend-b"
}
```

### Integration Tests

```typescript
test("mobile reconnect to different backend", async () => {
  // Backend A: Create session
  const backendA = new MockBackend("backend-a")
  await backendA.connect(mobile)
  await verifyAudioFlowing(backendA)

  // Mobile disconnects
  await mobile.disconnect()

  // Backend B: Mobile reconnects
  const backendB = new MockBackend("backend-b")
  await backendB.connect(mobile)

  // Verify takeover succeeded
  await verifyAudioFlowing(backendB)

  // Verify old session cleaned up
  const backendAHasAudio = await backendA.checkAudioFlowing()
  expect(backendAHasAudio).toBe(false)
})
```

### Manual Testing

1. Deploy 2 backend instances with different BACKEND_ID env vars
2. Connect mobile to Backend A, verify transcription
3. Kill Backend A's WebSocket (not the process)
4. Mobile reconnects to Backend B
5. Verify: Transcription resumes within 5 seconds
6. Check Bridge logs: Should see "Backend takeover" message

### Production Validation

After deployment:

- Monitor Better Stack for "session already exists" errors (should drop to zero)
- Monitor "Backend takeover" events (should see after reconnections)
- Track transcription recovery time after mobile reconnects
- Alert if session count grows unbounded (indicates leak)
