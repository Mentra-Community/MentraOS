# MentraOS Cloud Infrastructure

A primer on the platforms and pieces that run the MentraOS
cloud. Operational procedures for each piece live in the
service-specific subfolders (`porter/`, `betterstack/`,
`cloudflare/`, `doppler/`).

This doc describes the shape of the system, not the live state.
Cluster lists, source IDs, and pool tables drift; for current
state run the commands or open the dashboards each service
runbook points at.

## What Is What

### Porter

Porter is the deployment platform. It sits on top of Kubernetes
and provides a UI/CLI for deploying apps, managing clusters,
viewing logs, and configuring services. Each Porter
"application" maps to a Kubernetes deployment (pods, services,
ingress). Porter manages Helm charts, Docker builds, rolling
deploys, environment variables, health checks, and ingress
configuration.

Porter clusters run on Azure Kubernetes Service (AKS).

### Kubernetes (K8s)

The container orchestration layer. Each Porter cluster is a K8s
cluster running on Azure.

- **Node:** A virtual machine (Azure VM). Has CPU, RAM, disk,
  IP address. Multiple pods share a node's resources. A cluster
  has one or more nodes.
- **Pod:** A process running on a node. One pod = one process
  (one Bun instance for the cloud, one Node process for a
  MiniApp, etc.). Multiple pods run on the same node.
- **Deployment:** Manages pod replicas and rolling updates. New
  version = new pod created, old pod killed after the new one
  is ready.
- **Service:** Internal networking. Routes traffic between pods
  within the cluster.
- **Ingress:** External networking. nginx ingress controller
  routes external HTTP/WS traffic from the internet to the right
  service. We configure separate timeout rules for WebSocket
  paths (3600s) vs REST paths (60s).
- **DaemonSet:** Runs exactly one pod per node in the cluster.
  Used for log collectors that need to capture stdout from every
  node.
- **Liveness probe:** K8s periodically hits an endpoint to check
  if the process is alive. After enough consecutive failures,
  K8s restarts the pod with SIGTERM, waits up to
  `terminationGracePeriodSeconds` (10s in our `porter.yaml`),
  then SIGKILL (exit 137) if still running. Our liveness probe:
  `GET /livez`, zero computation, 3s timeout.
- **Readiness probe:** K8s periodically hits an endpoint to
  check if the pod can handle traffic. If it fails, K8s removes
  the pod from the load balancer (nginx stops routing NEW
  requests to it) but does NOT kill the pod. Existing WebSocket
  connections stay alive. A readiness failure causes REST
  requests to 503 while WebSockets keep working. When the probe
  passes again, the pod is added back to the load balancer.
  Our readiness probe: `GET /health`, 5s timeout. The `/health`
  endpoint iterates all sessions, counts WebSockets, updates
  gauges, and serializes JSON, so it is heavier than `/livez`.

**Readiness failure cascade:** A transient readiness probe
failure (e.g. from a GC pause or MongoDB spike making `/health`
slow) can cause the pattern where REST returns 503 but WebSocket
is still connected. If the phone then tries to reconnect the
WebSocket because it sees 503s, the reconnection is a NEW HTTP
upgrade request which also gets rejected because the pod is
still not-ready. This can cascade into both REST and WebSocket
breaking even though the pod is alive. We currently have no
visibility into when readiness probe failures happen or how
long they last.

### BetterStack

The observability platform. Handles log ingestion, storage,
querying (ClickHouse), alerting, dashboards, and uptime
monitoring.

- **Source:** A log destination with its own ID, ingestion
  token, and ingesting host URL. Logs are sent to a source via
  HTTP POST. Each source has its own ClickHouse table for
  querying.
- **Platform types:**
  - `javascript`: a standard log source. Expects structured JSON
    logs sent via HTTP (e.g. from `@logtail/pino` or from our
    custom Vector Helm chart).
  - `collector`: a BetterStack-managed Helm chart that deploys a
    log collection agent as a DaemonSet on a K8s cluster. It
    collects ALL container stdout/stderr from the cluster and
    ships it to the source. No container filtering by default;
    we apply VRL filtering on the collector.
- **Hot storage:** Recent logs (last ~30 minutes) queryable via
  `remote()` in ClickHouse. Fast.
- **S3/cold storage:** Historical logs queryable via
  `s3Cluster()`. Slower. Requires `_row_type = 1` for logs,
  `_row_type = 3` for spans.
- **Live Tail:** Real-time log streaming in the UI. Queries
  top-level fields in the JSON (which is why we flatten Pino's
  nested fields in our Vector transform).

See `betterstack/concepts.md` for the full pipeline.

### Vector

