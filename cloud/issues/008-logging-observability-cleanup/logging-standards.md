# Cloud Logging Standards

This document defines the logging standards for the MentraOS cloud services.

## Log Levels

### `error` - Something broke that shouldn't have

Use for:

- Unhandled exceptions
- Failed API calls that can't be retried
- Data corruption or inconsistent state
- Security violations

```typescript
// ✅ Good
this.logger.error({error, userId, streamId}, "Soniox WebSocket connection failed")
this.logger.error({error, appId}, "Failed to send webhook after 3 retries")

// ❌ Bad - these are not errors
this.logger.error("User disconnected") // Expected behavior
this.logger.error("No subscribers for transcription") // Normal state
```

### `warn` - Potential problem, but recoverable

Use for:

- Retry succeeded after failure
- Rate limiting applied
- Deprecated feature used
- Unexpected but handled condition

```typescript
// ✅ Good
this.logger.warn({attempt: 2, maxAttempts: 3}, "Retrying failed request")
this.logger.warn({userId}, "Session grace period started - glasses disconnected")
this.logger.warn({queueSize: 100}, "Audio buffer growing large")

// ❌ Bad - these are normal
this.logger.warn("No apps subscribed to transcription") // Normal state
this.logger.warn("Keepalive sent") // Routine operation
```

### `info` - Significant business events

Use for:

- Session started/ended
- App started/stopped
- User connected/disconnected
- Final transcriptions (the actual speech-to-text result)
- Configuration changes
- Pipeline state changes

```typescript
// ✅ Good
this.logger.info({userId, appId}, "App started")
this.logger.info({text, isFinal: true}, "Final transcription")
this.logger.info({userId}, "User session created")
this.logger.info({streamId, provider: "soniox"}, "Transcription stream ready")

// ❌ Bad - too detailed
this.logger.info("Sending message to app") // Routine operation
this.logger.info("Processing audio chunk") // High frequency
```

### `debug` - Detailed flow for debugging

Use for:

- State transitions
- Message routing decisions
- Intermediate processing steps
- Non-trivial branching logic

```typescript
// ✅ Good
this.logger.debug({from: "connecting", to: "running"}, "State transition")
this.logger.debug({subscribers: 3}, "Broadcasting transcription to apps")
this.logger.debug({reason: "no_subscription"}, "Skipping transcription delivery")

// ❌ Bad - too noisy
this.logger.debug("Entering function") // Useless
this.logger.debug("Keepalive sent") // Should be trace or omitted
```

### `trace` - High-frequency internals (use sparingly)

Use for:

- Keepalives and health checks
- Individual audio chunks
- Per-packet processing
- Metrics sampling

**Note**: Most trace-level events should probably just be metrics, not logs.

```typescript
// ✅ Acceptable (but consider metrics instead)
this.logger.trace({bytesReceived: 1600}, "Audio chunk processed")
this.logger.trace("Keepalive sent to Soniox")

// Better: Don't log at all, just update metrics
this.metrics.audioChunksReceived.inc()
```

## Structured Logging

### Always use structured fields

```typescript
// ✅ Good - structured, queryable
this.logger.info(
  {
    event: "app.started",
    userId: "user@example.com",
    packageName: "com.example.app",
    durationMs: 245,
  },
  "App started successfully",
)

// ❌ Bad - string interpolation, not queryable
this.logger.info(`App ${packageName} started for user ${userId} in ${duration}ms`)
```

### Standard fields

Every log should include relevant context through the logger's child context:

| Field         | Type   | Description            | Example                  |
| ------------- | ------ | ---------------------- | ------------------------ |
| `userId`      | string | User identifier        | `"user@example.com"`     |
| `service`     | string | Service/class name     | `"TranscriptionManager"` |
| `traceId`     | string | Request correlation ID | `"tr_abc123"`            |
| `packageName` | string | App package name       | `"com.example.app"`      |
| `streamId`    | string | Stream identifier      | `"stream_xyz"`           |

### Event naming convention

Use dot-separated event names for machine-readable categorization:

```typescript
// Format: {domain}.{action}
// Domains: app, session, transcription, translation, audio, display, pipeline

this.logger.info({event: "app.started"}, "...")
this.logger.info({event: "app.stopped"}, "...")
this.logger.info({event: "transcription.final"}, "...")
this.logger.info({event: "transcription.stream.created"}, "...")
this.logger.info({event: "session.created"}, "...")
this.logger.info({event: "session.disposed"}, "...")
this.logger.info({event: "pipeline.health"}, "...")
this.logger.info({event: "pipeline.anomaly"}, "...")
```

## Trace Context

### Propagating trace IDs

For operations that span multiple services, use a trace ID:

```typescript
// In route handler or entry point:
const traceId = generateTraceId(); // "tr_" + nanoid(12)

// Pass through context:
await this.appManager.startApp(packageName, { traceId });

// In AppManager:
async startApp(packageName: string, ctx: { traceId: string }) {
  const logger = this.logger.child({ traceId: ctx.traceId });
  logger.info({ event: "app.starting", packageName }, "Starting app");

  await this.subscriptionManager.update(subs, { traceId: ctx.traceId });
}
```

### When to create trace IDs

