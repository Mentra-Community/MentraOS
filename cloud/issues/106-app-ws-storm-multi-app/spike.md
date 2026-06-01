# Spike: Multi-App WebSocket Disconnect Storm — Cascade Trigger?

**Status:** Open — investigation only, no fix proposed in this doc
**Date:** 2026-05-04
**Last updated:** 2026-05-05 — W4 prod back-test completed; local harness evidence added
**Reporter:** Identified during analysis of staging 2026-05-04 17:02 UTC cascade
**Related:**

- [105-event-loop-cascade-investigation](../105-event-loop-cascade-investigation/) — parent investigation that identified this pattern as the proximate cascade trigger
- [102-pod-loop-stall-cascade](../102-pod-loop-stall-cascade/) — original cascade framing
- [076-aks-node-maintenance-pod-evictions](../076-aks-node-maintenance-pod-evictions/) — distinct pattern (Azure node rotation), explicitly NOT this
- [055-cloud-prod-oom-crashes](../055-cloud-prod-oom-crashes/), [061-crash-investigation](../061-crash-investigation/) — historical cascade context

---

## Plain-English Goal

This spike asks one narrow question:

```text
Did a burst of app WebSocket disconnects help trigger the pod cascade,
and if yes, what made those sockets all close at nearly the same time?
```

A WebSocket close code `1006` means the connection disappeared without a clean close handshake. That can happen because the network broke, the peer gave up, or the pod was too busy to respond in time. The code alone does not tell us which one.

The evidence we need is therefore simple:

- when did each app socket last receive a message?
- when did the pod last send a ping or app message?
- did Bun report send backpressure or delayed drain events?
- did many packages close in the same second?
- did event-loop delay rise before the closes, or only after them?

Better Stack can store and graph those facts, but our app has to emit them because generic container metrics cannot tell the difference between "network closed the socket" and "our pod missed heartbeat work while overloaded."

---

## Summary

In the 60-second window immediately preceding the staging 2026-05-04 17:02 cascade, **49 distinct app WebSocket connections from 5 different package names closed simultaneously with code 1006** (abnormal closure, no clean WS frame handshake). Container restarted in place 60–90 seconds later.

**2026-05-05 count refinement:** a follow-up per-second aggregate query found the same core storm plus three one-off packages. At 17:01:17 UTC, staging had `104` AppManager `1006` log lines, `56` UserSession/glasses `1006` lines, `52` "unexpectedly disconnected" app warnings, and `8` distinct app package names. The original "49 from 5 packages" count remains the core set; the wider query includes three single-disconnect packages.

This pattern looks like the **proximate trigger** of the cascade: 49 simultaneous reconnect cycles (cleanup + auth + state-sync + subscription re-establishment + transcription re-attach + mic-state-resync + glasses-WS broadcasts) is enough cleanup work to push an already-loaded event loop over the K8s liveness probe threshold.

**The open question this spike opens:** *what causes 49 unrelated app WS connections (across different mini-app servers, different deployment units) to close abnormally within 60 seconds?*

We don't yet know if this is:
- A network-layer event (Cloudflare hiccup, k8s service mesh blip, Azure VNet)
- Pod-side missed pings (loop too busy → all peers time out independently within ~30s)
- Bun WS server pathology under load
- Something else

This is open and worth investigating. It might or might not turn out to be the same root cause as issue 105's cascade slowness; could be independent.

**2026-05-05 refinement:** this pattern is now best framed as **staging-proven, prod-unproven**. The staging event clearly had a large multi-app storm immediately before restart. The three earlier us-central prod cascade windows did not show a staging-scale simultaneous 1006 storm, so this is probably one trigger shape rather than the universal explanation for all app-message cascades.

---

## The Storm in 30 Seconds (Staging 2026-05-04 17:01)

In the minute 17:01:00 → 17:02:00 UTC, AppManager logged 104 `1006`-related events (≈2 log lines per disconnect — close detection + grace-period start) and 52 distinct "App unexpectedly disconnected" warnings. Breakdown by package:

