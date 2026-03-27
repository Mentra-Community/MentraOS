# Context for Next Conversation

This file exists because the AI agent loses all conversation history between sessions. These are operational notes — CLIs, tools, gotchas, infrastructure state, and things learned the hard way.

---

## Current State (as of March 27, 2026)

### What just shipped

PR #2319 merged to `main` → deployed to all prod regions. Contains:
- 7 memory leak / correctness fixes (ManagedStreamingExtension interval, Soniox listener cleanup, 4 missing dispose calls, identity check on session map delete, email case normalization, disposed guards on scheduled reconnects)
- Observability additions (event loop lag warnings, `/health` enrichment, `/livez`, SystemVitalsLogger, heap snapshot admin endpoint)
- Docs: issues 055, 056, 057

**Cloud-prod US Central was running with 68 sessions, 0 restarts, 1.07ms event loop lag at deploy time.**

Previous crash rate: ~8/day. If it drops to <2/day, the memory leaks were the cause.

### Cherry-pick needed

The hotfix went `main` directly (hotfix branch). It needs to be cherry-picked into `dev` so the fixes aren't lost when `dev` eventually merges to `main`. The commit to cherry-pick is the squashed one on `main` from PR #2319.

### Infrastructure already set up

| Thing | Status | Details |
|-------|--------|---------|
| BetterStack Collector (US Central) | ✅ Running | Cluster 4689. Installed via `porter helm --`. Helm release: `better-stack-collector`. Collector ID: 60277. Needs tolerations `operator=Exists` on both collector and ebpf containers to schedule on Porter nodes. |
| BetterStack Collector (other 4 clusters) | ❌ Not installed | East Asia (4754), France (4696), US West (4965), US East (4977). Same process — create collector via API, install via Porter Helm. |
| BetterStack source: MentraCloud - Prod | ✅ Created, not pointed to | ID: 2324289, token stored in notes (NOT in docs — see cloud/.env). Prod and staging Porter envs need BETTERSTACK_SOURCE_TOKEN updated. |
| BetterStack source: AugmentOS (old) | ✅ Active | ID: 1311181. Currently receives ALL logs (prod + dev + local + staging). Will become dev/local only after migration. |
| Uptime monitor: prod.augmentos.cloud/health | ✅ Active | ID: 3355604. 60s checks, keyword "status":"ok", 10s confirmation. 69 incidents in March. |
| Response-time uptime monitor | ❌ Not created | Spec says: alert when >3s sustained for 2 minutes. |
| Error tracking (@sentry/bun) | ❌ Not set up | BetterStack has Sentry-compatible error tracking. ~30 min setup. |
| Deploy Slack annotations | ❌ Not set up | Needs SLACK_DEPLOY_WEBHOOK secret in GitHub. |
| MEMORY_TELEMETRY_ENABLED | ❌ Still disabled | Set to `true` in Porter env for all prod/staging. Zero code change. |

---

## How to Use the Tools

### Porter CLI

```bash
# Porter is installed at /usr/local/bin/porter
# Config: cluster 4689 (US Central), project 15081
# Always ignore the "new version available" warning

# Get pods
porter kubectl -- get pods --namespace=default | grep cloud-prod

# Describe a pod
porter kubectl -- describe pod <pod-name>

# Check deploy image
porter kubectl -- get pod <pod-name> -o jsonpath='{.spec.containers[0].image}'

# Helm operations (for BetterStack collector etc)
porter helm -- list
porter helm -- upgrade better-stack-collector better-stack/collector --set collector.env.COLLECTOR_SECRET="$SECRET"

# Switch clusters (for multi-region work)
porter config set-cluster  # interactive — pick from dropdown
```

**GOTCHA:** Porter uses the `default` namespace for everything, not `prod`. Don't look in namespace `prod`.

**GOTCHA:** Kubernetes events expire after ~1 hour. Don't rely on them for historical data.

**GOTCHA:** `porter helm --` (not `helm` directly). Going through Porter ensures correct kubeconfig/cluster context.

### BetterStack MCP Tools

The BetterStack MCP server is already configured. Key tools:

```
# Querying logs (use source ID 1311181 for current logs, 2321796 for collector metrics)
telemetry_query — runs ClickHouse SQL against BetterStack data

# IMPORTANT: Dashboard charts use {{source}} which resolves to the METRICS table.
# Our log-based queries need the LOGS table. For dashboards, use collector metrics (source 2321796).
# For ad-hoc log queries, use telemetry_query with s3Cluster() for historical or remote() for recent.

# Log query patterns:
# Recent (last 30 min): FROM remote(t373499_augmentos_logs)
# Historical: FROM s3Cluster(primary, t373499_augmentos_s3) WHERE _row_type = 1
# Collector metrics: FROM remote(t373499_mentra_us_central_metrics)

# Fields are inside the `raw` JSON column:
# JSONExtract(raw, 'level', 'Nullable(String)') AS level
# JSONExtract(raw, 'message', 'Nullable(String)') AS message
# JSONExtract(raw, 'server', 'Nullable(String)') AS server  -- 'cloud-prod', 'cloud-local', etc.
# JSONExtract(raw, 'service', 'Nullable(String)') AS service
# JSONExtract(raw, 'feature', 'Nullable(String)') AS feature -- 'system-vitals', 'event-loop-lag'

# Collector metrics use label() function:
# label('_service') = 'default/Deployment/cloud-prod-cloud'
# Use avgMerge(rate_avg) for CPU rate, not raw value (it's a counter)

# Uptime tools
uptime_list_monitors_tool — see all monitors
uptime_list_incidents_tool — see crash history (monitor_id: 3355604)
uptime_get_monitor_availability_tool — SLA data

# Creating BetterStack resources (ALWAYS confirm with user first)
telemetry_create_source_tool — creates log/metric sources
# Collector creation: use curl to POST to https://telemetry.betterstack.com/api/v1/collectors
# API token is in cloud/.env as BETTERSTACK_API_TOKEN
```

### GitHub CLI

```bash
# PR operations
gh pr view <number> --json comments
gh pr checks <number>

# Reply to PR review comments
gh api repos/Mentra-Community/MentraOS/pulls/<PR>/comments/<comment-id>/replies -f body="message"

# Check deploy status
gh run list --workflow=porter-prod.yml --limit 5

# Can't mark review comments as "resolved" via API — UI only
```

### Building and Testing

```bash
# ALWAYS build locally before pushing
cd cloud/packages/cloud && bun run build

# This runs: mkdir -p dist && bun x tsc -p tsconfig.json
# If this passes, CI will pass. If this fails, CI will fail.
# There is NO excuse for pushing code that doesn't build.

# Run the benchmark script
cd cloud/packages/cloud && bun run src/scripts/benchmark-cpu-suspects.ts
```

---

## Key Gotchas Learned the Hard Way

### Security
- **NEVER put real tokens in markdown files.** Use `$VARIABLE_NAME` or `(stored in cloud/.env)`. We leaked tokens in a PR and had to force-push to clean history.
- **cloud/.env is gitignored** — tokens there are safe. But anything in `cloud/issues/` is public.
- **Heap snapshot endpoint MUST be behind admin auth.** We accidentally added one without auth, caught by PR review bots.

### Process
- **Always write the design doc BEFORE implementing.** We skipped this and the TypeScript build broke because we called `removeAllListeners()` on a Soniox SDK type that doesn't declare it.
- **The doc flow is: spike → spec → design → implement.** Don't skip steps.
- **Always confirm with the user before creating BetterStack sources, installing Helm charts, or making any infrastructure changes.**
- **Don't push to main, staging, or dev.** Ever. The user creates PRs manually.