Create a new trace ID at:

- HTTP request entry
- WebSocket message received (glasses or app)
- Timer/cron job execution
- External event (webhook received)

## Reducing Noise

### Don't log routine operations

```typescript
// ❌ Don't log keepalives at info/debug level
this.logger.info("Sent keepalive")
this.logger.debug("Bridge health check passed")

// ✅ Either use trace level or just metrics
this.metrics.keepalivesSent.inc()
// or
this.logger.trace("Keepalive sent") // filtered out in production
```

### Don't log the same event multiple times

```typescript
// ❌ Bad - same transcription logged 3 times
this.logger.debug("Received tokens from Soniox")
this.logger.debug("Processing transcription")
this.logger.debug("Broadcasting transcription to apps")

// ✅ Good - one log with full context
this.logger.debug(
  {
    event: "transcription.broadcast",
    text: transcript.text,
    isFinal: transcript.isFinal,
    subscriberCount: apps.length,
  },
  "Transcription delivered to apps",
)
```

### Aggregate high-frequency events

```typescript
// ❌ Bad - logging every audio chunk
audioChunks.forEach((chunk) => {
  this.logger.debug({size: chunk.length}, "Processing audio chunk")
})

// ✅ Good - log summary periodically
if (this.chunkCount % 100 === 0) {
  this.logger.debug(
    {
      chunksProcessed: this.chunkCount,
      totalBytes: this.bytesProcessed,
    },
    "Audio processing progress",
  )
}
```

## Log Message Guidelines

### Be specific and actionable

```typescript
// ❌ Vague
this.logger.error("Something went wrong")
this.logger.warn("Invalid state")

// ✅ Specific
this.logger.error({error, streamId}, "Failed to write audio to Soniox stream")
this.logger.warn({expected: "running", actual: "stopped"}, "App state mismatch")
```

### Don't include redundant information

```typescript
// ❌ Redundant - userId is in logger context
this.logger.info(`User ${userId} connected`)

// ✅ Clean
this.logger.info("User connected")
```

### Use consistent tense and voice

- Use past tense for completed actions: "App started", "Stream created"
- Use present tense for ongoing state: "Processing audio", "Waiting for connection"

## Pipeline Health Logging

### Periodic health summaries

Log pipeline health every 60 seconds:

```typescript
this.logger.info(
  {
    event: "pipeline.health",
    glasses: {
      connected: true,
      lastMessageAgeMs: 1500,
    },
    audio: {
      receiving: true,
      lastChunkAgeMs: 500,
      chunksLastMinute: 100,
    },
    transcription: {
      activeStreams: 1,
      provider: "soniox",
      lastTranscriptAgeMs: 2000,
    },
    apps: {
      running: 2,
      subscribed: ["transcription:en-US"],
    },
  },
  "Pipeline health OK",
)
```

### Anomaly detection

Log warnings when things look wrong:

```typescript
// No audio but mic is enabled
this.logger.warn(
  {
    event: "pipeline.anomaly",
    anomaly: "no_audio",
    micEnabled: true,
    lastAudioAgeMs: 45000,
    glassesConnected: true,
  },
  "No audio received for 45s but mic is enabled",
)

// App subscribed but no transcriptions delivered
this.logger.warn(
  {
    event: "pipeline.anomaly",
    anomaly: "no_transcriptions",
    subscribedApps: 1,
    lastTranscriptAgeMs: 60000,
    streamHealthy: true,
  },
  "No transcriptions delivered to subscribed apps",
)
```

## Examples by Service

### AppManager

```typescript
// App lifecycle
this.logger.info({event: "app.starting", packageName}, "Starting app")
this.logger.info({event: "app.started", packageName, durationMs}, "App started")
this.logger.info({event: "app.stopping", packageName, reason}, "Stopping app")
this.logger.info({event: "app.stopped", packageName}, "App stopped")

// Errors
this.logger.error({event: "app.start_failed", packageName, error}, "Failed to start app")
```

### TranscriptionManager

```typescript
// Stream lifecycle
this.logger.info({event: "transcription.stream.creating", provider, language}, "Creating stream")
this.logger.info({event: "transcription.stream.ready", streamId, provider}, "Stream ready")
this.logger.info({event: "transcription.stream.closed", streamId, reason}, "Stream closed")

// Transcriptions (final only at info level)
this.logger.info({event: "transcription.final", text, language, provider}, "Final transcription")
this.logger.debug({event: "transcription.interim", text}, "Interim transcription")
```

### UserSession

```typescript
// Session lifecycle
this.logger.info({event: "session.created"}, "Session created")
this.logger.info({event: "session.disposed", reason}, "Session disposed")

// Connection events
this.logger.info({event: "session.glasses_connected"}, "Glasses connected")
this.logger.warn({event: "session.glasses_disconnected", code}, "Glasses disconnected")
```

## Migration Checklist

When updating a file to comply with these standards:

- [ ] Replace string interpolation with structured fields
- [ ] Review log levels (move keepalives to trace)
- [ ] Remove duplicate logging
- [ ] Add `event` field to significant logs
- [ ] Ensure context (userId, service) is in logger child
- [ ] Add trace ID propagation where applicable
- [ ] Test that logs are still useful for debugging
