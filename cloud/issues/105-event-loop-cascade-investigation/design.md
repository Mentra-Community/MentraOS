# Design: Phase-1.5 Cascade Diagnostic Instrumentation

**Status:** Implemented on `cloud/issue-106` — cloud-debug smoke passed; soak ongoing
**Date:** 2026-05-05
**Related:** [spike.md](./spike.md), [spec.md](./spec.md), [106 spike](../106-app-ws-storm-multi-app/spike.md)

---

## Plain-English Mental Model

Observability means "make production explain itself."

For this incident, use this vocabulary:

| Word | Simple definition | What we need here |
|---|---|---|
| Log | A timestamped event saying what happened | `slow-app-connect`, `ws-close`, `process-shutdown-started` |
| Metric | A number tracked over time | event-loop max delay, app WS close count, active sessions |
| Trace/phase timing | A breakdown of one operation | reconnect total time split across auth, session lookup, app refresh, broadcast |
| Profile | CPU samples showing which code burned processor time | useful locally/debug, not the main production signal |

Better Stack is the evidence warehouse: it collects logs/metrics, lets us query them, builds dashboards, and sends alerts. It is not a replacement for application-level breadcrumbs. It can tell us a pod restarted or HTTP latency rose, but our code must tell it whether the slow path was `CONNECTION_INIT`, `RECONNECT`, `subscription_update`, `refreshInstalledApps`, or app WS close cleanup.

The design goal is therefore:

```text
Emit cheap, structured Mentra-specific facts.
Let Better Stack store, graph, alert, and correlate them.
Use the next cascade to choose one fix PR instead of guessing.
```

---

## Overview

This design describes how to add production-safe diagnostics for the app-message / reconnect cascade without changing runtime behavior.

The goal is not to fix the cascade in this PR. The goal is to make the next staging or debug event produce enough evidence to choose the correct fix.

The current evidence points at two mechanisms that existing telemetry conflates:

1. **Async wall-time amplification:** app-message timers can grow to tens of seconds because they wrap awaited work. The event loop can remain responsive while `op_appMessage_ms` grows.
2. **Synchronous storm amplification:** small sync segments in app init/reconnect/subscription paths can multiply across many simultaneous app sessions and miss `/livez`.

The design instruments the boundary between those two mechanisms.

---

## Decision

Ship a Phase-1.5 observability PR before any optimization PR.

Ship the diagnostic surfaces together in one PR, not as three staged observability PRs. The cascade is intermittent; capturing the next event with only protocol timers but without connect/subscription/WS lifecycle context could leave us with another ambiguous incident and another wait cycle. The safer review strategy is to keep one PR but organize it into clear file-level sections matching S1-S8 in [spec.md](./spec.md), with cloud-debug soak as the blast-radius control.

Do not keep broad-spiking before instrumentation. The spike has already narrowed the unknowns to paths and phases that can be measured safely:

- app WS protocol: `CONNECTION_INIT`, `RECONNECT`, regular app messages;
- app connect phases: `attachAppSocket`, `broadcastAppState`, `refreshInstalledApps`, app/user DB lookups;
- subscription fanout phases: transcription, translation, stream ensure, microphone state;
- event-loop delay and liveness lifecycle;
- app WS close/backpressure facts.

Keep this PR behavior-neutral:

- no liveness/readiness changes;
- no DB query changes;
- no reconnect semantics changes;
- no coalescing/debouncing yet;
- no profiler enabled by default.

