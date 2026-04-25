# Spec: Fail Fast on SIGTERM

## Overview

**What this doc covers:** Exact replacement behavior for the SIGTERM handler in `cloud/packages/cloud/src/index.ts`. Establishes a hard 5-second budget from signal-received to `process.exit(0)`, with close-frame delivery as the only user-visible operation that must succeed. Replaces the "graceful" approach from issue 063.

**Why this doc exists:** Issue 063's design tried to do cleanup work (timers, Mongo, 2 s flush wait) inside the shutdown path. In practice this produces exit-137 restarts (SIGKILL after 30 s grace period elapses) and no visible shutdown log lines. The spike proved the user-visible outcome (close frame to clients) doesn't require any of that cleanup. This spec codifies the minimum we need to do, with timeouts on every async step.

**What you need to know first:** [spike.md](./spike.md).

**Who should read this:** Cloud reviewers, SRE, anyone who touches the shutdown path.

---

## The Problem in 30 Seconds

SIGTERM handler must announce itself loudly, close every WebSocket with code 1001, flush Pino, and exit — all within 5 s. No Mongo close, no 2 s magic wait, no dispose of sessions. Anything that doesn't contribute to "client phone sees close frame and reconnects" is waste that pushes us toward SIGKILL.

---

## Spec

### S1 — Handler budget: 5 seconds, hard

From the moment `process.on("SIGTERM", handler)` fires to the moment the process exits, **nothing may block longer than the remaining budget**. A watchdog timer is armed at the start; if the budget elapses, the handler calls `process.exit(1)` with a stderr line rather than letting Kubernetes SIGKILL us.

### S2 — Required steps, in order

The handler does exactly these steps, in this order, with these timeouts.

1. **Announce via stderr (synchronous).**
   - `process.stderr.write(...)` with a one-line JSON payload: signal name, PID, timestamp, active session count. Synchronous write, not Pino.
   - Rationale: Pino is async-buffered. A synchronous stderr write is the only way to guarantee the log leaves the pod before exit.

2. **Set `isShuttingDown()`.**
   - Existing `setShuttingDown()` from `cloud/packages/cloud/src/services/shutdown.ts`.
   - Takes < 1 ms. Causes `/health` → 503 and new WS upgrades → 503 immediately.

3. **Close all WebSockets with code 1001.**
   - Iterate `UserSession.getAllSessions()`.
   - For each session: `session.websocket?.close(1001, "Server shutting down")`.
   - For each entry in `session.appWebsockets`: `.close(1001, "Server shutting down")`.
   - Wrap each `.close()` call in a `try/catch` — a thrown close on one socket must not abort the loop.
   - Budget: best-effort, no per-socket await. Target 500 ms total.

4. **Flush Pino with a 500 ms timeout.**
   - Attempt `logger.flush?.()` if the API exists, or the Pino transport's `finish` event. Await with `Promise.race([flushPromise, timeoutPromise])` where the timeout is 500 ms.
   - Rationale: we want the final Pino log lines (the ones we wrote before signal handler) to flush. We cannot wait forever.

5. **Fire-and-forget Mongo close.**
   - Call `mongoose.connection.close()` without awaiting it. If it completes before exit, good; if not, Mongo sees a TCP FIN and handles it.
   - Rationale: Mongo server-side cleanup on connection drop is robust. Our blocking on it adds latency with no user-visible benefit.

6. **Announce completion via stderr.**
   - Second synchronous stderr line: signal name, total wall-clock elapsed, counts of closed WebSockets.
   - Rationale: gives us proof-of-completion in container logs even if Pino flush failed.

7. **`process.exit(0)`.**
   - Exit code 0. No 2 s wait. If close frames are still in-flight, Bun's TCP stack delivers them on socket teardown.

### S3 — Watchdog

Armed at the very start of the handler. If 5 s elapses before step 7, a separate `setTimeout(() => { process.stderr.write(...); process.exit(1); }, 5000)` fires and force-exits.

```typescript
const WATCHDOG_MS = 5000;
const watchdog = setTimeout(() => {
  process.stderr.write(
    JSON.stringify({
      event: "shutdown-watchdog-fired",
      elapsedMs: WATCHDOG_MS,
      reason: "handler did not complete in time",
    }) + "\n",
  );
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();
```

`unref()` so the watchdog itself doesn't prevent normal exit. Cleared just before the normal `process.exit(0)`.

### S4 — What the handler explicitly does NOT do

| Removed from 063 handler                                                  | Why                                                                                                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `systemVitalsLogger.stop()` / `appCache.stop()` / `metricsService.stop()` | Timers die with the process. Setting `stopped: true` flags is ceremony.                                               |
| `await mongoose.connection.close()`                                       | Server handles TCP FIN cleanup. Blocking on it adds 100–1000 ms with no benefit.                                      |
| `await new Promise(resolve => setTimeout(resolve, 2000))`                 | 2 s of wall-clock doing nothing. Bun's close-frame delivery works without it for properly formed `close(1001)` calls. |
| `session.dispose()` per session                                           | DB writes, Soniox stream close, transcript persistence. Seconds of async work. Clients don't need any of it.          |
| Drain in-flight HTTP requests                                             | LB already stopped routing; in-flight requests will either complete or fail over to a new pod.                        |

### S5 — `terminationGracePeriodSeconds` drops to 10

**File:** `cloud/porter.yaml`

Change `terminationGracePeriodSeconds: 30` → `terminationGracePeriodSeconds: 10`.

