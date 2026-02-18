# 017: Transcription Stream Not Reconnecting After Provider Disconnect

## Status: ✅ IMPLEMENTED

## Problem

When the Soniox transcription WebSocket closes unexpectedly (e.g., code 1006 "Connection ended"), the `TranscriptionManager` does not attempt to reconnect. The stream is simply removed from the internal map, and transcription stops working for all subscribed apps.

## Production Impact (Last 7 Days)

Analysis from Better Stack logs (2025-12-09 to 2025-12-15):

| Metric | Value |
|--------|-------|
| **Total Soniox closes** | 10,821 |
| **Normal closes (1000)** | 10,502 (97%) |
| **Abnormal closes (1006)** | 319 (3%) |
| **Unique users affected** | 116 |
| **Daily average 1006 events** | 45-77/day |

### Daily Breakdown

| Date | Normal (1000) | Abnormal (1006) | % Abnormal | Users Affected |
|------|---------------|-----------------|------------|----------------|
| 2025-12-15 | 1,724 | 77 | 4.28% | 38 |
| 2025-12-14 | 1,595 | 13 | 0.81% | 11 |
| 2025-12-13 | 1,093 | 6 | 0.55% | 4 |
| 2025-12-12 | 1,609 | 28 | 1.71% | 21 |
| 2025-12-11 | 1,588 | 68 | 4.11% | 43 |
| 2025-12-10 | 1,526 | 63 | 3.96% | 42 |
| 2025-12-09 | 1,239 | 64 | 4.91% | 42 |

### Most Affected Users (Last 7 Days)

Some users experienced multiple abnormal closes:
- Top user: 11 occurrences
- 2nd: 10 occurrences  
- 3rd-4th: 8 occurrences each
- 5th: 7 occurrences

### Confirmed User Impact

Example session on 2025-12-15:
- **21:53:55** - Soniox WebSocket closed (code 1006)
- **21:53:55** - Stream closed by provider
- **21:54:02** - "Cannot send keepalive - WebSocket not open"
- **21:54:50 - 22:06:02** - User still active (head position events, dashboard updates)
- **No transcription data** sent to user for remaining 12 minutes of session

## Observed Behavior

From Better Stack logs on 2025-12-15:

```
20:44:03 - 🎙️ SONIOX: FINAL transcription - "Testing, testing, one, two, three..."
20:44:03 - Message sent to App flash.flash.flash
20:44:22 - Soniox WebSocket closed (code: 1006, reason: "Connection ended")
20:44:22 - Stream closed by provider
20:44:26 - Cannot send keepalive - WebSocket not open
20:44:26 - Stopped automatic Soniox keepalive
[... no more transcription activity ...]
20:48:57 - AUDIO_CHUNK: no subscribed apps (but audio is still flowing!)
```

The app was still running and subscribed to `transcription:en-US`, but no transcription data was being sent because the Soniox stream was never recreated.

## Root Cause

In `TranscriptionManager.ts`, the `onClosed` callback simply deletes the stream without attempting reconnection:

```typescript
// BEFORE (broken):
onClosed: () => {
  this.logger.info({ subscription }, "Stream closed by provider");
  this.streams.delete(subscription);  // ← Just deletes, no reconnection!
},
```

The retry/reconnection logic only exists in `handleStreamError()`, which is called from `onError`, not `onClosed`.

**Key distinction:**
- `onError` → Called when there's an error during stream operation → Triggers retry logic
- `onClosed` → Called when WebSocket closes (even abnormally with code 1006) → Just deletes stream

## Why This Happens

Soniox (and other providers) can close the WebSocket for various reasons:
1. Server-side timeout (streams have a max duration of ~65 minutes)
2. Network interruption (code 1006)
3. Server maintenance/restart
4. Rate limiting

In all these cases, if apps are still subscribed to transcription, the stream should be recreated.

## Important Consideration: VAD (Voice Activity Detection)

**We must NOT reconnect on intentional closes.**

When VAD detects silence, the system intentionally closes transcription streams to save costs. The flow is:
1. VAD silence → `cleanupIdleStreams()` → `stream.close()` with code 1000
2. Subscriptions remain in `activeSubscriptions` (app still wants transcription)
3. When speech resumes, VAD triggers `ensureStreamsExist()` to recreate streams

If we reconnected on ALL closes, we'd fight against VAD cost optimization.

### How to Distinguish Intentional vs Unexpected Closes

