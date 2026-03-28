# Context for Next Conversation

This file exists because the AI agent loses all conversation history between sessions. These are operational notes — CLIs, tools, gotchas, infrastructure state, and things learned the hard way.

---

## Current State (as of March 27, 2026 — end of day)

### What shipped today

**Doppler migration (complete):**

- All 8 Porter apps across 5 clusters now use Doppler env groups as the sole source of env vars
- All manual Porter env vars deleted from every app (using `--skip-redeploys`)
- Doppler project: `mentraos-cloud` with configs: `prod` (base), `prod_central-us`, `prod_france`, `prod_east-asia`, `prod_us-west`, `prod_us-east`, `dev`, `dev_debug`, `staging`, `staging_stress`
- Region-specific vars (`UDP_HOST`, `CLOUD_HOST_NAME`, `CLOUD_LOCAL_HOST_NAME`, `CLOUD_PUBLIC_HOST_NAME`, `UDP_PORT`, `PORTER_APP_NAME`) removed from base `prod` — only in regional configs. Ensures new regions fail loudly if not configured.
- `UDP_HOST` updated to DNS hostnames (e.g., `udp-prod-uscentral.mentraglass.com`) instead of raw IPs for all configs
- `REGION` env var added to all configs (was missing — logs showed `region: ""`)
- Fixed stale values: `ADMIN_EMAILS` (removed ex-employee), `ADDITIONAL_PRE_INSTALLED_APPS` (removed deprecated app), `DELETE_APP_BY_PACKAGE_NAME` (updated package names)
- `R2_*` vars added to all Doppler configs (were missing — only `CLOUDFLARE_R2_*` existed, which is for a different service)
- `OPEN_WEATHER_API_KEY` added to all configs (was missing everywhere)

**BetterStack log source migration:**

- `BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_ENDPOINT` updated in Doppler `prod` base + `staging` configs to point at new MentraCloud - Prod source (ID 2324289)
- `LOG_LEVEL=info` set for staging + staging_stress (was sending debug — ~1.5M unnecessary logs/day)
- **Pods need redeploy to pick up these changes** — Doppler syncs at deploy time, not live

**BetterStack Collectors installed on ALL 5 clusters:**

- US Central (4689): collector 60277, source 2321796 — already running
- France (4696): collector 60500, source 2326580 — installed
- East Asia (4754): collector 60501, source 2326583 — installed
- US West (4965): collector 60502, source 2326586 — installed
- US East (4977): collector 60503, source 2326589 — installed

**SRE Dashboard built:**

- "MentraCloud SRE — US Central" (ID 973977) — 10 charts across 5 sections
- Uses collector metrics (source 2321796) — works with `{{source}}` in dashboard charts
- Sections: At a Glance, Memory — The Crash Signal, CPU, Crashes & Restarts, HTTP & Network

**Cloudflare Load Balancer fixed:**

- Session affinity disabled (was `ip_cookie` with 23hr TTL — was pinning users to wrong continent)
- `failover_across_pools` enabled (was false)
- Proximity steering configured with GPS coords for all 5 pools
- US East pool still missing a health monitor
- User reports proximity steering still not consistently routing to US West from SF — needs more investigation

**Crash investigation findings (issue 061):**

- Crashes are ~6-7/day across all regions — 057 fixes did NOT significantly reduce crash rate
- US Central crashes at 65-70 sessions, France crashes at 22-30 sessions — SAME timeline (~3-4 hours)
- Root cause chain: memory grows → GC thrashes → CPU spikes → event loop blocks → liveness probe timeout → SIGKILL
- NOT OOM kills (dashboard shows zero) — it's probe failure from CPU starvation
- Pod memory limit is 4GB but crashes at ~1GB RSS — increasing limit won't help
- `disposedSessionsPendingGC` dropped from 245 to 0-1 post-057 ✅ but crashes continue ❌

### Cherry-pick still needed

The hotfix went `main` directly (hotfix branch). It needs to be cherry-picked into `dev` so the fixes aren't lost when `dev` eventually merges to `main`. The commit to cherry-pick is the squashed one on `main` from PR #2319.

### Infrastructure state

