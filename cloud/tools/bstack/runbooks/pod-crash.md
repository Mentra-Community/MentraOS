# Pod Crash

## Trigger

BetterStack Uptime alert: `prod.augmentos.cloud/health` returning 503, 502, timeout, or 521. Or Porter dashboard showing "Non-zero exit code" / container restart.

## Quick Check (30 seconds)

```bash
bstack health
```

Look at the `uptime` column. If a region shows low uptime (< 5 minutes) while others show hours, that region just crashed and restarted.

## Diagnose (2-5 minutes)

### Step 1: What was the exit code?

Check Porter dashboard → Deployments tab → look for "Non-zero exit code" events.

Or via CLI:

```bash
porter kubectl --cluster <CLUSTER_ID> -- describe pod -n default -l "app.kubernetes.io/name=cloud-prod-cloud" | grep -A8 "Last State"
```

| Exit Code | Meaning                             | Next Step                     |
| --------- | ----------------------------------- | ----------------------------- |
| **137**   | SIGKILL — Kubernetes killed the pod | Go to "Exit 137" below        |
| **1**     | Unhandled exception — code bug      | Go to "Exit 1" below          |
| **0**     | Clean shutdown — likely a deploy    | Check if a deploy was running |

### Step 2: Exit 137 — Why did Kubernetes kill it?

Check for OOM kills:

```bash
porter kubectl --cluster <CLUSTER_ID> -- get events -n default --sort-by=.lastTimestamp | grep -i "oom\|kill\|unhealthy\|liveness"
```

Check the vitals leading up to the crash:

```bash
bstack memory --region <REGION> --duration 1h
bstack gc --region <REGION> --duration 1h
bstack gaps --region <REGION> --duration 1h
```

| Signal                               | What it means                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| RSS climbing steadily → crash        | Memory leak. Check if `@logtail/pino` was re-enabled or a new transport added. See issue 067.              |
| Event loop gap detected before crash | GC freeze or blocking operation. Check `gc-probe` times — if >100ms, heap is too large.                    |
| No gaps, RSS stable, still killed    | Liveness probe failure. Check if `/livez` is the probe target (not `/health`). Check `health-timing` logs. |
| OOMKilling event in kubectl          | Container exceeded 4096MB memory limit. Check for massive heap or external memory.                         |

### Step 3: Exit 1 — What threw?

Check Porter's container logs for the stack trace:

```bash
porter kubectl --cluster <CLUSTER_ID> -- logs -n default -l "app.kubernetes.io/name=cloud-prod-cloud" --previous --tail=50
```

Look for `error:` followed by a stack trace. Common patterns:

| Error                                                  | Cause                                                           | Fix                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Cannot track resources on a disposed ResourceTracker` | Race condition: async operation completes after session dispose | Fixed in issue 068. Should not recur — global handler catches it now.                         |
| `Soniox WebSocket connection timeout`                  | Soniox API unreachable, unhandled rejection                     | Fixed in issue 070. Global `unhandledRejection` handler prevents crash.                       |
| Any `unhandledRejection`                               | A promise rejected without a `.catch()`                         | Check BetterStack for `feature="unhandled-rejection"`. File a bug for the specific call site. |

### Step 4: Check if it's Cloudflare, not us

If the BetterStack status code is **521**:

```bash
bstack health
```

If all regions show high uptime and sessions > 0, the server is fine. 521 = Cloudflare couldn't reach the origin. Check:

- [Cloudflare Status](https://www.cloudflarestatus.com/)
- Azure status for the cluster's region
- Whether the incident auto-resolved within 5 minutes (typical for network blips)

See issue 072 for a documented example.

## Fix

### Memory leak (exit 137, RSS climbing)

1. Check if the logging transport changed — the `@logtail/pino` transport caused 15 MB/min heap growth (issue 067)
2. Check `disposedSessionsPendingGC` in system-vitals — if > 0, sessions are leaking
3. Take a heap snapshot if the pod is still alive: `analyze-heap.ts live --host=<REGION_HOST>`

### Unhandled rejection (exit 1)

1. The global handler (issue 070) should prevent this now — check BetterStack for `feature="unhandled-rejection"`
2. If you find one, file a bug for the specific call site and add a `.catch()` handler
3. The server stays alive — the individual operation fails but other users are unaffected

### Liveness probe failure (exit 137, no OOM, no gaps)

1. Check if liveness probe is on `/livez` (lightweight) not `/health` (heavy):
   ```bash
   porter kubectl --cluster <CLUSTER_ID> -- describe pod -n default -l "app.kubernetes.io/name=cloud-prod-cloud" | grep -i liveness
   ```
2. If it's on `/health`, update via Porter dashboard → Services → Health Checks → Advanced → Liveness → `/livez`
3. Check `health-timing` logs for slow `/health` responses:
   ```bash
   bstack sql "SELECT dt, JSONExtract(raw, 'durationMs', 'Nullable(Float64)') as ms FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 1 HOUR AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'health-timing' AND JSONExtract(raw, 'region', 'Nullable(String)') = '<REGION>' ORDER BY ms DESC LIMIT 10"
   ```

### Cloudflare 521

No action needed. Monitor for auto-resolution (typically 3-5 minutes). If it persists > 10 minutes, check Cloudflare and Azure status pages.

## Verify

After the pod restarts:

```bash
bstack health
```

All regions should show `ok` status. Check that:

- Sessions are reconnecting (count climbing back up)
- RSS and heap are at baseline levels for the session count
- No new crashes in the next 10 minutes

```bash
bstack diagnostics --region <REGION> --duration 10m
```

Verify zero event loop gaps and GC probes within range.

## Prevent

| Crash type              | Prevention                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Heap growth → 137       | Logs go through Vector, not in-process transport. Monitor with `bstack memory`.            |
| GC freeze → 137         | Keep heap under 400MB. Distribute traffic via Cloudflare LB to reduce per-region sessions. |
| Unhandled rejection → 1 | Global handler catches all. Monitor `feature="unhandled-rejection"` in weekly error audit. |
| Liveness probe → 137    | Use `/livez` for liveness (zero computation). `/health` for readiness only.                |

## History

| Date      | Issue   | Root Cause                               | Resolution                                  |
| --------- | ------- | ---------------------------------------- | ------------------------------------------- |
| Mar 18-28 | 055-065 | `@logtail/pino` heap growth + GC freezes | Switched to Vector log collection (067)     |
| Mar 29    | 068     | ResourceTracker.track() throw → exit 1   | Run cleanup immediately instead of throwing |
| Mar 29    | 070     | Soniox WebSocket timeout → exit 1        | Global unhandledRejection handler           |
| Mar 30    | 072     | Cloudflare 521 — server was healthy      | No action needed — Cloudflare network blip  |
| Mar 30    | 074     | Timer closures pinning disposed sessions | Cleared 5 leaked timers in dispose() paths  |

## Cluster IDs

| Region     | Cluster ID | Health URL                  |
| ---------- | ---------- | --------------------------- |
| US Central | 4689       | `uscentralapi.mentra.glass` |
| France     | 4696       | `franceapi.mentra.glass`    |
| East Asia  | 4754       | `asiaeastapi.mentra.glass`  |
| US West    | 4965       | `uswestapi.mentraglass.com` |
| US East    | 4977       | `useastapi.mentraglass.com` |

---

## Tips & Tricks (Lessons Learned)

### Getting credentials

SRE credentials (BetterStack, admin JWT) are in Doppler project `mentra-sre`:

```bash
# Run any bstack command with SRE credentials injected
doppler run --project mentra-sre --config dev -- bstack health
doppler run --project mentra-sre --config dev -- bstack incidents --limit 10

# Or export for a session
export BETTERSTACK_USERNAME=$(doppler secrets get BETTERSTACK_USERNAME --project mentra-sre --config dev --plain)
export BETTERSTACK_PASSWORD=$(doppler secrets get BETTERSTACK_PASSWORD --project mentra-sre --config dev --plain)
export BETTERSTACK_API_TOKEN=$(doppler secrets get BETTERSTACK_API_TOKEN --project mentra-sre --config dev --plain)
export MENTRA_ADMIN_JWT=$(doppler secrets get MENTRA_ADMIN_JWT --project mentra-sre --config dev --plain)
```

Cloud runtime secrets (MONGO_URL, SONIOX_API_KEY, etc.) are in Doppler project `mentraos-cloud` — configs: `dev`, `dev_debug`, `staging`, `prod_central-us`, etc. **Don't put SRE tokens in the cloud project.**

### BetterStack log table gotchas

- **Hot storage** (`remote(t373499_mentracloud_prod_logs)`) only has the last few minutes of data. If you're investigating something older, you get zero rows.
- **Historical/S3 storage** (`s3Cluster(primary, t373499_mentracloud_prod_s3)`) has everything but is slower (~3-5s per query) and requires `WHERE _row_type = 1` for log rows.
- **Dev/debug logs** go to `remote(t373499_augmentos_logs)` (the dev source), NOT the prod source.
- The `json` column exists in DESCRIBE but you can't use `json.field` dot notation. Use `JSONExtractString(raw, 'field')` instead.
- Pino fields: `level` is a string ("error"/"warn"/"info"), `message` (not `msg` — Vector renames it), `service`, `region`, `feature`, `userId`.

### BetterStack query patterns that work

```sql
-- Errors for a specific user (last 15 min, hot storage)
SELECT dt, JSONExtractString(raw, 'level') as lvl,
       JSONExtractString(raw, 'message') as message,
       JSONExtractString(raw, 'service') as svc
FROM remote(t373499_augmentos_logs)
WHERE raw LIKE '%isaiahballah%'
  AND JSONExtractString(raw, 'level') IN ('error', 'warn')
  AND dt > now() - INTERVAL 15 MINUTE
