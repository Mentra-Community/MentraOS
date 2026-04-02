# Spec: Fix Heap Growth — Switch from @logtail/pino to Vector Log Collection

## Overview

**What this doc covers:** Exact specification for replacing the in-process `@logtail/pino` Pino transport with out-of-process log collection via BetterStack's Vector Helm chart. Includes the Vector config to flatten Pino JSON so logs look identical in BetterStack Live Tail, container filtering to exclude kube-system noise, the Pino logger code change, and the rollout plan.
**Why this doc exists:** The `@logtail/pino` transport causes unbounded heap growth (~15 MB/min on US Central with 60 sessions) because Pino's `thread-stream` worker thread buffers log strings faster than the BetterStack HTTP API can consume them. This is a known class of issue (pinojs/pino #2106, #1781, #1845). We proved it definitively by disabling the BetterStack token on US Central (heap stopped growing with 60 sessions) and enabling it on France (heap grew at 2.8 MB/min with 25 sessions).
**What you need to know first:** [067 spike](./spike.md) for heap snapshot analysis, [066 spike](../066-ws-disconnect-churn/spike.md) for the proof that churn is NOT the cause.
**Who should read this:** Anyone reviewing or deploying this change.

## The Problem in 30 Seconds

Every `logger.info(...)` call serializes the log to JSON and passes it to `@logtail/pino` via Pino's `thread-stream`. The transport sends logs to BetterStack's HTTP API. When the API can't consume as fast as we produce (~100-170 logs/sec on US Central), the thread-stream buffer grows without bound. Each buffered string stays in main-thread memory. The heap grows ~15 MB/min, JSC triggers a full GC on the 500MB+ heap, the event loop freezes for 3+ seconds, and Kubernetes kills the pod.

The fix: write JSON to stdout, let Vector (running as a DaemonSet outside the Node process) collect it from container logs and ship it to BetterStack. Zero in-process buffering. This is what Pino's maintainer recommends for Kubernetes deployments.

## Spec

### A1. Vector Helm chart values — flatten Pino JSON, filter containers

**File:** `cloud/infra/betterstack-logs/values.yaml`

The BetterStack logs Helm chart deploys Vector as a DaemonSet that tails `/var/log/pods/`. By default, it wraps stdout content in a `message` field with `kubernetes` metadata alongside it. This produces logs like:

```json
{
  "kubernetes": { "container_name": "cloud-prod-cloud", ... },
  "message": { "level": 30, "region": "us-west", "feature": "gc-probe", ... },
  "platform": "Kubernetes"
}
```

This is not usable — `region` is nested inside `message`, not top-level. BetterStack Live Tail queries like `region="us-west"` don't work.

We need a Vector transform that:

1. **Filters** to only `cloud-prod-cloud` and `cloud-staging-cloud` containers (drops kube-system, cert-manager, ingress-nginx, etc.)
2. **Flattens** the Pino JSON from `message` to the top level so all fields (`region`, `feature`, `service`, `heapUsedMB`, etc.) are directly queryable
3. **Adds** a `kubernetes_pod` field (just the pod name, not the entire kubernetes blob) for debugging
4. **Drops** the verbose `kubernetes` metadata blob (node labels, pod annotations, etc.)

```yaml
vector:
  customConfig:
    transforms:
      # Step 1: Filter to only our cloud containers
      cloud_only_filter:
        type: "filter"
        inputs: ["better_stack_kubernetes_parser"]
        condition: >
          .kubernetes.container_name == "cloud-prod-cloud" ||
          .kubernetes.container_name == "cloud-staging-cloud" ||
          .kubernetes.container_name == "cloud-debug-cloud" ||
          .kubernetes.container_name == "cloud-dev-cloud"

      # Step 2: Flatten the Pino JSON from message to top level
      flatten_pino:
        type: "remap"
        inputs: ["cloud_only_filter"]
        source: |
          # Save pod name before we restructure
          pod_name = .kubernetes.pod_name ?? "unknown"
          container = .kubernetes.container_name ?? "unknown"

          # The Pino JSON is in .message — it may be a string or already parsed
          pino = .message
          if is_string(pino) {
            parsed, err = parse_json(pino)
            if err == null {
              pino = parsed
            }
          }

          # If pino is an object, flatten it to top level
          if is_object(pino) {
            . = pino
          }

          # Add kubernetes context (just pod name, not the whole blob)
          .kubernetes_pod = pod_name
          .kubernetes_container = container
          .log_source = "vector"

    sinks:
      better_stack_http_sink:
        inputs: ["flatten_pino"] # Use flattened output, not raw
        uri: "https://PLACEHOLDER_INGESTING_HOST/"
        auth:
          strategy: "bearer"
          token: "PLACEHOLDER_SOURCE_TOKEN"
      better_stack_http_metrics_sink:
        uri: "https://PLACEHOLDER_INGESTING_HOST/metrics"
        auth:
          strategy: "bearer"
          token: "PLACEHOLDER_SOURCE_TOKEN"

metrics-server:
  enabled: false
```

