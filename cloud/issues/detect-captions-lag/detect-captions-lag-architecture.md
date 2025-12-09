# Detect Captions Lag - Architecture

## Current System

### Audio Pipeline Overview

```
Mobile Client → LiveKit Bridge (Go) → Cloud (Node.js) → Soniox WebSocket
    |               |                      |                  |
    |               |                      |                  |
  mic data      DataPacket            AudioManager      transcripts
  (base64)      channel (200)         feedAudio()      (tokens)
                                           ↓
                                   TranscriptionManager
                                           ↓
                                   relayDataToApps()
                                           ↓
                                      TPAs via SDK
```

### Key Code Paths

**Mobile sends audio** (`mobile/src/bridge/MantleBridge.tsx:283-292`):
```typescript
case "mic_data":
  binaryString = atob(data.base64);
  bytes = new Uint8Array(binaryString.length);
  // ... decode ...
  if (livekit.isRoomConnected()) {
    livekit.addPcm(bytes);  // → LiveKit DataPacket
  }
```

**Bridge receives audio** (`cloud-livekit-bridge/service.go:80-95`):
```go
OnDataPacket: func(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
  userPacket, ok := packet.(*lksdk.UserDataPacket)
  pcmData := userPacket.Payload
  
  select {
  case session.audioFromLiveKit <- pcmData:  // Buffer: 200 chunks (~2s)
    receivedPackets++
  default:
    droppedPackets++  // Channel full, drop packet
  }
}
```

**Cloud receives audio** (`cloud/packages/cloud/src/services/session/AudioManager.ts:62-87`):
```typescript
processAudioData(audioData: ArrayBuffer) {
  this.userSession.lastAudioTimestamp = Date.now();  // Server time only
  
  // Normalize to Buffer
  let buf = Buffer.from(audioData);
  
  // Feed to transcription
  this.userSession.transcriptionManager.feedAudio(buf);
}
```

**TranscriptionManager buffers** (`TranscriptionManager.ts:710-732`):
```typescript
feedAudio(data: ArrayBuffer) {
  if (this.isBufferingForVAD) {
    this.vadAudioBuffer.push(data);  // Buffer during stream startup
    return;
  }
  this.feedAudioToStreams(data);
}
```

**Soniox processes** (`SonioxTranscriptionProvider.ts:715-757`):
```typescript
async writeAudio(data: ArrayBuffer): Promise<boolean> {
  if (this.state !== StreamState.READY) {
    this.metrics.audioDroppedCount++;
    return false;
  }
  
  this.ws.send(data);  // WebSocket to Soniox
  this.metrics.audioChunksWritten++;
  return true;
}
```

**Soniox responds** (`SonioxTranscriptionProvider.ts:503-525`):
```typescript
private handleMessage(data: Buffer): void {
  const response: SonioxResponse = JSON.parse(data.toString());
  
  // Response contains tokens with timestamps
  if (response.tokens) {
    this.processSonioxTokens(response.tokens);
  }
}
```

### Problems with Current System

1. **No latency visibility**: We log that we received a transcript, but not how old it is
2. **No timestamp from client**: Mobile doesn't send capture time, so can't measure true end-to-end
3. **Server timestamp only**: `Date.now()` at receive time doesn't help measure processing lag
4. **No backlog tracking**: Don't know if Soniox is falling behind
5. **No automated alerts**: Only discover issues from user reports

## Proposed System

### New Data Flow with Latency Tracking

```
Mobile → Bridge → Cloud → Soniox → Cloud (with lag calculation)
                           ↓
                     Returns tokens:
                     { text, start_ms, end_ms }
                           ↓
                     Calculate lag:
                     now - (streamStart + end_ms)
                           ↓
                     Log if > threshold
                           ↓
                     Aggregate metrics
```

### Key Changes

**1. Track stream start time** (already exists):
```typescript
// SonioxTranscriptionStream constructor
public startTime = Date.now();  // When stream was created
```