An open-source log collection and transformation pipeline
(originally by Timber, now Datadog). Used as a DaemonSet to
collect container stdout, transform logs, and ship them to
BetterStack.

We have a custom Vector config in
`cloud/infra/betterstack-logs/values.yaml` that:

1. Filters to only cloud containers (`cloud-prod-cloud`,
   `cloud-staging-cloud`, `cloud-debug-cloud`,
   `cloud-dev-cloud`).
2. Parses Pino JSON from the `message` field.
3. Flattens all Pino fields to the top level.
4. Normalizes numeric log levels to strings (30 = "info",
   40 = "warn", etc.).
5. Nests Vector metadata into `_meta` (kubernetes_pod,
   kubernetes_container, log_source).

This custom Vector Helm chart sends logs to the
`MentraCloud - Prod` source (javascript type). It is separate
from the BetterStack default collector (see "Log Flow" below).

### @logtail/pino

A Pino transport plugin that sends logs directly from a Bun/Node
process to BetterStack via HTTP. Was removed from the cloud
process in issue 067 because it caused ~15 MB/min heap growth.
Replaced by stdout JSON picked up by Vector. Still present as a
dependency of `@mentra/sdk`, which means MiniApps built with the
SDK may still use it.

## Clusters

Each region runs on a separate Porter/K8s cluster on Azure. Dev,
debug, and staging environments are separate Porter applications
on the US Central cluster, not separate clusters.

Run `porter cluster list` for the live list. As of this writing
there are seven, summarized below by role rather than current
status (which drifts).

| Cluster                   | ID   | Azure region    | Role |
| ------------------------- | ---- | --------------- | ---- |
| US Central                | 4689 | Central US      | Primary US production. Also runs cloud-staging, cloud-dev, cloud-debug, and the bulk of MiniApps. |
| France                    | 4696 | France Central  | Production, EU traffic. |
| East Asia                 | 4754 | East Asia       | Production, OC + ME traffic via the Asia-East pool. |
| US East                   | 4977 | East US         | Capacity-constrained; intentionally not in either Cloudflare LB pool today. See `cloudflare/load-balancer.md`. |
| US West                   | 4965 | West US 2       | In the next-gen LB only (no production clients yet). |
| Canada Central            | 4753 | Canada Central  | Provisioned, not wired into any Cloudflare LB pool. |
| Australia East            | 4978 | Australia East  | Provisioned, not wired into any Cloudflare LB pool. |

For "what's actually deployed where right now," use:

```bash
porter cluster list
porter app list --cluster <ID>
```

The Cloudflare LB doc has the live LB-to-pool mapping
(`cloudflare/load-balancer.md`).

### Porter applications on US Central

Most of the org's MiniApps run on US Central as separate Porter
apps alongside `cloud-prod`, `cloud-staging`, `cloud-dev`, and
`cloud-debug`. The full list is too long and churns too often to
snapshot here; run:

```bash
porter app list --cluster 4689
```

Notable Porter apps you will see: `cloud-prod`, `cloud-staging`,
`cloud-dev`, `cloud-debug`, `captions`, `captions-beta`,
`dashboard`, `translation`, `mentra-ai-2-prod`,
`mentra-notes-prod`, plus various dev/test/example apps and
streamers.

## Porter Cloud Configuration

From `cloud/porter.yaml` as a reference shape; verify the deployed
values in the Porter dashboard or with
`porter app yaml cloud-prod --cluster <ID> --target <TARGET>`,
since repo yamls can drift from what is actually running:

- **CPU limit:** 5 cores
- **Memory limit:** 4096 MB (4 GB)
- **Port 80:** HTTP/WS (REST API, glasses-ws, app-ws)
- **Port 8000 (UDP):** Audio streaming
- **Liveness probe:** `GET /livez`, 3s timeout, 15s initial delay
- **Readiness probe:** `GET /health`, 5s timeout, 15s initial delay
- **Ingress timeouts:** 3600s for proxy-read and proxy-send
  (keeps WebSocket connections alive), 60s for proxy-connect
- **Prometheus scraping:** enabled on `/metrics` port 80, every 30s
- **Termination grace period:** 10s (time between SIGTERM and
  SIGKILL)
- **`LOG_LEVEL=info`** in `porter.yaml`. `LOG_STDOUT_JSON=true`
  controls the Pino vs pino-pretty output mode and is set
  per-cluster.

## BetterStack Sources

We have a handful of long-lived sources. Run
`bstack sources` for the live list with current sizes; the
table below describes what each one is for.

