# 004: Metrics & Observability

Add connection metrics, correlation IDs, and structured logging for production visibility.

## Problem

No visibility into WebSocket server health or message flow:

### Missing Connection Metrics

- No active connection count (glasses vs apps)
- No connection rate (connects/disconnects per minute)
- No session count tracking
- Can't see connection health in dashboards

### Missing Message Metrics

- No message throughput by type
- No processing latency tracking
- No error rate by message type
- Can't identify slow or problematic message handlers

### No Correlation IDs

- Can't trace message from receipt to completion
- Incident investigation requires manual log correlation
- No way to track a single request across services

**Evidence**: In recent incident investigation, had to manually query Better Stack with time windows to correlate phone disconnect with session disposal. No built-in tracing.

### Inconsistent Logging

- Some logs have `{ service, userId }` context, others don't
- No standard format for message handling logs
- Debug logs mixed with important operational logs

## Goal

- Real-time visibility into connection health
- Message throughput and latency metrics
- Correlation IDs through message lifecycle
- Consistent structured logging
- Metrics exposed via `/health` and Better Stack

## Implementation

### MetricsService

```typescript
// packages/cloud/src/services/metrics/MetricsService.ts

import {logger as rootLogger} from "../logging/pino-logger"
import UserSession from "../session/UserSession"

const logger = rootLogger.child({service: "MetricsService"})

interface ConnectionMetrics {
  glassesConnections: number
  appConnections: number
  totalSessions: number
  connectionsLastMinute: number
  disconnectionsLastMinute: number
}

interface MessageMetrics {
  // Counters by message type
  glassesMessagesByType: Map<string, number>
  appMessagesByType: Map<string, number>

  // Totals
  totalMessagesProcessed: number
  totalMessageErrors: number

  // Latency tracking (last 100 samples)
  processingLatencies: number[]
}

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy"
  connections: ConnectionMetrics
  messages: {
    glassesTypes: Record<string, number>
    appTypes: Record<string, number>
    processed: number
    errors: number
    avgLatencyMs: number
    p99LatencyMs: number
  }
  uptime: number
  timestamp: string
}

class MetricsService {
  private connectionMetrics: ConnectionMetrics = {
    glassesConnections: 0,
    appConnections: 0,
    totalSessions: 0,
    connectionsLastMinute: 0,
    disconnectionsLastMinute: 0,
  }

  private messageMetrics: MessageMetrics = {
    glassesMessagesByType: new Map(),
    appMessagesByType: new Map(),
    totalMessagesProcessed: 0,
    totalMessageErrors: 0,
    processingLatencies: [],
  }

  // Rolling window for connections/disconnections
  private recentConnections: number[] = []
  private recentDisconnections: number[] = []
  private readonly WINDOW_MS = 60000 // 1 minute

  // ===== Connection Tracking =====

  onGlassesConnect(userId: string) {
    this.connectionMetrics.glassesConnections++
    this.connectionMetrics.totalSessions = UserSession.getAllSessions().length
    this.recordConnection()
    logger.debug({userId}, "Glasses connected")
  }

  onGlassesDisconnect(userId: string, code: number, reason: string) {
    this.connectionMetrics.glassesConnections = Math.max(0, this.connectionMetrics.glassesConnections - 1)
    this.connectionMetrics.totalSessions = UserSession.getAllSessions().length
    this.recordDisconnection()
    logger.debug({userId, code, reason}, "Glasses disconnected")
  }

  onAppConnect(userId: string, packageName: string) {
    this.connectionMetrics.appConnections++
    logger.debug({userId, packageName}, "App connected")
  }

  onAppDisconnect(userId: string, packageName: string, code: number, reason: string) {
    this.connectionMetrics.appConnections = Math.max(0, this.connectionMetrics.appConnections - 1)
    logger.debug({userId, packageName, code, reason}, "App disconnected")
  }

  // ===== Message Tracking =====

  onGlassesMessage(type: string, correlationId: string) {
    const count = this.messageMetrics.glassesMessagesByType.get(type) || 0
    this.messageMetrics.glassesMessagesByType.set(type, count + 1)
    this.messageMetrics.totalMessagesProcessed++
  }

  onAppMessage(type: string, packageName: string, correlationId: string) {
    const count = this.messageMetrics.appMessagesByType.get(type) || 0
    this.messageMetrics.appMessagesByType.set(type, count + 1)
    this.messageMetrics.totalMessagesProcessed++
  }

  onMessageError(type: string, correlationId: string, error: Error) {
    this.messageMetrics.totalMessageErrors++
    logger.warn({correlationId, type, error: error.message}, "Message processing error")
  }

  recordLatency(latencyMs: number) {
    this.messageMetrics.processingLatencies.push(latencyMs)
    // Keep last 100 samples
    if (this.messageMetrics.processingLatencies.length > 100) {
      this.messageMetrics.processingLatencies.shift()
    }
  }

  // ===== Helper Methods =====

  private recordConnection() {
    const now = Date.now()
    this.recentConnections.push(now)
    this.cleanOldEntries()
  }

  private recordDisconnection() {
    const now = Date.now()
    this.recentDisconnections.push(now)
    this.cleanOldEntries()
  }

  private cleanOldEntries() {
    const cutoff = Date.now() - this.WINDOW_MS
    this.recentConnections = this.recentConnections.filter((t) => t > cutoff)
    this.recentDisconnections = this.recentDisconnections.filter((t) => t > cutoff)
    this.connectionMetrics.connectionsLastMinute = this.recentConnections.length
    this.connectionMetrics.disconnectionsLastMinute = this.recentDisconnections.length
  }

  private calculateAvgLatency(): number {
    const latencies = this.messageMetrics.processingLatencies
    if (latencies.length === 0) return 0
    return latencies.reduce((a, b) => a + b, 0) / latencies.length
  }

  private calculateP99Latency(): number {
    const latencies = [...this.messageMetrics.processingLatencies].sort((a, b) => a - b)
    if (latencies.length === 0) return 0
    const index = Math.floor(latencies.length * 0.99)
    return latencies[index]
  }

  // ===== Public API =====

  getHealth(): HealthStatus {
    this.cleanOldEntries()

    const errorRate =
      this.messageMetrics.totalMessagesProcessed > 0
        ? this.messageMetrics.totalMessageErrors / this.messageMetrics.totalMessagesProcessed
        : 0

    let status: "healthy" | "degraded" | "unhealthy" = "healthy"
    if (errorRate > 0.1) status = "unhealthy"
    else if (errorRate > 0.01) status = "degraded"

    return {
      status,
      connections: {...this.connectionMetrics},
      messages: {
        glassesTypes: Object.fromEntries(this.messageMetrics.glassesMessagesByType),
        appTypes: Object.fromEntries(this.messageMetrics.appMessagesByType),
        processed: this.messageMetrics.totalMessagesProcessed,
        errors: this.messageMetrics.totalMessageErrors,
        avgLatencyMs: Math.round(this.calculateAvgLatency() * 100) / 100,
        p99LatencyMs: Math.round(this.calculateP99Latency() * 100) / 100,
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }
  }

  // Reset counters (for testing)
  reset() {
    this.connectionMetrics = {
      glassesConnections: 0,
      appConnections: 0,
      totalSessions: 0,
      connectionsLastMinute: 0,
      disconnectionsLastMinute: 0,
    }
    this.messageMetrics = {
      glassesMessagesByType: new Map(),
      appMessagesByType: new Map(),
      totalMessagesProcessed: 0,
      totalMessageErrors: 0,
      processingLatencies: [],
    }
    this.recentConnections = []
    this.recentDisconnections = []
  }
}

export const metricsService = new MetricsService()
export default metricsService
```