**2. Calculate transcript age** (NEW in `SonioxTranscriptionProvider.ts:541-650`):
```typescript
private processTranscriptionTokens(tokens: SonioxApiToken[]): void {
  let latestEndMs = 0;
  
  for (const token of tokens) {
    if (token.end_ms && token.end_ms > latestEndMs) {
      latestEndMs = token.end_ms;
    }
  }
  
  // NEW: Calculate lag
  if (latestEndMs > 0) {
    const now = Date.now();
    const streamAge = now - this.startTime;
    const transcriptLag = streamAge - latestEndMs;
    
    // Update metrics
    this.metrics.lastTranscriptEndMs = latestEndMs;
    this.metrics.lastTranscriptLagMs = transcriptLag;
    this.metrics.maxTranscriptLagMs = Math.max(
      this.metrics.maxTranscriptLagMs || 0,
      transcriptLag
    );
    
    // Calculate processing deficit
    const audioSentDurationMs = this.metrics.totalAudioBytesSent / 32;
    const processingDeficit = audioSentDurationMs - latestEndMs;
    
    // Alert if high latency
    if (transcriptLag > 5000) {
      this.metrics.transcriptLagWarnings++;
      this.logger.warn({
        streamId: this.id,
        transcriptLagMs: Math.round(transcriptLag),
        streamAgeMs: Math.round(streamAge),
        transcriptEndMs: Math.round(latestEndMs),
        processingDeficitMs: Math.round(processingDeficit),
        provider: "soniox"
      }, "⚠️ HIGH TRANSCRIPTION LATENCY DETECTED");
    }
  }
}
```

**3. Track audio bytes sent** (NEW in `SonioxTranscriptionProvider.ts:715-757`):
```typescript
async writeAudio(data: ArrayBuffer): Promise<boolean> {
  // ... existing write logic ...
  
  // NEW: Track total bytes for backlog calculation
  this.metrics.totalAudioBytesSent = 
    (this.metrics.totalAudioBytesSent || 0) + data.byteLength;
  
  return true;
}
```

**4. Aggregate metrics** (NEW in `TranscriptionManager.ts:763-850`):
```typescript
getMetrics(): Record<string, any> {
  const metrics = {
    totalStreams: this.streams.size,
    activeStreams: 0,
    latency: {
      maxTranscriptLagMs: 0,
      avgTranscriptLagMs: 0,
      totalLagWarnings: 0
    },
    backlog: {
      totalAudioBytesSent: 0,
      totalTranscriptEndMs: 0,
      processingDeficitMs: 0
    }
  };
  
  let totalLag = 0;
  let lagCount = 0;
  
  for (const stream of this.streams.values()) {
    // Aggregate latency
    if (stream.metrics.lastTranscriptLagMs) {
      totalLag += stream.metrics.lastTranscriptLagMs;
      lagCount++;
    }
    metrics.latency.maxTranscriptLagMs = Math.max(
      metrics.latency.maxTranscriptLagMs,
      stream.metrics.maxTranscriptLagMs || 0
    );
    
    // Aggregate backlog
    metrics.backlog.totalAudioBytesSent += stream.metrics.totalAudioBytesSent || 0;
    metrics.backlog.totalTranscriptEndMs = Math.max(
      metrics.backlog.totalTranscriptEndMs,
      stream.metrics.lastTranscriptEndMs || 0
    );
  }
  
  // Calculate averages
  metrics.latency.avgTranscriptLagMs = lagCount > 0 
    ? Math.round(totalLag / lagCount) 
    : 0;
  
  // Calculate processing deficit
  if (metrics.backlog.totalAudioBytesSent > 0) {
    const audioSentDurationMs = metrics.backlog.totalAudioBytesSent / 32;
    metrics.backlog.processingDeficitMs = Math.round(
      audioSentDurationMs - metrics.backlog.totalTranscriptEndMs
    );
  }
  
  return metrics;
}
```

**5. Periodic monitoring** (NEW in `TranscriptionManager.ts:1820-1872`):
```typescript
private startHealthMonitoring(): void {
  this.healthCheckInterval = setInterval(() => {
    this.cleanupDeadStreams();
    this.logLatencyMetrics();  // NEW
  }, this.config.performance.healthCheckIntervalMs);
}

private logLatencyMetrics(): void {
  const metrics = this.getMetrics();
  
  if (metrics.activeStreams === 0) return;
  
  // Log if high latency
  if (metrics.latency.maxTranscriptLagMs > 5000) {
    this.logger.warn({
      activeStreams: metrics.activeStreams,
      avgLagMs: metrics.latency.avgTranscriptLagMs,
      maxLagMs: metrics.latency.maxTranscriptLagMs,
      lagWarnings: metrics.latency.totalLagWarnings,
      processingDeficitMs: metrics.backlog.processingDeficitMs
    }, "⚠️ HIGH LATENCY: Transcription is significantly lagging");
  }
  
  // Alert on processing backlog
  if (metrics.backlog.processingDeficitMs > 10000) {
    this.logger.warn({
      deficitMs: metrics.backlog.processingDeficitMs,
      audioSentBytes: metrics.backlog.totalAudioBytesSent,
      transcriptEndMs: metrics.backlog.totalTranscriptEndMs
    }, "⚠️ PROCESSING BACKLOG: Provider is falling behind");
  }
}
```

