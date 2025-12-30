# 018: Audio Gap Detection and Auto-Reconnect

## Status: ✅ IMPLEMENTED

## Problem

When audio stops flowing from the mobile client to the cloud (due to LiveKit data channel issues, network problems, or client-side stalls), transcription stops working but the cloud-side connection appears healthy. The WebSocket remains connected, the LiveKit bridge reports as connected, but no audio data arrives. This leads to silent failures where users lose transcription without any indication or automatic recovery.

## Observed Behavior

From production logs and user reports:

```
18:24:51 - AudioManager received PCM chunk (msSinceLast: 50ms)
18:24:51 - SONIOX: FINAL transcription - "Hello world"
18:24:51 - Message sent to App captions
[... long silence ...]
18:34:57 - No more audio chunks received
18:34:57 - User still active (WebSocket connected, apps running)
18:34:57 - Transcription has stopped for 10+ minutes
```

The pattern:

1. Audio flows normally
2. Audio suddenly stops (client-side issue, data channel drop, network glitch)
3. Cloud-side bridge remains "connected"
4. No automatic recovery
5. User loses transcription for the rest of their session

## Root Cause

The mobile client uses LiveKit's lossy data channel for audio streaming. When this channel experiences issues:

- The WebSocket to the cloud remains connected
- The LiveKit bridge reports as healthy
- But audio data stops flowing
- No error is raised that would trigger recovery

Client-side logs often show: "dropping lossy data channel messages" indicating the data channel is congested or misbehaving.

## Solution: Cloud-Side Audio Gap Detection

Implement proactive monitoring in `AudioManager` that:

1. Tracks when audio was last received
2. Periodically checks for gaps exceeding a threshold (5 seconds)
3. When a gap is detected with active audio subscriptions, triggers LiveKit reconnection
4. Uses cooldown to prevent reconnect storms

### Why Cloud-Side Only?

- No client code changes required
- Leverages existing client behavior: mobile app reconnects LiveKit when receiving CONNECTION_ACK with fresh token
- Can be tuned and monitored server-side without app updates
- Works with all existing client versions

## Implementation

### Location

`cloud/packages/cloud/src/services/session/AudioManager.ts`

### Configuration

| Parameter                     | Value | Description                                    |
| ----------------------------- | ----- | ---------------------------------------------- |
| `AUDIO_GAP_THRESHOLD_MS`      | 5000  | Time without audio before triggering reconnect |
| `AUDIO_GAP_CHECK_INTERVAL_MS` | 2000  | How often to check for gaps                    |
| `RECONNECT_COOLDOWN_MS`       | 30000 | Minimum time between reconnect attempts        |

### Key Methods Added

#### `startAudioGapMonitoring()`

Starts an interval timer that calls `checkForAudioGap()` every 2 seconds.

#### `checkForAudioGap()`

Checks if:

1. Manager is not disposed (safety guard)
2. Audio has been received before (lastAudioTimestamp exists)
3. Time since last audio exceeds threshold (5 seconds)
4. Session is not disconnected (not in grace period)
5. WebSocket is actually open
6. There are active audio subscriptions (transcription, translation, or audio chunks)
7. Microphone is enabled
8. Not in cooldown period

If all conditions met, triggers reconnection.

#### `hasActiveAudioSubscriptions()`

Returns true if any of these are active:

- TranscriptionManager has active subscriptions
- Apps subscribed to AUDIO_CHUNK stream
- TranslationManager has active subscriptions

#### `triggerLiveKitReconnect()`

1. Checks disposed flag (guard)
2. Attempts to rejoin the server-side LiveKit bridge
3. Re-checks state after async operation (guard against race conditions)
4. Gets fresh LiveKit credentials (URL, room, token)
5. Re-checks state again (guard)
6. Sends CONNECTION_ACK with LiveKit info to glasses WebSocket
7. Mobile client receives ACK and reconnects to LiveKit with fresh token

#### `getAudioGapStats()`

Returns telemetry data for debugging:

- `lastAudioTimestamp`
- `timeSinceLastAudio`
- `reconnectAttemptCount`
- `lastReconnectAttemptAt`
- `hasActiveSubscriptions`

#### `isDisposed()`

Returns whether the manager has been disposed (for external checks).

## Safety Mechanisms

### 1. Disposed Flag Pattern

Following `UserSession`'s pattern, `AudioManager` now has a `disposed` flag that:

- Is set FIRST in `dispose()` before any cleanup
- Is checked at the start of interval callbacks
- Is checked before and after async operations
- Prevents stale callbacks from executing after disposal