| Thing                                       | Status                                | Details                                                                                 |
| ------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| Doppler env management                      | ✅ Complete                           | All 8 apps on 5 clusters use Doppler env groups. Zero manual Porter env vars.           |
| BetterStack Collector (all 5 clusters)      | ✅ Running                            | US Central (60277), France (60500), East Asia (60501), US West (60502), US East (60503) |
| BetterStack source: MentraCloud - Prod      | ✅ Token in Doppler, pending redeploy | ID: 2324289. Prod/staging Doppler configs updated. Pods need redeploy to switch.        |
| BetterStack source: AugmentOS (old)         | ✅ Active                             | ID: 1311181. Will become dev/local only after prod pods redeploy.                       |
| SRE Dashboard (US Central)                  | ✅ Built                              | ID: 973977. Collector metrics. 10 charts.                                               |
| Uptime monitor: prod.augmentos.cloud/health | ✅ Active                             | ID: 3355604. Still firing ~6-7 incidents/day.                                           |
| Response-time uptime monitor                | ❌ Not created                        | Spec says: alert when >3s sustained for 2 minutes.                                      |
| Error tracking (@sentry/bun)                | ❌ Not set up                         | BetterStack has Sentry-compatible error tracking. ~30 min setup.                        |
| Deploy Slack annotations                    | ❌ Not set up                         | Needs SLACK_DEPLOY_WEBHOOK secret in GitHub.                                            |
| MEMORY_TELEMETRY_ENABLED                    | ❌ Still disabled                     | Add to Doppler prod configs. Zero code change.                                          |
| Dashboard alerts (RSS > 800MB, restart)     | ❌ Not set up                         | SRE dashboard exists, alerts not configured.                                            |
| Prometheus scrape annotations               | ❌ Not in porter.yaml                 | Needed for application-level metrics in collector.                                      |
| Cloudflare LB proximity steering            | ⚠️ Partially working                  | Session affinity fixed, failover enabled. US West routing inconsistent.                 |

### New issue docs created today

| Issue                      | Doc      | What it covers                                                              |
| -------------------------- | -------- | --------------------------------------------------------------------------- |
| 059-env-var-cleanup        | spike.md | Full audit of every env var — dead vars, duplicates, naming inconsistencies |
| 060-betterstack-collectors | spike.md | Collector install process for all 5 clusters                                |
| 061-crash-investigation    | spike.md | Root cause analysis with dashboard/collector findings                       |

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
# Querying logs
# OLD source (dev/local — will become the only use after prod redeploy):
#   Source ID: 1311181, table: t373499.augmentos
#   Recent: FROM remote(t373499_augmentos_logs)
#   Historical: FROM s3Cluster(primary, t373499_augmentos_s3) WHERE _row_type = 1
#
# NEW source (prod/staging — active after next redeploy):
#   Source ID: 2324289, table: t373499.mentracloud_prod
#   Recent: FROM remote(t373499_mentracloud_prod_logs)
#   Historical: FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1
#
# IMPORTANT: Until prod pods redeploy, prod logs still go to OLD source (1311181).

# Dashboard charts use {{source}} which resolves to the METRICS table.
# Log-based queries DON'T work in dashboards. Use collector metrics for dashboards.

# Collector metrics (one source per cluster):
#   US Central: source 2321796, FROM remote(t373499_mentra_us_central_metrics)
#   France: source 2326580
#   East Asia: source 2326583
#   US West: source 2326586
#   US East: source 2326589
#
# Key collector metrics for crash investigation:
#   container_resources_memory_rss_bytes — THE crash signal
#   container_resources_cpu_usage_seconds_total — use avgMerge(rate_avg)
#   container_resources_cpu_throttled_seconds_total — CPU throttling
#   container_restarts_total — crash count (NOT deploys)
#   container_oom_kills_total — OOM kills (currently zero — crashes are probe failures)
#   container_net_tcp_active_connections — WebSocket/TCP connections
#   container_http_requests_total — HTTP request rate
#
# Filter to cloud-prod: AND label('_service') LIKE '%cloud-prod%'
# Filter to all cloud: AND label('_service') LIKE '%cloud%'

# Log fields are inside the `raw` JSON column:
# JSONExtract(raw, 'level', 'Nullable(String)') AS level
# JSONExtract(raw, 'message', 'Nullable(String)') AS message
# JSONExtract(raw, 'server', 'Nullable(String)') AS server  -- 'cloud-prod', 'cloud-local', etc.
# JSONExtract(raw, 'region', 'Nullable(String)') AS region  -- 'us-central', 'france', etc. (added March 27)
# JSONExtract(raw, 'service', 'Nullable(String)') AS service
# JSONExtract(raw, 'feature', 'Nullable(String)') AS feature -- 'system-vitals', 'event-loop-lag'

# Uptime tools
uptime_list_monitors_tool — see all monitors
uptime_list_incidents_tool — see crash history (monitor_id: 3355604)
uptime_get_monitor_availability_tool — SLA data

# Creating BetterStack resources (ALWAYS confirm with user first)
telemetry_create_source_tool — creates log/metric sources
# Collector creation: use curl to POST to https://telemetry.betterstack.com/api/v1/collectors
# API token is in cloud/.env as BETTERSTACK_API_TOKEN
```

### Doppler CLI

```bash
# Doppler is installed at /opt/homebrew/bin/doppler
# Always use --no-check-version to avoid interactive update prompts

