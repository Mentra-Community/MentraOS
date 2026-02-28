# LiveKit Mobile Reconnection Bug - Investigation Guide

## Incident Details

**User**: `israelov+test2@mentra.glass`
**Environment**: Staging (centralus)
**Timestamp**: 2025-11-20T23:12:42.769Z (3:12:42 PM PST)
**Event**: WebSocket close code 1006 (abnormal closure)
**Symptom**: Transcription broke and never recovered

## Better Stack Log Queries

### Query 1: Full Timeline (5 minutes after disconnect)

```
userId:"israelov+test2@mentra.glass"
AND dt:>=2025-11-20T23:12:00.000Z
AND dt:<=2025-11-20T23:18:00.000Z
ORDER BY dt ASC
```

**Look for**:

- Initial 1006 close event (confirmed at 23:12:42.769Z)
- Reconnection attempt logs
- Any errors in between

### Query 2: LiveKit Bridge Activity

```
userId:"israelov+test2@mentra.glass"
AND (
  message:*JoinRoom* OR
  message:*LeaveRoom* OR
  message:*StreamAudio* OR
  message:*bridge* OR
  service:"LiveKitManager" OR
  service:"LiveKitGrpcClient"
)
AND dt:>=2025-11-20T23:12:00.000Z
ORDER BY dt ASC
```

**Look for**:

- JoinRoom success/failure
- "session already exists for this user"
- StreamAudio start/error
- Bridge disconnect/cleanup

### Query 3: Reconnection Logic

```
userId:"israelov+test2@mentra.glass"
AND (
  message:*reconnection* OR
  message:*handleConnectionInit* OR
  message:*rejoinBridge* OR
  message:*getBridgeStatus* OR
  message:"Phone WebSocket connection"
)
AND dt:>=2025-11-20T23:12:42.000Z
AND dt:<=2025-11-20T23:18:00.000Z
ORDER BY dt ASC
```

**Look for**:

- Was reconnection detected? (handleConnectionInit with reconnection=true)
- Did rejoinBridge get called?
- What was bridge status?

### Query 4: Grace Period & Cleanup

```
userId:"israelov+test2@mentra.glass"
AND (
  message:*"grace period"* OR
  message:*cleanup* OR
  message:*disconnect* OR
  message:*"session cleanup"*
)
AND dt:>=2025-11-20T23:12:00.000Z
ORDER BY dt ASC
```

**Look for**:

- "Grace period cleanup" started
- "Grace period expired"
- Was old session cleaned up before rejoin?

### Query 5: Audio/Transcription Status

```
userId:"israelov+test2@mentra.glass"
AND (
  message:*audio* OR
  message:*transcription* OR
  message:*AudioManager* OR
  message:*TranscriptionManager*
)
AND level:>="warn"
AND dt:>=2025-11-20T23:12:42.000Z
AND dt:<=2025-11-20T23:20:00.000Z
ORDER BY dt ASC
```

**Look for**:

- Audio chunks still being received?
- Transcription stream errors?
- "No audio received" warnings?

### Query 6: Room Name Usage

```
userId:"israelov+test2@mentra.glass"
AND (
  room_name:* OR
  roomName:* OR
  message:*room-*
)
AND dt:>=2025-11-20T23:12:00.000Z
ORDER BY dt ASC
```

**Look for**:

- What room name was used? (should be `room-staging-israelov+test2@mentra.glass`)
- Did room name change between disconnect/reconnect?
- Any room name conflicts?

## Expected Behavior vs Actual

### Expected (working reconnection):

```
23:12:42.769 - Mobile: WebSocket closes (1006)
23:12:42.770 - Cloud: Detects close, logs "Glasses connection closed"
23:12:42.771 - Cloud: Sets disconnectedAt, starts 60s grace period
23:12:43.000 - Mobile: Reconnects (new WebSocket)
23:12:43.100 - Cloud: handleConnectionInit(reconnection=true)
23:12:43.200 - Cloud: Calls getBridgeStatus()
23:12:43.300 - Bridge: Returns status (connected or not)
23:12:43.400 - Cloud: Calls rejoinBridge()
23:12:43.500 - Bridge: JoinRoom succeeds (or forces cleanup if needed)
23:12:43.600 - Bridge: StreamAudio established
23:12:44.000 - Transcription: Resumes working
```

### Actual (broken reconnection hypothesis):

```
23:12:42.769 - Mobile: WebSocket closes (1006)
23:12:42.770 - Cloud: Detects close, logs "Glasses connection closed"
23:12:42.771 - Cloud: Sets disconnectedAt, starts 60s grace period
23:12:43.000 - Mobile: Reconnects (new WebSocket)
23:12:43.100 - Cloud: handleConnectionInit(reconnection=true)
23:12:43.200 - Cloud: Calls getBridgeStatus()
23:12:43.300 - Bridge: Returns ??? (error? wrong status?)
23:12:43.400 - Cloud: Calls rejoinBridge()
23:12:43.500 - Bridge: ERROR - "session already exists" OR other error
23:12:43.600 - Cloud: Rejoin failed, no StreamAudio
23:12:44.000+ - Transcription: Never resumes
```