**Expected result in BetterStack Live Tail:**

```json
{
  "level": 30,
  "time": "2026-03-29T04:32:00.047Z",
  "env": "production",
  "server": "cloud-prod",
  "region": "us-west",
  "service": "SystemVitalsLogger",
  "feature": "system-vitals",
  "heapUsedMB": 59,
  "rssMB": 237,
  "activeSessions": 0,
  "msg": "system-vitals",
  "kubernetes_pod": "cloud-prod-cloud-dbdbbdb8c-dsxxn",
  "kubernetes_container": "cloud-prod-cloud",
  "log_source": "vector"
}
```

This is queryable with `region="us-west"`, `feature="system-vitals"`, etc. — identical to the current Pino transport logs, plus `log_source="vector"` to distinguish them during the migration.

### A2. Pino logger change — JSON to stdout, remove @logtail/pino

**File:** `cloud/packages/cloud/src/services/logging/pino-logger.ts`

**Already implemented on this branch** via the `LOG_STDOUT_JSON` env var. When `LOG_STDOUT_JSON=true`:

- Pino writes raw JSON to stdout via `pino.destination(1)` (fast, no worker thread)
- The `createFilteredStream` wrapper passes through directly when no log filters are set (eliminates the unnecessary `JSON.parse` on every log line)
- `@logtail/pino` still runs alongside (for safety during migration)

**Phase 2 change (after Vector is confirmed working):**

Remove the `@logtail/pino` transport entirely. The logger becomes:

```typescript
// Production: JSON to stdout → Vector collects → BetterStack
// Dev/local: pino-pretty to console
const isProduction = NODE_ENV === "production";

if (isProduction) {
  streams.push({
    stream: pino.destination({ dest: 1, sync: false }),
    level: LOG_LEVEL,
  });
} else {
  // pino-pretty for development
  streams.push({
    stream: pino.transport({ target: "pino-pretty", options: { ... } }),
    level: LOG_LEVEL,
  });
}

// No @logtail/pino. No createFilteredStream. No thread-stream.
```

This eliminates:

- The `@logtail/pino` worker thread and its unbounded buffer (the heap growth cause)
- The `createFilteredStream` JSON.parse on every log line (unnecessary CPU)
- The `pino-pretty` transport in production (was writing to stdout alongside @logtail/pino)

### A3. Remove gc-after-disconnect

**File:** `cloud/packages/cloud/src/services/session/UserSession.ts`

Remove the `Bun.gc(true)` call after session disposal (the block guarded by `canRunPostDisconnectGc()`). Also remove the static fields `lastPostDisconnectGc`, `POST_DISCONNECT_GC_COOLDOWN_MS`, and the method `canRunPostDisconnectGc()`.

Confirmed wasteful: 31 calls/hour on US Central, 2,242ms total event loop blocking, freed 0 bytes every time. The `gc-probe` in SystemVitalsLogger provides the same diagnostic data.

### A4. Remove createFilteredStream double-parse

**File:** `cloud/packages/cloud/src/services/logging/pino-logger.ts`

**Already implemented on this branch.** When `HAS_LOG_FILTERS` is false (the common case — no `LOG_FEATURES` or `LOG_SERVICES` env vars set), `createFilteredStream` returns the target stream directly instead of wrapping it with a `JSON.parse` on every log line.

