# Issue 008: Logging & Observability Cleanup

**Status**: In Progress  
**Branch**: `cloud/008-logging-observability-cleanup`  
**Related**: Issue 007 (Resource Lifecycle Cleanup)  
**Last Analysis**: 2025-12-16 (250K+ errors analyzed in 6-hour window)

## Quick Links

- **[Sub-Issues Summary](./sub-issues/README.md)** - Detailed breakdown of error categories
- **[Logging Standards](./logging-standards.md)** - Standards for cloud logging
- **[Quick Wins](./quick-wins.md)** - Immediate fixes to reduce noise

## Current Error Volume (6-hour sample)

| Category                       | Count   | % of Total | Priority    |
| ------------------------------ | ------- | ---------- | ----------- |
| Dashboard app WebSocket errors | 130,685 | ~52%       | 🔴 Critical |
| Display validation errors      | 25,148  | ~10%       | 🟠 High     |
| Hardware validation errors     | 25,171  | ~10%       | 🟠 High     |
| API auth errors (401)          | 971     | ~0.4%      | 🟡 Medium   |
| Unrecognized message type      | 1,025   | ~0.4%      | 🟡 Medium   |
| App not found errors           | 186     | ~0.1%      | 🟢 Low      |
| Other                          | ~67,000 | ~27%       | Various     |

**Key Finding**: ~70% of errors are from code already fixed in the repo but not deployed.

## Problem Statement

The current cloud logging makes it extremely difficult to:

1. Follow a single request/flow through the system
2. Understand what's happening during an incident
3. Distinguish important events from noise
4. Correlate events across services

### Evidence from Real Incident (2025-12-16)

While debugging a "Live Captions stopped working" issue, we had to:

- Manually piece together that audio stopped flowing at 20:39:12
- Search through 200+ log lines to find the relevant events
- Deal with keepalive spam every 10-15 seconds burying actual events
- Notice that the glasses disconnected 13 minutes after audio stopped

**The logs didn't tell us the story - we had to reconstruct it manually.**

## Current Problems

### 1. Too Much Noise

```
20:49:42.142 | debug | Sent keepalive message to Soniox          <- Every 15 seconds
20:49:27.142 | debug | Sent keepalive message to Soniox
20:49:12.142 | debug | Sent keepalive message to Soniox
20:49:10.767 | debug | Bridge health                              <- Every 10 seconds
20:49:04.851 | debug | Sent microphone keep-alive message         <- Every 10 seconds
20:49:00.767 | debug | Bridge health
```

**Impact**: Important events get buried. A single minute of logs has 6+ keepalive messages.

### 2. Inconsistent Formatting

```
🎙️ SONIOX: interim transcription - "hello"           <- Emoji prefix
[AppManager]: App stopped as expected                  <- Bracket prefix
Sent microphone state change message                   <- No prefix
📝 TRANSCRIPTION: [soniox] interim "hello" → 1 apps   <- Mixed emoji + brackets
[isaiah@mentra.glass] Boot complete for app            <- User ID prefix
```

**Impact**: Can't grep/filter consistently. Visual noise. Hard to scan.

### 3. No Correlation IDs

When an app starts, we see logs from:

- `apps.routes`
- `AppManager`
- `AppSession`
- `SubscriptionManager`
- `TranscriptionManager`
- `MicrophoneManager`
- `DisplayManager`
- `DashboardManager`

But there's no way to correlate them. If two users start apps simultaneously, logs are interleaved with no way to separate them.

### 4. Wrong Log Levels

```
debug | 🎙️ SONIOX: FINAL transcription - "important speech"   <- Should be info/trace
info  | Sent keepalive message to Soniox                       <- Should be debug/trace
debug | Bridge health                                           <- Should be trace or not logged
warn  | Ignoring empty subscription update                      <- Legitimate warning, good
```

### 5. Duplicate/Redundant Logging

Same transcription logged 3 times:

```
debug | 🎙️ SONIOX: interim transcription - "hello"
debug | Broadcasting transcription data
debug | 📝 TRANSCRIPTION: [soniox] interim "hello" → 1 apps
```

### 6. No Pipeline Health Visibility

We have no single log that says:

- "Audio pipeline healthy: glasses → livekit → transcription → apps"
- "Audio pipeline BROKEN: no audio received in 30 seconds"

Instead we have to infer this from absence of "AudioManager received PCM chunk" messages.

## Proposed Solutions

### Phase 1: Log Level Cleanup

**Establish clear log level semantics:**

| Level   | Use Case                             | Example                                            |
| ------- | ------------------------------------ | -------------------------------------------------- |
| `error` | Something failed that shouldn't have | WebSocket error, API failure                       |
| `warn`  | Recoverable issue, potential problem | Retry succeeded, rate limited                      |
| `info`  | Significant business events          | App started, user connected, transcription final   |
| `debug` | Detailed flow for debugging          | State transitions, message routing                 |
| `trace` | High-frequency internals             | Keepalives, health checks, individual audio chunks |

**Changes:**

