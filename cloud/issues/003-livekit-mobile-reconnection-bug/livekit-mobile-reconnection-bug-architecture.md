# LiveKit Mobile Reconnection Bug - Architecture

## Current System

### Deployment Structure

```
Prod Environment:
  Cloud VM (Node.js process) → Bridge Process (Go) → LiveKit Server

Staging Environment:
  Cloud VM (Node.js process) → Bridge Process (Go) → LiveKit Server

Shared Resources:
  - LiveKit Server URL (same LIVEKIT_URL env var)
  - Database (userId is same across environments)

LiveKit Room Structure:
  Room Name: userId (e.g., "user123")
  Participants:
    - "user123" (mobile client, publishes DataPackets)
    - "cloud-agent:user123" (bridge agent, subscribes to DataPackets)
```

**Key Architecture Facts**:

- Each environment has separate Cloud + Bridge processes
- Environments run on different VMs
- Bridge maintains in-memory session map (not shared between environments)
- **Room names are NOT environment-specific** - just userId
- Mobile joins LiveKit room directly (doesn't know which backend env)
- Multiple bridge agents can join same room (prod and staging both join "user123")
- Bridge session map check blocks legitimate reconnections

### Normal Operation Flow

```
1. Mobile → Cloud: WebSocket connect
2. Cloud → Bridge: JoinRoom(userId, roomName: "room-staging-user123")
3. Bridge → LiveKit: Connect to room, subscribe to user's DataPackets
4. Bridge stores: sessions[userId] = { room, channel, ... }
5. Cloud → Bridge: StreamAudio(userId) bidirectional gRPC
6. Mobile → LiveKit: Publish audio as DataPackets
7. Bridge receives: OnDataPacket → writes to audioFromLiveKit channel
8. Bridge → Cloud: Audio via gRPC StreamAudio
9. Cloud → Soniox: Transcription via WebSocket
10. Cloud → Mobile: Captions via WebSocket
```

### The Reconnection Problem (Actual Bug from Logs)

**Incident**: `israelov+test2@mentra.glass` on `2025-11-20 15:12:56 PST`

```
T+0s (15:12:42):  Mobile connected to Staging, transcription working
                  Bridge session: sessions[userId] = { room, audioFromLiveKit, ... }
                  StreamAudio: Goroutines running, audio flowing

T+0s:             Mobile network drops, WebSocket closes (code 1006)
                  Cloud: Detects close, logs "Glasses connection closed"
                  Cloud: Sets disconnectedAt, starts 60s grace period timer
                  Cloud: Does NOT call bridge.LeaveRoom() yet
                  Bridge: Session still in memory, StreamAudio goroutines still alive

T+14s (15:12:56): Mobile reconnects (14 seconds later, still in grace period)
                  Cloud: New WebSocket connection established
                  Cloud: handleConnectionInit(reconnection=true)
                  Cloud: Calls getBridgeStatus()
                  Cloud: ERROR "GetStatus threw" (can't get status)
                  Cloud: Proceeds with rejoinBridge() anyway

                  Cloud → Bridge: JoinRoom(userId)
                  Bridge: sessions.Load(userId) → EXISTS
                  Bridge: Returns error "session already exists for this user" ❌
                  Cloud: ERROR "JoinRoom returned failure"
                  Cloud: ERROR "Bridge rejoin failed"

                  Cloud: Tries again with fresh gRPC client
                  Cloud → Bridge: JoinRoom(userId) second attempt
                  Bridge: Still has session, rejects again ❌
                  Cloud: ERROR "JoinRoom returned failure"
                  Cloud: ERROR "Failed to start bridge subscriber"

                  Cloud: Gives up on bridge rejoin
                  Cloud → Mobile: Sends CONNECTION_ACK (pretends success!) ❌
                  Mobile: Receives ACK, thinks connection is good

                  Bridge: No new session created, no StreamAudio established
                  Result: No audio flows from bridge to cloud
                  Transcription: Permanently dead until app restart
```

### Key Code Paths

**Bridge session check** (`service.go:63-70`):

```go
func (s *LiveKitBridgeService) JoinRoom(req *pb.JoinRoomRequest) {
  // Check if session already exists
  if _, exists := s.sessions.Load(req.UserId); exists {
    s.bsLogger.LogWarn("Session already exists for user", map[string]interface{}{
      "user_id": req.UserId,
    })
    return &pb.JoinRoomResponse{
      Success: false,
      Error:   "session already exists for this user",  // ← BLOCKS RECONNECTION
    }
  }
  // ... create session
}
```

**The Problem**:

- This check is in bridge's memory map, NOT LiveKit room level
- LiveKit WOULD allow rejoining (kicks old participant, accepts new one)
- Bridge blocks it before LiveKit is involved
- No distinction between "stale session" vs "active duplicate"
- No logic to replace old session when new JoinRoom arrives

**Cloud reconnection logic** (`websocket-glasses.service.ts:700-730`):

```typescript
private async handleConnectionInit(reconnection: boolean) {
  if (reconnection) {
    try {
      const status = await userSession.liveKitManager.getBridgeStatus();

      // If bridge not connected, rejoin
      if (!status || status.connected === false) {
        await userSession.liveKitManager.rejoinBridge();  // ← FAILS: "session exists"
      }
    } catch (err) {
      // getBridgeStatus throws error but we continue anyway
      await userSession.liveKitManager.rejoinBridge();  // ← FAILS AGAIN
    }
  }

  // ❌ BUG: Sends CONNECTION_ACK even if rejoin failed!
  sendConnectionAck(liveKitInfo);  // Mobile thinks it's connected
}
```

**Problems**:

1. `getBridgeStatus()` throws error instead of returning useful status
2. Cloud continues with rejoin even when status check fails
3. JoinRoom fails but cloud doesn't abort the connection
4. Cloud sends CONNECTION_ACK to mobile despite bridge failure
5. Mobile has no indication that bridge is not actually connected

**Bridge StreamAudio cleanup** (`service.go:355-368`):

```go
func (s *LiveKitBridgeService) StreamAudio(stream) {
  errChan := make(chan error, 2)

  // Goroutine 1: Receive from Cloud → LiveKit
  // Goroutine 2: Send from LiveKit → Cloud

  // Wait for error
  select {
  case err := <-errChan:
    // ONLY cleanup trigger when gRPC stream fails
    session.Close()
    s.sessions.Delete(userId)
    return err
  case <-session.ctx.Done():
    // Never fires when mobile just disconnects
    return nil
  }
}
```

**The Gap**: Session cleanup only happens when:

- gRPC stream.Recv() fails (Cloud closes connection)
- gRPC stream.Send() fails (Cloud not consuming)

Session cleanup does NOT happen when:

- Mobile disconnects from Cloud WebSocket (Cloud enters 60s grace period)
- Cloud detects disconnect but doesn't call LeaveRoom RPC yet
- Cloud waits to see if mobile will reconnect

**Result**: Stale session sits in bridge memory during grace period

**Why we can't use delayed LeaveRoom cleanup**:

- Room names are NOT environment-specific (just userId)
- Can't add env prefix (mobile joins directly, doesn't know backend env)
- Delayed LeaveRoom could kick out new session if:
  - User reconnects quickly to same environment
  - User switches to different environment
