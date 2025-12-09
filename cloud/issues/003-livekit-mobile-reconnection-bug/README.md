# LiveKit Mobile Reconnection Bug

Transcription stops completely after mobile reconnects following WebSocket 1006 error. Two root causes: (1) GetStatus RPC missing from proto definition, (2) Bridge rejects JoinRoom with "session already exists" for stale sessions.

## Documents

- **livekit-mobile-reconnection-bug-spec.md** - Problem, evidence, constraints
- **livekit-mobile-reconnection-bug-architecture.md** - Root cause, fix implementation
- **investigation-guide.md** - Better Stack log queries used

## Quick Context

**Actual incident** (2025-11-20 23:10 UTC): Mobile disconnects (1001), reconnects to SAME backend after 6s. GetStatus throws "this.client.getStatus is not a function" (missing from proto). Cloud tries JoinRoom twice → Bridge rejects both: "session already exists". Cloud sends CONNECTION_ACK anyway. Mobile thinks connected but no StreamAudio. PCM chunks stop flowing. Soniox keeps sending keepalives (false healthy signal). Transcription permanently dead.

**Root causes confirmed**:

1. **GetStatus RPC not defined in proto** - Cloud can't check session health, operates blind
2. **Bridge session check too strict** - Rejects based on existence, not health (doesn't check if session is disconnected/stale)
3. **False healthy signal** - Soniox keepalives succeed even though no audio flows

## Key Context

**Architecture**:

- Each environment (prod/staging) has separate Cloud VM + Bridge process
- Shared: LiveKit server URL, Database (userId)
- Room names: Environment-specific (e.g., `room-staging-user123`)

**The bug sequence** (confirmed from logs):

1. User connected to Staging, transcription working
2. Mobile network drops, WebSocket closes (1006) at 15:12:42
3. Cloud detects close, starts 60s grace period, does NOT clean up bridge session
4. Mobile reconnects at 15:12:56 (14 seconds later, still in grace period)
5. Cloud calls `rejoinBridge()` → Bridge JoinRoom
6. Bridge rejects: "session already exists for this user"
7. Cloud retries with fresh gRPC client, rejected again
8. Cloud gives up but sends CONNECTION_ACK to mobile anyway
9. Mobile thinks it's connected, but no audio flows
10. Transcription permanently broken

**Evidence**: Better Stack logs for `israelov+test2@mentra.glass` on `2025-11-20 15:12:56 PST` showing double JoinRoom failure

## Solution

### Root Causes Identified

1. **GetStatus RPC Missing from Proto** (Critical)

   ```
   Error: "this.client.getStatus is not a function"
   ```

   - Implemented in Go (service.go line 523) but NOT in proto definition
   - TypeScript gRPC client can't find the method
   - Cloud operates blind, can't check if bridge session is healthy/stale

2. **Bridge Session Check Too Strict - Causes Zombie Sessions**

   ```go
   // Bridge service.go line 63
   if _, exists := s.sessions.Load(req.UserId); exists {
       return error("session already exists")
   }
   ```

   - Only checks existence, not health
   - Blocks ALL reconnections when old session exists in memory
   - **No cleanup mechanism for orphaned sessions**
   - When cloud crashes/restarts, bridge keeps sessions forever

3. **Zombie Session Problem** (Major Discovery)
   - Users hitting "session already exists" on **FIRST CONNECTION** (not reconnection!)
   - 375 failures in 7 days, 212 for one dev user (mentradevphone@gmail.com)
   - Caused by: Cloud crashes/restarts, bridge never cleans up session
   - Zombie sessions have `connected=true, room!=nil` but cloud is long gone
   - No TTL, no activity checks, no cleanup mechanism at all

4. **Broken Audio Pipeline Not Detected**
   - JoinRoom fails → No StreamAudio goroutine
   - PCM chunks never reach AudioManager
   - But Soniox keeps sending keepalives (false healthy signal)
   - TranscriptionManager reports "healthy" even though audio pipeline is dead

### Fixes Required

**Fix #1: Add GetStatus to Proto** (Required First)

```protobuf
service LiveKitBridge {
  rpc GetStatus(GetStatusRequest) returns (GetStatusResponse);
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

**Fix #2: Always Replace Existing Sessions in Bridge** (Recommended)

```go
func (s *LiveKitBridgeService) JoinRoom(req *pb.JoinRoomRequest) {
    // Always replace existing session - no health checks needed
    if existingVal, exists := s.sessions.Load(req.UserId); exists {
        log.Printf("Replacing existing session for %s", req.UserId)
        existing := existingVal.(*RoomSession)
        existing.Close()  // Calls room.Disconnect() to LiveKit
        s.sessions.Delete(req.UserId)
    }

    // Create new session...
}
```

**Why always-replace instead of health checks**:

- **Solves zombie sessions**: Orphaned sessions from crashes get cleaned up
- **No false positives**: Health checks fail for zombies with `connected=true, room!=nil`
- **Simplest solution**: No complex logic, no edge cases
- **Matches user expectation**: Calling JoinRoom should always let me join
- **LiveKit handles duplicates**: If old participant still in room, LiveKit kicks it

**Fix #3: Add Error Notification to Mobile**

- When bridge rejoin fails, send error message to mobile
- CONNECTION_ACK should still be sent (WebSocket is up, apps need to work)
- Add separate error notification: "Audio unavailable - transcription disabled"

### Why Always-Replace Is Better Than Grace Period Cleanup

**Previous consideration**: Call LeaveRoom after short grace period

- **Problem**: If user switches backends, old backend's LeaveRoom kicks new session
- **Problem**: Race condition between backends calling LeaveRoom/JoinRoom
- **Problem**: Doesn't solve zombie sessions from crashes (no LeaveRoom ever called)

**Always-replace solution**:

- Each backend has own bridge process with separate session map
- When JoinRoom called, always replace existing session in that bridge
- Cross-backend switches work: different bridges, different maps
- Zombie sessions cleaned up: next JoinRoom replaces them
- No grace period coordination needed
- LiveKit handles participant-level conflicts naturally

## Status

- [x] Query Better Stack logs - Found exact failure at 23:10:23 UTC
- [x] Identify error sequence - GetStatus throws, JoinRoom rejected twice, CONNECTION_ACK sent anyway
- [x] Confirm root causes:
  - GetStatus RPC not defined in proto (this.client.getStatus is not a function)
  - Bridge session check only verifies existence, blocks all reconnections
  - Zombie sessions from crashes never cleaned up (no TTL, no activity checks)
  - 375 failures in 7 days from orphaned sessions
- [x] Decision: Always-replace approach (not health checks)
  - Solves zombie sessions, no false positives, simplest solution
- [x] Implement Fix #1: Add GetStatus to livekit_bridge.proto
  - Added BridgeStatusRequest and BridgeStatusResponse messages
  - Added GetStatus RPC to service definition
- [x] Regenerate proto files:
  - Synchronized both proto files (cloud and cloud-livekit-bridge) - now identical
  - Regenerated Go proto files with GetStatus RPC included
  - TypeScript uses dynamic proto loading (@grpc/proto-loader) - no generation needed
  - Verified GetStatus method exists in generated Go code
- [x] Implement Fix #2: Always-replace in service.go JoinRoom
  - Removed "session already exists" rejection
  - Added logic to close old session and create new one
  - Logs "Replacing existing bridge session"
- [x] Rebuild bridge: `cd cloud/packages/cloud-livekit-bridge && go build`
  - Binary built successfully (37MB)
  - Compiled with updated proto definitions including GetStatus
- [ ] Implement Fix #3: Error notification to mobile when bridge fails (optional)
- [ ] Test reproduction: Force quit app + restart cloud = zombie session
- [ ] Test fix: Zombie session should be replaced, transcription works
- [ ] Deploy to staging, verify reconnection and zombie cleanup works
- [ ] Deploy to prod after validation

## How to Reproduce the Bug

### Method 1: Force Quit + Restart Cloud (Most Reliable)

This simulates a cloud crash that leaves zombie sessions in the bridge:

```bash
# 1. Connect your mobile device to development environment
# 2. Verify transcription is working (speak and see captions)

# 3. Force quit the mobile app (swipe up on iOS, don't just minimize)

# 4. On your dev server, restart ONLY the cloud process (not bridge):
pm2 restart cloud
# or
docker restart cloud-container

# 5. Wait 2 seconds for cloud to fully restart

# 6. Reopen mobile app and try to connect

# 7. Check Better Stack logs:
#    BEFORE FIX: "JoinRoom returned failure: session already exists"
#    AFTER FIX:  "Replacing existing bridge session" + "Successfully joined room"
```

### Method 2: Kill Cloud Process (Simulates Crash)

```bash
# 1. SSH into your development cloud server

# 2. Find the node process
ps aux | grep node

# 3. Kill it hard (simulates crash)
kill -9 <pid>

# 4. Restart cloud
pm2 start cloud

# 5. Try to connect from mobile
# Bridge will have zombie session, should fail before fix, succeed after fix
```

### Method 3: Check for Existing Zombies

You might already have zombie sessions! Just try connecting:

```bash
# Check Better Stack logs for your userId
# Search for: "JoinRoom returned failure"
# If you see it on FIRST connection (not reconnection), you have a zombie!
```

### Expected Results

**BEFORE FIX (Current Behavior):**

```
[Cloud] Calling JoinRoom RPC
[Bridge] session already exists for this user
[Cloud] JoinRoom returned failure
[Cloud] Sent CONNECTION_ACK  ← Mobile thinks connected
[Mobile] No captions appear when speaking
```

**AFTER FIX (With Always-Replace):**

```
[Cloud] Calling JoinRoom RPC
[Bridge] Replacing existing bridge session
[Bridge] Successfully joined room
[Cloud] Sent CONNECTION_ACK
[Cloud] AudioManager received PCM chunk  ← Audio flowing!
[Mobile] Captions appear when speaking ✅
```

### Verification Checklist

After implementing the fix:

- [ ] Method 1 works: Force quit + cloud restart → can reconnect
- [ ] No "session already exists" errors in logs
- [ ] See "Replacing existing bridge session" in bridge logs
- [ ] PCM chunks flow after reconnection
- [ ] Transcription works after reconnection
- [ ] Zombie session cleanup: Old sessions don't accumulate over time
