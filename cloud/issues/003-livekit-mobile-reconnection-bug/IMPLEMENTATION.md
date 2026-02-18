# Implementation Guide: LiveKit Mobile Reconnection Bug Fix

## Changes Completed ✅

### 1. Added GetStatus RPC to Proto (Fix #1)

**Files modified:**

- `cloud/packages/cloud/proto/livekit_bridge.proto`
- `cloud/packages/cloud-livekit-bridge/proto/livekit_bridge.proto`

**Changes:**

```protobuf
service LiveKitBridge {
  rpc GetStatus(GetStatusRequest) returns (GetStatusResponse);  // ← ADDED
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

### 2. Always-Replace Logic in Bridge (Fix #2)

**File modified:**

- `cloud/packages/cloud-livekit-bridge/service.go`

**Changes:**

```go
// OLD CODE (line 62-69):
if _, exists := s.sessions.Load(req.UserId); exists {
    s.bsLogger.LogWarn("Session already exists for user", ...)
    return &pb.JoinRoomResponse{
        Success: false,
        Error:   "session already exists for this user",
    }, nil
}

// NEW CODE:
if existingVal, exists := s.sessions.Load(req.UserId); exists {
    s.bsLogger.LogInfo("Replacing existing bridge session", ...)
    existingSession := existingVal.(*RoomSession)
    existingSession.Close()  // Calls room.Disconnect(), closes goroutines
    s.sessions.Delete(req.UserId)
}
```

## Next Steps 🚀

### Step 1: Regenerate Proto Files ✅ COMPLETED

Both proto files have been synchronized and regenerated:

#### For Go Bridge: ✅ DONE

```bash
cd cloud/packages/cloud-livekit-bridge
protoc --plugin=protoc-gen-go=$HOME/go/bin/protoc-gen-go \
  --plugin=protoc-gen-go-grpc=$HOME/go/bin/protoc-gen-go-grpc \
  --go_out=. --go_opt=paths=source_relative \
  --go-grpc_out=. --go-grpc_opt=paths=source_relative \
  proto/livekit_bridge.proto
```

Generated files (verified GetStatus RPC is included):

- ✅ `proto/livekit_bridge.pb.go` (45KB)
- ✅ `proto/livekit_bridge_grpc.pb.go` (16KB)
- ✅ `GetStatus` method confirmed in generated code

#### For TypeScript Cloud: ✅ NO ACTION NEEDED

The TypeScript code uses `@grpc/proto-loader` to load proto files **dynamically at runtime**.
No code generation required - proto changes are automatically picked up!

The `getStatus()` method already exists in `LiveKitGrpcClient.ts` and will work immediately
with the updated proto file.

### Step 2: Rebuild Go Bridge ✅ COMPLETED

```bash
cd cloud/packages/cloud-livekit-bridge
go build -o cloud-livekit-bridge
```

Result:

- ✅ Binary built successfully: `cloud-livekit-bridge` (37MB)
- ✅ Compiled with updated proto definitions
- ⚠️ Warning about duplicate `-lopus` libraries (harmless)

### Step 3: Test the Fix (NEXT)

#### Test 1: Reproduce the Bug (Before Deploying)

1. Connect mobile app to development environment
2. Verify transcription working
3. Force quit mobile app
4. On dev server: `pm2 restart cloud` (restart cloud but NOT bridge)
5. Reopen mobile app and try to connect
6. **Before fix**: "JoinRoom returned failure: session already exists"
7. **After fix**: Should see "Replacing existing bridge session" in logs

#### Test 2: Verify Reconnection Works

Check Better Stack logs for:

```
[Bridge] Replacing existing bridge session (user_id=X, reason=new_join_request)
[Cloud] Joined LiveKit room
[Cloud] AudioManager received PCM chunk
[User speaks] Captions appear ✅
```

#### Test 3: Verify GetStatus Works

Check logs - should no longer see:

```
ERROR: GetStatus threw: "this.client.getStatus is not a function"
```

Instead should see:

```
INFO: Bridge status fetched: {connected: false/true, ...}
```

### Step 4: Deploy to Staging (PENDING)

1. **Deploy bridge first** (backwards compatible - won't break existing cloud)
2. **Then deploy cloud** (can now call GetStatus)
3. Monitor Better Stack for:
   - No more "session already exists" errors
   - "Replacing existing bridge session" logs appearing
   - Successful reconnections

### Step 5: Deploy to Production (PENDING)

Same order as staging:

1. Deploy bridge
2. Deploy cloud
3. Monitor for 24 hours

## Verification Checklist

Build & Proto Generation:

- [x] Proto files synchronized (both files identical)
- [x] Go proto files regenerated with GetStatus RPC
- [x] GetStatus method verified in generated Go code
- [x] TypeScript proto loading confirmed (dynamic, no generation needed)
- [x] Go bridge binary built successfully

After deployment, verify:

- [ ] No "JoinRoom returned failure: session already exists" errors in logs
- [ ] See "Replacing existing bridge session" when reconnections happen
- [ ] GetStatus no longer throws "not a function" error
- [ ] Transcription works after reconnection
- [ ] PCM chunks flow after reconnection
- [ ] No increase in error rates
- [ ] Zombie session cleanup working (monitor session count)

## Rollback Plan

If issues occur:

1. **Rollback cloud only**: Old cloud will still work with new bridge (GetStatus just won't be called)
2. **Rollback bridge only**: Old bridge will reject duplicates again (back to broken state)
3. **Rollback both**: Back to original broken state

**Recommendation**: If rollback needed, rollback cloud only first to see if that fixes issues. Bridge changes are safe and beneficial.

## Expected Impact

### Before Fix:

- 375 "session already exists" failures in 7 days
- 12 users affected
- Transcription broken after reconnections
- Users experiencing: mentradevphone@gmail.com (212 failures), alex1115alex@gmail.com (79 failures), etc.

### After Fix:

- Zero "session already exists" errors
- Seamless reconnections
- Zombie sessions automatically cleaned up
- Transcription resumes within 2-3 seconds of reconnection

## Monitoring

Key metrics to watch in Better Stack:

```
# Count of "session exists" errors (should drop to 0)
message:"session already exists for this user" AND env:staging

# Count of session replacements (should match reconnection rate)
message:"Replacing existing bridge session" AND env:staging

# Successful JoinRoom calls
message:"Successfully joined room" AND env:staging
```

## Related Issues

- [Issue #004: Apps Not Restarting on Reconnection](../004-apps-not-restarting-on-reconnection/README.md) - Separate issue, needs different fix

## Notes

- The always-replace approach is simpler and more reliable than health checks
- Handles all edge cases: quick reconnects, zombie sessions, crashes, cross-backend switches
- LiveKit naturally handles duplicate participant identities (kicks old one)
- No false positives from stale sessions appearing healthy

## Questions?

If you encounter issues:

1. Check Better Stack logs for new error patterns
2. Verify proto files were regenerated correctly
3. Ensure bridge was rebuilt with new code
4. Check that GetStatus RPC is working (no longer throws error)