# List configs
doppler configs --project mentraos-cloud --no-check-version

# Get a secret value
doppler secrets get VARIABLE_NAME --project mentraos-cloud --config prod --plain --no-check-version

# Set secrets (propagates to inheriting configs)
doppler secrets set "KEY=value" --project mentraos-cloud --config prod --no-check-version

# Delete secrets
doppler secrets delete KEY1 KEY2 --project mentraos-cloud --config prod --yes --no-check-version

# Download all secrets as env file
doppler secrets download --project mentraos-cloud --config prod --no-file --format env --no-check-version

# Create service token for Porter integration
doppler configs tokens create --project mentraos-cloud --config prod_us-east --plain "token-name" --no-check-version
```

**GOTCHA:** Doppler service tokens are per-config. There's no "whole account" service token in the `dp.st.*` format.

**GOTCHA:** Deleting a var from base `prod` removes it from regional configs that were inheriting it. Always verify regional configs after base changes.

**GOTCHA:** Porter's Doppler integration creates env groups per-cluster. The env group name must match exactly when linking via CLI (`porter app update --attach-env-groups`).

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

- Dashboard `{{source}}` resolves to the **metrics** collection, not logs. Log-based queries CAN'T work in dashboard charts. Use collector metrics for dashboards.
- Collectors now on ALL 5 clusters. Each has its own source ID (see BetterStack MCP Tools section above).
- SRE Dashboard (ID 973977) uses US Central collector metrics. Shows RSS memory, CPU, restarts, OOM kills, HTTP rate, TCP connections.
- MentraCloud - Prod source (ID 2324289) is in Doppler but pods haven't redeployed to switch yet. Until then, prod logs still go to old AugmentOS source (ID 1311181).
- Log volume: ~21M logs/day total. Staging now set to `LOG_LEVEL=info` which should reduce ~1.5M debug logs/day.
- 884K identical `app-server` errors per day from the dashboard app. This is the `system.augmentos.dashboard` session error spam.

### Doppler

- All env vars are now managed in Doppler, not Porter. NEVER set env vars manually in Porter.
- Project: `mentraos-cloud`. Configs mirror Porter apps/clusters.
- Regional configs inherit from base `prod` but have their own region-specific overrides.
- `R2_*` vars (mentra-store bucket) and `CLOUDFLARE_R2_*` vars (mentra-gallery bucket) are DIFFERENT — both needed.
- `CLOUD_HOST_NAME` is dead (zero code references). Only `CLOUD_PUBLIC_HOST_NAME` and `CLOUD_LOCAL_HOST_NAME` are used. Cleanup tracked in issue 059.

### Cloudflare Load Balancer

- Proximity steering with GPS coords for 5 pools: uscentral, france, asiaeast, us-west, us-east.
- Session affinity DISABLED (was ip_cookie with 23hr TTL — caused users to be pinned to wrong continent after travel).
- `failover_across_pools` ENABLED — if a region goes down, traffic reroutes to next closest.
- US East pool has no health monitor — needs one added.
- Cloudflare LB API token stored in cloud/.env as `CLOUDFLARE_LB_API_TOKEN`.

### Cloud Architecture

- Single-threaded Bun event loop. When CPU crosses ~1 core, the event loop saturates and everything backs up. GC/JIT threads push total CPU to 3-5 cores. Confirmed by SRE dashboard CPU chart.
- Sessions are in-memory `Map<string, UserSession>`. No persistence. Pod restart = all sessions lost.
- ~50-65 sessions is the practical limit per pod before CPU saturation on US Central.
- France crashes at only 22-30 sessions after ~3 hours — crash is time-based, not just session-count-based.
- The crash chain: memory grows → GC thrashes → CPU spikes → event loop blocks → `/health` can't respond within 1s for 15 consecutive checks (75s) → SIGKILL.
- NOT OOM kills — pod memory limit is 4096MB, crashes happen at ~1GB RSS. SRE dashboard confirms zero OOM kills.
- Increasing memory limit will NOT help — the bottleneck is CPU starvation from GC, not memory exhaustion.

---

## File Locations

| What                      | Path                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Cloud server source       | `cloud/packages/cloud/src/`                                                            |
| Porter YAML               | `cloud/porter.yaml`                                                                    |
| Porter prod workflow      | `.github/workflows/porter-prod.yml`                                                    |
| Porter debug workflow     | `.github/workflows/porter-debug.yml`                                                   |
| Issue docs                | `cloud/issues/{number}-{name}/`                                                        |
| Doc guidelines            | `cloud/issues/README.md`                                                               |
| Benchmark script          | `cloud/packages/cloud/src/scripts/benchmark-cpu-suspects.ts`                           |
| SystemVitalsLogger        | `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`                      |
| MetricsService            | `cloud/packages/cloud/src/services/metrics/MetricsService.ts`                          |
| UserSession               | `cloud/packages/cloud/src/services/session/UserSession.ts`                             |
| WebSocket handlers        | `cloud/packages/cloud/src/services/websocket/bun-websocket.ts`                         |
| Hono app (routes)         | `cloud/packages/cloud/src/hono-app.ts`                                                 |
| Server entry              | `cloud/packages/cloud/src/index.ts`                                                    |
| Admin routes              | `cloud/packages/cloud/src/api/hono/routes/admin.routes.ts`                             |
| ManagedStreamingExtension | `cloud/packages/cloud/src/services/streaming/ManagedStreamingExtension.ts`             |
| SonioxSdkStream           | `cloud/packages/cloud/src/services/session/transcription/providers/SonioxSdkStream.ts` |
| TranscriptionManager      | `cloud/packages/cloud/src/services/session/transcription/TranscriptionManager.ts`      |
| TranslationManager        | `cloud/packages/cloud/src/services/session/translation/TranslationManager.ts`          |
| MemoryLeakDetector        | `cloud/packages/cloud/src/services/debug/MemoryLeakDetector.ts`                        |
| MemoryTelemetryService    | `cloud/packages/cloud/src/services/debug/MemoryTelemetryService.ts`                    |

---

## Porter Cluster IDs

| Region     | Cluster ID | Deployment Target ID                 |
| ---------- | ---------- | ------------------------------------ |
| US Central | 4689       | 4a24a192-04c8-421f-8fc2-22db1714fdc0 |
| East Asia  | 4754       | 7ed60823-5c81-40a8-8162-95cb0e1e1480 |
| France     | 4696       | 6d7f479b-fd7e-4f5d-83ad-154edc538012 |
| US West    | 4965       | 540690ee-b1d7-4a5e-80e9-683d11001c75 |
| US East    | 4977       | 2b421266-64ab-46d4-bf29-55b3223392ee |

---

## Doppler Service Tokens (for Porter env groups)

| Porter Cluster    | App           | Env Group Name        | Doppler Config  |
| ----------------- | ------------- | --------------------- | --------------- |
| US Central (4689) | cloud-prod    | cloud-prod-central-us | prod_central-us |
| US Central (4689) | cloud-dev     | cloud-dev-doppler     | dev             |
| US Central (4689) | cloud-debug   | cloud-debug-doppler   | dev_debug       |
| US Central (4689) | cloud-staging | cloud-staging-doppler | staging         |
| France (4696)     | cloud-prod    | cloud-prod-france     | prod_france     |
| East Asia (4754)  | cloud-prod    | cloud-prod-east-asia  | prod_east-asia  |
| US West (4965)    | cloud-prod    | cloud-prod-us-west    | prod_us-west    |
| US East (4977)    | cloud-prod    | cloud-prod-us-east    | prod_us-east    |

Tokens stored in Doppler (service tokens are per-config, created via `doppler configs tokens create`). The Porter Doppler integration UI is at `dashboard.porter.run/integrations/doppler` per cluster.

## BetterStack Source/Collector IDs

| Resource                              | ID      | Purpose                                                      |
| ------------------------------------- | ------- | ------------------------------------------------------------ |
| AugmentOS (logs)                      | 1311181 | OLD log source — receives dev/local (prod until redeploy)    |
| MentraCloud - Prod (logs)             | 2324289 | NEW prod/staging source — token in Doppler, pending redeploy |
| mentra-us-central (collector metrics) | 2321796 | Collector metrics from US Central cluster                    |
| mentra-france (collector metrics)     | 2326580 | Collector metrics from France cluster                        |
| mentra-east-asia (collector metrics)  | 2326583 | Collector metrics from East Asia cluster                     |
| mentra-us-west (collector metrics)    | 2326586 | Collector metrics from US West cluster                       |
| mentra-us-east (collector metrics)    | 2326589 | Collector metrics from US East cluster                       |
| Collector (US Central)                | 60277   | Collector instance config                                    |
| Collector (France)                    | 60500   | Collector instance config                                    |
| Collector (East Asia)                 | 60501   | Collector instance config                                    |
| Collector (US West)                   | 60502   | Collector instance config                                    |
| Collector (US East)                   | 60503   | Collector instance config                                    |
| Uptime monitor (prod health)          | 3355604 | Checks prod.augmentos.cloud/health every 60s                 |
| SRE Dashboard (US Central)            | 973977  | 10 charts — memory, CPU, restarts, OOM, HTTP, TCP            |
| Old investigation dashboard           | 971353  | Log-based charts — mostly broken, superseded by 973977       |
