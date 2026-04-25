# Design: Fail Fast on SIGTERM — Implementation

## Overview

**What this doc covers:** File-by-file implementation plan for the fail-fast shutdown handler defined in [spec.md](./spec.md).

**What you need to know first:** [spike.md](./spike.md), [spec.md](./spec.md).

**Who should read this:** PR reviewers.

---

## Changes Summary

| Component       | File                                                 | What changes                                            |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Entry point     | `cloud/packages/cloud/src/index.ts`                  | Replace `gracefulShutdown` body with fail-fast sequence |
| Porter manifest | `cloud/porter.yaml`                                  | `terminationGracePeriodSeconds: 30` → `10`              |
| 063 docs        | `cloud/issues/063-graceful-shutdown/README.md` (new) | Note that 063 is superseded by 100                      |

No changes to `services/shutdown.ts` (existing flag is fine), `hono-app.ts` (drain middleware is fine), or `bun-websocket.ts` (upgrade rejection is fine).

---

## Entry Point Changes

### Change 1: Replace `gracefulShutdown` body

**File:** `cloud/packages/cloud/src/index.ts`

**Current (~L199–263, see spike.md for full quote):** async function that sets flag, iterates sessions closing WebSockets, stops timers, awaits Mongo close, awaits 2 s, exits.

**New:**

```typescript
// ---------------------------------------------------------------------------
// Fail-fast shutdown on SIGTERM/SIGINT
//
// Goals (in priority order):
//   1. Every connected WebSocket receives a close frame (1001).
//   2. Exit the process within 5 seconds.
//   3. Everything else — Mongo close, timer stopping, session dispose — is
//      either irrelevant (process is dying) or best-effort.
//
// See: cloud/issues/100-fail-fast-sigterm/spec.md
// ---------------------------------------------------------------------------

import { inspect } from "node:util";

const SHUTDOWN_BUDGET_MS = 5000;
const PINO_FLUSH_TIMEOUT_MS = 500;

let isShutdownInProgress = false;

function stderrLine(fields: Record<string, unknown>): void {
  // Synchronous write. Bypasses Pino. Guaranteed to leave the pod before exit.
  try {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...fields }) + "\n");
  } catch {
    // stderr write failed; nothing useful we can do.
  }
}

async function flushPinoWithTimeout(ms: number): Promise<"flushed" | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve("timeout");
    }, ms);
    timer.unref();

    try {
      // Pino's flush API: logger.flush(cb?) on sync transports, or Symbol.for('pino.end') / .finish on async.
      // Best-effort: if no API is available, we just race the timer.
      const anyLogger = logger as unknown as { flush?: (cb?: (err?: Error) => void) => void };
      if (typeof anyLogger.flush === "function") {
        anyLogger.flush(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve("flushed");
        });
      } else {
        // No flush API — rely on the timer.
      }
    } catch {
      // Flush threw; fall through to the timer.
    }
  });
}

async function failFastShutdown(signal: string): Promise<void> {
  if (isShutdownInProgress) return;
  isShutdownInProgress = true;

  const t0 = Date.now();
  setShuttingDown();

  // Watchdog: if anything hangs, force-exit at the budget.
  const watchdog = setTimeout(() => {
    stderrLine({
      event: "shutdown-watchdog-fired",
      signal,
      budgetMs: SHUTDOWN_BUDGET_MS,
      elapsedMs: Date.now() - t0,
    });
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }, SHUTDOWN_BUDGET_MS);
  watchdog.unref();

  // Step 1: announce via stderr (synchronous).
  const sessions = UserSession.getAllSessions();
  stderrLine({
    event: "shutdown-started",
    signal,
    pid: process.pid,
    sessionCount: sessions.length,
  });

  // Step 2: close every WebSocket with 1001. Fire-and-forget per socket.
  let closedGlasses = 0;
  let closedApps = 0;
  for (const session of sessions) {
    try {
      session.websocket?.close(1001, "Server shutting down");
      closedGlasses++;
    } catch {
      // swallow per-socket
    }
    if (session.appWebsockets) {
      for (const [, appWs] of session.appWebsockets) {
        try {
          appWs.close(1001, "Server shutting down");
          closedApps++;
        } catch {
          // swallow per-socket
        }
      }
    }
  }

  // Step 3: fire-and-forget Mongo close.
  // Not awaited. Most of the time we'll exit before it completes — that's fine.
  try {
    void mongoose.connection.close();
  } catch {
    // swallow
  }

  // Step 4: flush Pino with a short timeout.
  const flushResult = await flushPinoWithTimeout(PINO_FLUSH_TIMEOUT_MS);

  // Step 5: announce completion via stderr.
  stderrLine({
    event: "shutdown-complete",
    signal,
    elapsedMs: Date.now() - t0,
    closedGlasses,
    closedApps,
    pinoFlush: flushResult,
  });

  clearTimeout(watchdog);
  // eslint-disable-next-line no-process-exit
  process.exit(0);
}

process.on("SIGTERM", () => void failFastShutdown("SIGTERM"));
process.on("SIGINT", () => void failFastShutdown("SIGINT"));
```

Rename `gracefulShutdown` → `failFastShutdown` to make the intent obvious at every call site.

Remove the old `gracefulShutdown` function entirely.

**Key changes vs. 063:**