- No safe way to delay cleanup without risking wrong session disconnect

## Proposed System

### Solution: Immediate Session Replacement

**Core idea**: Remove "session exists" error. When JoinRoom is called with existing session, immediately close old session and create new one. Let LiveKit handle participant conflicts at room level.

```
Cloud reconnects → Bridge: JoinRoom(userId)
Bridge: Session exists for userId
Bridge: Close old session immediately
Bridge: Delete from map
Bridge: Create new session
Bridge: Connect to LiveKit room (LiveKit kicks old participant if still there)
Result: Success
```

**Why this works**:

- LiveKit room already handles duplicate participants (kicks old "cloud-agent:userId")
- No delayed cleanup that could affect wrong session
- Works for same environment reconnect AND cross-environment switch
- Single round-trip, no retry logic needed

### Updated Flow (With Fix)

```
T+0s:  Mobile disconnects (1006)
T+14s: Mobile reconnects to same environment
       Cloud → Bridge: JoinRoom(userId)
       Bridge: Session exists, checks health:

       session.mu.RLock()
       isHealthy = session.connected &&
                   session.room != nil &&
                   !isChannelClosed(session.audioFromLiveKit)
       session.mu.RUnlock()

       Result: NOT healthy (mobile was disconnected)

       Bridge: Logs "Stale session detected, force replacing"
       Bridge: session.Close() → closes room, channel, goroutines
       Bridge: s.sessions.Delete(userId)
       Bridge: Creates new session
       Bridge → Cloud: JoinRoom success ✅

       Cloud → Bridge: StreamAudio(userId)
       Bridge: New goroutines start, audio flows ✅

       Mobile → LiveKit: Audio DataPackets
       Bridge → Cloud: Audio via new gRPC stream
       Cloud → Soniox: Transcription
       Cloud → Mobile: Captions appear ✅

       Result: Transcription resumes within 2 seconds
```

