# Plan of Action: Enable Audio Overlap When `StopOther = false`

## Problem Statement

**Current Behavior:**

- When `StopOther = false`, audio plays sequentially (Audio A finishes, then Audio B starts)
- Audio queues/waits instead of overlapping

**Desired Behavior:**

- When `StopOther = false`, audio should overlap (Audio A and Audio B play simultaneously)
- When `StopOther = true`, audio should interrupt immediately (current behavior is correct)

---

## Root Cause Analysis

### The Blocking Mechanism

**Location:** [service.go:407-435](../service.go#L407-L435)

```go
// Play audio file (implementation in playback.go)
duration, err := s.playAudioFile(req, session, stream, trackName)

// ... error handling ...

// Send COMPLETED event
if err := stream.Send(&pb.PlayAudioEvent{
    Type:       pb.PlayAudioEvent_COMPLETED,
    RequestId:  req.RequestId,
    DurationMs: duration,
}); err != nil {
    return err
}

// DON'T close the track - keep it alive for reuse
// This prevents "no audio after first play" issue

return nil  //  RPC returns ONLY after playback completes
```

**Key Issue:**
The `PlayAudio` RPC handler is **synchronous**. It calls `playAudioFile()` which blocks until the entire audio finishes playing. This means:

1. PlayAudio RPC for Audio A arrives � starts playing � **blocks until Audio A completes**
2. PlayAudio RPC for Audio B arrives � **waits for Audio A's RPC to finish** � then starts playing
3. Result: Sequential playback, no overlap

### Why This Design Was Chosen

The synchronous design ensures:

- gRPC stream stays alive to send STARTED/COMPLETED/FAILED events
- Clean error handling
- Simple state management

### Previous Implementation Attempt

Based on code comments and the provided files, the previous implementation likely:

- Made `playAudioFile()` asynchronous (returned immediately)
- Did not wait for playback to complete before returning from RPC
- **Problem:** gRPC stream closed too early, events couldn't be sent
- **Problem:** No coordination between concurrent playback goroutines

---

## Solution Design

### Overview

Enable concurrent audio playback when `StopOther = false` while maintaining the RPC stream for event delivery. The key is to:

1. **Decouple playback execution from RPC lifecycle** when `StopOther = false`
2. **Manage concurrent goroutines** writing to the same track
3. **Handle the `StopOther = true` flag** to cancel ALL ongoing playback
4. **Preserve event delivery** through the gRPC stream

---

## Detailed Implementation Plan

### Phase 1: Add Concurrent Playback Management to RoomSession

**File:** `session.go`

**Changes:**

1. **Add concurrent playback tracking** (around line 16-34):

```go
type RoomSession struct {
    userId           string
    room             *lksdk.Room
    tracks           map[string]*lkmedia.PCMLocalTrack
    publications     map[string]*lksdk.LocalTrackPublication
    audioFromLiveKit chan []byte
    ctx              context.Context
    cancel           context.CancelFunc
    closeOnce        sync.Once
    mu               sync.RWMutex

    // NEW: Concurrent playback management
    activePlaybacks     map[string]*PlaybackContext  // requestId -> context
    playbackMu          sync.RWMutex                 // Separate lock for playback map

    // Connectivity state
    connected            bool
    participantID        string
    participantCount     int
    lastDisconnectAt     time.Time
    lastDisconnectReason string
}

// NEW: Playback context for each audio request
type PlaybackContext struct {
    requestId  string
    trackName  string
    ctx        context.Context
    cancel     context.CancelFunc
    startTime  time.Time
}
```

2. **Add methods to manage concurrent playback** (after line 46):

```go
// registerPlayback registers a new concurrent playback
func (s *RoomSession) registerPlayback(requestId, trackName string) *PlaybackContext {
    s.playbackMu.Lock()
    defer s.playbackMu.Unlock()

    if s.activePlaybacks == nil {
        s.activePlaybacks = make(map[string]*PlaybackContext)
    }

    ctx, cancel := context.WithCancel(s.ctx)
    pctx := &PlaybackContext{
        requestId: requestId,
        trackName: trackName,
        ctx:       ctx,
        cancel:    cancel,
        startTime: time.Now(),
    }

    s.activePlaybacks[requestId] = pctx
    log.Printf("Registered playback: requestId=%s, trackName=%s (total active: %d)",
        requestId, trackName, len(s.activePlaybacks))

    return pctx
}

// unregisterPlayback removes a completed playback
func (s *RoomSession) unregisterPlayback(requestId string) {
    s.playbackMu.Lock()
    defer s.playbackMu.Unlock()

    if pctx, exists := s.activePlaybacks[requestId]; exists {
        duration := time.Since(pctx.startTime)
        delete(s.activePlaybacks, requestId)
        log.Printf("Unregistered playback: requestId=%s, duration=%s (remaining active: %d)",
            requestId, duration, len(s.activePlaybacks))
    }
}

// stopAllPlayback cancels ALL ongoing playback (for StopOther=true)
func (s *RoomSession) stopAllPlayback() {
    s.playbackMu.Lock()
    defer s.playbackMu.Unlock()

    log.Printf("Stopping all playback for user %s (%d active)", s.userId, len(s.activePlaybacks))

    for requestId, pctx := range s.activePlaybacks {
        log.Printf("Canceling playback: requestId=%s", requestId)
        pctx.cancel()
    }

    // Clear the map (will be repopulated as goroutines exit)
    s.activePlaybacks = make(map[string]*PlaybackContext)
}

// getActivePlaybackCount returns number of concurrent playbacks
func (s *RoomSession) getActivePlaybackCount() int {
    s.playbackMu.RLock()
    defer s.playbackMu.RUnlock()
    return len(s.activePlaybacks)
}
```

3. **Update stopPlayback() method** (replace lines 151-160):

```go
// stopPlayback cancels ALL ongoing audio playback
func (s *RoomSession) stopPlayback() {
    s.stopAllPlayback()

    // Also unpublish and close all tracks to ensure immediate silence
    s.mu.Lock()
    defer s.mu.Unlock()

    for name, track := range s.tracks {
        if pub, exists := s.publications[name]; exists {
            s.room.LocalParticipant.UnpublishTrack(pub.SID())
            delete(s.publications, name)
        }
        track.Close()
        delete(s.tracks, name)
        log.Printf("Stopped and closed track '%s' for user %s", name, s.userId)
    }
}
```

4. **Update Close() method** to clean up playback contexts (modify lines 162-205):

```go
func (s *RoomSession) Close() {
    s.closeOnce.Do(func() {
        log.Printf("Closing room session for user %s", s.userId)

        // Cancel all active playback first
        s.stopAllPlayback()

        // Cancel main context (stops all goroutines)
        s.cancel()

        // ... rest of existing Close() logic ...
    })
}
```

5. **Update NewRoomSession()** (line 37-46):

```go
func NewRoomSession(userId string) *RoomSession {
    ctx, cancel := context.WithCancel(context.Background())
    return &RoomSession{
        userId:           userId,
        tracks:           make(map[string]*lkmedia.PCMLocalTrack),
        publications:     make(map[string]*lksdk.LocalTrackPublication),
        audioFromLiveKit: make(chan []byte, 200),
        ctx:              ctx,
        cancel:           cancel,
        activePlaybacks:  make(map[string]*PlaybackContext),  // NEW
    }
}
```

---

### Phase 2: Modify PlayAudio RPC Handler for Concurrent Execution

**File:** `service.go`

**Changes to PlayAudio method** (lines 383-436):

```go
func (s *LiveKitBridgeService) PlayAudio(
    req *pb.PlayAudioRequest,
    stream pb.LiveKitBridge_PlayAudioServer,
) error {
    log.Printf("PlayAudio request: userId=%s, url=%s, stopOther=%v, requestId=%s",
        req.UserId, req.AudioUrl, req.StopOther, req.RequestId)

    sessionVal, ok := s.sessions.Load(req.UserId)
    if !ok {
        return status.Errorf(codes.NotFound, "session not found for user %s", req.UserId)
    }
    session := sessionVal.(*RoomSession)

    // If stop_other is true, cancel ALL ongoing playback first
    if req.StopOther {
        log.Printf("StopOther flag set, canceling all ongoing playback for user %s", req.UserId)
        session.stopPlayback()

        // Brief sleep to ensure cancellation propagates
        time.Sleep(50 * time.Millisecond)
    }

    // Send STARTED event
    if err := stream.Send(&pb.PlayAudioEvent{
        Type:      pb.PlayAudioEvent_STARTED,
        RequestId: req.RequestId,
    }); err != nil {
        return err
    }

    // Convert track_id to track name
    trackName := trackIDToName(req.TrackId)

    // Register this playback for concurrent management
    playbackCtx := session.registerPlayback(req.RequestId, trackName)
    defer session.unregisterPlayback(req.RequestId)

    // CRITICAL CHANGE: Play audio asynchronously when StopOther=false
    if req.StopOther {
        // StopOther=true: BLOCKING mode (wait for completion)
        log.Printf("Playing audio in BLOCKING mode (StopOther=true): requestId=%s", req.RequestId)

        duration, err := s.playAudioFile(req, session, playbackCtx, trackName)

        if err != nil {
            stream.Send(&pb.PlayAudioEvent{
                Type:      pb.PlayAudioEvent_FAILED,
                RequestId: req.RequestId,
                Error:     err.Error(),
            })
            return err
        }

        // Send COMPLETED event
        if err := stream.Send(&pb.PlayAudioEvent{
            Type:       pb.PlayAudioEvent_COMPLETED,
            RequestId:  req.RequestId,
            DurationMs: duration,
        }); err != nil {
            return err
        }

        return nil

    } else {
        // StopOther=false: NON-BLOCKING mode (allow overlap)
        log.Printf("Playing audio in NON-BLOCKING mode (StopOther=false): requestId=%s", req.RequestId)

        // Create done channel for async completion
        done := make(chan struct{})
        var playbackErr error
        var playbackDuration int64

        // Start playback in goroutine
        go func() {
            defer close(done)
            duration, err := s.playAudioFile(req, session, playbackCtx, trackName)
            playbackErr = err
            playbackDuration = duration

            // Send completion event from goroutine
            if err != nil {
                stream.Send(&pb.PlayAudioEvent{
                    Type:      pb.PlayAudioEvent_FAILED,
                    RequestId: req.RequestId,
                    Error:     err.Error(),
                })
            } else {
                stream.Send(&pb.PlayAudioEvent{
                    Type:       pb.PlayAudioEvent_COMPLETED,
                    RequestId:  req.RequestId,
                    DurationMs: duration,
                })
            }

            log.Printf("Async playback completed: requestId=%s, duration=%dms, err=%v",
                req.RequestId, duration, err)
        }()

        // Wait for completion to keep stream alive for event delivery
        // BUT allow other PlayAudio RPCs to proceed concurrently
        <-done

        // Return any error from playback
        return playbackErr
    }
}
```

**Key Changes:**

1. **Check `StopOther` flag** and call `stopAllPlayback()` to cancel ALL active playback
2. **Register playback** with request ID for tracking
3. **Branch logic:**
   - `StopOther=true`: Synchronous/blocking playback (original behavior)
   - `StopOther=false`: Asynchronous/non-blocking playback (new behavior)
4. **Send events from goroutine** when in async mode
5. **Still wait on `<-done`** to keep gRPC stream alive for event delivery

---

### Phase 3: Update playAudioFile to Use PlaybackContext

**File:** `playback.go`

**Changes:**

1. **Update function signature** (line 20-25):

```go
func (s *LiveKitBridgeService) playAudioFile(
    req *pb.PlayAudioRequest,
    session *RoomSession,
    playbackCtx *PlaybackContext,  // NEW: Use playback context instead of stream
    trackName string,
) (int64, error) {
    // Use playbackCtx.ctx instead of creating new context
    ctx := playbackCtx.ctx
```

2. **Remove context creation** (delete lines 26-33):

```go
// DELETE THIS:
// ctx, cancel := context.WithCancel(stream.Context())
// defer cancel()
//
// session.mu.Lock()
// session.playbackCancel = cancel
// session.mu.Unlock()
```

3. **Update playMP3 and playWAV calls** (line 59, 64):

```go
if strings.Contains(contentType, "audio/mpeg") || strings.HasSuffix(url, ".mp3") {
    return s.playMP3(ctx, resp.Body, req, session, trackName)
} else if strings.Contains(contentType, "audio/wav") || ... {
    return s.playWAV(ctx, resp.Body, req, session, trackName)
}
```

**Note:** `playMP3` and `playWAV` already accept `ctx` as first parameter, so they'll automatically use the playback-specific context for cancellation.

---

### Phase 4: Handle Track Reuse and Concurrency

**File:** `session.go`

**Ensure thread-safety for concurrent writes:**

The existing `writeAudioToTrack()` method (lines 98-137) already has proper locking:

- `getOrCreateTrack()` uses `s.mu.Lock()` for track creation
- `track.WriteSample()` is thread-safe in the LiveKit SDK

**No changes needed** - concurrent writes to the same track will be automatically mixed by LiveKit.

**Optional Enhancement:** Add logging to track concurrent writes (line 128):

```go
if err := track.WriteSample(frame); err != nil {
    return fmt.Errorf("failed to write sample: %w", err)
}

// Optional: Log concurrent usage
if session.getActivePlaybackCount() > 1 {
    log.Printf("Concurrent playback detected: %d active on track '%s'",
        session.getActivePlaybackCount(), trackName)
}
```

---

### Phase 5: Update StopAudio RPC Handler

**File:** `service.go`

**Update StopAudio method** (lines 438-468):

```go
func (s *LiveKitBridgeService) StopAudio(
    ctx context.Context,
    req *pb.StopAudioRequest,
) (*pb.StopAudioResponse, error) {
    log.Printf("StopAudio request: userId=%s, trackId=%d", req.UserId, req.TrackId)

    sessionVal, ok := s.sessions.Load(req.UserId)
    if !ok {
        return &pb.StopAudioResponse{
            Success: false,
            Error:   "session not found",
        }, nil
    }

    session := sessionVal.(*RoomSession)

    // Cancel ALL active playback (not just one track)
    session.stopAllPlayback()

    // Convert track_id to track name
    trackName := trackIDToName(req.TrackId)

    // Close the specific track
    session.closeTrack(trackName)

    log.Printf("Stopped all playback and closed track '%s' for user %s", trackName, session.userId)

    return &pb.StopAudioResponse{
        Success:          true,
        StoppedRequestId: req.RequestId,
    }, nil
}
```

**Key Change:** Call `stopAllPlayback()` instead of `stopPlayback()` to cancel ALL concurrent playback, not just one.

---

## Testing Strategy

### Test Case 1: Overlapping Audio (StopOther=false)

**SDK Code:**

```typescript
console.log("Starting audio1")
session.audio.speak("This is audio one", {stopOtherAudio: false})
console.log("Immediately starting audio2")
session.audio.speak("This is audio two", {stopOtherAudio: false})
console.log("Both audios started")

// Expected behavior:
// - Both audios start immediately
// - Audio overlaps (plays simultaneously)
// - Both STARTED events arrive quickly
// - Both COMPLETED events arrive after respective audio finishes
```

**Verification:**

- Listen to audio output - should hear both overlapping
- Check logs for "Concurrent playback detected"
- Verify `activePlaybacks` map has 2 entries during overlap

---

### Test Case 2: Interrupt Behavior (StopOther=true)

**SDK Code:**

```typescript
console.log("Starting long audio")
session.audio.speak("This is a very long message that takes time to play", {stopOtherAudio: false})

setTimeout(() => {
  console.log("Interrupting with urgent message")
  session.audio.speak("URGENT", {stopOtherAudio: true})
}, 1000)

// Expected behavior:
// - Long audio starts playing
// - After 1 second, urgent message interrupts
// - Long audio stops immediately (FAILED event or context canceled)
// - Urgent message plays alone
```

**Verification:**

- Audio should cut off abruptly when interrupted
- Check logs for "StopOther flag set, canceling all ongoing playback"
- Verify all previous playback contexts are canceled

---

### Test Case 3: Multiple Concurrent Overlaps

**SDK Code:**

```typescript
// Fire 3 audio requests without await
session.audio.speak("One", {stopOtherAudio: false})
session.audio.speak("Two", {stopOtherAudio: false})
session.audio.speak("Three", {stopOtherAudio: false})

// Expected behavior:
// - All 3 start immediately
// - All 3 play simultaneously (overlapping)
// - 3 concurrent goroutines writing to same track
```

**Verification:**

- Verify `activePlaybacks` has 3 entries
- Audio should sound chaotic (all 3 voices at once)
- All COMPLETED events should arrive

---

### Test Case 4: Rapid Stop/Start

**SDK Code:**

```typescript
session.audio.speak("First audio", {stopOtherAudio: false})
session.audio.speak("Second audio", {stopOtherAudio: false})

// Immediately stop
session.audio.stopAudio(0)

// Start new audio
session.audio.speak("After stop", {stopOtherAudio: false})

// Expected behavior:
// - First two audios start
// - StopAudio cancels both
// - Third audio starts fresh
```

**Verification:**

- Check that `stopAllPlayback()` cancels both active playbacks
- Verify new audio plays after stop

---

### Test Case 5: Error Handling During Overlap

**SDK Code:**

```typescript
// Start valid audio
session.audio.speak("Valid audio", {stopOtherAudio: false})

// Start invalid audio (bad URL)
session.audio.playAudio({
  audioUrl: "https://invalid-url.com/audio.mp3",
  stopOtherAudio: false,
  trackId: 0,
})

// Start another valid audio
session.audio.speak("Another valid audio", {stopOtherAudio: false})

// Expected behavior:
// - Valid audio plays
// - Invalid audio fails (FAILED event)
// - Another valid audio plays
// - No impact on concurrent valid audio
```

**Verification:**

- Check that one failed playback doesn't affect others
- Verify `unregisterPlayback()` is called for failed playback
- Verify track remains open for subsequent audio

---

## Edge Cases to Handle

### 1. Maximum Concurrent Limit

**Problem:** Too many concurrent playbacks could overwhelm the system.

**Solution:** Add limit to `registerPlayback()`:

```go
func (s *RoomSession) registerPlayback(requestId, trackName string) (*PlaybackContext, error) {
    s.playbackMu.Lock()
    defer s.playbackMu.Unlock()

    // Limit to 10 concurrent playbacks per user
    if len(s.activePlaybacks) >= 10 {
        return nil, fmt.Errorf("too many concurrent playbacks (max 10)")
    }

    // ... rest of method
}
```

**Handle in PlayAudio:**

```go
playbackCtx, err := session.registerPlayback(req.RequestId, trackName)
if err != nil {
    stream.Send(&pb.PlayAudioEvent{
        Type:      pb.PlayAudioEvent_FAILED,
        RequestId: req.RequestId,
        Error:     err.Error(),
    })
    return err
}
defer session.unregisterPlayback(req.RequestId)
```

---

### 2. Context Cancellation Race Condition

**Problem:** Playback goroutine might continue briefly after cancellation.

**Solution:** Check context at regular intervals in `playMP3` and `playWAV` (already implemented at lines 98-102 in playback.go):

```go
for {
    // Check for cancellation
    select {
    case <-ctx.Done():
        return 0, ctx.Err()
    default:
    }

    // ... read and write audio
}
```

This is already in place - no changes needed.

---

### 3. Event Ordering Guarantees

**Problem:** Events might arrive out of order when sent from goroutines.

**Solution:** gRPC streams are ordered by default. Events sent on the same stream arrive in order. However, if we're worried about race conditions:

```go
// Optional: Add sequence numbers to events
stream.Send(&pb.PlayAudioEvent{
    Type:         pb.PlayAudioEvent_COMPLETED,
    RequestId:    req.RequestId,
    DurationMs:   duration,
    SequenceNum:  atomic.AddInt64(&s.eventSequence, 1),
})
```

**Recommendation:** Not needed initially. Monitor in production.

---

### 4. Track Cleanup After Concurrent Playback

**Problem:** When should tracks be closed after multiple concurrent playbacks finish?

**Current Behavior:** Tracks are NOT closed after playback (to enable reuse).

**Recommendation:** Keep current behavior. Tracks are only closed when:

- `StopAudio()` is explicitly called
- Session closes
- Error during playback

This prevents the "no audio after first play" issue.

---

## Migration and Rollback Plan

### Deployment Strategy

1. **Feature Flag:** Add environment variable to enable/disable overlapping audio:

   ```go
   var enableAudioOverlap = os.Getenv("ENABLE_AUDIO_OVERLAP") == "true"

   if enableAudioOverlap && !req.StopOther {
       // New non-blocking behavior
   } else {
       // Old blocking behavior
   }
   ```

2. **Gradual Rollout:**
   - Deploy with flag OFF initially
   - Enable for test users
   - Monitor metrics (concurrent playback count, errors)
   - Enable for all users

3. **Monitoring:**
   - Log concurrent playback count
   - Track `activePlaybacks` map size
   - Monitor error rates for playback failures

### Rollback Plan

If issues arise:

1. Set `ENABLE_AUDIO_OVERLAP=false`
2. Restart service
3. All audio reverts to sequential behavior

**No data loss** - this is a behavioral change only.

---

## Success Criteria

### Functional Requirements

-  When `StopOther=false`, multiple audio plays simultaneously
-  When `StopOther=true`, audio interrupts immediately
-  STARTED/COMPLETED/FAILED events still delivered correctly
-  Track reuse works (no "no audio after first play" bug)
-  No static feedback from empty tracks

### Performance Requirements

-  Support at least 3-5 concurrent audio playbacks per user
-  No memory leaks from orphaned goroutines
-  Context cancellation works within 100ms

### Stability Requirements

-  No crashes from concurrent map access
-  Graceful handling of errors during concurrent playback
-  Clean session shutdown cancels all active playback

---

## Files to Modify Summary

| File          | Lines to Modify                           | Changes                                                                  |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `session.go`  | 16-34, 37-46, 46+ (new), 151-160, 162-205 | Add `PlaybackContext`, concurrent playback tracking, `stopAllPlayback()` |
| `service.go`  | 383-436, 438-468                          | Split blocking/non-blocking logic, update `StopAudio`                    |
| `playback.go` | 20-25, 26-33 (delete), 59, 64             | Use `PlaybackContext` instead of creating context                        |

**Estimated Lines Changed:** ~300 lines
**New Code:** ~150 lines
**Deleted Code:** ~10 lines

---

## Timeline Estimate

- **Phase 1 (Session Changes):** 2-3 hours
- **Phase 2 (Service Changes):** 2-3 hours
- **Phase 3 (Playback Changes):** 1 hour
- **Phase 4 (Track Concurrency):** 1 hour (verify existing)
- **Phase 5 (StopAudio Update):** 30 minutes
- **Testing:** 3-4 hours
- **Code Review & Documentation:** 2 hours

**Total:** ~12-15 hours of development time

---

## Risks and Mitigations

### Risk 1: Audio Quality Degradation

**Risk:** Multiple overlapping audio streams might cause distortion or clipping.

**Mitigation:**

- LiveKit SDK handles audio mixing at the track level
- Test with various audio combinations
- Consider adding volume normalization if needed

### Risk 2: Resource Exhaustion

**Risk:** Too many concurrent goroutines writing to track.

**Mitigation:**

- Limit concurrent playbacks to 10 per user
- Monitor goroutine count in production
- Add timeout for long-running playback (e.g., 5 minutes)

### Risk 3: Event Delivery Issues

**Risk:** Events might not arrive when sent from goroutines.

**Mitigation:**

- Keep `<-done` wait even in async mode to preserve stream
- Add event acknowledgment if needed
- Monitor event delivery metrics

### Risk 4: Context Cancellation Delays

**Risk:** Canceled audio might continue playing briefly.

**Mitigation:**

- Check context frequently in playback loops (already done)
- Add 50ms sleep after `stopAllPlayback()` to allow propagation
- Consider adding immediate track unpublish on cancellation

---

## Conclusion

This plan enables audio overlap when `StopOther=false` by:

1. **Tracking concurrent playback** per request ID
2. **Using non-blocking RPC** for overlap mode
3. **Preserving blocking behavior** for interrupt mode
4. **Maintaining event delivery** through stream lifecycle

The solution is backward compatible and can be feature-flagged for safe rollout.

**Next Step:** Review this plan, then proceed with implementation.
