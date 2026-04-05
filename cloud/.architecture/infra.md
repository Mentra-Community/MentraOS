# MentraOS Cloud Infrastructure

**Last updated:** April 2, 2026

This document describes the infrastructure that runs the MentraOS cloud. It covers the deployment platform, observability stack, log collection, and cluster topology.

## What Is What

### Porter

Porter is the deployment platform. It sits on top of Kubernetes and provides a UI/CLI for deploying apps, managing clusters, viewing logs, and configuring services. Each Porter "application" maps to a Kubernetes deployment (pods, services, ingress). Porter manages Helm charts, Docker builds, rolling deploys, environment variables, health checks, and ingress configuration.

Porter clusters run on Azure Kubernetes Service (AKS).

### Kubernetes (K8s)

The container orchestration layer. Each Porter cluster is a K8s cluster running on Azure.

- **Node:** A virtual machine (Azure VM). Has CPU, RAM, disk, IP address. Multiple pods share a node's resources. A cluster has one or more nodes.
- **Pod:** A process running on a node. One pod = one process (one Bun instance for the cloud, one Node process for a MiniApp, etc.). Multiple pods run on the same node.
- **Deployment:** Manages pod replicas and rolling updates. New version = new pod created, old pod killed after the new one is ready.
- **Service:** Internal networking. Routes traffic between pods within the cluster.
- **Ingress:** External networking. nginx ingress controller routes external HTTP/WS traffic from the internet to the right service. We configure separate timeout rules for WebSocket paths (3600s) vs REST paths (60s).
- **DaemonSet:** Runs exactly one pod per node in the cluster. Used for log collectors that need to capture stdout from every node.
- **Liveness probe:** K8s periodically hits an endpoint to check if the process is alive. If it fails repeatedly, K8s sends SIGKILL (exit 137). Kills everything including existing WebSocket connections. Our liveness probe: `GET /livez`, zero computation, 3s timeout.
- **Readiness probe:** K8s periodically hits an endpoint to check if the pod can handle traffic. If it fails, K8s removes the pod from the load balancer (nginx stops routing NEW requests to it) but does NOT kill the pod. Existing WebSocket connections stay alive. This means a readiness failure causes REST requests to 503 while WebSockets keep working. When the probe passes again, the pod is added back to the load balancer. Our readiness probe: `GET /health`, 5s timeout. The `/health` endpoint iterates all sessions, counts WebSockets, updates gauges, and serializes JSON, so it's heavier than `/livez`.

**Readiness failure cascade:** A transient readiness probe failure (e.g. from a GC pause or MongoDB spike making `/health` slow) could cause the pattern where REST returns 503 but WebSocket is still connected. If the phone then tries to reconnect the WebSocket (because it sees 503s and thinks something is wrong), the reconnection is a NEW HTTP upgrade request which also gets rejected because the pod is still not-ready. This could cascade into both REST and WebSocket being broken even though the pod is alive. We currently have no visibility into when readiness probe failures happen or how long they last.

### BetterStack

The observability platform. Handles log ingestion, storage, querying (ClickHouse), alerting, dashboards, and uptime monitoring.

- **Source:** A log destination with its own ID, ingestion token, and ingesting host URL. Logs are sent to a source via HTTP POST. Each source has its own ClickHouse table for querying.
- **Platform types:**
  - `javascript` — A standard log source. Expects structured JSON logs sent via HTTP (e.g. from `@logtail/pino` or from our custom Vector Helm chart).
  - `collector` — A BetterStack-managed Helm chart that deploys a log collection agent as a DaemonSet on a K8s cluster. It collects ALL container stdout/stderr from the cluster and ships it to the source. No container filtering by default.