Rationale: we promise 5 s. Kubernetes gives us double that ceiling. If the handler hangs past 10 s, Kubernetes SIGKILLs — which is the correct escape valve.

### S6 — SIGINT (local dev) uses the same handler

No change from 063: `process.on("SIGINT", () => gracefulShutdown("SIGINT"))` gives developers the same fail-fast experience (Ctrl+C in dev exits in < 1 s).

### S7 — Observability

Add a counter: `shutdown.handlerInvocations`, `shutdown.watchdogFires`. Export via the standard metrics path so we can alert on unexpected watchdog fires. Optional for the first PR; can land as a follow-up.

---

## Non-Goals

- Replacing `gracefulShutdown` with something that tries harder to preserve session state. Session state is ephemeral; clients rebuild on reconnect.
- Changing the client-side reconnect logic. That's issue 079.
- Adding a pre-stop hook in Kubernetes. Not needed; SIGTERM is fine.
- Persisting session state to disk before exit. Ephemeral on purpose.
- Waiting for current transcription or translation streams to finalize. They'll reconnect on the next session.

---

## Decision Log

| Decision                                   | Alternatives considered        | Why we chose this                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5 s budget, 10 s K8s grace period          | Keep 30 s; use 15 s            | 5 s is plenty for the only required step (close frames). Larger budgets incentivize adding "just one more cleanup step" which brought us here.                                                            |
| Synchronous stderr for signal announcement | Pino log                       | Pino logs are buffered; in our current prod incidents they never leave the pod. Stderr is delivered immediately.                                                                                          |
| Watchdog force-exits with code 1           | Let K8s SIGKILL                | Exit-code-1 on watchdog is our signal; SIGKILL is K8s's. We want to distinguish "our watchdog fired" (expected if a bug) from "K8s killed us" (unexpected).                                               |
| Fire-and-forget Mongo close                | Await it; skip entirely        | Fire-and-forget gives us best-effort clean shutdown without blocking.                                                                                                                                     |
| No session.dispose()                       | Call it per-session            | dispose() is seconds of async work; its side effects are nice-to-have, not required.                                                                                                                      |
| No 2 s post-exit wait                      | Keep the 2 s wait              | Spike argues the 2 s was a guess, not evidence-based. If close frames need time, Bun's TCP stack handles it during socket teardown. If it's actually broken, we add back a 100–500 ms wait with evidence. |
| Close app WebSockets too, not just glasses | Close glasses only             | A disconnected phone reconnects quickly. A ghost app on a dead pod can keep writing to a stale WS for minutes. Close them too.                                                                            |
| Keep using code 1001                       | 1012 "Service Restart"; custom | 1001 is universal and already-supported by mobile. 1012 support is inconsistent.                                                                                                                          |
| Supersede 063, don't amend it              | Update 063 in place            | 063 was correct for its time; this is a deliberate design shift. Traceable history > edited spec.                                                                                                         |

---

## Testing

### Local (macOS, `bun run dev`)

1. Start cloud locally. Connect a glasses client.
2. Send SIGTERM: `kill -TERM <pid>`.
3. Expect:
   - stderr line `shutdown-started` within 50 ms
   - glasses client receives WebSocket close frame (1001) within 500 ms
   - stderr line `shutdown-complete` with wall-clock < 2 s
   - process exits with code 0
4. Watchdog test: insert a `while(true){}` into step 3 locally, confirm watchdog fires at 5 s with exit code 1.

### cloud-debug

1. Deploy the branch.
2. Trigger a pod restart (redeploy, or `kubectl delete pod`).
3. Check BetterStack for the stderr-origin lines (they'll show up as container-stderr, not Pino-structured). Confirm `shutdown-started` and `shutdown-complete` both visible.
4. Check Porter for exit code 0, not 137.
5. Reconnect a glasses client during the restart window; measure time from deploy-trigger to the client landing on the new pod. Target < 3 s.

### cloud-prod (rolling)

1. Deploy during a low-traffic window.
2. Watch pod termination times across a full region rollover. Expect all pods to exit within 5 s.
3. Over the next 24 h, check Porter incidents: exit-137 count should drop to zero (barring true hangs).
4. Spot-check user-visible reconnect latency via log correlation: time from `ws-dispose` on old pod to next `ws-upgrade` on new pod, same user. Target P90 < 5 s.

### Regression checks

- `/health` returns 503 immediately when `isShuttingDown` is set — already covered by 063; confirm still working.
- New WS upgrades return 503 during shutdown — already covered by 063; confirm still working.

---

## Rollout

1. **Branch:** `cloud/issues-100-fail-fast-sigterm`. Land the handler rewrite + `porter.yaml` change in one PR.
2. **cloud-debug soak:** one hour, one manually triggered restart.
3. **cloud-prod rolling:** us-central first, monitor 30 min, then france / east-asia / us-east / us-west.
4. **Close 063 as superseded** in a follow-up docs commit.

---

## Key Numbers

| Metric                                                       | Before (current 063 handler)                         | Target                        |
| ------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------- |
| Wall-clock SIGTERM → exit                                    | Unknown (no logs make it out); at least 2 s intended | < 2 s typical, 5 s worst case |
| `"SIGTERM received"` log visible in BetterStack              | 0 in 7 days                                          | Every restart                 |
| Pod exit code on deploy                                      | 137 (SIGKILL observed)                               | 0                             |
| Time from pod rollout trigger to client reconnect on new pod | Unknown; anecdotally > 10 s                          | < 5 s P90                     |
| `terminationGracePeriodSeconds`                              | 30                                                   | 10                            |