| Package | Closes (code 1006) |
|---|---|
| com.mentra.captions | 16 |
| com.mentra.ai | 10 |
| cloud.augmentos.notify | 9 |
| com.mentra.merge | 8 |
| com.mentra.notes | 6 |
| com.mentra.dash | 1 |
| com.mentra.translation | 1 |
| com.mentra.link | 1 |
| **Total unexpected app disconnect warnings** | **52** |

Plus glasses-side WS disconnects in the same minute:
- "Glasses connection closed: code=1006" — multiple sessions, varying silent-time before detection (138 ms to 4858 ms).

Each of the core 49 app disconnects produced:
- "App disconnected" log
- "Starting grace period for reconnection"
- "Grace period started"
- "✅ SDK reconnected during grace period - resurrection avoided!" (within ~1 second; the apps reconnected fast)
- "Grace period cancelled"

So the core 49 apps successfully reconnected within the grace window. No app stayed dead. But the cleanup + reconnect work for all of them simultaneously was substantial.

---

## Why This Pattern Matters

### The cleanup cost per disconnect

Each unexpected app WS disconnect triggers (in the cloud pod):

1. **Close handler runs** — cleanup of WS event listeners, marking the AppSession as disconnected
2. **Grace period timer scheduled** — `setTimeout(graceMs)` for resurrection deadline
3. **Subscription cleanup** — current subscriptions are paused (transcription stream may unsubscribe)
4. **Transcription stream re-evaluation** — does this app's missing subscription mean the underlying Soniox stream should be torn down?
5. **`app_state_change` broadcast to all glasses WSs in the user session** — informs phone app the mini-app stopped
6. **"Display request skipped - GLASSES_DISCONNECTED" cascading errors** if other apps are mid-flight to the now-disconnected user

Then on reconnect (which happens in ~hundreds of milliseconds for SDK-mediated reconnects):

1. **WS upgrade handshake** — auth, session lookup, attach handlers
2. **State sync** — current display state, pending photo requests, settings
3. **Subscription re-establishment** — app re-subscribes to its data streams
4. **Transcription stream re-attach** — Soniox stream re-bound to this app's subscription
5. **Mic state resync** — verify mic state matches current subscription requirements (logged 20× during the 17:01 storm)
6. **Grace-period cancellation** — clear the timer scheduled in step 2 above

Per disconnect+reconnect, that's tens of synchronous-and-asynchronous operations. Most are sub-millisecond, but combined across 49 simultaneous cycles in 60 seconds, we're plausibly looking at hundreds of milliseconds to several seconds of cumulative work, including allocations that pressure GC.

### Why "simultaneous" matters

If 49 disconnects were spread over an hour (one every ~73 seconds), the cleanup work would be background noise — never enough to notice. The cascade-triggering shape is **clustered**: 49 in 60 seconds = ~one every 1.2 seconds. The pod has no idle window to amortize the work.

49 reconnect-state-sync chains running interleaved on the event loop is precisely the kind of bursty load that pushes a busy loop into "blocked" territory.

---

## What Caused 49 Apps to Close Simultaneously?

### Hypothesis A: Network-layer event

External infrastructure (Cloudflare, Azure VNet, Tailscale-via-Porter, k8s service mesh) briefly disrupted the TCP connections from the apps' Porter pods to the cloud pod.

**Supporting evidence:**

- 5 different packages from different deployment units (separate Porter apps) all dropped at the same time. They don't share infrastructure within their own pods, but they all ride through Porter → k8s service → cloud pod. A network event affecting that path could hit all of them.
- Code 1006 = TCP-level disruption. App-side `ws.close(1000, ...)` would be code 1000 (clean). 1006 is "the connection just died without warning."
- The 49 reconnects all succeeded fast (~hundreds of ms), suggesting the apps themselves were healthy and the TCP layer recovered quickly.

**Counter-evidence:**

- We have no direct signal from BetterStack or Porter about a network blip at 17:01 UTC. (Could check if alerts/Cloudflare/Azure status had anything around that time.)
- Other regions / pods didn't show similar disconnect storms.

### Hypothesis B: Pod-side missed pings