- **Hot storage:** Recent logs (last ~30 minutes) queryable via `remote()` in ClickHouse. Fast.
- **S3/cold storage:** Historical logs queryable via `s3Cluster()`. Slower. Requires `_row_type = 1` for logs, `_row_type = 3` for spans.
- **Live Tail:** Real-time log streaming in the UI. Queries top-level fields in the JSON (which is why we flatten Pino's nested fields in our Vector transform).

### Vector

An open-source log collection and transformation pipeline (originally by Timber, now Datadog). Used as a DaemonSet to collect container stdout, transform logs, and ship them to BetterStack.

We have a custom Vector config in `cloud/infra/betterstack-logs/values.yaml` that:

1. Filters to only cloud containers (`cloud-prod-cloud`, `cloud-staging-cloud`, `cloud-debug-cloud`, `cloud-dev-cloud`)
2. Parses Pino JSON from the `message` field
3. Flattens all Pino fields to the top level
4. Normalizes numeric log levels to strings (30 = "info", 40 = "warn", etc.)
5. Nests Vector metadata into `_meta` (kubernetes_pod, kubernetes_container, log_source)

This custom Vector Helm chart sends logs to the `MentraCloud - Prod` source (javascript type). It is separate from the BetterStack default collector.

### @logtail/pino

A Pino transport plugin that sends logs directly from a Bun/Node process to BetterStack via HTTP. Was removed from the cloud process in issue 067 because it caused ~15 MB/min heap growth. Replaced by stdout JSON picked up by Vector. Still present as a dependency of `@mentra/sdk`, which means MiniApps built with the SDK may still use it.

## Clusters

Each region runs on a separate Porter/K8s cluster on Azure. Dev, debug, and staging environments are separate Porter applications on the US Central cluster, not separate clusters.

| Cluster    | ID   | Region           | Status                                     | What runs on it                                                                  |
| ---------- | ---- | ---------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| US Central | 4689 | Azure Central US | Active, handling all US production traffic | cloud-prod, cloud-dev, cloud-debug, cloud-staging, all MiniApps, system services |
| France     | 4696 | Azure France     | Active                                     | cloud-prod (MiniApps status TBD)                                                 |
| East Asia  | 4754 | Azure East Asia  | Active                                     | cloud-prod (MiniApps status TBD)                                                 |
| US West    | 4965 | Azure West US    | Deployed, not receiving user traffic       | cloud-prod                                                                       |
| US East    | 4977 | Azure East US    | Deployed, not receiving user traffic       | cloud-prod                                                                       |

All MiniApps (captions, dashboard, translation, merge, mentra-notes, mentra-ai, mira, notify, live-translation, cactusai, etc.) are confirmed running on US Central. Whether France and East Asia also run MiniApps has not been verified.

### Porter applications on US Central

From container logs collected on April 2, 2026 (sorted by log volume):

| Porter App        | Container                      | Type                           | Log volume (2 hrs) |
| ----------------- | ------------------------------ | ------------------------------ | ------------------ |
| dashboard         | dashboard-dashboard            | MiniApp                        | 5.1M lines         |
| captions          | captions-captions              | MiniApp                        | 4.3M lines         |
| cloud-prod        | cloud-prod-cloud               | Cloud                          | 285K lines         |
| translation       | translation-translation        | MiniApp                        | 277K lines         |
| merge-2-prod      | merge-2-prod-web               | MiniApp                        | 43K lines          |
| mentra-notes-prod | mentra-notes-prod-mentra-notes | MiniApp                        | 11K lines          |
| aughog-prod       | aughog-prod-aughog             | MiniApp                        | 8K lines           |
| notify            | notify-notify                  | MiniApp                        | 5K lines           |
| mentra-ai-2-prod  | mentra-ai-2-prod-mentra-ai-2   | MiniApp                        | 3K lines           |
| cloud-staging     | cloud-staging-cloud            | Cloud (staging)                | 1.6K lines         |
| cloud-dev         | cloud-dev-cloud                | Cloud (dev)                    | 1.3K lines         |
| cloud-debug       | cloud-debug-cloud              | Cloud (debug)                  | 835 lines          |
| cloud-livekit     | cloud-livekit-cloud            | Legacy (should be removed)     | 216 lines          |
| + ~15 more        | various                        | Dev/test apps, streamers, etc. | minimal            |

## Porter Cloud Configuration

From `cloud/porter.yaml`:

- **CPU limit:** 5 cores
- **Memory limit:** 4096 MB (4 GB)
- **Port 80:** HTTP/WS (REST API, glasses-ws, app-ws)
- **Port 8000 (UDP):** Audio streaming
- **Liveness probe:** `GET /livez`, 3s timeout, 15s initial delay
- **Readiness probe:** `GET /health`, 5s timeout, 15s initial delay
- **Ingress timeouts:** 3600s for proxy-read and proxy-send (keeps WebSocket connections alive), 60s for proxy-connect
- **Prometheus scraping:** enabled on `/metrics` port 80, every 30s
- **Termination grace period:** 30s (time between SIGTERM and SIGKILL)
- **Environment:** LOG_LEVEL=info in porter.yaml, LOG_STDOUT_JSON set per-cluster in Porter dashboard

## BetterStack Sources

Seven sources, verified via BetterStack API on April 2, 2026.

| Source             | ID      | Type       | Retention | Created    | Purpose                                                                                              |
| ------------------ | ------- | ---------- | --------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| AugmentOS          | 1311181 | javascript | 7 days    | 2025-05-15 | Old source from before the Mentra rename. Still active.                                              |
| mentra-us-central  | 2321796 | collector  | 60 days   | 2026-03-25 | BetterStack default collector on US Central. Collects ALL container stdout. No filtering.            |
| MentraCloud - Prod | 2324289 | javascript | 90 days   | 2026-03-26 | Receives structured cloud logs from our custom Vector Helm chart. Filtered to cloud containers only. |
| mentra-france      | 2326580 | collector  | 90 days   | 2026-03-27 | Collector source for France cluster. Currently receiving zero logs (collector may not be installed). |
| mentra-east-asia   | 2326583 | collector  | 90 days   | 2026-03-27 | Collector source for East Asia cluster. Currently receiving zero logs.                               |
| mentra-us-west     | 2326586 | collector  | 90 days   | 2026-03-27 | Collector source for US West cluster. Currently receiving zero logs.                                 |
| mentra-us-east     | 2326589 | collector  | 90 days   | 2026-03-27 | Collector source for US East cluster. Currently receiving zero logs.                                 |

### Collector configuration (as of April 4, 2026)

Every cluster has a BetterStack Collector installed. Each collector sends filtered cloud logs + eBPF infrastructure metrics to its regional source. A VRL transformation on each collector filters logs to only cloud containers (names starting with `cloud-`). MiniApp stdout, K8s system pod logs, and all other non-cloud containers are dropped before ingestion.

Additionally, our custom Vector Helm chart (from issue 067) is still running on US Central, sending cloud-only logs to `MentraCloud - Prod`. This is technically a duplicate for US Central cloud logs, but `MentraCloud - Prod` receives logs from all regions (each region's custom Vector sends there) while the regional collector sources only contain their own region's data. Both are useful for different query patterns.

| Collector ID | Region     | Source            | Logs                  | Metrics      | VRL filter |
| ------------ | ---------- | ----------------- | --------------------- | ------------ | ---------- |
| 60277        | US Central | mentra-us-central | cloud containers only | eBPF enabled | Yes        |
| 60500        | France     | mentra-france     | cloud containers only | eBPF enabled | Yes        |
| 60501        | East Asia  | mentra-east-asia  | cloud containers only | eBPF enabled | Yes        |
| 60502        | US West    | mentra-us-west    | cloud containers only | eBPF enabled | Yes        |
| 60503        | US East    | mentra-us-east    | cloud containers only | eBPF enabled | Yes        |

## BetterStack Uptime Monitors

| Monitor                       | URL                                   | Status (Apr 2)      |
| ----------------------------- | ------------------------------------- | ------------------- |
| prod.augmentos.cloud/health   | https://prod.augmentos.cloud/health   | Up                  |
| global.augmentos.cloud/health | https://global.augmentos.cloud/health | Up                  |
| mira.augmentos.cloud/health   | https://mira.augmentos.cloud/health   | Up                  |
| Live captions global          | Porter internal URL                   | Down                |
| dashboard health              | Porter internal URL                   | Up                  |
| Dev Server Transcription      | Porter internal URL                   | Down (likely stale) |
| Prod Server Transcription     | Porter internal URL                   | Down (likely stale) |

URLs still use the old `augmentos.cloud` domain. Check frequency is 60s for all monitors. Monitors check for keyword `"status":"ok"` in the response.

## Log Flow

### Cloud process (production)

```
Cloud (Bun)
  → LOG_STDOUT_JSON=true
  → stdout (structured Pino JSON, info level and above)
  → Two paths:
    1. Our custom Vector DaemonSet → filters to cloud containers → MentraCloud-Prod source
    2. BetterStack default collector → no filter → mentra-us-central source (double ingestion)
```

Pino log level is set to "info" in production (`NODE_ENV=production`). Debug logs are never emitted to stdout.

### Cloud process (dev/local)

```
Cloud (Bun)
  → LOG_STDOUT_JSON not set
  → pino-pretty → console (human readable)
  → No BetterStack
```

### MiniApps (captions, dashboard, translation, etc.)

```
MiniApp (Bun/Node)
  → stdout (whatever the app logs, often very verbose)
  → BetterStack default collector picks up stdout → mentra-us-central source
  → Possibly also @logtail/pino direct to BetterStack (if the SDK dependency initializes it)
```

MiniApps are separate deployments with their own code. The `@mentra/sdk` package includes `@logtail/pino` as a dependency. Whether individual MiniApps initialize this transport depends on their code.

### Log level filtering

| Environment                          | Pino log level | What reaches stdout             | What reaches BetterStack                  |
| ------------------------------------ | -------------- | ------------------------------- | ----------------------------------------- |
| Production (NODE_ENV=production)     | info           | info, warn, error, fatal        | Same (collectors ship stdout as-is)       |
| Development (NODE_ENV != production) | debug          | debug, info, warn, error, fatal | Depends on whether a collector is running |

Neither the custom Vector config nor the BetterStack default collector filters by log level. All filtering happens at the application level (Pino config). If a MiniApp emits debug-level logs to stdout in production, the collector ships them.

## Known Issues

### Cloud log double ingestion on US Central

Cloud logs on US Central go to both `MentraCloud - Prod` (via our custom Vector Helm chart) and `mentra-us-central` (via the BetterStack Collector). This is intentional for now: `MentraCloud - Prod` has all regions in one source with Pino-flattened fields, while `mentra-us-central` has only US Central data plus infrastructure metrics. A future cleanup could remove the custom Vector and migrate all queries to the regional collector sources.

### No readiness probe visibility

We do not log or alert when K8s marks the cloud pod as not-ready due to a `/health` timeout. This is a potential cause of REST 503 errors and WebSocket reconnection failures that has not been investigated.

### Stale uptime monitors

Several BetterStack uptime monitors point to old URLs or permanently-down services. They still use the `augmentos.cloud` domain.

### Legacy deployments

`cloud-livekit` is still running on US Central despite LiveKit being removed from the codebase.
