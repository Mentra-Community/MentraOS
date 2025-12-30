# Quick Wins: Immediate Logging Noise Reduction

These changes can be made quickly to significantly reduce log noise without major refactoring.

## Priority 1: High-Frequency Noise (Do First)

### 1. LiveKitManager - Bridge Health Check

**File**: `cloud/packages/cloud/src/services/session/livekit/LiveKitManager.ts`  
**Line**: ~240-250

**Current** (logs every 10 seconds):

```typescript
this.logger.debug(
  {
    feature: "livekit",
    micEnabled: this.session.microphoneManager.isEnabled(),
    isConnected,
  },
  "Bridge health",
)
```

**Change**: Remove entirely or only log on state change

```typescript
// Option A: Remove (just keep the interval for internal monitoring)
// Option B: Only log when something changes
const newState = {micEnabled, isConnected}
if (JSON.stringify(newState) !== JSON.stringify(this.lastHealthState)) {
  this.logger.debug({feature: "livekit", ...newState}, "Bridge state changed")
  this.lastHealthState = newState
}
```

**Impact**: Removes ~6 log lines per minute per user

---

### 2. SonioxTranscriptionProvider - Keepalive Messages

**File**: `cloud/packages/cloud/src/services/session/transcription/providers/SonioxTranscriptionProvider.ts`  
**Line**: ~1111

**Current** (logs every 15 seconds):

```typescript
this.logger.debug({streamId: this.id}, "Sent keepalive message to Soniox")
```

**Change**: Remove or change to trace level

```typescript
// Option A: Remove entirely
// Option B: Log only every Nth keepalive
if (this.keepaliveCount % 20 === 0) {
  this.logger.debug({streamId: this.id, count: this.keepaliveCount}, "Soniox keepalives sent")
}
this.keepaliveCount++
```

**Impact**: Removes ~4 log lines per minute per active stream

---

### 3. MicrophoneManager - Keep-alive Messages

**File**: `cloud/packages/cloud/src/services/session/MicrophoneManager.ts`  
**Lines**: ~196, ~380

**Current** (logs every 10 seconds):

```typescript
this.logger.debug("Sending microphone keep-alive")
// ...later...
this.logger.debug("Sent microphone keep-alive message")
```

**Change**: Remove both or consolidate to one

```typescript
// Remove both - keepalives are routine operations
// If needed for debugging, use trace level or count-based logging
```

**Impact**: Removes ~6-12 log lines per minute per user

---

## Priority 2: Duplicate/Verbose Logging

### 4. TranscriptionManager - Duplicate Transcription Logs

**File**: `cloud/packages/cloud/src/services/session/transcription/TranscriptionManager.ts`

**Current** (logs same transcription 2-3 times):

```typescript
this.logger.debug('🎙️ SONIOX: interim transcription - "hello"')
this.logger.debug("Broadcasting transcription data")
this.logger.debug('📝 TRANSCRIPTION: [soniox] interim "hello" → 1 apps')
```

**Change**: Single consolidated log

```typescript
this.logger.debug(
  {
    event: "transcription.delivered",
    provider: "soniox",
    text: transcript.text,
    isFinal: transcript.isFinal,
    subscriberCount: apps.length,
  },
  transcript.isFinal ? "Final transcription delivered" : "Interim transcription delivered",
)
```

**Impact**: Reduces transcription logging by 66%

---

### 5. AppSession - State Change Logging

**File**: `cloud/packages/cloud/src/services/session/AppSession.ts`

**Current** (verbose state transitions):

```typescript
this.logger.debug("State transition: connecting -> running")
this.logger.info("App connected")
this.logger.debug("Heartbeat started")
```

**Change**: Single consolidated log

```typescript
this.logger.info(
  {
    event: "app.connected",
    previousState: "connecting",
    heartbeatStarted: true,
  },
  "App connected",
)
```

---

## Priority 3: Wrong Log Levels

### 6. Downgrade Info to Debug

These are currently `info` but should be `debug`:

| File                      | Message                                              | Reason          |
| ------------------------- | ---------------------------------------------------- | --------------- |
| `TranscriptionManager.ts` | "Stream already exists and is healthy"               | Routine check   |
| `TranscriptionManager.ts` | "All required streams already exist and are healthy" | Routine check   |
| `MicrophoneManager.ts`    | "Starting microphone keep-alive timer"               | Internal detail |
| `MicrophoneManager.ts`    | "Stopping microphone keep-alive timer"               | Internal detail |

### 7. Upgrade Debug to Info

These are currently `debug` but should be `info`:

| File                      | Message                           | Reason              |
| ------------------------- | --------------------------------- | ------------------- |
| `TranscriptionManager.ts` | Final transcriptions              | Key business event  |
| `AppManager.ts`           | "App connected and authenticated" | Key lifecycle event |

---

## Implementation Order

1. **First PR: Remove/reduce keepalives** (Priority 1, items 1-3)
   - Estimated log volume reduction: 40-50%
   - Risk: Very low - just removing noise
   - Time: 30 minutes

2. **Second PR: Consolidate duplicates** (Priority 2, items 4-5)
   - Estimated log volume reduction: 20%
   - Risk: Low - need to ensure all info is captured
   - Time: 1 hour

3. **Third PR: Fix log levels** (Priority 3, items 6-7)
   - Estimated log volume reduction: 10%
   - Risk: Very low
   - Time: 30 minutes

---

## Validation

After each PR, verify in Better Stack:

1. Log volume decreased as expected
2. Important events still visible (app start/stop, final transcriptions)
3. Can still debug issues effectively

Query to check log volume:

```sql
SELECT
  toStartOfMinute(dt) AS minute,
  count() AS log_count,
  countIf(level = 'debug') AS debug_count,
  countIf(level = 'info') AS info_count
FROM remote(t373499_augmentos_logs)
WHERE dt >= now() - INTERVAL 1 HOUR
  AND JSONExtractString(raw, 'userId') = 'isaiah@mentra.glass'
GROUP BY minute
ORDER BY minute DESC
```

---

## What NOT to Change Yet

Save these for later PRs (require more design work):

- Adding trace IDs (needs architectural decision)
- Pipeline health monitoring (new feature)
- Consistent log format/prefixes (broad refactor)
- Event naming conventions (needs standards agreement)