### Implementation Changes

**Change 1: Immediate session replacement** (`service.go:51-90`):

```go
func (s *LiveKitBridgeService) JoinRoom(req *pb.JoinRoomRequest) {
  log.Printf("JoinRoom request: userId=%s, room=%s", req.UserId, req.RoomName)
  s.bsLogger.LogInfo("JoinRoom request received", map[string]interface{}{
    "user_id":     req.UserId,
    "room_name":   req.RoomName,
    "livekit_url": req.LivekitUrl,
  })

  // CHANGED: Check if session already exists
  if existingVal, exists := s.sessions.Load(req.UserId); exists {
    // Session exists - replace it immediately
    s.bsLogger.LogWarn("Replacing existing bridge session", map[string]interface{}{
      "user_id":   req.UserId,
      "room_name": req.RoomName,
      "reason":    "new_join_request",
    })

    existingSession := existingVal.(*RoomSession)
    existingSession.Close()  // Closes room connection, channel, goroutines
    s.sessions.Delete(req.UserId)

    // Continue to create new session below
  }

  // Create new session
  session := NewRoomSession(req.UserId)

  // Setup callbacks for LiveKit room
  var receivedPackets int64
  var droppedPackets int64

  roomCallback := &lksdk.RoomCallback{
    // ... existing callback logic
  }

  // Connect to LiveKit room
  // LiveKit will handle kicking old "cloud-agent:userId" participant if still there
  room, err := lksdk.ConnectToRoomWithToken(
    req.LivekitUrl,
    req.Token,
    roomCallback,
    lksdk.WithAutoSubscribe(false),
  )
  if err != nil {
    s.bsLogger.LogError("Failed to connect to LiveKit room", err, map[string]interface{}{
      "user_id":     req.UserId,
      "room_name":   req.RoomName,
      "livekit_url": req.LivekitUrl,
    })
    return &pb.JoinRoomResponse{
      Success: false,
      Error:   fmt.Sprintf("failed to connect to room: %v", err),
    }, nil
  }

  session.room = room
  // ... rest of initialization

  // Store session
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

**Summary of changes**:

- Line 63-69: Remove "return error" for existing session
- Line 63-75: Add session replacement logic with warning log
- Line 76+: Continue with normal session creation
- Net change: ~10 lines added/modified

**Change 2: Fix CONNECTION_ACK logic** (`websocket-glasses.service.ts`):

```typescript
private async handleConnectionInit(reconnection: boolean) {
  let livekitInfo = null;

  if (reconnection) {
    try {
      const status = await userSession.liveKitManager.getBridgeStatus();

      if (!status || status.connected === false) {
        // CHANGED: Wrap in try-catch and check result
        try {
          await userSession.liveKitManager.rejoinBridge();
          // Success! Get fresh LiveKit info
          livekitInfo = await userSession.liveKitManager.getLiveKitInfo();
        } catch (rejoinError) {
          this.logger.error({ error: rejoinError }, "Bridge rejoin failed, aborting connection");
          // NEW: Send error to mobile instead of pretending success
          userSession.websocket.send(JSON.stringify({
            type: CloudToGlassesMessageType.CONNECTION_ERROR,
            error: "Failed to establish audio bridge",
            code: "BRIDGE_REJOIN_FAILED"
          }));
          return;  // Don't send CONNECTION_ACK
        }
      }
    } catch (statusError) {
      this.logger.error({ error: statusError }, "Bridge status check failed");
      // If we can't even get status, don't try to rejoin
      return;
    }
  } else {
    // Fresh connection
    livekitInfo = await userSession.liveKitManager.handleLiveKitInit();
  }

  // Only send CONNECTION_ACK if we actually have working LiveKit bridge
  if (livekitInfo) {
    sendConnectionAck({ livekitInfo });
  }
}
```

**Why this change matters**:

- Cloud currently sends CONNECTION_ACK even when bridge rejoin fails
- Mobile thinks it's connected but no audio flows
- With fix: Mobile gets error, can show user "connection failed"
- User can retry or knows something is wrong

### Edge Cases Handled

**Case 1: Fast reconnect (<3s) - Same Environment**

```
T+0s:  Mobile disconnects, session exists in bridge
T+2s:  Mobile reconnects
       Cloud → Bridge: JoinRoom(userId)
       Bridge: Session exists → Close old, create new
       Result: Reconnect succeeds ✅