## Implementation Details

### Type Changes

**`types.ts` - StreamMetrics interface**:
```typescript
export interface StreamMetrics {
  // Existing fields...
  totalDuration: number;
  audioChunksReceived: number;
  audioChunksWritten: number;
  
  // NEW: Latency & Backlog Tracking
  totalAudioBytesSent?: number;        // Total bytes sent to provider
  lastTranscriptEndMs?: number;        // Last transcript end time (relative to stream start)
  lastTranscriptLagMs?: number;        // Current lag (now - spoken time)
  maxTranscriptLagMs?: number;         // Peak lag observed
  transcriptLagWarnings?: number;      // Count of lag warnings (>5s)
  
  // Existing fields...
  errorCount: number;
}
```

**`types.ts` - StreamHealth interface**:
```typescript
export interface StreamHealth {
  isAlive: boolean;
  lastActivity: number;
  consecutiveFailures: number;
  lastSuccessfulWrite?: number;
  providerHealth: ProviderHealthStatus;
  
  // NEW: Latency metrics
  transcriptLagMs?: number;            // Current lag
  maxTranscriptLagMs?: number;         // Peak lag
}
```

### Calculation Examples

**Scenario 1: Normal Operation**
```
Stream started: 12:00:00.000 (timestamp: 1704139200000)
Current time:   12:00:03.500 (timestamp: 1704139203500)
Token end_ms:   2000 (word ended 2s into stream)

streamAge = 1704139203500 - 1704139200000 = 3500ms
transcriptLag = 3500 - 2000 = 1500ms

Result: 1.5 second lag (normal)
```

**Scenario 2: Soniox Lagging**
```
Stream started: 12:00:00.000 (timestamp: 1704139200000)
Current time:   12:01:00.000 (timestamp: 1704139260000)
Token end_ms:   5000 (word ended 5s into stream)

streamAge = 1704139260000 - 1704139200000 = 60000ms
transcriptLag = 60000 - 5000 = 55000ms

Result: 55 second lag (HIGH LATENCY WARNING)
```

**Scenario 3: Processing Deficit**
```
totalAudioBytesSent = 1920000 bytes
audioSentDurationMs = 1920000 / 32 = 60000ms (60 seconds)
lastTranscriptEndMs = 10000 (10 seconds transcribed)

processingDeficit = 60000 - 10000 = 50000ms

Result: 50 seconds of audio not yet transcribed (BACKLOG WARNING)
```

### Performance Impact

**Per-transcript calculation**:
- 4 arithmetic operations: <0.01ms
- 1 max comparison: <0.01ms
- 1 conditional check: <0.01ms
- Total: <0.05ms per transcript

**Memory overhead per stream**:
- 5 new number fields: 40 bytes (5 × 8 bytes)
- Negligible compared to stream memory (~5MB)

**Logging overhead**:
- Warnings only when lag > 5s: rare
- Aggregate metrics every 30s: ~10ms CPU
- Total: <0.1% overhead

## Migration Strategy

### Phase 1: Implementation (DONE)
- [x] Add metrics to types
- [x] Implement calculation in SonioxTranscriptionProvider
- [x] Add aggregation in TranscriptionManager
- [x] Add periodic logging

### Phase 2: Monitoring (IN PROGRESS)
- [ ] Deploy to production
- [ ] Watch logs for latency patterns
- [ ] Tune alert thresholds if needed
- [ ] Set up Better Stack alerts

### Phase 3: Response (FUTURE)
- [ ] Build latency dashboard
- [ ] Implement auto-fallback to Azure/Alibaba when Soniox lag > 30s
- [ ] Add client-side timestamps for true end-to-end measurement
- [ ] SLA tracking (P50/P95/P99 latency)

## Edge Cases

### 1. Stream just started
```typescript
// First transcript arrives before 1 second
streamAge = 500ms
transcriptEndMs = 200ms
lag = 500 - 200 = 300ms

// This is normal, no alert
```

### 2. Multiple tokens in one response
```typescript
// Take the latest end_ms
tokens = [
  { text: "hello", end_ms: 1000 },
  { text: "world", end_ms: 1500 }
]

latestEndMs = 1500  // Use this for lag calculation
```

### 3. No tokens yet (stream initializing)
```typescript
if (latestEndMs === 0) {
  // Skip lag calculation, no data yet
  return;
}
```

### 4. Stream reconnects
```typescript
// Each stream has its own startTime
// Reconnect creates NEW stream with NEW startTime
// Metrics don't carry over (correct behavior)
```