## Key Questions to Answer

1. **Did mobile reconnect?**
   - Search for "Phone WebSocket connection" after 23:12:42.769Z
   - Should see new connection within 1-5 seconds

2. **Was it treated as reconnection?**
   - Search for "handleConnectionInit" with reconnection=true
   - Should happen immediately after new WS connection

3. **What did getBridgeStatus return?**
   - Search for "Bridge status fetched" or "getBridgeStatus"
   - Status should show connected: false if session was cleaned up

4. **Did rejoinBridge get called?**
   - Search for "rejoinBridge" or "Attempting to reconnect"
   - Should be called if bridge status was disconnected

5. **What happened in JoinRoom?**
   - Search for "JoinRoom request" in bridge logs
   - Look for success or error response
   - If error: "session already exists"? Other error?

6. **Was there a StreamAudio?**
   - Search for "Audio stream started" or "StreamAudio started"
   - Should happen right after successful JoinRoom

7. **Room name consistency?**
   - Was same room name used: `room-staging-israelov+test2@mentra.glass`?
   - Or did room name change somehow?

8. **Grace period interference?**
   - Did grace period timer fire during reconnection?
   - Search for "Grace period expired" - should be 60s later at 23:13:42

## Analysis Template

After gathering logs, fill this in:

```
TIMELINE:
23:12:42.769 - [CONFIRMED] WebSocket close (1006)
23:12:??     - [ ] Mobile reconnected? (YES/NO)
23:12:??     - [ ] handleConnectionInit called? (YES/NO)
23:12:??     - [ ] getBridgeStatus called? (YES/NO)
              - [ ] Status returned: connected=??? participant_id=???
23:12:??     - [ ] rejoinBridge called? (YES/NO)
23:12:??     - [ ] JoinRoom request sent? (YES/NO)
              - [ ] JoinRoom result: SUCCESS / "session already exists" / OTHER
23:12:??     - [ ] StreamAudio started? (YES/NO)
23:12:??     - [ ] Audio chunks received? (YES/NO)
23:12:??     - [ ] Transcription working? (YES/NO)

ROOT CAUSE:
[Fill in based on evidence above]

HYPOTHESES RULED OUT:
- [ ] Room name conflict (different environments)
- [ ] Grace period expired too early
- [ ] Bridge session not cleaned up
- [ ] gRPC stream not closed
- [ ] Other: ___________

HYPOTHESIS CONFIRMED:
[Fill in which hypothesis matches the evidence]
```

## Common Patterns to Recognize

### Pattern 1: Bridge Session Not Cleaned Up

```
ERROR: "session already exists for this user"
CAUSE: Old session still in bridge memory map
FIX: Force cleanup stale sessions in JoinRoom
```

### Pattern 2: LiveKit Room Still Active

```
ERROR: "participant already in room" or LiveKit SDK error
CAUSE: LiveKit server still has user in room from before disconnect
FIX: Force disconnect from room before rejoin
```

### Pattern 3: StreamAudio Goroutines Leaked

```
ERROR: "context deadline exceeded" or "channel full"
CAUSE: Old StreamAudio goroutines not cleaned up, blocking new stream
FIX: Monitor gRPC context.Done() and cleanup goroutines
```

### Pattern 4: Race Condition

```
PATTERN: Reconnect happens < 1 second after disconnect
CAUSE: Grace period not started yet, new connection before old cleanup
FIX: Immediate cleanup on disconnect OR handle overlapping connections
```

## Next Steps After Investigation

Based on findings:

1. **If logs show "session already exists"**:
   - Implement force-cleanup in bridge JoinRoom
   - Add health check before rejecting duplicate session

2. **If logs show LiveKit room conflict**:
   - Ensure old room is disconnected before new join
   - Add room name sanitization/uniqueness

3. **If logs show StreamAudio errors**:
   - Add gRPC context monitoring in StreamAudio
   - Ensure goroutine cleanup on disconnect

4. **If logs show race condition**:
   - Reduce grace period to 5s for faster cleanup
   - OR allow force-takeover on fast reconnect

5. **If logs show NO reconnection attempt**:
   - Bug might be in mobile app not reconnecting
   - Or WebSocket reconnection logic in cloud

## Checklist for Isaiah

- [ ] Run Query 1 (Full Timeline) - screenshot results
- [ ] Run Query 2 (LiveKit Bridge) - note any errors
- [ ] Run Query 3 (Reconnection Logic) - confirm rejoin was attempted
- [ ] Run Query 4 (Grace Period) - check cleanup timing
- [ ] Run Query 5 (Audio/Transcription) - verify data flow stopped
- [ ] Run Query 6 (Room Name) - confirm room name used
- [ ] Fill in Timeline Analysis Template above
- [ ] Identify which Pattern matches (1-4 above)
- [ ] Document findings in spec.md "Evidence" section
