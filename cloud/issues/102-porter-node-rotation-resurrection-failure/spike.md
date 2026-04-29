# 102 — Porter Node Rotation Kills Long-Idle Sessions (Resurrection Failure)

**Status:** Open — investigation only, no fix proposed in this doc
**Date:** 2026-04-22
**Reporter:** Isaiah / Philippe (mac mini 24/7 captions test rig)
**Related:** 076-aks-node-maintenance-pod-evictions (same root cause, documented March 31)

---

## Summary

Philippe runs `com.mentra.captions.debug` on a mac mini 24/7. On 2026-04-22 at 14:20 UTC, the session died and did not recover. The glasses went blank; no manual restart happened until a human intervened hours later.

What happened:

1. Azure AKS started a rolling node-image upgrade across the `mentra-cluster-central-us` pool at ~14:02 UTC.
2. Each node in the pool was drained and replaced one at a time over the next 40+ minutes.
3. When the node hosting Philippe's `captions-debug` pod was drained, Kubernetes gracefully shut the pod down and scheduled a replacement on a brand-new node.
4. The replacement pod took ~25 seconds to become healthy.
5. Cloud's resurrection webhook retry budget expired after ~1 second, declared the app dead, sent `app_stopped` to the mobile client, and never retried.
6. Session stayed dead until a human restarted it.

This same event affected many first-party apps simultaneously — the rolling upgrade hit every node in the pool, and every Mentra-hosted miniapp running on those nodes got rotated.

## Incident Evidence

User session: `philippe+macmini@mentraglass.com`, app `com.mentra.captions.debug`, cluster `cloud-dev` in us-central-dev. All timestamps UTC.

### Cloud timeline (BetterStack, source `MentraCloud - Prod`)

```
14:20:10.x   AppManager           debug  sendMessageToApp ... (captions streaming fine)
14:20:12.220 AppManager           warn   App com.mentra.captions.debug unexpectedly disconnected (code: 1000) (reason: ), starting grace period
14:20:12.x   TranscriptionManager warn   Failed to send transcription data to App com.mentra.captions.debug (×20 over next 5s)
14:20:17.328 AppManager           info   Grace period expired, attempting resurrection (v2 legacy)
14:20:17.423 AppManager           error  Error triggering stop webhook for com.mentra.captions.debug
14:20:17.799 AppManager           info   Triggering webhook for com.mentra.captions.debug: https://live-captions-13320-4a24a192-3pvx4f1z.onporter.run/webhook
14:20:18.807 AppManager           error  Webhook failed after 2 attempts
14:20:18.808 AppManager           error  Error triggering webhook for app com.mentra.captions.debug
14:20:18.809 AppManager           error  [AppManager] Resurrection failed for com.mentra.captions.debug: Webhook failed after 2 attempts: Request failed with status code 503
14:20:18.809 AppManager           info   Sent app_stopped to mobile after resurrection failure
```

- Disconnect detected at 14:20:12.
- Grace period = 5s. Resurrection started at 14:20:17.
- Two webhook attempts, ~1s apart, both returned 503. Given up at 14:20:18.809.
- Total time from disconnect-detected to give-up: **~6.6 seconds**.

Note the close code on the disconnect: `code: 1000` with empty reason. That's a WebSocket "normal closure" — it was NOT a crash. The app server gracefully closed its connection, which is exactly what you'd expect from a pod receiving SIGTERM during a Kubernetes eviction.

### Porter pod timeline (same window, `porter app logs captions-debug`)

```
14:20:11Z  live-captions  2026/04/22 14:20:11 starting downward api checker
14:20:11Z  live-captions  2026/04/22 14:20:11 found value 10.78.7.242 at env var DOWNWARD_HOST_IP
14:20:12Z  live-captions  🛑 Shutting down...
14:20:12Z  live-captions  SimpleStorage flushed on disconnect
14:20:35Z  live-captions  $ bun run build:webview && NODE_ENV=development bun src/index.ts
14:20:35Z  live-captions  $ bun run build.ts
14:20:36Z  live-captions  Build successful!
14:20:36Z  live-captions  🚀 Starting Live Captions App...
14:20:37Z  live-captions  ✅ Live Captions running on port 80
```

- 14:20:11 — Kubernetes downward-api init container starts on the new node.
- 14:20:12 — the old pod receives SIGTERM and gracefully shuts down (this is what shows up in cloud as close code 1000).
- 14:20:35 — new container main process starts (`bun run build:webview && bun src/index.ts`).
- 14:20:36 — webview build completes (~1s).
- 14:20:37 — server listening on port 80.

