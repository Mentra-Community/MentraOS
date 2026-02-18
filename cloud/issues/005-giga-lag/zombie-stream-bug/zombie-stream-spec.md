# Zombie Stream Bug - Technical Specification

## Overview

Soniox WebSocket streams can enter a "zombie" state where they stop producing transcriptions but the connection remains open. Audio continues to be sent successfully, but no transcription results are returned. This causes unbounded latency growth and users receive no captions.

## Problem

### The Bug

Current stream health monitoring only checks:

```typescript
// TranscriptionManager.ts - cleanupDeadStreams()
const isDead =
  timeSinceActivity > 300000 || // 5 minutes no activity
  stream.state === StreamState.ERROR ||
  stream.state === StreamState.CLOSED ||
  stream.metrics.consecutiveFailures >= 10;
```

**None of these conditions catch a zombie stream:**

1. `lastActivity` keeps updating because audio writes succeed
2. `state` stays `ACTIVE` because WebSocket is still open
3. `consecutiveFailures` stays 0 because `ws.send()` doesn't error

### Evidence from Production (Dec 9, 2025)

BetterStack query revealed multiple affected users:

```sql
SELECT
  userId,
  processingDeficitMs,
  transcriptEndMs,
  audioSentBytes
FROM logs
WHERE processingDeficitMs > 100000
ORDER BY processingDeficitMs DESC
```

Results:

| User | transcriptEndMs | audioSentBytes | processingDeficitMs | Status |
|------|-----------------|----------------|---------------------|--------|
| User A | 3,997,920 ms (frozen) | 181,923,200 bytes | 1,687,180 ms | Zombie - 27+ min behind |
| User B | 890,940 ms (frozen) | 82,634,240 bytes | 1,691,380 ms | Zombie - 28+ min behind |
| User C | 363,360 ms (frozen) | 16,393,600 bytes | 148,940 ms | Zombie - 2.5 min behind |

### Key Observations

1. **transcriptEndMs frozen**: The Soniox stream stopped advancing at a specific point
2. **audioSentBytes growing**: Audio writes succeeded (socket is open)
3. **processingDeficitMs unbounded**: Gap grows by ~60 seconds per minute
4. **No errors logged**: System thinks everything is healthy
5. **Multiple users affected**: Not isolated to one stream

### Timeline Analysis (User A)

```
20:43:00  transcriptEndMs: 3,997,920  audioSentBytes: 171,000,000  deficit: 1,370,000
20:44:00  transcriptEndMs: 3,997,920  audioSentBytes: 173,000,000  deficit: 1,430,000  (+60s)
20:45:00  transcriptEndMs: 3,997,920  audioSentBytes: 175,000,000  deficit: 1,490,000  (+60s)
...
21:54:00  transcriptEndMs: 3,997,920  audioSentBytes: 181,923,200  deficit: 1,687,180  (+60s/min)
```

The transcript position froze at 3,997,920 ms (~66.6 minutes into the session) but audio continued for another 70+ minutes.

## Root Cause Analysis

### Why Soniox Streams Die

Possible causes (requires Soniox investigation):

1. **Server-side timeout**: Soniox may timeout idle connections
2. **Resource exhaustion**: Long-running streams may hit limits
3. **Network issues**: Intermediate proxies may break the connection silently
4. **Soniox bugs**: Server-side processing may stall without closing connection

### Why We Don't Detect It

The WebSocket layer doesn't detect silent stream death:

```typescript
// SonioxTranscriptionProvider.ts - writeAudio()
async writeAudio(data: ArrayBuffer): Promise<boolean> {
  // Check socket is open
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
    return false;  // Only catches closed socket
  }

  // Send audio
  this.ws.send(data);  // Succeeds even if server not processing!
  this.lastActivity = Date.now();  // Updates even for zombie stream
  
  return true;
}
```

The `ws.send()` call succeeds because:
- TCP buffers accept the data
- WebSocket is technically open
- Server may be accepting data without processing

## Proposed Fix