| Source             | Type       | Fed by | Purpose |
| ------------------ | ---------- | ------ | ------- |
| `mentra-us-central` | collector  | BetterStack Collector on the US Central cluster | All cloud containers' stdout from US Central, after VRL filtering. |
| `mentra-us-east`   | collector  | BetterStack Collector on US East cluster | Same shape, US East. |
| `mentra-us-west`   | collector  | BetterStack Collector on US West cluster | Same shape, US West. |
| `mentra-france`    | collector  | BetterStack Collector on France cluster | Same shape, France. |
| `mentra-east-asia` | collector  | BetterStack Collector on East Asia cluster | Same shape, East Asia. |
| `MentraCloud - Prod` | javascript | Custom Vector Helm chart (issue 067) on US Central; SDK `@logtail/pino` from internal MiniApps | Cloud-only logs from US Central via the custom Vector chart, plus any internal MiniApps that ship via the SDK's BetterStack transport. |
| `AugmentOS`        | javascript | Legacy: SDK transports from before the Mentra rename | Mostly idle. Likely retire-able once we confirm nothing still ships there. |

## Collector configuration

Every region's cluster has a BetterStack Collector installed.
The collector ships container stdout to its regional source
above, with a VRL filter limiting to cloud containers
(`cloud-*`); MiniApps and K8s system pods are dropped.

Additionally, US Central runs the older custom Vector Helm
chart (the one in `cloud/infra/betterstack-logs/values.yaml`),
which has its own filter and ships to `MentraCloud - Prod`.
This is a deliberate duplicate path for US Central cloud logs.
Other regions only have the collector path.

For the live list of collectors and their config, use the
BetterStack dashboard (Sources -> the source -> Collectors).

## Uptime monitors

The uptime monitor list churns and includes some legacy
`augmentos.cloud` URLs that should eventually be retired. For
the current list, hit `https://uptime.betterstack.com/`. Common
pattern: each monitor checks for the keyword `"status":"ok"` in
the response and pages on failure.

## Log Flow

### Cloud process (production)

```mermaid
flowchart TD
  A["Cloud (Bun)<br/>LOG_STDOUT_JSON=true"]
  B["Container stdout<br/>structured Pino JSON, info level and above"]
  C["Custom Vector DaemonSet<br/>filters to cloud containers<br/>(US Central only)"]
  D["MentraCloud - Prod source"]
  E["BetterStack default collector<br/>VRL filter to cloud-* containers<br/>(every cluster)"]
  F["Regional source<br/>mentra-{region}"]

  A --> B
  B --> C
  B --> E
  C --> D
  E --> F
```

`MentraCloud - Prod` carries cloud logs from US Central only
(the custom Vector chart only runs there). The regional sources
each carry their own region's cloud logs.

Pino log level is `info` in production. Debug logs are never
emitted to stdout.

### Cloud process (dev/local)

When `LOG_STDOUT_JSON` is unset, Pino renders to a human-readable
console via `pino-pretty`. Nothing ships to BetterStack.

### MiniApps (captions, dashboard, translation, etc.)

MiniApps write to stdout. Some internal MiniApps additionally
ship via the SDK's `@logtail/pino` transport when
`BETTERSTACK_SOURCE_TOKEN` is set, landing in
`MentraCloud - Prod` directly.

The collector's VRL filter excludes MiniApp containers (it only
keeps `cloud-*` containers), so MiniApp stdout is NOT picked up
by the regional sources.

### Log level filtering

| Environment                          | Pino log level | What reaches stdout             | What reaches BetterStack                  |
| ------------------------------------ | -------------- | ------------------------------- | ----------------------------------------- |
| Production (NODE_ENV=production)     | info           | info, warn, error, fatal        | Same (collectors ship stdout as-is)       |
| Development (NODE_ENV != production) | debug          | debug, info, warn, error, fatal | Depends on whether a collector is running |

Neither the custom Vector config nor the BetterStack default
collector filters by log level. All filtering happens at the
application level (Pino config). If a MiniApp emits debug-level
logs to stdout in production, the collector ships them.

## Known issues

### Cloud log double ingestion on US Central

Cloud logs on US Central go to both `MentraCloud - Prod` (via
the custom Vector Helm chart) and `mentra-us-central` (via the
BetterStack Collector). Intentional for now: `MentraCloud - Prod`
has Pino-flattened fields and aligns with how queries used to
be written, while the regional sources have current-format data
plus infrastructure metrics. A future cleanup could remove the
custom Vector and migrate all queries to the regional sources.

### No readiness probe visibility

We do not log or alert when K8s marks the cloud pod as not-ready
due to a `/health` timeout. Potential cause of REST 503 errors
and WebSocket reconnection failures that has not been
investigated.

### Stale uptime monitors

Several BetterStack uptime monitors point to legacy
`augmentos.cloud` URLs. Cleanup task to retire or redirect them.
