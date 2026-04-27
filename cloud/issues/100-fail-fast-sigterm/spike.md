# Spike: Fail Fast on SIGTERM — Die Within Seconds, Not Minutes

## Overview

**What this doc covers:** Why our "graceful" shutdown is still producing `exit 137` (SIGKILL) in production, why we should pivot from "graceful" to "fail fast," and the evidence that suggests `cloud/issues/063-graceful-shutdown/` shipped correctly but is no longer the right design.

**Why this doc exists:** On 2026-04-15 the Porter dashboard showed a cloud-prod us-central pod restart with non-zero exit code 137. That is the kernel SIGKILL after the 30-second grace period elapsed. In the last 7 days of prod logs we can find **zero occurrences** of the `"SIGTERM received — starting graceful shutdown"` log line that issue 063 installed. Pods are restarting, Kubernetes is sending SIGTERM, and our "graceful" handler is apparently either not running to completion or not flushing its logs before the 30 s SIGKILL. Meanwhile every second we spend "gracefully" shutting down is a second every glasses WebSocket is dead but the phone doesn't know it yet. We should invert the design: send close frames first, kill the process within 5 seconds, let the client reconnect to a healthy pod immediately.

**Who should read this:** Cloud engineers, SRE, mobile engineers who debug reconnect latency.

**Depends on:**

- [063-graceful-shutdown](../063-graceful-shutdown/) — the original spec; this issue supersedes its "wait 2 seconds + cleanup everything" approach
- [079-client-liveness-reconnect-gap](../079-client-liveness-reconnect-gap/) — the client-side mirror of this problem: slow disconnect → session disposed → broken user

---

## The Problem In One Sentence

Our current SIGTERM handler tries to do too much (close WebSockets, stop timers, close Mongo, wait 2 s for frame flush) and is either exceeding the 30 s grace period or not getting its log lines out before the process exits, producing exit-code-137 restarts that look to Porter like crashes; we should instead send close frames and exit within 5 s so clients reconnect immediately to a healthy pod.

---

## Background

### What issue 063 shipped

From `cloud/packages/cloud/src/index.ts` L197–267, the current SIGTERM handler:

1. Sets the pod-global `isShuttingDown` flag so `/health` returns 503 and new WS upgrades are rejected.
2. Iterates every `UserSession`, calls `session.websocket.close(1001, "Server shutting down")` on the glasses WS and on every app WS.
3. Stops `systemVitalsLogger`, `appCache`, `metricsService`.
4. Awaits `mongoose.connection.close()`.
5. `await new Promise(resolve => setTimeout(resolve, 2000))` to let close frames flush.
6. `process.exit(0)`.

`porter.yaml` sets `terminationGracePeriodSeconds: 30`.

### What Kubernetes does on a rollout / OOM

Pod sent `SIGTERM`. Kubernetes waits up to `terminationGracePeriodSeconds` (30 s here) for the process to exit cleanly. If the process is still alive at the deadline, Kubernetes sends `SIGKILL`. The container terminates with exit code 137 (128 + SIGKILL signal number 9). Porter's dashboard flags this as "Non-zero exit code."

### Porter evidence from 2026-04-15

Porter dashboard snapshot (cloud v219, us-central, 09:03 local) showed:

> **Non-zero exit code.** The service restarted with exit code 137. This indicates that the service was killed by SIGKILL. The most common reason for this is that your service does not handle graceful shutdown when it receives a SIGTERM signal.

Logs leading up to restart: normal admin-route activity, then a hard cutoff. No `"SIGTERM received"` line.

---

## Findings

### 1. The `"SIGTERM received"` log line is missing from all prod regions for 7 days

BetterStack query across `remote(t373499_mentracloud_prod_logs)` and the cold S3 store for `message LIKE '%SIGTERM received%'` or `%Draining complete%` or `%Graceful shutdown complete%`, last 7 days:

```
0 rows
```

Pods **are** restarting in that window (Porter incidents, normal rollouts, OOM kills). Every one of those restart events should have emitted the `SIGTERM received` line. None of them did.

Possible explanations, ordered by likelihood:

1. **Pino logs aren't flushing before process exit.** Pino is async by default; a `logger.info` call returns before the log ever reaches the transport. When the process exits quickly after logging, the buffered log line never leaves the pod. This matches what we see: the handler runs, does its work, calls `process.exit(0)`, and the logs never make it to BetterStack.
2. **The handler runs past 30 s and Kubernetes SIGKILLs mid-execution.** Every `session.websocket.close()` on 60+ sessions × 3+ app WebSockets each could be slow if Bun's close impl is synchronous; `mongoose.connection.close()` can take seconds; `await setTimeout(resolve, 2000)` is exactly 2 s of wall time that's not doing anything useful. Add up log-flush time, and 30 s is tighter than it looks.
3. **Something in the handler throws and we don't catch.** The handler has `try/catch` around each section, but the broader function could fail in the merge step or during Mongo close. An unhandled rejection inside `gracefulShutdown` wouldn't be visible if logs aren't flushing.

All three are fixable. All three point the same direction: "graceful" is the wrong goal.

### 2. Nothing in the handler has to complete before the process dies

Walking the current steps:

- **Close glasses WebSockets with 1001.** This is the only user-visible operation. It must happen.
- **Close app WebSockets with 1001.** Useful; a ghost app-session on a dead pod is messy. Nice-to-have.
- **Stop timers (`systemVitalsLogger`, `appCache`, `metricsService`).** Irrelevant. The process is exiting; timers die when the process dies. Setting flags is pure ceremony.
- **Close Mongo.** Mongoose does a best-effort orderly shutdown. If the process exits without calling it, Mongo sees a TCP FIN from the OS and cleans up server-side. Skipping this is fine in practice.
- **Wait 2 s for frame flush.** Today this is the main blocker. The comment says "Without this delay, process.exit(0) can kill the runtime before Bun sends the close handshake on the wire." We need to verify this claim — it may be a Bun bug that got fixed, or we may need a much shorter wait (100–500 ms, not 2000 ms).
- **Wait for Pino to flush logs.** This is the hidden cost. `logger.info` is buffered; we need an explicit `logger.flush()` + a `pino.transport.on('finish', ...)` before exit to get the log out.

### 3. What "fail fast" should look like

User experience target: from the phone's point of view, when a pod goes down it should see the WebSocket close frame within 1–2 s of Kubernetes starting the rollout, and the next WebSocket reconnect should land on a healthy pod that has capacity.

That means the cloud's SIGTERM handler should:

1. Write a **synchronous** log line to stderr (not Pino) announcing the signal. Unflushed Pino logs are useless in a crash path.
2. Set `isShuttingDown` so the LB stops routing new traffic.
3. Close every WebSocket with code 1001. Do not await anything expensive.
4. Flush Pino (with a timeout, ~500 ms, so a stuck transport can't block us).
5. Exit with code 0 within **5 seconds of receiving SIGTERM**, period.

Everything else — Mongo close, timer stopping, telemetry flushing — either doesn't matter or should be best-effort inside the 5 s window.

### 4. Why 5 s and not faster

- WebSocket close frames need a moment on the wire. Bun buffers writes; the kernel needs to deliver the final TCP packet. ~500 ms is plenty in practice.
- Pino's flush needs a moment to drain whatever's buffered. Timeout at 500 ms.
- Some closes may straggle (slow clients, TCP retransmit). A 2–3 s ceiling on WebSocket close work.
- 5 s total gives headroom. It's 6× faster than the current 30 s ceiling.

### 5. Kubernetes `terminationGracePeriodSeconds` should drop too

If we promise to exit in 5 s, we should tell Kubernetes to SIGKILL at 10 s instead of 30 s. That way a bug in our handler can't prolong the outage window. The current 30 s is a footgun: if the handler hangs, all clients wait 30 s for the SIGKILL to sever the TCP connection.

Recommended: `terminationGracePeriodSeconds: 10`. Porter default is 30; lowering it is a deliberate signal that we commit to fast shutdowns.

### 6. What NOT to do

- **Do not try to dispose sessions properly.** `session.dispose()` does DB writes, PostHog events, Soniox stream cleanup, transcript persistence. Every one of those is a 10–500 ms async operation. Summed across 60 sessions, that's seconds we cannot afford. The close frame is all the phone needs. Session state rebuilds on reconnect.
- **Do not try to drain in-flight HTTP requests.** The LB already stopped sending new ones at `isShuttingDown`. Existing requests either complete in milliseconds or die with the process; either way the client retries against a new pod.
- **Do not try to finalize Prometheus metrics or BetterStack logs.** Pino flush is best-effort; everything else is nice-to-have.
- **Do not `await` Mongo close.** If we want to trigger it, do it fire-and-forget alongside the exit path. Most of the time we'll die before Mongo's close handshake completes, and that's fine.

### 7. What this is not

Not a replacement for 079. Issue 079 is about **the client failing to detect a dead cloud pod** and staying "connected" to it for minutes. This issue is about **the cloud announcing its death quickly** so the client sees the close frame. Both matter; both are different halves of the same reconnect-latency problem. Fixing this without 079 still helps, because a 1001 close is detectable even by a slow client — the TCP FIN is harder to miss than a silent idle socket.

---

## Conclusions

| Finding                                                                                                 | Confidence                                                                         |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Pods are restarting in prod with exit code 137 (SIGKILL after 30 s)                                     | **Confirmed** (Porter 2026-04-15)                                                  |
| The `"SIGTERM received"` log line appears zero times in 7 days of prod logs, despite restarts happening | **Confirmed** (BetterStack)                                                        |
| Pino async buffering is the most likely reason the log line is missing                                  | **High** — matches the symptom exactly                                             |
| The current "graceful" handler does too much work for a 30 s budget                                     | **High** — sum of close + Mongo + 2 s wait + Pino flush is tight                   |
| We should pivot from "graceful" to "fail fast": close frames, flush Pino, exit within 5 s               | **High**                                                                           |
| Kubernetes `terminationGracePeriodSeconds` should drop from 30 to 10                                    | **High** — if we commit to 5 s, SIGKILL at 10 s is appropriate belt-and-suspenders |

---

## Next Steps

1. `spec.md` — define the exact behavior: which steps run, in what order, with what timeouts; new log format; `terminationGracePeriodSeconds` change.
2. `design.md` — file-by-file diff, how to flush Pino synchronously, how to write to stderr before exit, testing plan.
3. Deploy to cloud-debug, trigger a restart, verify: `"SIGTERM received"` log visible in BetterStack; exit code 0 (not 137); wall-clock < 5 s from signal to exit.
4. Deploy to cloud-prod rolling. Monitor Porter for exit-137 count and user reconnect latency.
5. Close issue 063 as superseded.