```typescript
private disposed = false;

private checkForAudioGap(): void {
  // Guard: Don't run if disposed
  if (this.disposed) {
    return;
  }
  // ... rest of logic
}

dispose(): void {
  if (this.disposed) return; // Idempotent
  this.disposed = true; // Set FIRST
  // ... cleanup
}
```

### 2. Session Lifecycle Awareness

Checks `userSession.disconnectedAt` to avoid triggering reconnects during grace period:

- When WebSocket closes, `disconnectedAt` is set
- Session enters grace period waiting for reconnection
- No point sending CONNECTION_ACK when WebSocket is closed
- User will get fresh CONNECTION_ACK naturally when they reconnect

### 3. WebSocket State Validation

- Checks `websocket.readyState === WebSocketReadyState.OPEN` before any send
- Re-checks after every async operation (state may have changed)

### 4. Cooldown Period

- 30 seconds between reconnect attempts
- Prevents reconnect storms if the issue persists
- Logged when skipped due to cooldown

### 5. Subscription Check

- Only triggers if something actually needs audio
- Prevents unnecessary reconnects when user isn't using transcription

### 6. Microphone State Check

- Only triggers if microphone is enabled
- No point reconnecting if the user turned off their mic

### 7. First Audio Check

- Skips check if no audio has ever been received
- Prevents false positives during session startup

### 8. Async Operation Guards

Re-checks state after each async operation:

```typescript
await this.userSession.liveKitManager?.rejoinBridge?.()

// Guard: Check again after async operation
if (this.disposed) {
  return
}
```

## Logging

### Audio Gap Detected (WARN level)

```json
{
  "timeSinceLastAudio": 5234,
  "lastAudioTimestamp": 1702847091000,
  "userId": "user123",
  "reconnectAttemptCount": 1,
  "feature": "audio-gap",
  "message": "Audio gap detected with active subscriptions - triggering LiveKit reconnect"
}
```

### Reconnect Triggered (INFO level)

```json
{
  "userId": "user123",
  "hasLivekitInfo": true,
  "reconnectAttemptCount": 1,
  "feature": "audio-gap",
  "message": "Sent CONNECTION_ACK to trigger client LiveKit reconnect"
}
```

### Skipped - Session Disconnected (DEBUG level)

```json
{
  "timeSinceLastAudio": 7000,
  "feature": "audio-gap",
  "message": "Audio gap detected but session is disconnected (grace period) - skipping reconnect"
}
```

### Skipped - Cooldown (DEBUG level)

```json
{
  "timeSinceLastAudio": 7000,
  "timeSinceLastReconnect": 15000,
  "cooldownMs": 30000,
  "feature": "audio-gap",
  "message": "Audio gap detected but in cooldown period - skipping reconnect"
}
```

### Skipped - WebSocket Not Open (DEBUG level)

```json
{
  "timeSinceLastAudio": 6000,
  "readyState": 3,
  "feature": "audio-gap",
  "message": "Audio gap detected but WebSocket not open - skipping reconnect"
}
```

## Post-Deployment Verification

### 1. Check for Gap Detection Logs

```sql
SELECT
  dt AS timestamp,
  JSONExtractString(raw, 'userId') AS userId,
  JSONExtractInt(raw, 'timeSinceLastAudio') AS gapMs,
  JSONExtractInt(raw, 'reconnectAttemptCount') AS attempts
FROM logs
WHERE dt >= now() - INTERVAL 1 DAY
  AND JSONExtractString(raw, 'feature') = 'audio-gap'
  AND JSONExtractString(raw, 'message') LIKE '%Audio gap detected%'
ORDER BY dt DESC
LIMIT 50
```

### 2. Check for Successful Reconnects

```sql
SELECT
  dt AS timestamp,
  JSONExtractString(raw, 'userId') AS userId,
  JSONExtractBool(raw, 'hasLivekitInfo') AS hasLivekit
FROM logs
WHERE dt >= now() - INTERVAL 1 DAY
  AND JSONExtractString(raw, 'feature') = 'audio-gap'
  AND JSONExtractString(raw, 'message') LIKE '%Sent CONNECTION_ACK%'
ORDER BY dt DESC
LIMIT 50
```

### 3. Check Skipped Reconnects (Safety Guards Working)