```

**Case 2: Slow reconnect (>14s) - Same Environment**

```
T+0s:  Mobile disconnects
T+14s: Mobile reconnects (like in the bug logs)
       Cloud → Bridge: JoinRoom(userId)
       Bridge: Session exists → Close old, create new
       Result: Reconnect succeeds ✅
```

**Case 3: Cross-Environment Switch**

```
T+0s:  User on Prod bridge, LiveKit room "user123"
       Participant: "cloud-agent:user123" (Prod)
T+1s:  User switches to Staging
       Staging → Bridge: JoinRoom(userId)
       Staging Bridge: Session doesn't exist → Create new
       Staging Bridge joins LiveKit room "user123"
       LiveKit: Now has "cloud-agent:user123" (Staging)

T+2s:  Mobile reconnects to Staging
       Result: Staging bridge session exists, works ✅

Meanwhile:
       Prod bridge still has old session in memory
       Prod's StreamAudio will eventually error out when Cloud disconnects gRPC
       Prod session cleaned up when StreamAudio goroutines detect closed stream
```

**Case 4: Two Backends Call JoinRoom Simultaneously**

```
T+0s:  Backend A and Backend B both call JoinRoom(userId)
       Bridge: Atomic operations via sync.Map
       One arrives first, creates session
       Other arrives second, closes first session, creates new one
       Result: Last one wins (acceptable) ✅
       LiveKit: Sees "cloud-agent:userId" join, disconnect, rejoin
```

**Case 5: Mobile App Restart**

```
T+0s:  Mobile kills app
       Cloud: Grace period timer running
       Bridge: Session still exists
T+10s: Mobile restarts, connects
       Cloud → Bridge: JoinRoom(userId)
       Bridge: Session exists → Close old, create new
       Result: Works immediately, no waiting for grace period ✅
```

**Case 6: Cloud Crashes, Mobile Reconnects to New Cloud Instance**

```
T+0s:  Cloud crashes during active session
       Bridge: Session orphaned (gRPC stream dead)
       StreamAudio goroutines will detect stream.Context().Done()
       Session gets cleaned up

T+5s:  Mobile reconnects to new Cloud instance
       New Cloud → Bridge: JoinRoom(userId)
       Bridge: Session might still exist if cleanup hasn't completed
       Bridge: Close old session, create new
       Result: Works regardless of cleanup timing ✅