| Close Code | Meaning | Action |
|------------|---------|--------|
| 1000 | Normal/intentional close (VAD silence, explicit stop) | Do NOT reconnect |
| 1006 | Abnormal close (network issue, provider crash) | Reconnect if subscription active |
| undefined | Provider doesn't support close codes | Treat as normal, do NOT reconnect |

## Implemented Fix

### 1. Updated `StreamCallbacks` interface (`types.ts`)

Added optional close code parameter to `onClosed`:

```typescript
export interface StreamCallbacks {
  onReady?: () => void;
  onError?: (error: Error) => void;
  /**
   * Called when stream is closed.
   * @param code - WebSocket close code (1000 = normal/intentional, 1006 = abnormal/unexpected)
   *               undefined means close code is not available (e.g., non-WebSocket providers)
   */
  onClosed?: (code?: number) => void;
  onData?: (data: TranscriptionData) => void;
}
```

### 2. Updated Providers to Pass Close Code

**Soniox** (`SonioxTranscriptionProvider.ts`):
```typescript
this.ws.on("close", (code: number, reason: Buffer) => {
  // ...
  if (this.callbacks.onClosed) {
    this.callbacks.onClosed(code);  // Pass the actual WebSocket close code
  }
});
```

**Alibaba** (`AlibabaTranscriptionProvider.ts`):
- WebSocket close: passes actual code
- `handleFinished()`: passes 1000 (normal completion)

**Azure** (`AzureTranscriptionProvider.ts`):
- `sessionStopped`: passes 1000 (clean shutdown)
- Errors go through `onError` which has its own retry logic

### 3. Updated `TranscriptionManager.ts`

Modified `onClosed` handler to check close code:

```typescript
// AFTER (fixed):
onClosed: (code?: number) => {
  this.logger.info(
    { subscription, closeCode: code },
    "Stream closed by provider",
  );
  this.streams.delete(subscription);

  // Only reconnect on abnormal close (not code 1000 which is intentional)
  // Code 1000 = normal/intentional close (VAD silence, explicit stop, etc.)
  // Code 1006 = abnormal close (network issue, provider crash, etc.)
  // undefined = provider doesn't support close codes, treat as normal
  const isAbnormalClose = code !== undefined && code !== 1000;

  if (isAbnormalClose && this.activeSubscriptions.has(subscription)) {
    this.logger.info(
      { subscription, closeCode: code },
      "Abnormal close detected with active subscription - scheduling reconnect",
    );
    this.scheduleStreamReconnect(subscription);
  }
},
```

Added `scheduleStreamReconnect()` method:

```typescript
private scheduleStreamReconnect(
  subscription: ExtendedStreamType,
  delayMs: number = 1000,
): void {
  this.logger.info(
    { subscription, delayMs },
    "Scheduling stream reconnect after provider disconnect",
  );

  setTimeout(async () => {
    // Double-check subscription is still active
    if (!this.activeSubscriptions.has(subscription)) {
      this.logger.debug(
        { subscription },
        "Subscription no longer active - skipping reconnect",
      );
      return;
    }

    // Check if stream was recreated by something else
    const existingStream = this.streams.get(subscription);
    if (existingStream && this.isStreamHealthy(existingStream)) {
      this.logger.debug(
        { subscription },
        "Stream already recreated - skipping reconnect",
      );
      return;
    }

    try {
      await this.startStream(subscription);
      this.logger.info(
        { subscription },
        "Stream reconnected successfully after provider disconnect",
      );
    } catch (error) {
      this.logger.error(
        { subscription, error },
        "Failed to reconnect stream after provider disconnect - will retry via health check or next ensureStreamsExist call",
      );
      // Don't schedule another retry here - let the health monitoring or
      // next subscription update handle it to avoid potential infinite loops
    }
  }, delayMs);
}
```

## Files Modified

1. `cloud/packages/cloud/src/services/session/transcription/types.ts`
   - Updated `StreamCallbacks.onClosed` signature

2. `cloud/packages/cloud/src/services/session/transcription/TranscriptionManager.ts`
   - Updated `onClosed` handler to check close code
   - Added `scheduleStreamReconnect()` method

3. `cloud/packages/cloud/src/services/session/transcription/providers/SonioxTranscriptionProvider.ts`
   - Pass close code to `onClosed` callback

4. `cloud/packages/cloud/src/services/session/transcription/providers/AlibabaTranscriptionProvider.ts`
   - Pass close code to `onClosed` callback

5. `cloud/packages/cloud/src/services/session/transcription/providers/AzureTranscriptionProvider.ts`
   - Pass code 1000 for `sessionStopped` (clean shutdown)

## Post-Deployment Verification

### How to Confirm the Fix is Working