## Install & Deploy Commands

### Per-cluster Vector install

```bash
# Add repo (once)
porter helm --cluster <CLUSTER_ID> -- repo add betterstack-logs \
  https://betterstackhq.github.io/logs-helm-chart
porter helm --cluster <CLUSTER_ID> -- repo update

# Get source token from Doppler
TOKEN=$(doppler secrets get BETTERSTACK_SOURCE_TOKEN \
  --project mentraos-cloud --config <DOPPLER_CONFIG> --plain)

INGESTING_HOST="s2324289.eu-nbg-2.betterstackdata.com"

# Install
porter helm --cluster <CLUSTER_ID> -- install betterstack-logs \
  betterstack-logs/betterstack-logs \
  --namespace betterstack \
  --create-namespace \
  --values cloud/infra/betterstack-logs/values.yaml \
  --set "vector.customConfig.sinks.better_stack_http_sink.auth.token=$TOKEN" \
  --set "vector.customConfig.sinks.better_stack_http_metrics_sink.auth.token=$TOKEN" \
  --set "vector.customConfig.sinks.better_stack_http_sink.uri=https://$INGESTING_HOST/" \
  --set "vector.customConfig.sinks.better_stack_http_metrics_sink.uri=https://$INGESTING_HOST/metrics"
```

### Cluster table

| Region     | Cluster | Doppler Config  |
| ---------- | ------- | --------------- |
| US West    | 4965    | prod_us-west    |
| US East    | 4977    | prod_us-east    |
| France     | 4696    | prod_france     |
| East Asia  | 4754    | prod_east-asia  |
| US Central | 4689    | prod_central-us |

### Doppler env var

```bash
doppler secrets set LOG_STDOUT_JSON="true" \
  --project mentraos-cloud --config <DOPPLER_CONFIG>
```

## Rollout Plan

### Phase 1: Validate on US West (0 sessions, zero risk)

1. Update `values.yaml` with the flatten + filter transforms (A1)
2. Install Vector Helm chart on US West (cluster 4965)
3. `LOG_STDOUT_JSON=true` is already set in Doppler for US West
4. Push branch → deploys to US West via `porter-us-west.yml` workflow
5. **Verify in BetterStack Live Tail:** query `region="us-west"` — should see logs with `log_source="vector"` that look identical to the existing Pino logs
6. **Verify:** query `log_source="vector" AND feature="system-vitals"` — should show flat structured fields
7. **Verify:** no kube-system noise in the source

**Revert:** `porter helm --cluster 4965 -- uninstall betterstack-logs --namespace betterstack`

### Phase 2: Validate on France (25 sessions, moderate risk)