The cloud pod's event loop was already busy (recall: `op_appMessage_ms` was sustained at 1,400–2,000 ms / 30 s for several minutes prior). WebSocket keepalive pings from cloud → app servers may have been delayed. Each app server has its own ping-timeout watchdog; when cloud's ping arrived too late, the app server closed the connection abnormally (1006 from app-server perspective, then the close propagates back to cloud as 1006 also).

**Supporting evidence:**

- Cascade buildup was visible in `op_appMessage_ms` for 4–5 minutes before the storm.
- Bun and Node WS servers send periodic pings; if the loop is busy, pings can be delayed enough to trip the receiving side's timeout.
- Multiple apps independently timing out makes sense if they share roughly the same ping-timeout (say, 30 s) — they'd all expire within a window.

**Counter-evidence:**

- The 16:46 spike (`op_appMessage_ms = 2,142 ms`) was larger than the 17:00:11 spike (1,467 ms) and didn't trigger a storm. Pure-load explanations need to also explain why the threshold was crossed at 17:01 specifically.
- We have zero `event-loop-lag` warnings (>100 ms) across the whole 4-day window. If pings were delayed enough to time out, we'd expect lag samples to catch some of it.

### Hypothesis C: Bun WS server pathology

Bun's WebSocket server might have a behavior under specific load patterns where it batches close detection or holds onto connections in some pathological way that surfaces as a burst of `1006` events.

**Supporting evidence:**

- We're on a relatively recent Bun version. Bun's WS server has had behavioral changes in past releases.

**Counter-evidence:**

- This is speculation. We don't have concrete evidence of a Bun bug.
- The same pod runs continuously without issue for many hours between cascades.

### Hypothesis D: A specific app's reconnect logic triggered cross-pod pressure

If e.g. `com.mentra.captions` reconnects with a tight retry loop, and 16 simultaneous user sessions of captions are all reconnecting simultaneously, that's 16 connections being established at once on the cloud pod. Each opens a new TCP/WS connection, runs the upgrade handshake, attaches handlers — all on the main event loop.

**Supporting evidence:**

- Captions had the largest single-package count (16) in the storm.
- Captions runs as a service many users have installed; coordinated user-session reconnects could compound.

**Counter-evidence:**

- If this were captions-specific, we wouldn't see 5 different packages all storm-closing in the same minute. Other apps (ai, notify, merge, notes) close-closure at the same time strongly suggests an external trigger affecting all of them, not coordinated per-app reconnects.

### Hypothesis E: Combination

Most likely: **B + a triggering perturbation**. The pod is busy. Something small (a bigger-than-usual handler call, a brief network jitter, a single app server momentarily slow) tips the balance. The first peer times out and closes 1006. That close triggers cleanup work, which makes the loop slightly busier. The next peer times out. Cascade builds within 30–60 s.

The 16:46 spike didn't cascade because the pod happened not to be near the critical threshold at that moment — different concurrent load, different queue state, slightly different mic count, different app population. The 17:01 storm hit a moment where the pod was right at the edge.

---

## What's Eliminated

| Hypothesis | Evidence against |
|---|---|
| Cluster event (Azure node rotation, AKS upgrade) | [076 spike](../076-aks-node-maintenance-pod-evictions/) documents the cluster-event signature: simultaneous restarts across `cloud-prod`, `cloud-staging`, `cloud-dev`, `cloud-debug` on the same cluster within ~14 min. The 17:02 staging cascade had NO simultaneous restarts of other apps on cluster 4689. The 2026-05-01 12:01 incident WAS a cluster event and is excluded from this analysis. |
| Single-app server crash and recovery | We see 5 different packages close simultaneously. Not one app server's lifecycle. |
| Cloud pod restart causing the disconnects | The cloud pod restarted AFTER the 17:01 storm (at 17:02 from liveness failure). The disconnects came first. |
| Memory/heap pressure causing WS layer to fail | Memory was flat at 384–393 MB throughout. Not a memory event. |
| Raw Bun WebSocket storm alone | Local raw Bun WS harness closed/reconnected 112–168 sockets without meaningful heartbeat gaps. Bun WS close/reconnect alone did not reproduce the stall. |
| This storm pattern as universal prod trigger | W4 found no staging-scale simultaneous 1006 storm in the three prior us-central prod cascade windows. This is a proven staging trigger candidate, not yet a universal cascade explanation. |