### Correlation ID Utility

```typescript
// packages/cloud/src/utils/correlation.ts

export interface MessageContext {
  correlationId: string
  userId: string
  messageType: string
  receivedAt: number
  packageName?: string
}

/**
 * Generate correlation ID for tracing messages
 */
export function createCorrelationId(userId: string): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 8)
  return `${userId.substring(0, 8)}-${timestamp}-${random}`
}

/**
 * Create message context for logging/tracing
 */
export function createMessageContext(userId: string, messageType: string, packageName?: string): MessageContext {
  return {
    correlationId: createCorrelationId(userId),
    userId,
    messageType,
    receivedAt: Date.now(),
    packageName,
  }
}

/**
 * Calculate message processing duration
 */
export function getProcessingDuration(ctx: MessageContext): number {
  return Date.now() - ctx.receivedAt
}
```

### Updated Health Endpoint

```typescript
// In packages/cloud/src/index.ts

import {metricsService} from "./services/metrics/MetricsService"

app.get("/health", (req, res) => {
  try {
    const health = metricsService.getHealth()
    const statusCode = health.status === "healthy" ? 200 : health.status === "degraded" ? 200 : 503
    res.status(statusCode).json(health)
  } catch (error) {
    logger.error({error}, "Health check error")
    res.status(500).json({
      status: "unhealthy",
      error: "Health check failed",
      timestamp: new Date().toISOString(),
    })
  }
})
```

### Integration with Message Handling

