# Improved Transcription Latency Metrics

## Problem Statement

The current `processingDeficitMs` metric is misleading during silence periods:

```
processingDeficitMs = audioSentDurationMs - transcriptEndMs
```

**Issue:** When the user is silent:
- `audioSentDurationMs` keeps growing (we continue sending audio to Soniox)
- `transcriptEndMs` stays frozen (Soniox only updates this when speech is detected)
- Deficit appears HUGE (60+ minutes!) even though Soniox is working correctly

This caused confusion during debugging - we thought streams were "zombies" when users were simply silent.

## Root Cause

We conflate two different questions into one metric:

1. **"Are we getting transcription activity?"** (activity indicator)
2. **"When we get activity, how far behind is it?"** (latency indicator)

The current metric tries to answer #2 but fails because it doesn't account for #1.

## Proposed Solution

### New Metrics

Add these new fields to `StreamMetrics`:

```typescript
interface StreamMetrics {
  // ... existing fields ...

  // NEW: Activity Tracking
  lastTokenReceivedAt?: number;      // Timestamp when we last received ANY token from Soniox
  tokenBatchesReceived?: number;     // Count of token batches received (for rate calculation)
  lastTokenBatchSize?: number;       // Size of last token batch received
  
  // NEW: Silence Detection
  timeSinceLastTokenMs?: number;     // Calculated: now - lastTokenReceivedAt
  audioSentSinceLastTokenMs?: number; // Audio duration sent since last token received
  isReceivingTokens?: boolean;       // Have we received tokens in the last 30s?
  
  // NEW: True Latency (only meaningful when receiving tokens)
  realtimeLatencyMs?: number;        // When tokens ARE received, how far behind are they?
  avgRealtimeLatencyMs?: number;     // Rolling average of realtime latency
  
  // RENAMED (for clarity)
  totalDeficitMs?: number;           // Renamed from processingDeficitMs - keep for backwards compat
}
```

### Metric Definitions

#### `lastTokenReceivedAt`
- **Updated:** Every time `processTranscriptionTokens()` receives tokens
- **Purpose:** Track when we last heard from Soniox
- **Usage:** Calculate time since last activity

#### `timeSinceLastTokenMs`
- **Calculated:** `Date.now() - lastTokenReceivedAt`
- **Updated:** On each health check / log interval
- **Purpose:** Know how long the stream has been "quiet"

#### `audioSentSinceLastTokenMs`
- **Calculated:** Audio bytes sent since `lastTokenReceivedAt`, converted to ms
- **Purpose:** Know if we're sending audio during quiet period
- **Key insight:** High value during silence = user not speaking OR problem

#### `isReceivingTokens`
- **Calculated:** `timeSinceLastTokenMs < 30000` (30 second threshold)
- **Purpose:** Quick boolean check for "is this stream active?"

#### `realtimeLatencyMs`
- **Calculated:** When tokens received: `audioSentDurationMs - latestTokenEndMs`
- **Purpose:** The TRUE Soniox latency - only when we know Soniox is processing
- **Key insight:** Only meaningful when `isReceivingTokens === true`

### Implementation

#### In `SonioxTranscriptionStream.processTranscriptionTokens()`:

```typescript
private processTranscriptionTokens(tokens: SonioxApiToken[]): void {
  const now = Date.now();
  
  // Track token activity
  if (tokens.length > 0) {
    // Record that we received tokens
    this.metrics.lastTokenReceivedAt = now;
    this.metrics.tokenBatchesReceived = (this.metrics.tokenBatchesReceived || 0) + 1;
    this.metrics.lastTokenBatchSize = tokens.length;
    this.metrics.isReceivingTokens = true;
    
    // Calculate audio sent at this moment
    const audioSentDurationMs = (this.metrics.totalAudioBytesSent || 0) / 32;
    
    // Find latest token end time
    let latestEndMs = 0;
    for (const token of tokens) {
      if (token.end_ms && token.end_ms > latestEndMs) {
        latestEndMs = token.end_ms;
      }
    }
    
    if (latestEndMs > 0) {
      // Calculate TRUE realtime latency
      // This is how far behind Soniox is RIGHT NOW on processing
      this.metrics.realtimeLatencyMs = audioSentDurationMs - latestEndMs;
      
      // Update rolling average (simple exponential moving average)
      const alpha = 0.2; // Smoothing factor
      this.metrics.avgRealtimeLatencyMs = 
        alpha * this.metrics.realtimeLatencyMs + 
        (1 - alpha) * (this.metrics.avgRealtimeLatencyMs || this.metrics.realtimeLatencyMs);
      
      // Keep the old metric for backwards compatibility
      this.metrics.totalDeficitMs = this.metrics.realtimeLatencyMs;
      this.metrics.processingDeficitMs = this.metrics.realtimeLatencyMs;
      this.metrics.lastTranscriptEndMs = latestEndMs;
    }
  }
  
  // ... rest of existing token processing ...
}
```

#### In `SonioxTranscriptionStream.getHealth()` or periodic update:

```typescript
private updateActivityMetrics(): void {
  const now = Date.now();
  const lastToken = this.metrics.lastTokenReceivedAt || this.startTime;
  
  // Time since last token
  this.metrics.timeSinceLastTokenMs = now - lastToken;
  
  // Are we actively receiving tokens? (30 second window)
  this.metrics.isReceivingTokens = this.metrics.timeSinceLastTokenMs < 30000;
  
  // How much audio sent since last token?
  // This requires tracking audioBytesSentAtLastToken
  if (this.audioBytesSentAtLastToken !== undefined) {
    const bytesSinceLast = (this.metrics.totalAudioBytesSent || 0) - this.audioBytesSentAtLastToken;
    this.metrics.audioSentSinceLastTokenMs = bytesSinceLast / 32;
  }
}

// Track audio sent at time of last token
private audioBytesSentAtLastToken?: number;

// Update when tokens received
private onTokensReceived(): void {
  this.audioBytesSentAtLastToken = this.metrics.totalAudioBytesSent || 0;
}
```

### Updated Logging Logic

#### In `TranscriptionManager.logLatencyMetrics()`:

```typescript
private logLatencyMetrics(): void {
  const metrics = this.getMetrics();
  
  if (metrics.activeStreams === 0) {
    return;
  }

  // CASE 1: Actively receiving tokens - check actual latency
  if (metrics.isReceivingTokens) {
    if (metrics.realtimeLatencyMs > 5000) {
      this.logger.warn({
        status: "SONIOX_PROCESSING_BEHIND",
        realtimeLatencyMs: Math.round(metrics.realtimeLatencyMs),
        avgRealtimeLatencyMs: Math.round(metrics.avgRealtimeLatencyMs || 0),
        activeStreams: metrics.activeStreams,
      }, "⚠️ HIGH LATENCY: Soniox is processing behind real-time");
    } else {
      this.logger.debug({
        status: "HEALTHY",
        realtimeLatencyMs: Math.round(metrics.realtimeLatencyMs),
        activeStreams: metrics.activeStreams,
      }, "Transcription latency healthy");
    }
    return;
  }

  // CASE 2: Not receiving tokens - could be silence or problem
  const timeSinceToken = metrics.timeSinceLastTokenMs || 0;
  const audioSentDuringSilence = metrics.audioSentSinceLastTokenMs || 0;

  if (timeSinceToken > 60000 && audioSentDuringSilence > 60000) {
    // Extended period (>60s) with no tokens despite sending audio
    this.logger.warn({
      status: "EXTENDED_SILENCE_OR_ISSUE",
      timeSinceLastTokenMs: Math.round(timeSinceToken),
      audioSentSinceLastTokenMs: Math.round(audioSentDuringSilence),
      activeStreams: metrics.activeStreams,
    }, "⚠️ NO TRANSCRIPTION ACTIVITY: 60s+ without tokens despite audio being sent (likely user silence)");
  } else if (timeSinceToken > 30000) {
    // Moderate period with no tokens
    this.logger.info({
      status: "NO_RECENT_ACTIVITY",
      timeSinceLastTokenMs: Math.round(timeSinceToken),
      audioSentSinceLastTokenMs: Math.round(audioSentDuringSilence),
      activeStreams: metrics.activeStreams,
    }, "ℹ️ No recent transcription activity - possibly silence");
  }
}
```