**Pod unavailability window: 25 seconds (14:20:12 → 14:20:37).**
**Cloud gave up at second 6.6.**
**Gap: 19 seconds. The new pod was healthy 19 seconds after cloud declared the session dead.**

### AKS node evidence

```sh
$ porter kubectl --cluster 4689 -- describe pod captions-debug-live-captions-5bc8d8c765-hkhm6 -n default
Node:        aks-a4689qbpv-27613717-vmss00000d/10.78.7.242
Start Time:  Wed, 22 Apr 2026 07:20:07 -0700   # = 14:20:07 UTC

$ porter kubectl --cluster 4689 -- get node aks-a4689qbpv-27613717-vmss00000d \
    -o jsonpath='{.metadata.creationTimestamp}'
2026-04-22T14:19:29Z
```

- Replacement pod landed on node `vmss00000d` at 14:20:07.
- That node was created at 14:19:29 — **38 seconds before the pod was scheduled onto it**.

### Broader rotation pattern

All nodes in the `a4689qbpv-27613717` pool, sorted by creation time:

```
aks-a4689qbpv-27613717-vmss00002r   2026-04-22T14:02:15Z
aks-a4689qbpv-27613717-vmss000003   2026-04-22T14:02:20Z
aks-a4689qbpv-27613717-vmss00000u   2026-04-22T14:02:27Z
aks-a4689qbpv-27613717-vmss00002k   2026-04-22T14:02:31Z
aks-a4689qbpv-27613717-vmss00002j   2026-04-22T14:03:01Z
aks-a4689qbpv-27613717-vmss000009   2026-04-22T14:07:12Z
... (new node every 1-2 minutes) ...
aks-a4689qbpv-27613717-vmss00000d   2026-04-22T14:19:29Z   ← Philippe's node
...
aks-a4689qbpv-27613717-vmss000002   2026-04-22T14:43:52Z

All nodes running image AKSUbuntu-2204gen2containerd-202603.30.0
```

~35 nodes replaced over 40+ minutes, all running the same new base-OS image version (March 30, 2026). This is an AKS rolling node-image upgrade — not a deploy, not a spot eviction, not a failure. It's the monthly/weekly Azure routine for patching the host OS.

### Cross-user / cross-app correlation

Same BetterStack query for all users in the 14:00–15:00 UTC window, `level=error` with `webhook` or `503` or `Resurrection`:

| Time         | App                           | Affected users (503 on resurrection) |
| ------------ | ----------------------------- | ------------------------------------ |
| 14:09:35     | com.mentra.captions           | 12+                                  |
| 14:13:27     | com.mentra.streamer           | 5+                                   |
| 14:17:29     | com.mentra.notes              | 8+                                   |
| 14:17:42     | com.mentra.translation        | 7+                                   |
| 14:18:13     | com.mentra.merge              | 12+                                  |
| **14:20:18** | **com.mentra.captions.debug** | **philippe+macmini**                 |
| 14:30:22     | cloud.augmentos.notify        | 9+                                   |

Every row above is a Mentra first-party app whose pod was on a node that got drained during this single rolling upgrade. The exact times cluster around when specific nodes finished draining — different apps were on different nodes.

`captions.debug` shows up alone because it's a single-developer deployment with one user attached (Philippe).

## Why the replacement pod takes 25 seconds

Three things happen in series when Kubernetes moves a pod to a new node:

1. **Scheduling + image pull on a fresh node (~19 seconds).** The replacement pod was placed on `vmss00000d`, a node that was 38 seconds old at the time of scheduling. A brand-new node has no cached Docker images, so the pod pays the full image-pull cost. The Porter init container ran at 14:20:11, and the main container's first log line is at 14:20:35, so image pull + container creation for this particular pod was ~24 seconds.

2. **Webview build on container start (~4 seconds).** The captions-debug container's start command is:

   ```
   bun run build:webview && NODE_ENV=development bun src/index.ts
   ```

   i.e. the container rebuilds the frontend bundle every time it starts, rather than shipping a pre-built bundle in the image. Logs show `$ bun run build.ts` → `Build successful!` over ~1 second plus ~2-3 seconds of bun startup overhead.

3. **App listen (~1 second).** Standard `app.listen(80)` plus whatever init the app does.

Of the 25 seconds, roughly 19-20 are "Kubernetes + image pull on a fresh node" and ~5 are "the app rebuilds itself on boot."

## Why cloud gives up after ~1 second

