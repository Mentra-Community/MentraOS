# Spec: Phase-1.5 Cascade Diagnostic Instrumentation

**Status:** Implemented on `cloud/issue-106` — cloud-debug smoke passed; soak ongoing
**Target branch:** staging-first; soak on cloud-debug before staging
**Scope:** Observability only. No behavior changes, no cascade fix in this PR.
**Design:** [design.md](./design.md) explains the production-safety rationale and rollout model.

---

## Plain-English Goal

This PR is a flight recorder, not a fix.

Today we know that `op_appMessage_ms` gets huge during cascade windows, but that number is too broad. It only says "app-message handling took wall-clock time." It does not tell us whether:

- the event loop was blocked by synchronous JavaScript work;
- the handler was waiting on MongoDB, app lookup, app server behavior, or another async resource;
- dozens of reconnects/subscription updates each did a small amount of sync work that stacked up;
- WebSocket close/backpressure behavior started the pile-up;
- Kubernetes killed the pod before the process could run its shutdown handler.

The instrumentation below adds the missing labels and phase timings. After the next event, the team should be able to answer:

```text
What path was slow?
Which internal phase was slow?
Was the event loop pinned or merely waiting on async work?
Did the WS storm happen before, during, or after the slow path?
Did the process receive and handle shutdown cleanly?
```

Better Stack will store, search, graph, and alert on these records. The application still has to emit the Mentra-specific facts because no vendor can infer `CONNECTION_INIT`, `RECONNECT`, `subscription_update`, or `broadcastAppState` from generic container metrics.

---

## Are We Done Spiking?

We are done enough to instrument. We are **not** done enough to fix.

The spike has narrowed the problem to a concrete proof gap:

1. `op_appMessage_ms` dominates every known cascade window.
2. `op_appMessage_ms` is wall-clock around awaits, so it conflates async wait with sync CPU.
3. The staging 2026-05-04 event had a real multi-app WS storm plus an event-loop silence window.
4. The earlier prod windows did not show the same staging-scale WS storm, so the storm is not a proven universal trigger.
5. Local harnesses show both mechanisms are plausible:
   - async DB/resource wait can create 69-92s aggregate app-message wall-time without pinning the loop;
   - small sync work in reconnect/init/subscription paths can multiply across dozens of sessions and miss `/livez`.

More unaided log spelunking will mostly recycle the same ambiguity. The next useful work is a tightly scoped instrumentation PR that lets the next event answer:

- Which app protocol/message path is slow?
- Which internal phase is slow?
- Is the time async wait, sync loop blockage, WS backpressure, or process/liveness behavior?
- Did the app WS storm come from pod-side missed pings or peer/network-side closure?

---

## Instrumentation Shape

This PR should add **eight diagnostic surfaces**:

1. Top-level app WS protocol timers: `CONNECTION_INIT`, `RECONNECT`, normal app messages.
2. Per-message-type timers inside `handleAppMessage`.
3. Reconnect/init phase timers around `attachAppSocket`, `broadcastAppState`, and DB-backed app refresh.
4. Subscription fanout phase timers around `SubscriptionManager.syncManagers`.
5. Slow outlier warnings with phase breakdowns.
6. Continuous event-loop delay fields in every `system-vitals`.
7. WS close, ping, send-return, and drain/backpressure telemetry.
8. Process/liveness lifecycle breadcrumbs for exit-137 interpretation.

This is more than the original four-item spec because the local harness changed the suspect set. In particular, instrumentation that only times message types would miss legacy `CONNECTION_INIT`, v3 `RECONNECT`, and the `broadcastAppState -> refreshInstalledApps -> appService.getAllApps` path.

Implementation note: the detailed diagnostic timers are emitted as `op_*` fields for Better Stack query consistency, but they are excluded from `opTotalMs` so the existing coarse operation budget does not double-count nested phase timings.

---

## S1. Top-Level App WS Protocol Timers

**File:** `cloud/packages/cloud/src/services/websocket/bun-websocket.ts`

**Why:** `CONNECTION_INIT` and `RECONNECT` are handled in `bun-websocket.ts` before normal app messages reach `UserSession.handleAppMessage`. The existing per-message handler spec would miss the exact path the local harness made suspicious.

Add operation timers:

```text
op_appProtocol_connectionInit_ms
op_appProtocol_reconnect_ms
op_appProtocol_regularMessage_ms
op_appProtocol_ping_ms
op_appProtocol_parse_ms
op_appProtocol_sessionLookup_ms
```

Also emit counters in vitals:

```text
appProtocol_connectionInit_count
appProtocol_reconnect_count
appProtocol_regularMessage_count
appProtocol_ping_count
appProtocol_parseError_count
appProtocol_sessionMissing_count
```

For slow protocol-level calls, log:

```json
{
  "feature": "slow-app-protocol",
  "protocolType": "connection_init",
  "packageName": "com.mentra.captions.debug",
  "userIdHash": 1514391467,
  "durationMs": 412.3,
  "phaseTimings": {
    "parse": 0.2,
    "validateApiKey": 102.1,
    "handleAppInit": 309.4
  }
}
```

Thresholds:

- `SLOW_APP_PROTOCOL_MS = 100`
- Always include package and hashed user, never raw user ID.

---

## S2. Per-Message-Type Timers

**File:** `cloud/packages/cloud/src/services/session/handlers/app-message-handler.ts`

Keep the existing outer `op_appMessage_ms` timer as a backstop, but add per-type timers for normal app messages:

```text
op_appMsg_subscriptionUpdate_ms
op_appMsg_displayRequest_ms
op_appMsg_dashboardContentUpdate_ms
op_appMsg_dashboardModeChange_ms
op_appMsg_dashboardSystemUpdate_ms
op_appMsg_rgbLedControl_ms
op_appMsg_cameraFovSet_ms
op_appMsg_streamRequest_ms
op_appMsg_streamStop_ms
op_appMsg_streamStatusCheck_ms
op_appMsg_locationPollRequest_ms
op_appMsg_photoRequest_ms
op_appMsg_audioPlayRequest_ms
op_appMsg_audioStopRequest_ms
op_appMsg_audioStreamStart_ms
op_appMsg_audioStreamEnd_ms
op_appMsg_managedStreamRequest_ms
op_appMsg_managedStreamStop_ms
op_appMsg_requestWifiSetup_ms
op_appMsg_ownershipRelease_ms
op_appMsg_unknown_ms
```

Also emit per-type counts:

```text
appMsg_subscriptionUpdate_count
appMsg_displayRequest_count
...
```

Counts matter because a window can be slow because one message took 2s, or because 600 messages each took 3ms.

---

## S3. App Init/Reconnect Phase Timers

**Files:**

- `cloud/packages/cloud/src/services/session/AppManager.ts`
- `cloud/packages/cloud/src/services/core/app.service.ts`

**Why:** The local Mentra-path harness points at legacy `CONNECTION_INIT` and reconnect/init fanout. v3 `RECONNECT` is relatively light; legacy init calls `attachAppSocket`, then `broadcastAppState`, then `refreshInstalledApps`, which can do DB-backed app/user lookups.

Add operation timers:

```text
op_appConnect_handleAppInit_ms
op_appConnect_handleReconnect_ms
op_appConnect_shouldDeferReconnect_ms
op_appConnect_attachAppSocket_ms
op_appConnect_findOrCreateUser_ms
op_appConnect_addRunningApp_ms
op_appConnect_sendAck_ms
op_appConnect_sendFullStateSnapshot_ms
op_appConnect_broadcastAppState_ms
op_appConnect_refreshInstalledApps_ms
op_appConnect_snapshotForClient_ms
op_appService_getAllApps_ms
op_appService_getAllApps_userFindOne_ms
op_appService_getAllApps_appFind_ms
```

Add counters:

```text
appConnect_handleAppInit_count
appConnect_handleReconnect_count
appConnect_broadcastAppState_count
appConnect_refreshInstalledApps_count
```

Slow log:

```json
{
  "feature": "slow-app-connect",
  "mode": "connection_init",
  "packageName": "com.mentra.captions.debug",
  "sdkVersion": "none",
  "userIdHash": 1514391467,
  "durationMs": 418.7,
  "phaseTimings": {
    "attachAppSocket": 103.2,
    "broadcastAppState": 309.1,
    "refreshInstalledApps": 205.0,
    "snapshotForClient": 3.1
  }
}
```

Thresholds:

- `SLOW_APP_CONNECT_MS = 100`
- `SLOW_APP_CONNECT_PHASE_MS = 50`

`SLOW_APP_CONNECT_PHASE_MS` should not create separate per-phase warning logs on the hot path. It should only annotate the parent `slow-app-connect` payload, for example with `slowPhases: ["refreshInstalledApps"]`, after the total connect/reconnect path has already crossed `SLOW_APP_CONNECT_MS`.

This directly answers whether the 17:03 post-restart `op_appMessage_ms = 41s` shape is DB/app refresh wall-time, state snapshot work, or something else.

---

## S4. Subscription Fanout Timers

**Files:**