```

## Testing Strategy

### Unit Tests (Go)

```go
func TestJoinRoomReplacesExistingSession(t *testing.T) {
  service := setupTestService()

  // First JoinRoom
  req1 := &pb.JoinRoomRequest{
    UserId: "user123",
    RoomName: "user123",
    Token: "token1",
  }
  resp1, _ := service.JoinRoom(context.Background(), req1)
  assert.True(t, resp1.Success)

  // Verify session exists
  _, exists := service.sessions.Load("user123")
  assert.True(t, exists)

  // Second JoinRoom (simulating reconnect)
  req2 := &pb.JoinRoomRequest{
    UserId: "user123",
    RoomName: "user123",
    Token: "token2",
  }
  resp2, _ := service.JoinRoom(context.Background(), req2)
  assert.True(t, resp2.Success, "Second JoinRoom should succeed, replacing old session")

  // Verify still only one session
  _, exists = service.sessions.Load("user123")
  assert.True(t, exists)
}

func TestSessionReplaceLoggedCorrectly(t *testing.T) {
  service := setupTestService()
  mockLogger := setupMockLogger()

  // Create first session
  req1 := &pb.JoinRoomRequest{UserId: "user123", ...}
  service.JoinRoom(context.Background(), req1)

  // Create second session (replacement)
  req2 := &pb.JoinRoomRequest{UserId: "user123", ...}
  service.JoinRoom(context.Background(), req2)

  // Verify warning log was emitted
  assert.Contains(t, mockLogger.Warnings, "Replacing existing bridge session")
}
```

### Integration Tests

**Test 1: Reconnection after 1006 disconnect**

```
1. Start mobile session, verify transcription working
2. Close mobile WebSocket (simulate 1006)
3. Wait 14 seconds
4. Reconnect mobile
5. Verify: JoinRoom succeeds, transcription resumes within 3s
6. Check logs: "Replacing existing bridge session" appears
```

**Test 2: Cross-environment switch**

```
1. Connect to Prod, verify working
2. Disconnect from Prod
3. Connect to Staging
4. Verify: Staging JoinRoom succeeds, transcription works
5. Verify: Prod session eventually cleaned up (StreamAudio detects closed gRPC)
```

**Test 3: Rapid reconnect cycles**

```
1. Connect mobile
2. Disconnect/reconnect 10 times in 30 seconds
3. Verify: All reconnections succeed
4. Verify: Only one session exists at any time
5. Verify: No goroutine leaks (check with pprof)
```

## Migration Strategy

### Phase 1: Proto Update

1. Add `backend_id` field to proto (optional, backward compatible)
2. Generate proto code (Go + TypeScript)
3. Deploy bridge with new proto (handles missing backendId gracefully)

**Backward compatibility**: If `backend_id` is empty, treat as legacy request:

```go
if req.BackendId == "" {
  // Legacy backend without backendId
  // Treat as before: reject if session exists
}
```

### Phase 2: Backend Update

1. Generate BACKEND_ID in cloud service startup
2. Pass backendId to all JoinRoom calls
3. Deploy backends with new code
4. Verify logs show backendId in JoinRoom requests

### Phase 3: Enable Takeover Logic

1. Bridge recognizes non-empty backendId
2. Backend takeover logic activates
3. Monitor "Backend takeover" log events
4. Verify "session already exists" errors drop to zero

### Phase 4: Deprecate Legacy Path

After 30 days of stable operation:

1. Make backendId required in proto
2. Remove empty backendId handling
3. Simplify code

## Monitoring

### Metrics to Add

**Bridge (Go)**:

```go
// Prometheus metrics
bridge_sessions_total                    // Current active sessions
bridge_sessions_created_total            // Counter
bridge_sessions_destroyed_total          // Counter
bridge_backend_takeovers_total           // Counter (NEW)
bridge_same_backend_rejections_total     // Counter (NEW)
```

**Logs to Watch**:

```
"Backend takeover detected" (WARN level)
  - user_id: string
  - old_backend: string
  - new_backend: string
  - timestamp: ISO8601