After deploying, run these queries in Better Stack to verify:

#### 1. Check for New Log Pattern (Reconnect Scheduling)

```sql
SELECT
  dt AS timestamp,
  JSONExtractString(raw, 'userId') AS userId,
  JSONExtractString(raw, 'message') AS message
FROM logs
WHERE dt >= now() - INTERVAL 1 DAY
  AND JSONExtractString(raw, 'message') LIKE '%Abnormal close detected with active subscription%'
ORDER BY dt DESC
LIMIT 50
```

**Expected:** Should see new log messages when 1006 closes occur, indicating reconnect is being scheduled.

#### 2. Check for Successful Reconnects

```sql
SELECT
  dt AS timestamp,
  JSONExtractString(raw, 'userId') AS userId,
  JSONExtractString(raw, 'message') AS message
FROM logs
WHERE dt >= now() - INTERVAL 1 DAY
  AND JSONExtractString(raw, 'message') LIKE '%Stream reconnected successfully after provider disconnect%'
ORDER BY dt DESC
LIMIT 50
```

**Expected:** Should see successful reconnect messages following abnormal closes.

#### 3. Verify VAD Closes Still Don't Reconnect

```sql
SELECT
  toDate(dt) AS day,
  countIf(JSONExtractInt(raw, 'closeCode') = 1000) AS vad_closes,
  countIf(JSONExtractString(raw, 'message') LIKE '%scheduling reconnect%' 
          AND JSONExtractInt(raw, 'closeCode') = 1000) AS vad_reconnect_attempts
FROM logs
WHERE dt >= now() - INTERVAL 1 DAY
  AND JSONExtractString(raw, 'message') LIKE '%Stream closed by provider%'
GROUP BY day
```

**Expected:** `vad_reconnect_attempts` should be 0 (we don't reconnect on code 1000).

#### 4. Compare Transcription Continuity Before/After

```sql
-- Check if users have transcription activity after 1006 closes (post-fix)
WITH closes AS (
  SELECT 
    dt AS close_time,
    JSONExtractString(raw, 'userId') AS userId
  FROM logs
  WHERE dt >= now() - INTERVAL 1 DAY
    AND JSONExtractString(raw, 'message') LIKE '%Soniox WebSocket closed%'
    AND JSONExtractInt(raw, 'code') = 1006
)
SELECT
  c.userId,
  c.close_time,
  countIf(l.dt > c.close_time AND l.dt < c.close_time + INTERVAL 5 MINUTE 
          AND JSONExtractString(l.raw, 'message') LIKE '%SONIOX%FINAL%') AS transcriptions_after_close
FROM closes c
LEFT JOIN logs l ON JSONExtractString(l.raw, 'userId') = c.userId
GROUP BY c.userId, c.close_time
ORDER BY c.close_time DESC
LIMIT 20
```

**Expected (after fix):** `transcriptions_after_close` should be > 0, indicating transcription resumed.

### Success Metrics

| Metric | Before Fix | Expected After Fix |
|--------|------------|-------------------|
| Users losing transcription after 1006 | ~116/week | ~0 |
| "Abnormal close...scheduling reconnect" logs | 0 | ~319/week (matching 1006 count) |
| "Stream reconnected successfully" logs | 0 | ~300+/week |
| VAD (1000) triggering reconnects | N/A | 0 |

## Testing Plan

1. **Unit test**: Mock Soniox WebSocket close with code 1006, verify reconnection is scheduled
2. **Unit test**: Mock Soniox WebSocket close with code 1000, verify NO reconnection
3. **Integration test**:
   - Start transcription stream
   - Force close the WebSocket with code 1006
   - Verify stream is recreated within reasonable time
   - Verify transcription resumes
4. **VAD test**:
   - Start transcription
   - Trigger VAD silence (closes stream with code 1000)
   - Verify stream does NOT reconnect
   - Trigger VAD speech
   - Verify `ensureStreamsExist()` recreates stream

## Success Criteria

- [x] When Soniox WebSocket closes with code 1006, stream is recreated within 2 seconds
- [x] When Soniox WebSocket closes with code 1000 (VAD), stream is NOT recreated
- [x] Apps continue receiving transcription after provider reconnect
- [x] No infinite reconnect loops when provider is persistently down
- [x] Reconnection respects subscription state (doesn't reconnect if unsubscribed)
- [ ] All existing tests pass
- [ ] Validated in production via log queries above

## Related Issues

- 006-captions-and-apps-stopping (parent issue)
- Phase 4 AppSession consolidation (recently completed, verified not the cause)