### Change 1: Add Zombie Detection to TranscriptionManager

Add a new check that compares transcript progress against audio sent:

```typescript
// TranscriptionManager.ts

// Track previous deficit values to detect growth
private lastDeficitValues: Map<string, { deficit: number; timestamp: number }> = new Map();

private isZombieStream(subscription: string, stream: StreamInstance): boolean {
  const audioSentDurationMs = (stream.metrics.totalAudioBytesSent || 0) / 32; // 16kHz * 2 bytes
  const transcriptEndMs = stream.metrics.lastTranscriptEndMs || 0;
  const currentDeficit = audioSentDurationMs - transcriptEndMs;
  
  // Need at least 30 seconds of audio sent to make a judgment
  if (audioSentDurationMs < 30000) {
    return false;
  }
  
  const lastValue = this.lastDeficitValues.get(subscription);
  const now = Date.now();
  
  // Update tracking
  this.lastDeficitValues.set(subscription, { deficit: currentDeficit, timestamp: now });
  
  // First check - no previous value
  if (!lastValue) {
    return false;
  }
  
  // Check if deficit has been growing consistently
  // If deficit grew by more than 30s over the last 60s check period, stream is zombie
  const timeDelta = now - lastValue.timestamp;
  const deficitGrowth = currentDeficit - lastValue.deficit;
  
  // Zombie condition: deficit grew by >30s in last minute AND total deficit >60s
  const isZombie = timeDelta > 30000 && // At least 30s between checks
                   deficitGrowth > 30000 && // Deficit grew by >30s
                   currentDeficit > 60000;  // Total deficit >60s
  
  if (isZombie) {
    this.logger.error(
      {
        subscription,
        currentDeficit: Math.round(currentDeficit),
        deficitGrowth: Math.round(deficitGrowth),
        transcriptEndMs: Math.round(transcriptEndMs),
        audioSentDurationMs: Math.round(audioSentDurationMs),
        timeSinceLastCheck: Math.round(timeDelta),
      },
      "🧟 ZOMBIE STREAM DETECTED: Transcript frozen while audio flowing"
    );
  }
  
  return isZombie;
}
```

### Change 2: Update cleanupDeadStreams() 

Add zombie check to existing dead stream detection:

```typescript
private async cleanupDeadStreams(): Promise<void> {
  const now = Date.now();
  const deadStreams: [string, StreamInstance][] = [];

  for (const [subscription, stream] of this.streams) {
    const timeSinceActivity = now - stream.lastActivity;

    // Original dead stream conditions
    const isDead =
      timeSinceActivity > 300000 || // 5 minutes
      stream.state === StreamState.ERROR ||
      stream.state === StreamState.CLOSED ||
      stream.metrics.consecutiveFailures >= 10;

    // NEW: Add zombie detection
    const isZombie = this.isZombieStream(subscription, stream);

    if (isDead || isZombie) {
      deadStreams.push([subscription, stream]);
      
      if (isZombie) {
        this.logger.warn(
          { subscription },
          "Marking zombie stream for restart"
        );
      }
    }
  }

  // ... rest of cleanup logic
}
```

### Change 3: Add Stream Restart Capability

Implement stream restart without affecting the subscription:

```typescript
private async restartStream(subscription: string): Promise<void> {
  const existingStream = this.streams.get(subscription);
  if (!existingStream) {
    return;
  }
  
  this.logger.info(
    { subscription },
    "♻️ Restarting zombie stream"
  );
  
  try {
    // Close the zombie stream
    await existingStream.close();
    this.streams.delete(subscription);
    
    // Clear deficit tracking for this subscription
    this.lastDeficitValues.delete(subscription);
    
    // Re-register the subscription (creates new stream)
    await this.registerSubscription(subscription);
    
    this.logger.info(
      { subscription },
      "✅ Stream restarted successfully"
    );
  } catch (error) {
    this.logger.error(
      { error, subscription },
      "Failed to restart stream"
    );
  }
}
```

### Change 4: Add Metrics for Monitoring