- Stderr announcement at start and end.
- Watchdog with `process.exit(1)` at 5 s if anything hangs.
- No `systemVitalsLogger.stop()` / `appCache.stop()` / `metricsService.stop()`.
- Mongo close is fire-and-forget, not awaited.
- No `await setTimeout(resolve, 2000)`.
- Explicit Pino flush with 500 ms timeout.

**Imports added:**

- `import { inspect } from "node:util";` — not strictly needed; remove if unused. Only here as a fallback for structured stderr.

**Imports removed:**

- None of the existing imports are removed. `systemVitalsLogger`, `appCache`, `metricsService`, `mongoose` are still imported for other reasons.

---

## Porter Manifest Changes

### Change 2: Drop grace period to 10 s

**File:** `cloud/porter.yaml`

```diff
-    # Graceful shutdown — give WebSocket close frames time to flush
-    # See: cloud/issues/063-graceful-shutdown/spec.md
-    terminationGracePeriodSeconds: 30
+    # Fail-fast shutdown — close frames + exit within 5s, K8s SIGKILL at 10s.
+    # See: cloud/issues/100-fail-fast-sigterm/spec.md
+    terminationGracePeriodSeconds: 10
```

Deploy-time effect: next pod rollout applies the new grace period.

---

## 063 Supersession

### Change 3: Mark 063 as superseded

**File:** `cloud/issues/063-graceful-shutdown/README.md` (new)

```markdown
# Issue 063 — Graceful Shutdown (SUPERSEDED)

This issue shipped a SIGTERM handler that attempts a graceful shutdown (close WebSockets, stop timers, close Mongo, wait 2 s for frame flush, exit).

In practice it produced exit-code-137 restarts in production and its shutdown log line never appeared in BetterStack, suggesting Pino logs were not flushing before exit and/or the handler was exceeding the 30 s grace period.

This issue has been superseded by [100-fail-fast-sigterm](../100-fail-fast-sigterm/) which pivots to a fail-fast design: close frames + synchronous stderr + 5 s budget + exit.

The original `spec.md` is preserved for historical context.
```

---

## Testing

### Unit-adjacent

None. The handler is entry-point code; smoke test via local run + cloud-debug.

### Local

`bun run dev`, connect a glasses client, `kill -TERM <pid>` from another terminal. Observe:

- stderr shows `shutdown-started` line immediately
- Client WebSocket fires `onclose(1001, "Server shutting down")` within ~500 ms
- stderr shows `shutdown-complete` line with `elapsedMs < 2000`
- Process exits with code 0

Watchdog test: add `while (true) {}` inside the shutdown function just after the watchdog is set. `kill -TERM <pid>`. Observe stderr `shutdown-watchdog-fired` at 5 s and exit code 1.

### cloud-debug

1. Deploy branch.
2. `kubectl get pod -l app=cloud-debug` to identify the pod, then `kubectl delete pod <name>`.
3. Check container logs for `shutdown-started` and `shutdown-complete` stderr lines.
4. Check Porter dashboard — exit code should be 0.
5. Connect glasses client to cloud-debug during the restart; measure time to reconnect on new pod.

### cloud-prod rolling

1. us-central first. Deploy, watch all 3 pods terminate sequentially.
2. Confirm all three exit with code 0 within 2–3 s.
3. Check BetterStack: `shutdown-complete` lines appear with `elapsedMs` < 2000.
4. Spot-check a glasses session: `ws-dispose` on old pod, next `ws-upgrade` on new pod, same user; the gap should be well under 5 s.
5. If confirmed clean, roll out to france, east-asia, us-east, us-west.

---

## Decision Log

| Decision                                                            | Alternatives considered               | Why we chose this                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Synchronous stderr line rather than Pino for the announcement       | Keep Pino, try harder to flush        | Pino is fundamentally async; in crash paths its guarantees are unreliable. Stderr.write is the simplest correct answer.  |
| `process.stderr.write(JSON...)` not `console.error`                 | `console.error` wraps stderr          | Same stream, but `console.error` may add formatting / locale conversion. Raw stderr is faster and has zero dependencies. |
| Watchdog exits with code 1, not `process.abort()`                   | abort(); kill(process.pid, 'SIGKILL') | Exit 1 is clean and distinguishable. abort() can dump core; SIGKILL skips final log writes.                              |
| Fire-and-forget Mongo close with `void mongoose.connection.close()` | Skip Mongo close entirely             | Signaling intent is polite. Server will clean up on TCP FIN regardless. Zero latency cost.                               |
| Rename function to `failFastShutdown`                               | Keep name `gracefulShutdown`          | Name should match behavior. Readers of `gracefulShutdown` would expect the old behavior.                                 |
| Mark 063 superseded, don't delete                                   | Delete 063 folder                     | Preserves history of the journey. Pattern matches how other issues have been superseded.                                 |

---

## Rollout

1. **Branch:** `cloud/issues-100-fail-fast-sigterm` (already created).
2. **PR:** single PR with Changes 1–3 above.
3. **cloud-debug:** one manually triggered restart, verify stderr lines and exit 0.
4. **cloud-prod rolling:** us-central, wait 30 min monitoring, then rest of regions.
5. **Follow-up PR:** `shutdown.handlerInvocations` / `shutdown.watchdogFires` counters via the existing metrics service, if we want Prometheus visibility.