```

### Alerts

**Alert 1: High takeover rate**

```
Rate: bridge_backend_takeovers_total > 10/minute
Severity: Warning
Indicates: Frequent reconnects to different backends
Action: Check load balancer, consider session affinity
```

**Alert 2: Session leak**

```
Condition: bridge_sessions_total > 100 for 10 minutes
Severity: Critical
Indicates: Sessions not cleaning up
Action: Check for goroutine leaks in StreamAudio
```

## Testing

### Unit Tests (Go)

```go
func TestBackendTakeover(t *testing.T) {
  service := &LiveKitBridgeService{
    sessions: &sync.Map{},
  }

  // Backend A joins
  req1 := &pb.JoinRoomRequest{
    UserId: "user1",
    BackendId: "backend-a",
    // ... other fields
  }
  resp1, _ := service.JoinRoom(context.Background(), req1)
  assert.True(t, resp1.Success)

  // Backend B attempts takeover
  req2 := &pb.JoinRoomRequest{
    UserId: "user1",
    BackendId: "backend-b",
  }
  resp2, _ := service.JoinRoom(context.Background(), req2)
  assert.True(t, resp2.Success, "Backend B should successfully take over")

  // Verify session now belongs to Backend B
  sessionVal, exists := service.sessions.Load("user1")
  assert.True(t, exists)
  session := sessionVal.(*RoomSession)
  assert.Equal(t, "backend-b", session.backendId)
}

func TestSameBackendHealthyRejection(t *testing.T) {
  service := setupTestService()

  // Create healthy session
  req := &pb.JoinRoomRequest{UserId: "user1", BackendId: "backend-a"}
  service.JoinRoom(context.Background(), req)

  // Same backend tries to rejoin
  resp, _ := service.JoinRoom(context.Background(), req)
  assert.False(t, resp.Success, "Should reject duplicate from same backend")
  assert.Contains(t, resp.Error, "already exists and is healthy")
}
```

### Integration Tests (TypeScript)

```typescript
describe("Mobile reconnect to different backend", () => {
  it("should resume transcription after takeover", async () => {
    // Setup two backend instances
    const backendA = await createBackend("backend-a")
    const backendB = await createBackend("backend-b")

    // Mobile connects to Backend A
    const mobile = await connectMobile(backendA)
    await verifyTranscriptionWorking(mobile)

    // Simulate network drop
    await mobile.disconnect()
    await sleep(100)

    // Mobile reconnects to Backend B
    await mobile.connect(backendB)

    // Verify transcription resumes
    const transcripts = await waitForTranscripts(mobile, 5000)
    expect(transcripts.length).toBeGreaterThan(0)

    // Verify Backend A no longer receiving audio
    const backendAActive = await backendA.isReceivingAudio()
    expect(backendAActive).toBe(false)
  })
})
```

### Manual Testing

1. Deploy 2 backend instances:
   - Backend A: `BACKEND_ID=backend-a-test`
   - Backend B: `BACKEND_ID=backend-b-test`

2. Connect mobile to Backend A:
   - Verify transcription working
   - Check logs: "JoinRoom: backendId=backend-a-test"

3. Simulate reconnect to Backend B:
   - Close mobile app (don't kill backend)
   - Reopen mobile, force connect to Backend B IP
   - Check logs: "Backend takeover detected: old=backend-a-test, new=backend-b-test"
   - Verify transcription resumes within 5 seconds

4. Monitor metrics:
   - `bridge_backend_takeovers_total` should increment
   - `bridge_sessions_total` should stay at 1 (not grow)

## Open Questions

1. **Should we add session affinity to load balancer?**
   - Pro: Reduces takeovers, more stable sessions
   - Con: Uneven load if users don't reconnect often
   - **Decision**: No, keep stateless. Takeover is cheap operation.

2. **What if backend crashes mid-gRPC stream?**
   - StreamAudio goroutines detect stream.Context().Done()
   - Session cleanup happens automatically
   - **Verified**: Covered by existing cleanup logic

3. **Should old backend be notified of takeover?**
   - Could add RPC: NotifySessionTaken(userId, newBackendId)
   - Old backend could clean up local state faster
   - **Decision**: No, old backend's grace period timer handles it

4. **Metrics: Track takeover frequency per user?**
   - Could indicate problem users with bad network
   - Or backend affinity issues
   - **Decision**: Add later if needed, start with aggregate metrics
