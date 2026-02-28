# Bun Time Spec

## Overview

Refactor MentraOS cloud WebSocket architecture to leverage Bun's native capabilities, extract message routing from WebSocket services into the UserSession/Manager hierarchy, and add proper observability.

## Problem

### 1. WebSocket Services Are God Classes

`websocket-glasses.service.ts` (1256 lines) and `websocket-app.service.ts` (1062 lines) handle too many concerns:

- Connection lifecycle (open/close/error)
- JWT authentication
- Message parsing
- Message routing via giant switch statements (20+ cases each)
- Business logic inline with routing

This violates Single Responsibility and Open/Closed principles. Adding a new message type requires modifying these massive files.

### 2. Not Leveraging Bun

Currently using:

- Node.js `http.Server` with Express
- `ws` package (Node.js WebSocket library)
- Node.js `setTimeout`/`setInterval`

Bun has native WebSocket support that's ~3-5x faster with built-in backpressure handling (`drain()`), compression, and better memory efficiency.

### 3. Hardcoded Configuration

```typescript
// In index.ts - 80+ hardcoded CORS origins
cors({
  origin: ["*", "http://localhost:3000" /* ... 80 more */],
})

// Scattered constants
const RECONNECT_GRACE_PERIOD_MS = 1000 * 60 * 1 // 1 minute
const HEARTBEAT_INTERVAL = 10000 // 10 seconds
const GRACE_PERIOD_MS = 5000 // 5 seconds
```

### 4. Missing Observability

No tracking of:

- Active WebSocket connection count
- Message throughput by type
- Connection success/failure rates
- Message processing latency
- Correlation IDs across message lifecycle

Evidence from incident investigation: Had to manually query Better Stack to trace what happened to a session. No built-in correlation between phone WebSocket disconnect and session disposal.

### Constraints

- **Backward compatibility**: Mobile clients and apps can't be updated simultaneously
- **Zero downtime**: Can't break existing connections during migration
- **Incremental rollout**: Need to be able to roll back each sub-issue independently
- **Testing burden**: WebSocket services are hard to unit test currently

## Goals

### Phase 1: Extract Message Routing (001)

- WebSocket services become thin (~200 lines each)
- Message routing moves to `UserSession.handleGlassesMessage()` / `UserSession.handleAppMessage()`
- Managers expose consistent `handle*` methods for their domain messages
- Switch statements replaced with handler registry pattern

### Phase 2: Config Extraction (003)

- CORS origins in environment/config file
- All timeouts/grace periods configurable
- Feature flags for experimental features
- No magic numbers in code

### Phase 3: Metrics & Observability (004)

- Connection count metrics (exposed via `/health` or dedicated endpoint)
- Message type counters
- Processing latency histograms
- Correlation IDs through message lifecycle
- Structured logging with consistent context

### Phase 4: Bun Native WebSocket (002)

- Replace `ws.Server` with `Bun.serve({ websocket: {...} })`
- Leverage `ws.data` for per-connection state (replaces `(request as any).userId` hacks)
- Native backpressure via `drain()` callback
- Optional: Evaluate replacing Express with Hono/Elysia for full Bun native

## Non-Goals

- **Rewriting UserSession/Manager architecture** - Already solid, keep as-is
- **Changing wire protocol** - Messages stay the same format
- **Breaking mobile/app clients** - All changes are internal
- **Full Express replacement** - Keep Express for HTTP routes (Bun runs it fine)
- **gRPC changes** - LiveKit bridge stays as-is

## Success Metrics

| Metric                             | Current | Target                             |
| ---------------------------------- | ------- | ---------------------------------- |
| websocket-glasses.service.ts lines | 1256    | <300                               |
| websocket-app.service.ts lines     | 1062    | <300                               |
| Hardcoded CORS origins             | 80+     | 0 (in config)                      |
| Connection metrics                 | None    | Active count, throughput, latency  |
| Message correlation                | None    | Full trace from receive → response |

## Open Questions

1. **Handler registry vs switch statement?**
   - Registry: More extensible, easier testing
   - Switch: Simpler, TypeScript exhaustiveness checking
   - **Leaning**: Registry pattern with TypeScript type safety

2. **Where does message routing live?**
   - Option A: `UserSession.handleGlassesMessage()` with internal routing
   - Option B: Separate `MessageRouter` class
   - **Leaning**: Option A - keeps it simple, UserSession already owns managers

3. **Config format?**
   - Option A: Environment variables (current)
   - Option B: JSON/YAML config file
   - Option C: Both (env overrides config file)
   - **Leaning**: Option C for flexibility

4. **Metrics backend?**
   - Option A: Expose via `/metrics` endpoint (Prometheus-style)
   - Option B: Send to Better Stack via existing logger
   - Option C: Both
   - **Leaning**: Option B initially (already using Better Stack)

5. **Bun WebSocket migration strategy?**
   - Option A: Big bang (swap all at once)
   - Option B: Feature flag (run both, route by flag)
   - Option C: New endpoints (e.g., `/glasses-ws-v2`)
   - **Leaning**: Option A after thorough staging testing