Coordination note: if the original Phase 1 observability PR (#2626) lands on `main` before Phase 1.5 is implemented, rebase Phase 1.5 onto the branch that contains it. If staging promotes with Phase 1.5 first, treat Phase 1.5 as superseding the older Phase 1-only observability branch and avoid carrying divergent instrumentation forward.

---

## Architecture

The diagnostics should be built from three small primitives:

### 1. Windowed Operation Timers

Use the existing `operationTimers` pattern so every `system-vitals` line gets bounded numeric totals for the prior 30s window.

Examples:

```text
op_appProtocol_connectionInit_ms
op_appConnect_refreshInstalledApps_ms
op_subscription_syncManagers_ms
op_appMsg_displayRequest_ms
```

These answer: "Where did wall-clock time accumulate in this 30s window?"

Implementation detail: these diagnostic `op_*` fields are intentionally excluded from `opTotalMs`. `opTotalMs` remains the older coarse budget signal, while Phase 1.5 fields provide nested explanation without double-counting.

### 2. Windowed Counters

Add lightweight count accumulators for the same windows.

Examples:

```text
appProtocol_connectionInit_count
appConnect_broadcastAppState_count
subscription_update_count
wsSend_backpressure_count
```

These answer: "Was this slow because one call was huge, or because many small calls stacked up?"

### 3. Slow Outlier Logs

Emit structured warnings only above thresholds. These logs include phase breakdowns for one slow operation.

Examples:

```text
slow-app-protocol
slow-app-connect
slow-subscription-update
ws-close
```

These answer: "Which package/user-hash/path was slow, and what phase inside it was responsible?"

---

## Data Flow

At runtime, every app WS event should pass through increasingly specific instrumentation:

```text
app-ws message
  -> bun-websocket protocol timer
      -> connection_init timer OR reconnect timer OR regular message timer
          -> AppManager phase timers, if init/reconnect
          -> AppMessageHandler per-type timers, if regular message
              -> SubscriptionManager phase timers, if subscription_update
  -> operationTimers snapshot in system-vitals
  -> slow-* log only if threshold exceeded
```

Separately:

```text
app-ws close/send/drain
  -> per-socket metadata in ws.data
  -> ws-close structured log on close
  -> ws send/backpressure/drain counters in system-vitals
```

And:

```text
process lifecycle
  -> startup / sigterm / shutdown breadcrumbs
  -> external porter kubectl describe pod check after restart
```

---

## Diagnostic Surfaces

### App Protocol Surface

Instrument `bun-websocket.ts` before dispatching into session handlers.

Required fields:

- `op_appProtocol_connectionInit_ms`
- `op_appProtocol_reconnect_ms`
- `op_appProtocol_regularMessage_ms`
- `op_appProtocol_parse_ms`
- `op_appProtocol_sessionLookup_ms`
- matching counts for each path

This is necessary because `CONNECTION_INIT` and `RECONNECT` do not behave like normal app messages.

### App Connect Surface

Instrument `AppManager.ts` and `app.service.ts`.

Required fields:

- `op_appConnect_handleAppInit_ms`
- `op_appConnect_handleReconnect_ms`
- `op_appConnect_attachAppSocket_ms`
- `op_appConnect_findOrCreateUser_ms`
- `op_appConnect_broadcastAppState_ms`
- `op_appConnect_refreshInstalledApps_ms`
- `op_appService_getAllApps_ms`
- `op_appService_getAllApps_userFindOne_ms`
- `op_appService_getAllApps_appFind_ms`

This directly tests the local-harness hypothesis that legacy init plus app-state refresh can create large wall-time and/or sync amplification.

### Normal App Message Surface

Instrument `app-message-handler.ts`.

Required fields:

- `op_appMsg_subscriptionUpdate_ms`
- `op_appMsg_displayRequest_ms`
- `op_appMsg_*_ms` for the remaining switch cases
- matching counts

This preserves the original 105 question: if regular messages dominate, which message type?

### Subscription Fanout Surface

Instrument `SubscriptionManager.ts` and the narrow downstream hooks that are easy to time.

Required fields:

- `op_subscription_updateSubscriptions_ms`
- `op_subscription_processUpdate_ms`
- `op_subscription_permissionCheck_ms`
- `op_subscription_syncManagers_ms`
- `op_subscription_transcriptionUpdate_ms`
- `op_subscription_translationUpdate_ms`
- `op_subscription_ensureStreamsExist_ms`
- `op_subscription_microphoneHandleChange_ms`

This tests whether multi-app subscription updates during a storm are the actual sync/async amplifier.

### Event Loop Surface

Keep the existing rolling lag samples and add Bun histogram delay.

Local spike result on Bun `1.3.13`:

- `perf_hooks.monitorEventLoopDelay` works.
- `histogram.reset()` works.
- `eventLoopDelayHistMaxMs` catches isolated 80ms and 250ms blocks.
- `p99` can miss isolated blocks depending on sample count.
- `performance.eventLoopUtilization()` exists but returned all zeros locally, so do not use ELU.

Required vitals fields:

- `eventLoopLagCurrentMs`
- `eventLoopLagAvgMs`
- `eventLoopLagP95Ms`
- `eventLoopLagP99Ms`
- `eventLoopLagMaxMs`
- `eventLoopDelayHistP95Ms`
- `eventLoopDelayHistP99Ms`
- `eventLoopDelayHistMaxMs`
- `eventLoopDelayHistMeanMs`

Reset the histogram each vitals window. Treat `max` as the key field for isolated stalls.

### WS Lifecycle Surface

Track facts in `ws.data` and log on close.

Current feasibility caveat: app sockets currently respond to SDK app-level `ping` messages, and `AppSession` sends protocol `ping()` heartbeats, but Bun app `pong` handling is not currently wired into app-session state. The first implementation should record what is directly observable (`lastMessageAt`, `lastSendAt`, ping send time, send return values, drain counts, close code). Add app `pong` timestamping only if it can be wired through `websocketHandlers.pong()` cleanly. If not, leave `lastPongReceivedAgoMs` null and keep `inferredCloseSource` conservative.

Required `ws-close` fields:

- `wsKind`
- `packageName`
- `userIdHash`
- `code`
- `connectionAgeMs`
- `lastMessageAgoMs`
- `lastSendAgoMs`
- `lastPingSentAgoMs`
- `lastPongReceivedAgoMs`
- `sendBackpressureCount`
- `drainCount`
- `bytesIn`
- `bytesOut`
- `messagesIn`
- `messagesOut`
- `inferredCloseSource`

Do not claim TCP-level details Bun does not expose. Use `inferredCloseSource`, not `closeSource`.

### Process Lifecycle Surface

Keep the existing fail-fast SIGTERM handler. Add or normalize small lifecycle breadcrumbs if needed:

- startup;
- SIGTERM received;
- shutdown complete;
- shutdown watchdog.

Exit 137 analysis must include an external Kube check:

```bash
porter kubectl --cluster 4689 -- describe pod <pod> -n default
```

In-process logs cannot prove a final stall if the process is pinned until SIGKILL.

### External Status Correlation

Issue 106 still tracks W3: Cloudflare/Azure/Porter status correlation around known cascade timestamps. This is useful context but should not block the instrumentation PR, because public status pages are too coarse to distinguish pod-side missed pings from a local loop stall. Record any public incident matches in the spike, then rely on S7 to gather pod-local evidence during the next event.

---

## Privacy And Safety

These diagnostics run in production-like environments, so they must be privacy-safe by construction.

Rules:

- Use `userIdHash`, never raw `userId` or email.
- Do not log transcript text.
- Do not log app message payloads.
- Do not log API keys, JWTs, authorization headers, or query strings.
- Do not log raw WebSocket close reasons; log `reasonLength` only if useful.
- Log package names because package name is already operational metadata and is needed for debugging.
- Keep all vitals fields numeric.

Slow logs should include only:

- feature name;
- package name;
- user hash;
- message/protocol type;
- duration;
- phase timings;
- bounded counts.

---

## Overhead Model

Expected overhead is low because the common path uses counters and `performance.now()` brackets only.

Costs:

- one or two `performance.now()` calls around instrumented phases;
- numeric accumulator updates;
- slow log object allocation only when threshold is exceeded;
- one event-loop histogram running with `resolution: 10`;
- per-socket metadata counters in `ws.data`.

Controls:

- slow thresholds start at 100ms for app protocol/connect/subscription logs;
- no per-message payload logging;
- no stack traces for slow paths;
- no continuous CPU/heap profiler outside debug;
- add throttling if `slow-*` volume becomes noisy during cloud-debug soak.

The debug soak must verify:

- no meaningful RSS/heap increase;
- no BetterStack volume spike;
- no change in steady-state event-loop lag;
- no warnings during idle traffic.

---

## Rollout

1. Branch from `staging`.
2. Implement S1-S8 from [spec.md](./spec.md).
3. Run local typecheck and targeted tests.
4. Run the local harness smoke against the instrumentation.
5. Deploy to `cloud-debug` only.
6. Soak for at least 30 minutes under normal traffic.
7. Verify BetterStack field shape and log volume.
8. PR to `staging`.
9. Wait for one staging cascade or high-load window.
10. Write a new numbered Phase 2 fix issue/spec from captured evidence.

Do not deploy directly to staging from the local branch. Do not push to staging.

---

## Acceptance Criteria

The next event should let us answer these seven questions:

1. Did `CONNECTION_INIT`, `RECONNECT`, or regular app messages dominate?
2. If regular app messages dominated, which message type dominated?
3. If init/reconnect dominated, which phase dominated?
4. If subscription dominated, which downstream manager phase dominated?
5. Was the event loop actually pinned, or was the time async wall-time?
6. Did app WSs show evidence of missed heartbeat or backpressure before close?
7. Did the process run the SIGTERM handler, or did Kube SIGKILL before JS could respond?

If those questions are answerable, the instrumentation succeeded even if the root cause is not fixed yet.

---

## Alternatives Considered

### Keep Spiking Without Code

Rejected. Existing logs have reached their limit. More aggregate queries can refine timelines but cannot split async wait from sync blockage or identify uninstrumented phases.

### Enable Bun CPU Profiling In Staging/Prod

Rejected as the default path. Bun profiling is useful, but it has higher operational complexity and artifact-retention problems. Keep it debug-only or one-off.

### Only Add Per-Message-Type Timers

Rejected. This was the original spec, but the local harness showed suspicious work in `CONNECTION_INIT`, `RECONNECT`, `broadcastAppState`, and subscription fanout. Those paths would be missed.

### Fix The Suspected Hot Paths Immediately

Rejected. We have plausible fixes, but choosing now risks optimizing the wrong path. Instrumentation should decide between app-state refresh coalescing, DB work reduction, subscription sync coalescing, WS heartbeat/backpressure work, or liveness tuning.

### Use `performance.eventLoopUtilization`

Rejected for now. Local Bun `1.3.13` returned zeros under idle and busy conditions. Revisit only after Bun behavior changes or is proven in the deployed runtime.

---

## Risks

| Risk | Mitigation |
|---|---|
| Log volume increases | Prefer vitals counters; slow logs only above threshold; add throttling if needed. |
| Hot-path overhead | Use only `performance.now()` and numeric accumulators in common paths. |
| Privacy leakage | Hash user IDs; do not log payloads, transcripts, tokens, or raw reasons. |
| Misreading async wall-time as CPU | Pair phase timings with event-loop histogram max and vitals gaps. |
| Missing final fatal stall | Use Kube pod state plus lifecycle breadcrumbs; in-process telemetry may die with the process. |
| Bun API mismatch in deployment | Feature-detect histogram support and log unsupported state explicitly. |

---

## Phase 2 Decision Tree

After one event with Phase 1.5:

| Evidence | Likely fix |
|---|---|
| `op_appConnect_refreshInstalledApps_ms` dominates | Debounce/coalesce `broadcastAppState` and installed-app refresh during reconnect storms. |
| `op_appConnect_findOrCreateUser_ms` or `appService` DB phases dominate async time | Cache or avoid DB-backed work on reconnect/init path. |
| `op_subscription_syncManagers_ms` dominates | Coalesce subscription downstream sync per user/package. |
| Event-loop max spikes while instrumented await time is low | Optimize or yield around sync CPU work. |
| WS backpressure/drain spikes precede 1006 storm | Investigate Bun WS send/backpressure and heartbeat behavior. |
| No SIGTERM breadcrumbs before 137 | Treat exit 137 as hard loop pin until Kube SIGKILL; do not blame missing graceful shutdown. |

Do not select a Phase 2 fix before this evidence exists.