ORDER BY dt DESC LIMIT 20

-- System vitals over time (historical, for a specific region)
SELECT toStartOfHour(dt) as hour,
       avg(JSONExtractFloat(raw, 'rssMB')) as rss,
       avg(JSONExtractInt(raw, 'activeSessions')) as sessions,
       avg(JSONExtractInt(raw, 'disposedSessionsPendingGC')) as leaked
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type = 1
  AND JSONExtractString(raw, 'feature') = 'system-vitals'
  AND JSONExtractString(raw, 'region') = 'france'
  AND dt > now() - INTERVAL 16 HOUR
GROUP BY hour ORDER BY hour ASC

-- Raw log snippet (when you don't know the field names)
SELECT dt, substring(raw, 1, 300) as snippet
FROM remote(t373499_augmentos_logs)
WHERE raw LIKE '%keyword%' AND dt > now() - INTERVAL 5 MINUTE
ORDER BY dt DESC LIMIT 5
```

### Debug environment has no logs?

The debug cloud needs `LOG_STDOUT_JSON=true` to output JSON that Vector can parse. Without it, pino-pretty outputs human-readable text and Vector ignores it. This is set in `porter.yaml` as of issue 074. If a new environment has no logs in BetterStack, check this first.

Vector is already deployed on cluster 4689 (DaemonSet in `betterstack` namespace) and filters for `cloud-debug-cloud` containers. No additional Vector install needed.

### When you can't see logs, use kubectl directly

```bash
# Find the pod
porter kubectl --cluster 4689 -- get pods -n default | grep debug

# Tail logs (last 100 lines, grep for your keyword)
porter kubectl --cluster 4689 -- logs -n default <POD_NAME> --tail=100 | grep -i "error\|timeout\|captions"

# Live follow
porter kubectl --cluster 4689 -- logs -n default <POD_NAME> -f | grep -i error
```

### Heap snapshot analysis

**WARNING: Taking a heap snapshot on a loaded server doubles memory usage temporarily. On a server at 400MB+ with many sessions, this WILL cause OOM.** Only take snapshots on low-traffic environments or right after a restart when memory is low.

```bash
# Fetch a Bun heap snapshot (saves as JSON, loadable in Chrome DevTools Memory tab)
doppler run --project mentra-sre --config dev -- \
  bun run packages/cloud/src/scripts/analyze-heap.ts fetch \
  --host=uscentralapi.mentra.glass --out=.heap/

# Analyze object counts
doppler run --project mentra-sre --config dev -- \
  bun run packages/cloud/src/scripts/analyze-heap.ts snapshot \
  --file=.heap/uscentralapi-TIMESTAMP.json

# Live memory tracking (polls /api/admin/memory/now every 30s)
doppler run --project mentra-sre --config dev -- \
  bun run packages/cloud/src/scripts/analyze-heap.ts live \
  --host=franceapi.mentra.glass --interval=10 --duration=300
```

Key things to look for in the snapshot:
- `UserSession` count vs `activeSessions` from health endpoint — difference = phantom sessions
- `Timeout` count — should be ~20× active sessions. Much higher = leaked timers
- All manager types (DashboardManager, DeviceManager, etc.) should equal UserSession count

### Timer leak investigation process

If `disposedSessionsPendingGC` is climbing and GC is freeing 0MB:

1. **Confirm the pattern**: check `disposedSessionsPendingGC` over time in system-vitals. If it climbs from 0 to 5+ over hours, sessions are being retained.
2. **Take a heap snapshot** (on a low-traffic env) and check object counts — UserSession count should match activeSessions.
3. **Audit timers**: `grep -rn "setInterval\|setTimeout" cloud/packages/cloud/src/services/session/ --include="*.ts"` — for each timer, verify it's stored in a variable AND cleared in the owning class's `dispose()` method.
4. **Red flags**:
   - `setTimeout(() => ..., N)` with no variable assignment = untracked, can't be cancelled
   - `setInterval` in a class whose `dispose()` doesn't `clearInterval` it
   - Module-level Maps/Sets that hold closures capturing session references
   - Recursive `setTimeout(fn, 100)` polling with no disposed guard
   - Closures that capture `this` (the session) without checking `this.disposed`
5. **Fix pattern**: store timer in a variable, clear in `dispose()`, add `if (this.disposed) return` guard in callbacks.

### Pre-push build verification

Always run before pushing to avoid CI failures:

```bash
cd cloud && bun run ci
```

This runs the same build sequence as `Dockerfile.porter` locally in ~7 seconds: types → display-utils → sdk → utils → cloud. If it passes, CI will pass.

### Maintain this runbook

After every investigation, add what you learned:
- New query patterns that worked
- Tools/credentials that were hard to find
- Failure modes you discovered
- Things that took multiple attempts to figure out
- Environment-specific gotchas (debug vs prod differences)
