# Detect Captions Lag - Spec

## Overview

Add observability to measure transcription latency and identify when Soniox (speech-to-text provider) is causing delays behind real-time.

## Problem

Users reported intermittent lag (10 seconds to 2+ minutes) between speaking and seeing captions/app responses. We lack visibility to determine the cause:

1. **No attribution**: Can't tell if lag is from Soniox, our pipeline, or network
2. **No real-time alerting**: Only discover issues from user reports
3. **No historical data**: Can't prove if incidents were Soniox's fault for SLA discussions
4. **No trend detection**: Can't see if problem is getting worse over time

### Evidence

- Last week: Multiple users reported 1-2 minute lag
- Current: ~1.5 second delay (likely normal processing time)
- Historical: No data to determine if spikes correlate with Soniox incidents

### Current Blind Spots

```
User speaks → [BLACK BOX] → Caption appears 60s later
```

We don't know where those 60 seconds were spent:
- Mobile client buffering? (unlikely - uses unreliable DataChannel)
- LiveKit bridge buffering? (max 2s buffer before dropping)
- Cloud VAD buffering? (max 10s timeout)
- Soniox processing time? (unknown)
- Network delay? (should be <500ms)

## Constraints

### Technical

- **Can't add client timestamps**: Mobile sends audio without capture time metadata
- **Soniox timestamps are relative**: `start_ms`/`end_ms` are relative to stream start, not absolute
- **Real-time requirement**: Calculations must be <1ms to avoid adding latency
- **No new dependencies**: Use existing logging/metrics infrastructure

### Operational

- **Must prove attribution**: Need definitive evidence if delay is Soniox's fault
- **24/7 monitoring**: Can't rely on manual checking
- **Post-mortem data**: Need historical metrics for incident analysis

## Goals

1. **Measure transcript age**: Calculate how old a transcript is when received
2. **Detect Soniox lag**: Identify when provider is processing behind real-time
3. **Alert on high latency**: Warn when lag exceeds thresholds (>5s warning, >10s critical)
4. **Track processing backlog**: Measure audio sent vs audio transcribed
5. **Aggregate metrics**: System-wide view of latency across all streams

### Success Criteria

- When user reports lag, logs show `transcriptLagMs` value proving source
- Alerts fire within 30 seconds of sustained high latency
- Can generate report: "Lag was 55s at timestamp X due to Soniox"
- Metrics available via API for dashboards

## Non-Goals

- **Not fixing the lag**: This is observability only, not performance improvement
- **Not client-side timing**: No changes to mobile app
- **Not automatic failover**: Detection only, not switching providers (future work)
- **Not historical analysis tools**: Just raw metrics, dashboard building is separate

## Approach

### The Golden Metric: Transcript Age

Soniox returns timestamps relative to stream start:
```typescript
// Soniox response
{
  text: "hello",
  start_ms: 1000,  // Word started 1s into stream
  end_ms: 1200     // Word ended 1.2s into stream
}
```

We know when stream started (`stream.startTime = Date.now()`).

Calculate transcript age:
```typescript
const streamAge = Date.now() - stream.startTime;  // How long stream has been running
const transcriptLag = streamAge - token.end_ms;    // How old the transcript is
```

**Example**:
- Stream started: 12:00:00 (timestamp: 1704139200000)
- Current time: 12:01:00 (timestamp: 1704139260000)
- Token end_ms: 5000 (word ended 5 seconds into stream, at 12:00:05)
- **Lag = 60000ms - 5000ms = 55000ms (55 seconds behind)**

This definitively proves the transcript is 55 seconds old.

### Secondary Metric: Processing Deficit

Track total audio sent vs transcribed:
```typescript
// Audio sent (in milliseconds)
const audioSentDurationMs = totalAudioBytesSent / 32;  // 16kHz * 2 bytes/sample = 32 bytes/ms

// Audio transcribed (from Soniox timestamps)
const audioTranscribedMs = lastTranscriptEndMs;

// Backlog
const processingDeficit = audioSentDurationMs - audioTranscribedMs;
```

