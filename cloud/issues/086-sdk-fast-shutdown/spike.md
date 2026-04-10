# Spike: SDK Fast Shutdown

## Overview

**What this doc covers:** The MiniAppServer takes too long to shut down on Ctrl+C (SIGINT), causing developers to press Ctrl+C multiple times and wait 5+ seconds for the process to exit.
**Why this doc exists:** Discovered during stream-test app development. The SDK's graceful shutdown was designed for production cloud deploys (issue 063) where flushing WebSocket close frames matters. For developer Ctrl+C, it should just exit immediately.
**Who should read this:** SDK developers.

## The Problem

When a developer presses Ctrl+C:

1. Multiple "Shutting down..." messages appear (2-3 times) because both `app.start()` and `Bun.serve()` catch SIGINT independently
2. The SDK waits ~2 seconds for WebSocket close frames to flush (the drain delay from issue 063)
3. Pending reconnect attempts (attempt 1, 2, 3...) continue scheduling during shutdown, keeping the process alive
4. The developer has to press Ctrl+C twice or wait 5+ seconds

## Root Causes

### 1. Multiple signal handlers

`MiniAppServer` extends `AppServer` which registers SIGINT/SIGTERM handlers. If the app also uses `Bun.serve()` (for fullstack webview), that's another listener. Each one prints "Shutting down..." independently.

### 2. Drain delay is always 2 seconds

The graceful shutdown (issue 063) has a hardcoded 2-second delay:

```typescript
// cloud/packages/cloud/src/index.ts (the cloud server, not the SDK)
// But the SDK's AppServer has a similar pattern
logger.info("Graceful shutdown complete — waiting 2s for close frames to flush");
await new Promise((resolve) => setTimeout(resolve, 2000));
```

This makes sense for production (K8s SIGTERM during deploy) but not for development (Ctrl+C).

### 3. Reconnect scheduler doesn't check shutdown state

The `_ConnectionManager` schedules reconnect attempts on transport close. When the transport closes during shutdown, it still tries to reconnect (attempt 1, 2, 3 with exponential backoff), keeping the event loop alive.

## Proposed Fix

### Differentiate SIGINT from SIGTERM

- **SIGINT** (Ctrl+C, developer action): Cancel all timers, close WebSocket without waiting for drain, `process.exit(0)` immediately.
- **SIGTERM** (K8s deploy, production): Keep the current graceful drain behavior (close frames, 2s wait, etc.)

### Cancel reconnects on shutdown

When the SDK enters shutdown state, `_ConnectionManager` should:
- Cancel any pending reconnect timers
- Not schedule new reconnect attempts
- Set a `shuttingDown` flag that prevents new connections

### Single shutdown handler

`MiniAppServer` should register one SIGINT handler that handles everything, rather than letting multiple listeners fight.

### Force exit timeout

As a safety net, if graceful shutdown takes more than 2 seconds on SIGINT, force `process.exit(0)`. This catches any edge case where a timer or callback keeps the event loop alive.

## Related Issues

- **063** — Graceful shutdown (the original implementation for cloud deploys)
- **085** — Stream lifecycle across session disruptions (streams should survive shutdown, but the process should still exit fast)