```typescript
// In UserSession.handleGlassesMessage()

import { createMessageContext, getProcessingDuration } from "../utils/correlation";
import { metricsService } from "../services/metrics/MetricsService";

async handleGlassesMessage(message: GlassesToCloudMessage): Promise<void> {
  const ctx = createMessageContext(this.userId, message.type);

  this.logger.debug(
    { correlationId: ctx.correlationId, type: message.type },
    "Handling glasses message"
  );

  try {
    switch (message.type) {
      case GlassesToCloudMessageType.VAD:
        await this.transcriptionManager.handleVad(message, ctx);
        break;
      // ... other cases
    }

    const duration = getProcessingDuration(ctx);
    metricsService.onGlassesMessage(message.type, ctx.correlationId);
    metricsService.recordLatency(duration);

    this.logger.debug(
      { correlationId: ctx.correlationId, durationMs: duration },
      "Message handled successfully"
    );
  } catch (error) {
    metricsService.onMessageError(message.type, ctx.correlationId, error as Error);
    this.logger.error(
      { correlationId: ctx.correlationId, error },
      "Error handling glasses message"
    );
    throw error;
  }
}
```

### Structured Logging Pattern

```typescript
// Standard log context for all services
interface LogContext {
  service: string
  userId?: string
  correlationId?: string
  packageName?: string
}

// In each manager/service constructor:
this.logger = userSession.logger.child({
  service: "TranscriptionManager",
})

// When handling messages:
this.logger.info({correlationId: ctx.correlationId, language: "en-US"}, "Starting transcription")

// On errors:
this.logger.error({correlationId: ctx.correlationId, error: err.message}, "Transcription failed")
```

## Health Response Example

```json
{
  "status": "healthy",
  "connections": {
    "glassesConnections": 42,
    "appConnections": 156,
    "totalSessions": 42,
    "connectionsLastMinute": 5,
    "disconnectionsLastMinute": 3
  },
  "messages": {
    "glassesTypes": {
      "vad": 15420,
      "keep_alive": 8640,
      "head_position": 3210,
      "touch_event": 456
    },
    "appTypes": {
      "subscription_update": 892,
      "display_request": 4521,
      "dashboard_system_update": 12045
    },
    "processed": 45184,
    "errors": 12,
    "avgLatencyMs": 2.34,
    "p99LatencyMs": 15.8
  },
  "uptime": 86400,
  "timestamp": "2025-12-18T10:30:00.000Z"
}
```

## Files Changed

| File                                 | Change                                                   |
| ------------------------------------ | -------------------------------------------------------- |
| `services/metrics/MetricsService.ts` | New - metrics tracking                                   |
| `utils/correlation.ts`               | New - correlation IDs                                    |
| `index.ts`                           | Update /health endpoint                                  |
| `UserSession.ts`                     | Add correlation to handleGlassesMessage/handleAppMessage |
| `websocket-glasses.service.ts`       | Call metricsService on connect/disconnect                |
| `websocket-app.service.ts`           | Call metricsService on connect/disconnect                |

## Better Stack Integration

Metrics are logged via pino and automatically flow to Better Stack. Create dashboard queries:

### Connection Health Query

```sql
SELECT
  toStartOfMinute(dt) AS minute,
  countIf(JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%connected%') AS connects,
  countIf(JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%disconnected%') AS disconnects
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
GROUP BY minute
ORDER BY minute
```

### Message Throughput Query

```sql
SELECT
  JSONExtract(raw, 'type', 'Nullable(String)') AS message_type,
  count(*) AS count
FROM remote(t373499_augmentos_logs)
WHERE
  dt > now() - INTERVAL 1 HOUR
  AND JSONExtract(raw, 'message', 'Nullable(String)') = 'Handling glasses message'
GROUP BY message_type
ORDER BY count DESC
```

### Error Rate Query

```sql
SELECT
  toStartOfMinute(dt) AS minute,
  countIf(JSONExtract(raw, 'level', 'Nullable(String)') = 'error') AS errors,
  count(*) AS total
FROM remote(t373499_augmentos_logs)
WHERE dt > now() - INTERVAL 1 HOUR
GROUP BY minute
ORDER BY minute
```

## Success Criteria

- [ ] MetricsService tracks all connection events
- [ ] MetricsService tracks all message types
- [ ] Correlation IDs in all message handling logs
- [ ] `/health` endpoint returns detailed metrics
- [ ] Better Stack dashboard shows connection health
- [ ] Better Stack dashboard shows message throughput
- [ ] P99 latency tracking works
- [ ] Can trace single message by correlation ID in logs

## Open Questions

1. **Metric storage for historical data?**
   - Current: In-memory counters (reset on restart)
   - Option: Persist to database
   - **Decision**: In-memory is fine for now, Better Stack has historical logs

2. **Prometheus format?**
   - Option A: Custom JSON format (current)
   - Option B: Prometheus exposition format
   - **Decision**: JSON for now, add `/metrics` Prometheus endpoint later if needed

3. **Latency percentiles?**
   - Current: avg and p99
   - Could add: p50, p95
   - **Decision**: avg and p99 sufficient for now

4. **Correlation ID propagation to apps?**
   - Should correlation ID be sent to apps in messages?
   - Would help trace across cloud → app boundary
   - **Decision**: Nice to have, not required for initial implementation