1. Install Vector on France (cluster 4696)
2. Set `LOG_STDOUT_JSON=true` in Doppler for `prod_france`
3. Redeploy France: `porter app update cloud-prod --cluster 4696`
4. **Verify logs in Live Tail** — same checks as Phase 1
5. **Monitor heap with `analyze-heap.ts live`** — with both transports running, heap will still grow (that's expected). This phase validates log format only.

**Revert:** Uninstall Vector, set `LOG_STDOUT_JSON=false`, redeploy.

### Phase 3: Remove @logtail/pino on France (the real test)

1. Remove the `@logtail/pino` transport from pino-logger.ts (A2 Phase 2 change)
2. Deploy to France only
3. **Verify logs still appear in BetterStack** — Vector is now the only path
4. **Monitor heap:** should stop growing. Run `analyze-heap.ts live` for 10+ minutes.
5. **Compare:** France (Vector only) vs US Central (still on @logtail/pino) — France should be flat, US Central should be growing.

**Revert:** Re-add `@logtail/pino` transport, redeploy. Vector still runs, so logs flow via both paths again.

### Phase 4: Roll to all regions

1. Install Vector on remaining clusters (US East, East Asia, US Central)
2. Set `LOG_STDOUT_JSON=true` in all Doppler configs
3. Deploy the @logtail/pino removal to all regions (merge to main)
4. Monitor all regions for 24 hours
5. Remove `LOG_STDOUT_JSON` env var checks from the code (no longer needed — JSON stdout is the only mode in production)

### Phase 5: Cleanup

1. Remove `@logtail/pino` from `package.json`
2. Remove the `LOG_STDOUT_JSON` conditional (always JSON stdout in production)
3. Remove the `createFilteredStream` wrapper entirely (no longer needed)
4. Remove `gc-after-disconnect` (A3)
5. Update `cloud/.architecture/` docs to reflect the new logging architecture

## What This Does NOT Include

| Out of scope                          | Why                                                         |
| ------------------------------------- | ----------------------------------------------------------- |
| Changing log content or volume        | Separate concern — this only changes the delivery mechanism |
| Client-side WebSocket fixes           | Separate issue (066)                                        |
| JSC GC tuning                         | Mitigates crash symptom, doesn't fix root cause             |
| Observability additions from 066 spec | Can be added after the transport fix                        |

## Decision Log

| Decision                              | Alternatives considered                                                              | Why we chose this                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vector via BetterStack Helm chart     | Write custom Writable stream with `@logtail/node`, switch to Winston, use Fluent Bit | Vector is BetterStack's own recommended K8s log collector, handles backpressure properly, runs outside the Node process. Zero custom code.                                                              |
| Flatten Pino JSON in Vector transform | Send nested JSON and change all BetterStack queries                                  | Existing queries, dashboards, and team muscle memory depend on `region=`, `feature=`, `service=` at top level. Changing query patterns across the team is more disruptive than a Vector transform.      |
| Filter to cloud containers only       | Send all pods, filter in BetterStack                                                 | Reduces log volume and cost. kube-system pods produce noise that's not useful for application debugging. We already have the BetterStack collector for infrastructure metrics.                          |
| Keep @logtail/pino during migration   | Remove it immediately                                                                | Running both paths lets us verify Vector logs match before cutting over. Zero-risk migration.                                                                                                           |
| `log_source="vector"` field           | No marker field                                                                      | Lets us distinguish Vector-delivered logs from Pino-transport logs during the migration period. Can query `log_source="vector"` to see only the new path. Remove the field after migration is complete. |
| Remove gc-after-disconnect            | Make it opt-in via env var                                                           | Data is definitive: 31 calls/hour, 2,242ms blocking, 0 bytes freed, every time. No scenario where it helps.                                                                                             |

## Testing

### Validate log format in Live Tail

After deploying to US West with the flatten transform:

```
# Should return structured logs with top-level fields:
region="us-west"

# Should return only Vector-delivered logs:
log_source="vector"

# Should return system vitals with all fields queryable:
feature="system-vitals" AND region="us-west"

# Should NOT return kube-system noise:
kubernetes_container="konnectivity-agent"  → 0 results
```

### Validate heap stops growing

After removing @logtail/pino on France:

```bash
MENTRA_ADMIN_JWT=$(grep "^MENTRA_ADMIN_JWT=" cloud/.env | cut -d'=' -f2-)
export MENTRA_ADMIN_JWT
cd cloud/packages/cloud

# Monitor for 10 minutes — heap should be stable (sawtooth GC pattern, not climbing)
bun run src/scripts/analyze-heap.ts live \
  --host=franceapi.mentra.glass --interval=30 --duration=600
```

**Expected:** Heap oscillates between ~100-140MB with GC cycles but does NOT trend upward. RSS stays under 500MB.

**Compare with US Central (still on @logtail/pino):**

```bash
bun run src/scripts/analyze-heap.ts live \
  --host=uscentralapi.mentra.glass --interval=30 --duration=600
```

**Expected:** Heap trends upward at ~2-15 MB/min (depending on session count).

### Validate no log loss

During the Phase 2→3 transition on France, count logs in BetterStack before and after removing @logtail/pino:

```sql
-- Before (both paths): expect ~X logs per minute from France
SELECT toStartOfMinute(dt) as minute, count() as logs
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt >= now() - INTERVAL 10 MINUTE
  AND JSONExtract(raw, 'region', 'Nullable(String)') = 'france'
GROUP BY minute ORDER BY minute

-- After (Vector only): should see similar log count
-- (may drop slightly because @logtail/pino was duplicating some logs)
```