```sql
SELECT
  JSONExtractString(raw, 'message') AS reason,
  count() AS count
FROM logs
WHERE dt >= now() - INTERVAL 1 DAY
  AND JSONExtractString(raw, 'feature') = 'audio-gap'
  AND JSONExtractString(raw, 'message') LIKE '%skipping reconnect%'
GROUP BY reason
ORDER BY count DESC
```

### 4. Verify Audio Resumes After Reconnect

```sql
WITH reconnects AS (
  SELECT
    dt AS reconnect_time,
    JSONExtractString(raw, 'userId') AS userId
  FROM logs
  WHERE dt >= now() - INTERVAL 1 DAY
    AND JSONExtractString(raw, 'feature') = 'audio-gap'
    AND JSONExtractString(raw, 'message') LIKE '%Sent CONNECTION_ACK%'
)
SELECT
  r.userId,
  r.reconnect_time,
  min(l.dt) AS first_audio_after,
  dateDiff('second', r.reconnect_time, min(l.dt)) AS recovery_seconds
FROM reconnects r
LEFT JOIN logs l ON
  JSONExtractString(l.raw, 'userId') = r.userId
  AND l.dt > r.reconnect_time
  AND l.dt < r.reconnect_time + INTERVAL 2 MINUTE
  AND JSONExtractString(l.raw, 'message') LIKE '%AudioManager received PCM chunk%'
GROUP BY r.userId, r.reconnect_time
ORDER BY r.reconnect_time DESC
LIMIT 20
```

**Expected:** `recovery_seconds` should typically be < 10 seconds for successful recoveries.

## Success Metrics

| Metric                        | Before      | Expected After      |
| ----------------------------- | ----------- | ------------------- |
| Users with audio stalls > 30s | Unknown     | Tracked             |
| Auto-reconnect attempts       | 0           | > 0 when gaps occur |
| Audio resumption rate         | Manual only | Automatic           |
| Average gap duration          | Minutes+    | < 10 seconds        |

## Testing Plan

### Unit Tests

1. Gap detection triggers after threshold
2. Gap detection respects cooldown
3. No trigger when no subscriptions active
4. No trigger when mic disabled
5. No trigger before first audio received
6. No trigger when disposed
7. No trigger when session disconnected (grace period)
8. No trigger when WebSocket not open
9. Dispose is idempotent

### Integration Tests

1. Simulate audio stop → verify reconnect triggered
2. Verify CONNECTION_ACK sent with LiveKit info
3. Verify interval cleanup on dispose
4. Verify no reconnect during grace period
5. Verify no stale callbacks after dispose

### Manual Testing

1. Connect glasses with transcription enabled
2. Force-kill mobile app's LiveKit connection (or airplane mode briefly)
3. Observe logs for gap detection
4. Verify transcription resumes within ~10 seconds

## Risks and Mitigations

### Risk: Reconnect storms

**Mitigation:** 30-second cooldown, subscription checks, mic state checks, disposed/disconnected guards

### Risk: False positives during legitimate pauses

**Mitigation:** 5-second threshold is long enough to avoid false positives from normal speech pauses (VAD handles those at ~1 second)

### Risk: Client doesn't handle rapid CONNECTION_ACKs

**Mitigation:** Cooldown ensures max 2 reconnects per minute; client is already designed to handle CONNECTION_ACK at any time

### Risk: Infinite reconnect loop if LiveKit is actually down

**Mitigation:** Cooldown limits attempts; reconnect count is tracked for monitoring; doesn't block other functionality

### Risk: Memory leaks from stale interval callbacks

**Mitigation:** `disposed` flag checked at start of every interval callback; interval cleared in dispose()

### Risk: Race conditions during async operations

**Mitigation:** State re-checked after every await; disposed flag prevents action if state changed

### Risk: Triggering reconnect during grace period

**Mitigation:** Explicit check for `userSession.disconnectedAt !== null`

## Related Issues

- 006-captions-and-apps-stopping (parent issue)
- 017-transcription-stream-not-reconnecting (handles provider disconnects, this handles client-side gaps)
- 003-livekit-mobile-reconnection-bug (original LiveKit reconnection investigation)

## Files Modified

1. `cloud/packages/cloud/src/services/session/AudioManager.ts`
   - Added `disposed` flag following UserSession pattern
   - Added audio gap monitoring infrastructure
   - Added reconnection trigger logic with comprehensive guards
   - Added telemetry methods
   - Updated `dispose()` to be idempotent and set flag first
   - Added guards for session lifecycle (disconnectedAt, WebSocket state)
   - Added guards after async operations to prevent race conditions