### 5. Clock skew
```typescript
// All timestamps are server-side Date.now()
// No cross-machine clock issues
// Mobile clock irrelevant (we don't use it)
```

## Testing

### Unit Tests
```typescript
describe('Latency Calculation', () => {
  it('calculates transcript lag correctly', () => {
    const stream = new SonioxTranscriptionStream(...);
    stream.startTime = 1704139200000;
    
    // Mock Date.now() to return 1704139203000 (3s later)
    jest.spyOn(Date, 'now').mockReturnValue(1704139203000);
    
    const tokens = [{ text: "hello", end_ms: 1000 }];
    stream.processTranscriptionTokens(tokens);
    
    expect(stream.metrics.lastTranscriptLagMs).toBe(2000); // 3000 - 1000
  });
  
  it('warns on high latency', () => {
    // Mock 55 second lag
    const warnSpy = jest.spyOn(logger, 'warn');
    
    stream.startTime = 1704139200000;
    jest.spyOn(Date, 'now').mockReturnValue(1704139255000); // 55s later
    
    const tokens = [{ text: "hello", end_ms: 0 }];
    stream.processTranscriptionTokens(tokens);
    
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptLagMs: 55000
      }),
      expect.stringContaining("HIGH TRANSCRIPTION LATENCY")
    );
  });
});
```

### Integration Tests
```typescript
describe('TranscriptionManager Metrics', () => {
  it('aggregates latency across streams', () => {
    const manager = new TranscriptionManager(...);
    
    // Create two streams with different lags
    const stream1 = createStream();
    stream1.metrics.lastTranscriptLagMs = 2000;
    stream1.metrics.maxTranscriptLagMs = 5000;
    
    const stream2 = createStream();
    stream2.metrics.lastTranscriptLagMs = 4000;
    stream2.metrics.maxTranscriptLagMs = 8000;
    
    manager.streams.set('sub1', stream1);
    manager.streams.set('sub2', stream2);
    
    const metrics = manager.getMetrics();
    
    expect(metrics.latency.avgTranscriptLagMs).toBe(3000); // (2000 + 4000) / 2
    expect(metrics.latency.maxTranscriptLagMs).toBe(8000); // max of all
  });
});
```

### Manual Testing
1. Start transcription session
2. Speak continuously for 30 seconds
3. Check logs for `transcriptLagMs` values
4. Verify lag is <2s under normal conditions
5. If Soniox is slow (simulate by rate limiting), verify warnings appear

## Monitoring Integration

### Better Stack Alerts

**Alert 1: High Latency**
```
Query: level:warn AND msg:"HIGH TRANSCRIPTION LATENCY"
Trigger: More than 5 occurrences in 2 minutes
Severity: Warning
Channel: #alerts
```

**Alert 2: Critical Latency**
```
Query: transcriptLagMs:>30000
Trigger: Any occurrence
Severity: Critical
Channel: #alerts, PagerDuty
```

**Alert 3: Processing Backlog**
```
Query: msg:"PROCESSING BACKLOG"
Trigger: More than 3 occurrences in 5 minutes
Severity: Warning
Channel: #alerts
```

### Dashboard Queries

**Average Latency Over Time**:
```
Parse: transcriptLagMs
Aggregate: AVG(transcriptLagMs) GROUP BY 1 minute
Visualization: Line chart
```

**Max Latency Per Hour**:
```
Parse: maxTranscriptLagMs
Aggregate: MAX(maxTranscriptLagMs) GROUP BY 1 hour
Visualization: Bar chart
```

**Processing Deficit Trend**:
```
Parse: processingDeficitMs
Aggregate: AVG(processingDeficitMs) GROUP BY 1 minute
Visualization: Area chart
Alert: When trend is increasing for 5 minutes
```

## Open Questions

1. **Should we track per-user latency separately?**
   - Current: Global metrics across all users
   - Alternative: Map<userId, LatencyMetrics>
   - **Decision**: Start global, add per-user if needed

2. **What about translation latency?**
   - Current: Only tracking transcription
   - Translation uses same Soniox stream, timestamps apply
   - **Decision**: Same metrics cover both (they share stream)

3. **Historical retention in code?**
   - Current: Per-stream lifetime only
   - Alternative: Keep sliding window (last hour)
   - **Decision**: Let external monitoring handle history

4. **Should we expose metrics via HTTP endpoint?**
   - Current: Logs only
   - Alternative: GET /api/metrics/transcription
   - **Decision**: Not yet, logs sufficient for now