If deficit grows over time, Soniox is processing slower than real-time.

## Metrics to Track

### Per-Stream Metrics (StreamMetrics interface)

```typescript
interface StreamMetrics {
  // Existing fields...
  
  // NEW: Latency tracking
  totalAudioBytesSent?: number;      // Total bytes sent to provider
  lastTranscriptEndMs?: number;      // Last transcript timestamp (relative to stream start)
  lastTranscriptLagMs?: number;      // Current lag (now - spoken time)
  maxTranscriptLagMs?: number;       // Peak lag observed this stream
  transcriptLagWarnings?: number;    // Count of times lag exceeded 5s
}
```

### Aggregate Metrics (TranscriptionManager.getMetrics())

```typescript
{
  latency: {
    avgTranscriptLagMs: 8500,        // Average across all active streams
    maxTranscriptLagMs: 15000,       // Worst stream
    totalLagWarnings: 12             // Total warnings across all streams
  },
  backlog: {
    totalAudioBytesSent: 640000,     // Total bytes sent to provider
    totalTranscriptEndMs: 20000,     // Latest transcript timestamp
    processingDeficitMs: 20000       // Audio not yet transcribed (ms)
  }
}
```

## Alert Thresholds

### Info Level (>2s)
Moderate latency, log for awareness:
```
transcriptLagMs: 2000-5000
→ Log level: info
→ Action: None, monitor
```

### Warning Level (>5s)
High latency, likely Soniox issue:
```
transcriptLagMs: 5000-15000
→ Log level: warn
→ Action: Alert on-call if sustained >2 minutes
```

### Critical Level (>15s)
Severe latency, service degraded:
```
transcriptLagMs: >15000
→ Log level: error
→ Action: Immediate alert, consider failover
```

### Backlog Alert (>10s)
Processing slower than real-time:
```
processingDeficitMs: >10000
→ Log level: warn
→ Action: Alert, Soniox may be overloaded
```

## Example Log Outputs

### Normal Operation
```json
{
  "level": "debug",
  "streamId": "soniox-en-US-abc123",
  "transcriptLagMs": 1200,
  "processingDeficitMs": 500,
  "provider": "soniox"
}
```

### High Latency Detected
```json
{
  "level": "warn",
  "streamId": "soniox-en-US-abc123",
  "transcriptLagMs": 55000,
  "streamAgeMs": 60000,
  "transcriptEndMs": 5000,
  "processingDeficitMs": 50000,
  "audioSentDurationMs": 60000,
  "maxLagMs": 55000,
  "lagWarnings": 3,
  "provider": "soniox",
  "msg": "⚠️ HIGH TRANSCRIPTION LATENCY DETECTED - Soniox is lagging behind real-time"
}
```

### System-Wide Alert
```json
{
  "level": "warn",
  "activeStreams": 2,
  "avgLagMs": 8500,
  "maxLagMs": 15000,
  "lagWarnings": 12,
  "processingDeficitMs": 20000,
  "msg": "⚠️ HIGH LATENCY: Transcription is significantly lagging"
}
```

## Open Questions

1. **Alert fatigue**: Should we debounce alerts or fire on every high-latency transcript?
   - **Decision**: Fire per-transcript warnings, aggregate alerts every 30s in health check
   
2. **Metric retention**: How long to keep historical max lag?
   - **Decision**: Per-stream lifetime only, external monitoring system handles history

3. **Client timestamps**: Should we add capture timestamps from mobile?
   - **Decision**: No, out of scope. Server-side timestamps sufficient for now

4. **Automatic failover**: When should we switch providers?
   - **Decision**: Not in this spec. Future work after gathering data

5. **Dashboard integration**: What tool for visualization?
   - **Decision**: Better Stack for logs/alerts, dashboard building is separate task