Source: `cloud/packages/cloud/src/services/session/AppManager.ts`.

```typescript
private async triggerWebhook(url: string, payload: SessionWebhookRequest, packageName?: string): Promise<void> {
  const maxRetries = 2;
  const baseDelay = 1000; // 1 second

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      });
      return;
    } catch (error: unknown) {
      if (attempt === maxRetries - 1) {
        // ... log + throw ...
      }
      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
    }
  }
}
```

- `maxRetries = 2` — that's the initial call plus one retry.
- `baseDelay * 2^attempt` with `attempt=0` → 1 second of backoff between attempts.
- When the pod is in its Kubernetes bootup window, the Porter ingress returns `503` immediately (Kubernetes's response for "service has no ready endpoints"). Both attempts fail instantly, ~1 second apart.
- Total elapsed time in Philippe's case: ~1.0 second (14:20:17.799 → 14:20:18.807).

The grace-period expiration handler, on webhook failure, transitions the AppSession to `STOPPED`, sends `app_stopped` to the mobile client, and does not schedule any further retry:

```typescript
// v2 legacy path in handleAppSessionGracePeriodExpired
await this.stopApp(packageName, true, "system_stop")
const result = await this.startApp(packageName)
if (!result.success) {
  appSession.markStopped()
  // send app_stopped to mobile
}
```

There is no state in this path that re-attempts later. Once we hit `markStopped()`, the session is gone until something external (user tapping restart, mobile relaunching the app) kicks off a fresh `session_request`.

## Why the budgets don't match

| Metric                                    | Observed value                     |
| ----------------------------------------- | ---------------------------------- |
| Kubernetes pod eviction → new pod healthy | ~25 seconds                        |
| Cloud grace period before resurrection    | 5 seconds                          |
| Cloud webhook retry budget                | ~1 second (2 attempts, 1s backoff) |
| Cloud total budget (grace + retries)      | ~6.6 seconds                       |
| **Gap between budget and reality**        | **~19 seconds**                    |

The cloud's retry budget was designed for "the app server crashed and immediately restarted" — a process-restart scenario where a new listener is usually up in 1-2 seconds. It was not designed for Kubernetes eviction, where the replacement has to go through scheduling + image pull + container start. The 19-second gap exists every time a pod is rotated to a fresh node, and that's exactly what AKS node-image upgrades do: force every pod onto a fresh node.

## Relationship to 076

Issue `076-aks-node-maintenance-pod-evictions` documented this same root cause on 2026-03-31 (US West, a captions-debug session Isaiah was running) and closed with "no code fix needed — cloud behavior is correct." The evidence in 076 shows the same pattern:

- Azure `RebootScheduled` / `RedeployScheduled` events on the node.
- Multiple unrelated pods evicted simultaneously.
- Cloud logs: `Webhook failed after 2 attempts: Request failed with status code 503`, `Sent app_stopped to mobile after resurrection failure`.
- 076 observed "captions-debug was ~2 minutes" of unavailability.

The April 22 incident documented here is not a new bug — it is the same bug recurring during Azure's routine node-pool maintenance. The only material difference is that 076 was a one-node reboot (weekly security patch), and April 22 was a full-pool rolling upgrade (monthly base-image refresh), so April 22 affected ~7 different first-party apps across dozens of users in one hour instead of one app on one node.

## Open questions this spike did not answer

- For v3 apps, resurrection preserves the AppSession and expects the SDK to reconnect on its own WebSocket. The webhook appears to exist to nudge a crashed app-server process to start up. When the "crash" is actually a Kubernetes eviction, the new pod is starting itself via Kubernetes regardless of whether the webhook fires. It is not clear whether the v3 path relies on the webhook at all, or whether a plain "wait longer for the AppSession to reconnect" would be sufficient. Worth a follow-up investigation.
- Does Porter's ingress consistently return HTTP 503 when a pod is not ready yet, or does it sometimes return ECONNREFUSED / a connection timeout? Philippe's incident shows 503, but the cloud's retry classification treats all axios errors the same, so we don't know whether the behavior is uniform across failure modes.
- What is the cold-start distribution across all first-party apps? Captions-debug is ~25s. Other apps using the same `bun run build:... && bun start` pattern likely have similar cold-starts, but individual apps may differ by tens of seconds, and we have not measured.
- What is the actual frequency of AKS node rotations per cluster? 076 speculated weekly for security patches and monthly for host OS upgrades, but that was based on Azure documentation defaults, not our observed behavior. Worth pulling from kube events history over 30 days to get a real number.