- Move keepalives to `trace` level (or don't log at all)
- Move "Bridge health" to `trace`
- Move final transcriptions to `info`
- Keep interim transcriptions at `debug`

### Phase 2: Consistent Log Format

**Adopt structured format:**

```typescript
// Instead of:
this.logger.debug('🎙️ SONIOX: interim transcription - "hello"')

// Use:
this.logger.debug(
  {
    event: "transcription.interim",
    provider: "soniox",
    text: "hello",
    utteranceId: "utt_123",
  },
  "Interim transcription received",
)
```

**Standard fields:**

- `event` - Machine-readable event type (e.g., `app.started`, `transcription.final`)
- `service` - Already have this
- `userId` - Already have this
- `traceId` - NEW: Correlation ID for request tracing
- `spanId` - NEW: For nested operations

### Phase 3: Correlation IDs / Tracing

**Add trace context to all operations:**

```typescript
// When app start request comes in:
const traceId = generateTraceId() // e.g., "tr_abc123"

// Pass through all calls:
await appManager.startApp(packageName, {traceId})
await subscriptionManager.updateSubscriptions(subs, {traceId})
await transcriptionManager.ensureStreams({traceId})

// All logs include traceId:
// info | [tr_abc123] App started: com.mentra.captions.beta
// debug | [tr_abc123] Subscriptions updated: transcription:en-US
// debug | [tr_abc123] Stream created: soniox/en-US
```

### Phase 4: Pipeline Health Logging

**Add periodic health summaries:**

```typescript
// Every 60 seconds, log pipeline health:
this.logger.info(
  {
    event: "pipeline.health",
    glasses: {connected: true, lastMessage: "2s ago"},
    livekit: {connected: true, lastAudio: "1s ago"},
    transcription: {
      activeStreams: 1,
      provider: "soniox",
      lastTranscript: "3s ago",
    },
    apps: {
      running: ["com.mentra.captions.beta"],
      subscribed: ["transcription:en-US"],
    },
  },
  "Pipeline health check",
)
```

**Add anomaly detection logging:**

```typescript
// If no audio for 30 seconds but mic is enabled:
this.logger.warn(
  {
    event: "pipeline.anomaly",
    issue: "no_audio",
    micEnabled: true,
    lastAudioAge: "45s",
    glassesConnected: true,
  },
  "No audio received but microphone is enabled",
)
```

### Phase 5: Reduce Duplicate Logging

**One service owns each event type:**

| Event                   | Owner                | Other services                     |
| ----------------------- | -------------------- | ---------------------------------- |
| Transcription received  | TranscriptionManager | Don't log                          |
| Transcription broadcast | TranscriptionManager | Don't log                          |
| App message sent        | AppManager           | Don't log in AppSession            |
| Display request         | DisplayManager       | Don't log in websocket-app.service |

## Implementation Plan

### Step 1: Audit Current Logging

- [ ] Grep for all logger calls in cloud/packages/cloud/src
- [ ] Categorize by: noise, useful, essential
- [ ] Create spreadsheet of all log messages with proposed changes

### Step 2: Create Logging Standards Doc

- [ ] Document log level semantics
- [ ] Document structured field requirements
- [ ] Document trace ID propagation pattern
- [ ] Create examples for common scenarios

### Step 3: Implement Trace Context

- [ ] Create TraceContext utility
- [ ] Add to request middleware
- [ ] Propagate through manager calls
- [ ] Update logger child creation

### Step 4: Fix High-Impact Areas First

- [ ] TranscriptionManager - reduce noise, add pipeline health
- [ ] AppManager/AppSession - reduce duplicates, add trace IDs
- [ ] MicrophoneManager - reduce keepalive noise
- [ ] LiveKitManager - reduce health check noise

### Step 5: Add Pipeline Health Monitoring

- [ ] Create PipelineHealthMonitor service
- [ ] Log periodic health summaries
- [ ] Log anomaly detection warnings
- [ ] Add metrics for Better Stack dashboards

## Success Criteria

After this work:

1. **Can follow a single app start** by grepping for its trace ID
2. **Can see pipeline health** at a glance in logs
3. **Important events stand out** - not buried in noise
4. **Log volume reduced** by 50%+ in steady state
5. **Consistent format** - can grep/filter reliably

## Files to Modify

High-priority (most noise):

- `TranscriptionManager.ts`
- `MicrophoneManager.ts`
- `LiveKitManager.ts`
- `LiveKitGrpcClient.ts`
- `AppManager.ts`
- `AppSession.ts`

Medium-priority:

- `UserSession.ts`
- `DisplayManager.ts`
- `DashboardManager.ts`
- `SubscriptionManager.ts`

New files:

- `utils/trace-context.ts`
- `utils/logging-standards.ts`
- `services/PipelineHealthMonitor.ts`

## Open Questions

1. Should we use OpenTelemetry for tracing instead of custom trace IDs?
2. What's the right frequency for pipeline health logs? 30s? 60s?
3. Should keepalives be logged at all, or just counted in metrics?
4. Do we need log sampling for high-frequency events?

## Related Work

- Issue 007: Resource Lifecycle Cleanup (completed) - fixed memory leaks
- This issue: Make it easier to debug when things go wrong
- Future: Better Stack dashboards for pipeline health visualization

---

# Part 2: Error Log Cleanup

## Problem

**1,696 errors in 24 hours** - but most are not real errors. They're expected behavior being logged at the wrong level.

**Goal**: When you see an error in Better Stack, it should mean "something is broken and needs attention."

## Error Audit (24 hours)

| Error Message                                                | Count | Actual Severity                                         | Fix                                    |
| ------------------------------------------------------------ | ----- | ------------------------------------------------------- | -------------------------------------- |
| "WebSocket not connected (current state: CLOSED)"            | 333+  | **Expected** - app trying to send after user disconnect | Downgrade to `warn` or handle silently |
| "Hardware request validation failed - glasses not connected" | 246   | **Expected** - display request when glasses offline     | Downgrade to `debug`                   |
| "Display request validation failed"                          | 204+  | **Expected** - same as above                            | Downgrade to `debug`                   |
| "Unrecognized message type: capabilities_update"             | 12    | **Bug or missing handler**                              | Add handler or downgrade               |
| "weather.request.failed 401"                                 | 8     | **Actual issue** - API key/auth problem                 | Keep as error, investigate             |

### Root Causes

#### 1. Dashboard App Timer Updates (333+ errors)

The `system.augmentos.dashboard` app updates every minute on a timer. When users disconnect:

1. WebSocket closes
2. Timer fires anyway
3. `send()` throws "WebSocket not connected"
4. App catches and logs as error

**Stack trace**:

```
at send (/app/node_modules/@mentra/sdk/dist/app/session/index.js:1216:27)
at updateSystemSection (/app/node_modules/@mentra/sdk/dist/app/session/dashboard.js:60:14)
at updateDashboardSections (/app/src/index.ts:459:33)
```

**Fix options**:

1. SDK: Check connection state before sending, don't throw if disconnected
2. SDK: Downgrade "Message send error" from `error` to `warn` when WS is closed
3. Dashboard app: Check `session.isConnected` before updating
4. Dashboard app: Clear timer on disconnect

#### 2. Hardware Validation Errors (450+ errors)

`ConnectionValidator.validateForHardwareRequest()` logs errors when glasses aren't connected.

**File**: `cloud/packages/cloud/src/services/validators/ConnectionValidator.ts`

**Fix**: These are validation failures, not system errors. Downgrade to `debug` or `warn`.

#### 3. Display Request Validation (204+ errors)

`DisplayManager6.1.ts` logs error when display request fails validation.

**Fix**: Same as above - validation failure is not an error.

## Implementation Plan

### Phase 1: SDK Fixes (High Impact)

**File**: `cloud/packages/sdk/src/app/session/index.ts`

```typescript
// Current (line ~1872):
} catch (error: unknown) {
  this.logger.error(error, "Message send error")
  // ...
}

// Change to:
} catch (error: unknown) {
  // Don't log as error if WebSocket is just closed - that's expected during disconnect
  const isDisconnectError = error instanceof Error &&
    error.message.includes("WebSocket not connected");

  if (isDisconnectError) {
    this.logger.debug(error, "Message send skipped - session disconnected");
  } else {
    this.logger.error(error, "Message send error");
  }
  // ...
}
```

### Phase 2: Cloud Validator Fixes

**File**: `cloud/packages/cloud/src/services/validators/ConnectionValidator.ts`

Change all `logger.error()` calls to `logger.debug()` for validation failures:

- "Hardware request validation failed - no WebSocket"
- "Hardware request validation failed - WebSocket not open"
- "Hardware request validation failed - glasses not connected"

These are **expected states**, not errors.

### Phase 3: DisplayManager Fixes

**File**: `cloud/packages/cloud/src/services/layout/DisplayManager6.1.ts`

Change validation failure logging from `error` to `debug`:

```typescript
// Current:
this.logger.error({...}, `[${this.getUserId()}] ❌ Display request validation failed`);

// Change to:
this.logger.debug({...}, `[${this.getUserId()}] Display request skipped - validation failed`);
```

### Phase 4: Dashboard App Fixes

**File**: Dashboard app `src/index.ts`

Add connection check before timer-based updates:

```typescript
// Before updating dashboard sections:
if (!session.isConnected) {
  return // Skip update, user disconnected
}
```

## Success Criteria

After these fixes:

- **Error count drops by 90%+** (from ~1,700 to <200/day)
- Remaining errors are **actionable** issues
- No more "WebSocket not connected" errors for normal disconnects
- No more "glasses not connected" errors for expected states

## Files to Modify

| File                                                                  | Changes                         |
| --------------------------------------------------------------------- | ------------------------------- |
| `cloud/packages/sdk/src/app/session/index.ts`                         | Downgrade disconnect errors     |
| `cloud/packages/cloud/src/services/validators/ConnectionValidator.ts` | error → debug for validation    |
| `cloud/packages/cloud/src/services/layout/DisplayManager6.1.ts`       | error → debug for validation    |
| Dashboard app `src/index.ts`                                          | Check connection before updates |