### Metric Interpretation Guide

| Scenario | isReceivingTokens | realtimeLatencyMs | timeSinceLastTokenMs | audioSentSinceLastTokenMs | Interpretation |
|----------|-------------------|-------------------|----------------------|---------------------------|----------------|
| Healthy, active | ✅ true | 500-2000ms | <30s | N/A | Normal operation |
| Healthy, lag | ✅ true | >5000ms | <30s | N/A | Soniox behind, real issue |
| User silent | ❌ false | N/A | 60s+ | 60s+ | User not speaking |
| Stream issue | ❌ false | N/A | 60s+ | 60s+ | Could be silence OR dead stream |
| Just started | ❌ false | N/A | <30s | <30s | Waiting for first speech |

### How to Distinguish Silence vs Dead Stream

When `isReceivingTokens === false` and `audioSentSinceLastTokenMs` is high:

1. **Check WebSocket state** - Is the connection still open?
2. **Check keepalive responses** - Is Soniox responding to keepalives?
3. **Check VAD state** - Does the client think there's speech?
4. **Check audio levels** - Is the audio we're sending actual speech or silence?

If all of these are healthy, it's likely user silence. If any are problematic, investigate further.

### Dashboard Recommendations

Show these metrics in the monitoring dashboard:

1. **Primary Health Indicator:**
   - `isReceivingTokens` (green/yellow/red light)
   
2. **When Active:**
   - `realtimeLatencyMs` (the TRUE latency)
   - `avgRealtimeLatencyMs` (smoothed trend)
   
3. **When Inactive:**
   - `timeSinceLastTokenMs` (how long since activity)
   - `audioSentSinceLastTokenMs` (audio during silence)

4. **Deprecate/De-emphasize:**
   - `processingDeficitMs` / `totalDeficitMs` (misleading, keep for backwards compat only)

### Migration Path

1. **Phase 1:** Add new metrics alongside existing ones
2. **Phase 2:** Update logging to use new metrics
3. **Phase 3:** Update dashboards/alerts to use new metrics
4. **Phase 4:** Deprecate old `processingDeficitMs` warnings

### Files to Change

1. `packages/cloud/src/services/session/transcription/types.ts`
   - Add new fields to `StreamMetrics` interface

2. `packages/cloud/src/services/session/transcription/providers/SonioxTranscriptionProvider.ts`
   - Update `processTranscriptionTokens()` to track new metrics
   - Add `updateActivityMetrics()` method
   - Update `getHealth()` to include new metrics

3. `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`
   - Update `logLatencyMetrics()` with new logic
   - Update `getMetrics()` to aggregate new metrics

4. `packages/cloud/src/services/session/transcription/providers/AzureTranscriptionProvider.ts`
   - Apply same changes for consistency (if Azure provider is used)

5. `packages/cloud/src/services/session/transcription/providers/AlibabaTranscriptionProvider.ts`
   - Apply same changes for consistency (if Alibaba provider is used)

### Success Criteria

After implementation:

1. ✅ Can clearly distinguish "user silent" from "Soniox behind" in logs
2. ✅ `realtimeLatencyMs` accurately reflects Soniox processing speed when active
3. ✅ No more false "60 minute lag" warnings during silence
4. ✅ Clear dashboard showing stream health at a glance
5. ✅ Backwards compatible - old metrics still available