---

## What We Need to Know

To distinguish A vs B vs E, we need:

### W1. Per-WS close-source categorization

When a WS closes with code 1006, log *why* the cloud pod believes the connection closed:

- "Peer sent close frame" — clean close from the other side (would be code 1000 or 1001 typically, not 1006, but worth distinguishing if observed)
- "Received close without close frame" — TCP-level close, peer didn't send WS close frame (typical 1006)
- "TCP RST received" — explicit reset
- "Our ping-pong watchdog fired" — we sent a ping, got no pong within timeout, we close the connection
- "Underlying socket error" — write failed, etc.

Bun's WS server may or may not expose these distinctions cleanly. Need to investigate. If it does, log the close-source as a structured field on every close event:

```json
{
  feature: "ws-close",
  packageName: "com.mentra.captions",
  code: 1006,
  closeSource: "ping-timeout-from-our-side",
  durationMs: 32100,  // how long this connection lived
  bytesIn: 12345,
  bytesOut: 67890
}
```

This single signal answers Hypothesis B definitively. If `closeSource: "ping-timeout-from-our-side"` dominates during the storm, the pod is missing pings — Hypothesis B is correct, fix is to keep the loop responsive enough to send pings on time (possibly the same fix as 105). If `closeSource: "received-close-without-frame"` dominates, the peer side sent the close — Hypothesis A is in play, we need to look at the network/proxy layer.

### W2. WS keepalive ping timing

Log when our pod sent its last ping to each app WS and when it received a pong. If pings are going out late during the buildup phase, that's pre-cascade evidence of Hypothesis B.

This requires Bun WS internals access; might be a custom keepalive implementation rather than Bun's built-in ping/pong (which we may not be using).

### W3. Cloudflare / Azure / Porter network event correlation

For each cascade event, check at the same UTC time:

- Cloudflare status page / network metrics
- Azure status page for centralus region
- Porter platform-level events (do we have an audit log?)
- BetterStack collector data for the underlying nodes — were there node-level network blips?

Manual today; could be partially automated with bstack runbook integrations.

### W4. Cross-correlate WS storms across cascades

If we have records of past cascades, do they all have a multi-app WS storm preceding? If yes, this pattern is the cascade trigger universally. If only some cascades, the WS storm is one of multiple possible triggers and we need to investigate the others.

For the three prior us-central prod cascades (04-30 15:40, 04-30 18:24, 05-01 11:38), we could query for similar 1006-cluster patterns. Phase 1 obs wasn't on prod, but `AppManager` close logs are present.

**Completed 2026-05-05:** W4 was run against S3 historical logs at minute and second granularity.

Query shape:

```sql
SELECT
  toStartOfSecond(dt) AS second,
  countIf(JSONExtractString(raw, 'service') = 'AppManager'
    AND positionCaseInsensitive(JSONExtractString(raw, 'message'), '1006') > 0) AS app_1006,
  countIf(positionCaseInsensitive(JSONExtractString(raw, 'message'), 'unexpectedly disconnected') > 0) AS unexpected,
  uniqIf(JSONExtractString(raw, 'packageName'),
    JSONExtractString(raw, 'service') = 'AppManager'
    AND positionCaseInsensitive(JSONExtractString(raw, 'message'), '1006') > 0) AS distinct_packages
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type = 1
  AND JSONExtractString(raw, 'region') = 'us-central'
  AND <cascade-window predicates>
GROUP BY second
HAVING app_1006 > 0 OR unexpected > 0
ORDER BY app_1006 DESC, unexpected DESC
```

Findings:

| Window | Largest app 1006 second | Distinct packages | Notes |
|---|---:|---:|---|
| Prod 04-30 15:40 | 2 | 1 | Small single-package trickles only |
| Prod 04-30 18:24 | 2 | 1 | Small single-package trickles only |
| Prod 05-01 11:38 | 12 | 5 | Small burst at 11:20:34 UTC, ~18 min before listed cascade |
| Staging 05-04 17:02 | 104 AppManager 1006 log lines, 52 unexpected app disconnects | 8 | Immediate precursor at 17:01:17 UTC |

Conclusion: the staging WS storm is real and large enough to be a plausible proximate trigger for that restart, but **prior prod cascades do not share the same storm signature**. 106 should remain a sibling investigation, not the sole explanation for 105.

### W5. Local storm harnesses

A local-only harness was added under `cloud/tools/ws-storm-local/` to test whether a storm can be reproduced without deploying. Any captions package in the harness package pool is `com.mentra.captions.debug`; the harness rewrites accidental `com.mentra.captions` arguments to debug.

Harnesses:

- `bun-ws-storm-harness.ts`: raw Bun native WebSocket server/client storm.
- `mentra-path-storm-harness.ts`: real `AppManager`, `AppSession`, `SubscriptionManager`, and optionally `handleAppMessage`, with fake sockets and stubbed services.

Results relevant to 106:

| Scenario | Result |
|---|---|
| Raw Bun WS, 112 simultaneous app closes/reconnects | No stall; max heartbeat gap ~2ms |
| Raw Bun WS, 168 simultaneous multi-app closes/reconnects | No stall; max heartbeat gap ~6ms |
| Raw Bun WS with high stdout/log pressure | No stall locally; log volume alone did not reproduce the silence window |
| Raw Bun WS with 3000ms async reconnect delay | Huge wall-time per message, but event loop stayed responsive |
| Real Mentra v3 reconnect storm, 56 app sessions × 10 rounds | Clean; max heartbeat gap 6ms |
| Real Mentra legacy init + async DB-like delay | Tens of seconds aggregate reconnect wall-time, but event loop stayed responsive |
| Real Mentra legacy init + small synchronous DB-like work | Multi-second heartbeat gaps; 20ms sync work crossed current `/livez` timeout |

Conclusion: raw Bun WS close/reconnect behavior is **not enough** to reproduce the staging stall on a laptop. The dangerous local reproduction requires the storm to amplify synchronous work in Mentra's reconnect/init/subscription paths.

---

## Proposed Investigation Plan (no code changes)

1. **W4 first** — completed 2026-05-05. Result: staging-scale storm did not appear in the three prior prod windows.
2. **W3 manual check** — look at Cloudflare and Azure status for the cascade timestamps. Quick.
3. **W1 + W2 spec** — write a small spec adding the close-source and ping-timing instrumentation. Estimate ~50 LoC. Ships separately or alongside the [105 spec](../105-event-loop-cascade-investigation/spec.md) instrumentation.
4. **Add storm-path timers** — for app `CONNECTION_INIT`, app `RECONNECT`, `attachAppSocket`, `broadcastAppState`, `refreshInstalledApps`, `SubscriptionManager.syncManagers`, transcription update, stream ensure, and Bun WS `send()` return values / `drain` counts.

---

## Open Follow-Ups

- [x] Run W4 query and document findings here.
- [ ] Run W3 status-page checks for the four known cascade timestamps.
- [ ] Spec W1 + W2 (separate doc or fold into 105 spec).
- [ ] Decide whether W1/W2 belongs in 106 or should be folded into the 105 Phase 1.5 instrumentation spec.
- [ ] Once W1 + W2 ship, capture the next cascade and confirm or rule out Hypotheses A vs B.

## Why This Is a Separate Issue (not part of 105)

105 is asking "which app-message handler is consuming time during cascade?" — that's about CPU within message-handling code paths, fixable in our own code.

106 is asking "what causes 49 simultaneous app WS disconnects, and is it actually the cascade trigger?" — that's about WS lifecycle behavior under load and possibly external infrastructure events. Different scope, different fix path.

Both could share the same root cause (e.g., the loop is busy, missing pings) — but they could equally be independent (e.g., cascade busy from message handling, WS storm from network event). Keeping them as sibling issues lets us investigate in parallel without over-coupling the analyses or fixes.