Add zombie stream metrics for dashboards:

```typescript
interface TranscriptionMetrics {
  // ... existing fields
  zombieStreamsDetected: number;
  zombieStreamsRestarted: number;
  lastZombieDetection: number | null;
}

// In getMetrics()
metrics.zombieStreamsDetected = this.zombieDetectionCount;
metrics.zombieStreamsRestarted = this.zombieRestartCount;
metrics.lastZombieDetection = this.lastZombieDetectionTime;
```

## Alternative Approaches Considered

### Option A: Heartbeat-based Detection

Send periodic "ping" messages and expect "pong" responses.

**Pros**: Direct health check
**Cons**: Soniox may not support custom ping/pong; adds complexity

### Option B: Timeout-based Transcript Activity

Mark stream dead if no transcript received for N seconds.

**Pros**: Simple
**Cons**: False positives during silence; VAD gaps would trigger it

### Option C: Periodic Stream Recycling

Restart all streams every N minutes proactively.

**Pros**: Prevents zombie accumulation
**Cons**: Disrupts active transcription; wasteful

**Chosen**: Option with deficit-growth detection is most accurate and least disruptive.

## Testing Plan

### Unit Tests

```typescript
describe("zombie stream detection", () => {
  it("should detect zombie stream when deficit grows consistently", () => {
    // Setup stream with frozen transcriptEndMs
    stream.metrics.lastTranscriptEndMs = 100000;
    stream.metrics.totalAudioBytesSent = 100000 * 32; // Equal
    
    // Simulate 60s of audio sent without transcript progress
    stream.metrics.totalAudioBytesSent = 160000 * 32;
    
    // After check interval, should detect zombie
    expect(manager.isZombieStream(subscription, stream)).toBe(true);
  });
  
  it("should not flag healthy stream as zombie", () => {
    // Setup stream with progressing transcript
    stream.metrics.lastTranscriptEndMs = 100000;
    stream.metrics.totalAudioBytesSent = 100500 * 32; // 500ms ahead
    
    // Advance both
    stream.metrics.lastTranscriptEndMs = 160000;
    stream.metrics.totalAudioBytesSent = 160500 * 32;
    
    expect(manager.isZombieStream(subscription, stream)).toBe(false);
  });
});
```

### Integration Tests

1. Mock Soniox WebSocket that stops sending responses
2. Verify zombie detection triggers after threshold
3. Verify stream restart succeeds
4. Verify transcription resumes after restart

### Production Validation

1. Deploy to staging with lower thresholds
2. Monitor zombie detection logs
3. Verify no false positives on healthy streams
4. Deploy to production
5. Monitor BetterStack for zombie detection events

## Rollout Plan

1. **Phase 1**: Deploy detection-only (logs but doesn't restart)
2. **Phase 2**: Enable auto-restart with high threshold (120s deficit)
3. **Phase 3**: Lower threshold to 60s after validation
4. **Phase 4**: Add alerting to PagerDuty for zombie events

## Files to Change

- `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`
  - Add `lastDeficitValues` tracking
  - Add `isZombieStream()` method
  - Update `cleanupDeadStreams()` to check for zombies
  - Add `restartStream()` method
  - Add zombie metrics

## Open Questions

1. **What causes Soniox streams to zombie?**
   - Need to investigate with Soniox support
   - May be timeout, resource limits, or bugs on their end

2. **Should we alert on zombie detection?**
   - Yes, after validating no false positives
   - Add to PagerDuty with rate limiting

3. **How long before restart?**
   - Proposed: 60s deficit growth threshold
   - Could be tuned based on production data

4. **Should we notify users?**
   - For now: silent restart (users just see captions resume)
   - Future: could add "reconnecting..." indicator

## Success Criteria

- [ ] Zero zombie streams lasting >2 minutes in production
- [ ] No false positive zombie detections on healthy streams
- [ ] Automatic recovery time <30 seconds from detection to transcription resume
- [ ] Monitoring dashboard shows zombie detection/restart metrics