- `cloud/packages/cloud/src/services/session/handlers/app-message-handler.ts`
- `cloud/packages/cloud/src/services/session/SubscriptionManager.ts`
- `cloud/packages/cloud/src/services/session/MicrophoneManager.ts` if a narrow hook is easy

**Why:** The staging storm produced many subscription updates across packages, and the harness showed that small sync work downstream can amplify across sessions.

Add operation timers:

```text
op_subscription_updateSubscriptions_ms
op_subscription_processUpdate_ms
op_subscription_permissionCheck_ms
op_subscription_permissionDbFallback_ms
op_subscription_appSessionUpdate_ms
op_subscription_syncManagers_ms
op_subscription_transcriptionUpdate_ms
op_subscription_translationUpdate_ms
op_subscription_ensureStreamsExist_ms
op_subscription_locationUpdate_ms
op_subscription_calendarUpdate_ms
op_subscription_microphoneHandleChange_ms
```

Add counters:

```text
subscription_update_count
subscription_languageChanged_count
subscription_debounceScheduled_count
subscription_debounceApplied_count
subscription_permissionDbFallback_count
```

Slow log:

```json
{
  "feature": "slow-subscription-update",
  "packageName": "com.mentra.ai",
  "userIdHash": 1514391467,
  "durationMs": 281.4,
  "subscriptionCount": 3,
  "languageChanged": true,
  "phaseTimings": {
    "permissionCheck": 0.8,
    "appSessionUpdate": 0.3,
    "syncManagers": 279.1,
    "transcriptionUpdate": 140.0,
    "ensureStreamsExist": 138.7
  }
}
```

Thresholds:

- `SLOW_SUBSCRIPTION_UPDATE_MS = 100`
- `SLOW_SUBSCRIPTION_PHASE_MS = 50`

---

## S5. Phase Breakdown Instead of Magical "SyncTimer"

**Files:** same call sites as S1-S4

The previous draft proposed a generic `SyncTimer`. That is directionally useful but too hand-wavy. Use explicit phase timing instead.

For each slow log, include:

```json
{
  "durationMs": 418.7,
  "instrumentedAwaitMs": 412.0,
  "unattributedSyncMs": 6.7,
  "phaseTimings": {
    "userFindOne": 101.2,
    "appFind": 103.5,
    "snapshotForClient": 3.1
  }
}
```

Definitions:

- `durationMs`: wall-clock duration of the whole operation.
- `instrumentedAwaitMs`: sum of known awaited phase wall-times.
- `unattributedSyncMs`: `durationMs - instrumentedAwaitMs`, clamped at 0.
- `phaseTimings`: named awaited or sync phases we care about.

This does not magically prove CPU time by itself; it tells us which awaited phase consumed wall-time. Combine with S6 event-loop delay. If `durationMs` is huge, `instrumentedAwaitMs` is low, and event-loop delay is high, suspect sync CPU. If `instrumentedAwaitMs` is huge and event-loop delay stays low, suspect async resource wait.

---

## S6. Continuous Event-Loop Delay in Vitals

**Files:**

- `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`
- `cloud/packages/cloud/src/services/metrics/MetricsService.ts`

**Local Bun spike result (2026-05-05):**

- Bun `1.3.13` exposes `perf_hooks.monitorEventLoopDelay`.
- A controlled 250ms busy loop was detected as `maxMs ~= 241ms` and `p99Ms ~= 241ms` with `resolution: 10`.
- A controlled 80ms busy loop was detected in `maxMs` across resolutions.
- `p99Ms` can miss a single isolated block when there are many samples, especially at `resolution: 1`; `maxMs` is required.
- Bun `performance.eventLoopUtilization()` exists but returned all zeros in the local spike. Do **not** use ELU for this instrumentation yet.

Add fields to every `system-vitals` log:

```json
{
  "eventLoopLagCurrentMs": 0.4,
  "eventLoopLagAvgMs": 0.6,
  "eventLoopLagP95Ms": 1.0,
  "eventLoopLagP99Ms": 1.2,
  "eventLoopLagMaxMs": 4.9,
  "eventLoopSampleCount": 300,
  "eventLoopDelayHistP95Ms": 1.0,
  "eventLoopDelayHistP99Ms": 1.2,
  "eventLoopDelayHistMaxMs": 4.9,
  "eventLoopDelayHistMeanMs": 0.6
}
```

Implementation:

1. Start with the existing rolling-window lag samples.
2. Add `perf_hooks.monitorEventLoopDelay({ resolution: 10 })` if supported.
3. Reset the histogram after each `system-vitals` emission so each vitals line represents the prior 30s window.
4. Treat histogram `maxMs` as the most important field for isolated stalls. Use p95/p99 for sustained jitter.
5. If Bun does not support it or behaves unexpectedly, log one startup line:

```json
{ "feature": "event-loop-delay-histogram-unsupported", "runtime": "bun" }
```

Do not let unsupported histogram instrumentation silently produce zeros.
Do not emit or rely on `eventLoopUtilization` until Bun returns nonzero local results.

Important limitation: in a hard stall that ends in SIGKILL, in-process event-loop instrumentation may never emit the final gap. This is still valuable for buildup-phase analysis and for nonfatal prod cascades.

---

## S7. App WS Close, Heartbeat, Backpressure, and Drain Telemetry

**File:** `cloud/packages/cloud/src/services/websocket/bun-websocket.ts`

**Why:** 106 needs to distinguish network/peer closure from pod-side missed pings or WS backpressure. Bun may not expose raw TCP reset vs close-frame details, so record the facts we control and infer cautiously.

On app WS open, track in `ws.data`:

```text
openedAt
lastMessageAt
lastSendAt
lastPingSentAt
lastPongReceivedAt
lastSendResult
sendBackpressureCount
drainCount
bytesIn
bytesOut
messagesIn
messagesOut
```

On every app WS close, log:

```json
{
  "feature": "ws-close",
  "wsKind": "app",
  "packageName": "com.mentra.captions.debug",
  "userIdHash": 1514391467,
  "code": 1006,
  "reasonLength": 0,
  "connectionAgeMs": 123456,
  "lastMessageAgoMs": 4858,
  "lastSendAgoMs": 1200,
  "lastPingSentAgoMs": 30000,
  "lastPongReceivedAgoMs": 61000,
  "sendBackpressureCount": 2,
  "drainCount": 2,
  "bytesIn": 12345,
  "bytesOut": 67890,
  "messagesIn": 42,
  "messagesOut": 41,
  "inferredCloseSource": "unknown_no_close_frame"
}
```

`inferredCloseSource` values:

```text
peer_clean_close
our_shutdown
our_error_close
our_ping_timeout
unknown_no_close_frame
unknown
```

Do not claim TCP RST unless Bun exposes it directly.

On `send()` calls to app/glasses sockets, record Bun's return value category:

```text
wsSend_success_count
wsSend_queued_count
wsSend_backpressure_count
wsSend_failed_count
```

Bun `ServerWebSocket.send()` can signal backpressure via negative return values, and `drain` tells us when pressure clears. During the next storm, this will tell us whether the pod was falling behind on outbound WS writes.

---

## S8. Process and Kube Lifecycle Breadcrumbs

**Files:**

- `cloud/packages/cloud/src/index.ts`
- `cloud/tools/bstack/runbooks/pod-crash.md` or a short query note in this issue

Current code already has a SIGTERM handler with synchronous stderr logs. Keep it. Add only small breadcrumbs if missing:

```json
{ "feature": "process-lifecycle", "event": "startup", "pid": 123, "imageTag": "..." }
{ "feature": "process-lifecycle", "event": "sigterm-received", "pid": 123 }
{ "feature": "process-lifecycle", "event": "shutdown-complete", "elapsedMs": 412 }
```

If the next exit 137 has no `sigterm-received`, the interpretation is: Kube likely sent SIGTERM, but JS could not run the handler before SIGKILL.

Also document the required external check:

```bash
porter kubectl --cluster 4689 -- describe pod <pod> -n default
```

Capture:

- last state reason and exit code;
- liveness timeout/period/failureThreshold;
- old finished time and new started time;
- restart count;
- events, if present.

In-process code cannot prove a gap while it is pinned and then killed. Kube state is part of the evidence.

---

## S9. Optional Debug-Only Bun Profiling Hooks

**Scope:** debug only; do not enable on staging/prod by default.

Bun supports CPU/heap profile flags such as:

```bash
bun --cpu-prof --cpu-prof-dir=/tmp/bun-profiles ...
bun --heap-prof --heap-prof-dir=/tmp/bun-profiles ...
```

For cloud-debug only, create an operator note for running a profiling build or one-off debug command with:

- CPU profiles written to `/tmp/bun-profiles`;
- a way to copy profiles before pod deletion/restart;
- no profiler enabled on staging/prod unless we explicitly decide the overhead and data retention are acceptable.

This is not the primary proof mechanism. The structured logs above are more likely to survive and explain the next event.

---

## Non-Goals

- Do not fix or optimize any hot path in this PR.
- Do not change liveness/readiness settings in this PR.
- Do not add new DB calls or app-server calls.
- Do not log raw user IDs, transcript text, API keys, JWTs, raw close reasons, or request payloads.
- Do not enable Bun CPU/heap profiling outside debug by default.
- Do not replace the existing `op_appMessage_ms`; keep it as a backstop.

