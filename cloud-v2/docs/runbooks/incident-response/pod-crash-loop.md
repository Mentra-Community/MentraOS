# A service's pods keep restarting (crash loop)

## Trigger

- Porter dashboard shows a service with "CrashLoopBackOff" or repeated
  "Non-zero exit code" events
- `/ready` returns 503 for that service
- BetterStack uptime alert fires (when we wire alerting)
- Users report errors that map back to that service being unavailable

## Quick check (30 sec)

```bash
porter app list                                # find the affected app
porter app logs cloud-v2 --service core --limit 50   # or --service audio
porter kubectl -- get pods -l porter.run/app-name=cloud-v2
```

Look at the `RESTARTS` column. A pod with 5+ restarts in a few minutes
is crashlooping.

## Diagnose (2–5 min)

### Step 1: What was the exit code?

```bash
porter kubectl -- describe pod -l porter.run/app-name=cloud-v2,porter.run/service-name=core | grep -A8 "Last State"
```

| Exit code | Meaning | Next step |
| --- | --- | --- |
| **0** | Clean shutdown | Check if a deploy was just rolling out — likely fine |
| **1** | Unhandled exception (code bug) | Go to "Exit 1" |
| **137** | SIGKILL (K8s killed it) | Go to "Exit 137" |
| **143** | SIGTERM acknowledged but didn't exit in time | Graceful-shutdown issue; pod is fine to restart |

### Step 2: Look at the logs leading up to the crash

```bash
# Last 200 lines of the previous container (the one that crashed)
porter kubectl -- logs -l porter.run/app-name=cloud-v2,porter.run/service-name=core --previous --tail=200

# Or via Porter's log search
porter app logs cloud-v2 --service core --since 10m --search "error"
```

Common things to look for:
- `MongoParseError` / `ECONNREFUSED` → MONGO_URL is wrong or Atlas is down
- `Stream isn't writeable` / Redis errors → REDIS_URL is wrong or
  ElastiCache is unreachable (cluster-only access — pod must be in the
  right VPC)
- `MENTRA_JWT_PRIVATE_KEY is not set` → env group not attached or stale
- `AccessTokenError` / `JWT verification failed` → keypair mismatch
  between core (signs) and audio/proxy (verifies)

### Step 3: Was a deploy just rolling?

```bash
porter app list   # check "CREATED AT" — if very recent, this is the rollout
```

If a deploy is in progress, the old pods are draining (SIGTERM) and new
pods are coming up. Brief 503s are normal during rolling deploys. Wait
2–3 minutes and re-check.

If the new revision is the bad one, roll back:

```bash
porter app rollback cloud-v2
```

## Exit 1 (unhandled exception)

The process threw and Bun exited. The stack trace in logs tells you where.

Common cloud-v2 causes:

1. **Bun.serve port already in use** — happens if two pods on the same
   node race; very rare since K8s schedules them. Restart fixes.
2. **Mongoose model registration after connect** — TS code in
   `models/*.model.ts` registers schemas on import; if a hot reload
   misfires it can re-register. Not a concern in prod (no hot reload).
3. **JSON parse error in worker postMessage** — malformed IPC. Look for
   `[audio-worker]` logs around the crash. Worker death triggers pool
   respawn; if the pool can't respawn (e.g., bad WORKER_URL), the whole
   audio service crashes.
4. **Env-loading throw at startup** — `requireEnv()` in
   `session.service.ts` throws if `MENTRA_JWT_PRIVATE_KEY` etc. are
   missing. Check the env group has all required keys.

## Exit 137 (SIGKILL)

K8s killed the pod. Usually OOM (Out Of Memory) or failed liveness probe.

### Was it OOM?

```bash
porter kubectl -- describe pod <pod-name> | grep -i "OOMKilled\|reason"
```

If yes: bump `ramMegabytes` in `porter.yaml` (core defaults to 1024, audio
2048 — try doubling). Re-deploy. Watch for steady-state memory growth in
metrics; a sustained climb means a leak.

Possible v2 leaks (none confirmed yet but worth checking):
- ioredis client per worker × user — if workers don't clean up on
  DETACH_USER, connections pile up
- LC3Decoder instances per user — same; check the worker's `decoders` Map
  shrinks on detach
- Soniox session leaks — `session.close()` must be awaited

### Was it failed liveness?

```bash
porter kubectl -- describe pod <pod-name> | grep -A2 "Liveness probe failed"
```

`/healthz` should be cheap — if it's failing, the event loop is blocked.

In cloud-v2 we deliberately keep `/healthz` minimal (just returns
`{ status: "ok" }`). If it's still failing, something is blocking the
event loop hard:
- Large XADDs / pipelining gone wrong
- Synchronous LC3 decode in main thread (workers should isolate this)
- Mongoose connection draining

## What changed?

Almost every crash-loop incident has the answer in "what changed in the
last 24h." Check:

- Latest `porter apply` revision time
- Doppler audit log: `doppler activity --config dev_aws --limit 20`
- Atlas / ElastiCache console for any maintenance events
- GitHub commits to `cloud-v2/` in the last day

If you can't find a change, the issue is environmental (Mongo / ElastiCache
hiccup, AWS event). Check status pages.

## Mitigation

If it's an emergency and you need to stop the bleeding:

1. **Roll back**: `porter app rollback cloud-v2`
2. **Scale down**: in `porter.yaml`, set `instances: 0` for the bad
   service and apply. (Trade availability for no crash spam.)
3. **Disable the affected feature**: if it's e.g. Soniox burning out the
   pod, confirm `SONIOX_API_KEY` is present in Doppler and redeploy.

## Lessons we've already learned (from v1)

- **`/healthz` must be cheap.** v1 issue 057: `/health` did session iteration +
  metrics gauging + JSON serialize. Under load it took >5s, K8s killed
  pods that were actually fine. Fix: `/livez` returns "ok" with no work;
  `/health` is for `/ready`. In cloud-v2 these are `/healthz` and `/ready`
  respectively and we kept them lean.
- **Cloud never closes WS for inactivity.** v1 issue 034/035: nginx
  ingress's `proxy-send-timeout: 60s` would fire on client silence
  (audio moved to UDP, WS had no traffic). Fix: bump nginx WS timeout to
  3600s, app-level pings from CLIENT to detect dead connections.
  See `docs/issues/002-cloud-runtime/audio/design.md` — we carry this forward in
  cloud-v2.
- **VAD silence is not a death signal.** v1 issue 044: Soniox stream
  closed on 2s of silence. Fix: pause-on-gap (Soniox SDK feature),
  resume on next audio. Cloud-v2's mock provider doesn't have this
  concern yet; SonioxProvider port will need it.

## How to prevent / detect earlier

- Add `instances: 2` minimum so a single pod crash doesn't drop user-visible
  availability
- Wire BetterStack uptime alerts on `/ready` for both services
- Add a synthetic monitor that connects via TestClient against the deployed
  services every 5 minutes (proves auth + WS + transcript flow end-to-end)
  *(TODO)*
