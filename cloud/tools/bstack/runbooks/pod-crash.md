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

## Cluster IDs

| Region     | Cluster ID | Health URL                  |
| ---------- | ---------- | --------------------------- |
| US Central | 4689       | `uscentralapi.mentra.glass` |
| France     | 4696       | `franceapi.mentra.glass`    |
| East Asia  | 4754       | `asiaeastapi.mentra.glass`  |
| US West    | 4965       | `uswestapi.mentraglass.com` |
| US East    | 4977       | `useastapi.mentraglass.com` |