---

## Acceptance Queries

After deploy to cloud-debug/staging, the next event should answer these with one BetterStack query set:

1. Which protocol path dominated?
   - `op_appProtocol_connectionInit_ms`
   - `op_appProtocol_reconnect_ms`
   - `op_appProtocol_regularMessage_ms`
2. If normal messages dominated, which message type?
   - `op_appMsg_subscriptionUpdate_ms`
   - `op_appMsg_displayRequest_ms`
   - etc.
3. If init/reconnect dominated, which phase?
   - `op_appConnect_refreshInstalledApps_ms`
   - `op_appConnect_broadcastAppState_ms`
   - `op_appConnect_findOrCreateUser_ms`
   - `op_appService_getAllApps_*`
4. If subscription dominated, which phase?
   - `op_subscription_syncManagers_ms`
   - `op_subscription_transcriptionUpdate_ms`
   - `op_subscription_ensureStreamsExist_ms`
5. Was the event loop pinned?
   - `eventLoopLagP99Ms`, `eventLoopLagMaxMs`, `event-loop-gap`, `heartbeat-gap`, vitals gaps.
6. Did app WSs close because we missed heartbeats/backpressure?
   - `ws-close` last ping/pong ages, `inferredCloseSource`, send backpressure counters, drain counts.
7. Did the process receive SIGTERM and exit cleanly?
   - process lifecycle logs plus `porter kubectl describe pod`.

If these seven questions are answerable for the next event, Phase 1.5 succeeded.

---

## Testing

### Local

1. `bunx tsc --noEmit`
2. Relevant unit tests for any timing helper.
3. Local harness smoke:

```bash
bun run tools/ws-storm-local/mentra-path-storm-harness.ts -- \
  --users=56 \
  --apps-per-user=1 \
  --rounds=1 \
  --message-handler=true \
  --connect-mode=init \
  --sdk-version=none \
  --user-db-async-ms=100 \
  --app-db-async-ms=100
```

Verify that local logs/vitals expose:

- protocol timer fields;
- app connect phase fields;
- subscription phase fields;
- no raw PII;
- no warnings under idle load.

### Cloud-Debug Smoke

1. Branch from `staging`.
2. Deploy/soak only on cloud-debug first.
3. Verify in BetterStack:
   - `system-vitals` includes new op fields and event-loop lag fields.
   - `ws-close` logs include the new metadata.
   - `slow-*` logs are rare under normal traffic.
   - No meaningful RSS/heap/log-volume regression.

### Staging Acceptance

After staging deploy, wait for the next cascade or high-load window. The event should produce a clear attribution:

```text
Dominant path: connection_init vs reconnect vs regular message
Dominant phase: refreshInstalledApps vs subscription sync vs display request vs other
Timing type: async resource wait vs sync loop blockage
WS storm source: likely pod-side heartbeat/backpressure vs peer/network-side unknown
Lifecycle: graceful SIGTERM observed vs SIGKILL before handler could run
```

---

## Rollout

1. Branch off `staging`.
2. Implement S1-S8. S9 is an operator note only unless debug profiling is explicitly requested.
3. Soak on cloud-debug.
4. PR to `staging`.
5. Let staging capture one event.
6. Write a Phase 2 fix spec from the captured evidence.

---

## Risks

| Risk | Mitigation |
|---|---|
| Vitals payload grows too much | Keep fields numeric and bounded; no labels or raw payloads. |
| Slow warnings flood BetterStack | Start with 100ms thresholds, add per-feature throttling if needed. |
| Phase timers add overhead | Use `performance.now()` and accumulator counters only; avoid allocations in hot paths where possible. |
| Close-source overclaims | Use `inferredCloseSource` and avoid TCP-level claims Bun does not expose. |
| In-process instrumentation misses fatal stalls | Combine with Kube pod state and startup/lifecycle breadcrumbs. |

---

## Summary

We should stop broad spiking and spec/ship this instrumentation next. It is the smallest useful step that converts the current ambiguous evidence into a fixable answer.

The likely fix will be one of:

- coalesce/debounce `broadcastAppState` and installed-app refresh on reconnect/init storms;
- reduce DB-backed work in `attachAppSocket` or `refreshInstalledApps`;
- coalesce subscription downstream manager syncs;
- address WS heartbeat/backpressure behavior;
- tune liveness only after understanding which path is actually pinning or waiting.

Do not choose among those fixes until this instrumentation captures the next event.