### Soniox SDK
- `RealtimeSttSession` uses a custom `TypedEmitter`, not Node's EventEmitter.
- It exposes `.on()`, `.off()`, `.once()` — but NOT `.removeAllListeners()` in the type definition (the method exists at runtime but TypeScript doesn't know about it).
- Store listener references as class fields, use typed `.off()` per listener. Don't cast to `any`.
- Remove listeners AFTER `session.finish()` (in a `finally` block), not before — otherwise `finalized`/`finished` handlers can't flush final transcript data.

### Porter / Kubernetes
- Porter manages apps via Helm. Don't `kubectl apply` directly — it breaks Porter.
- Use `porter helm --` for Helm chart installs (not raw `helm`).
- Porter nodes have taints: `removable=true:NoSchedule` and `porter.run/node-group-id=...:NoSchedule`. DaemonSets (like the BetterStack collector) need `tolerations[0].operator=Exists` to schedule.
- The BetterStack collector eBPF container needs privileged access. Verified working on Porter AKS clusters (kernel 5.15+).
- Pod annotations for Prometheus scraping: `prometheus.io/scrape: "true"`. Not yet added to porter.yaml.

### BetterStack
- Dashboard `{{source}}` resolves to the **metrics** collection, not logs. Log-based queries CAN'T work in dashboard charts. Use the Explore page for log queries, or emit proper metrics via the collector.
- The collector source (mentra-us-central, ID 2321796) has actual metrics that dashboard charts CAN use.
- Log volume: ~21M logs/day total, ~11M from cloud-prod alone. About half is from non-prod (cloud-local, cloud-staging). Separate sources are planned (MentraCloud - Prod created but not pointed to).
- 884K identical `app-server` errors per day from the dashboard app. This is the `system.augmentos.dashboard` session error spam.

### Cloud Architecture
- Single-threaded Bun event loop. When CPU crosses ~1 core, the event loop saturates and everything backs up. GC/JIT threads push total CPU to 3-5 cores. This is confirmed by collector data.
- Sessions are in-memory `Map<string, UserSession>`. No persistence. Pod restart = all sessions lost.
- ~50-65 sessions is the practical limit per pod before CPU saturation.
- The server crashes via liveness probe failure: `/health` can't respond within 1s (now 3s with `/livez`) for 15 consecutive checks (75 seconds) → SIGKILL.

---

## File Locations

| What | Path |
|------|------|
| Cloud server source | `cloud/packages/cloud/src/` |
| Porter YAML | `cloud/porter.yaml` |
| Porter prod workflow | `.github/workflows/porter-prod.yml` |
| Porter debug workflow | `.github/workflows/porter-debug.yml` |
| Issue docs | `cloud/issues/{number}-{name}/` |
| Doc guidelines | `cloud/issues/README.md` |
| Benchmark script | `cloud/packages/cloud/src/scripts/benchmark-cpu-suspects.ts` |
| SystemVitalsLogger | `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts` |
| MetricsService | `cloud/packages/cloud/src/services/metrics/MetricsService.ts` |
| UserSession | `cloud/packages/cloud/src/services/session/UserSession.ts` |
| WebSocket handlers | `cloud/packages/cloud/src/services/websocket/bun-websocket.ts` |
| Hono app (routes) | `cloud/packages/cloud/src/hono-app.ts` |
| Server entry | `cloud/packages/cloud/src/index.ts` |
| Admin routes | `cloud/packages/cloud/src/api/hono/routes/admin.routes.ts` |
| ManagedStreamingExtension | `cloud/packages/cloud/src/services/streaming/ManagedStreamingExtension.ts` |
| SonioxSdkStream | `cloud/packages/cloud/src/services/session/transcription/providers/SonioxSdkStream.ts` |
| TranscriptionManager | `cloud/packages/cloud/src/services/session/transcription/TranscriptionManager.ts` |
| TranslationManager | `cloud/packages/cloud/src/services/session/translation/TranslationManager.ts` |
| MemoryLeakDetector | `cloud/packages/cloud/src/services/debug/MemoryLeakDetector.ts` |
| MemoryTelemetryService | `cloud/packages/cloud/src/services/debug/MemoryTelemetryService.ts` |

---

## Porter Cluster IDs

| Region | Cluster ID | Deployment Target ID |
|--------|-----------|---------------------|
| US Central | 4689 | 4a24a192-04c8-421f-8fc2-22db1714fdc0 |
| East Asia | 4754 | 7ed60823-5c81-40a8-8162-95cb0e1e1480 |
| France | 4696 | 6d7f479b-fd7e-4f5d-83ad-154edc538012 |
| US West | 4965 | 540690ee-b1d7-4a5e-80e9-683d11001c75 |
| US East | 4977 | 2b421266-64ab-46d4-bf29-55b3223392ee |

---

## BetterStack Source/Collector IDs

| Resource | ID | Purpose |
|----------|-----|---------|
| AugmentOS (logs) | 1311181 | Current log source — receives all environments |
| MentraCloud - Prod (logs) | 2324289 | New prod-only source — created, not yet pointed to |
| mentra-us-central (collector) | 2321796 | Collector metrics from US Central cluster |
| Collector (US Central) | 60277 | The collector instance config |
| Uptime monitor (prod health) | 3355604 | Checks prod.augmentos.cloud/health every 60s |