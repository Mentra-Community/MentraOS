# BetterStack: Concepts and Prerequisites

Read this first if you are new to the stack. Operational
procedures live in [using-the-website.md](using-the-website.md) and [bstack-cli.md](bstack-cli.md).

The summary: the cloud writes JSON to stdout. A separate piece
of infrastructure called Vector reads those stdout streams and
ships them to BetterStack over HTTPS. Vector runs on every
Kubernetes node as a DaemonSet, installed via the BetterStack
Helm chart with our custom config.

If those words are unfamiliar, the rest of this doc explains
each one.

## Container stdout

When the cloud Bun process runs `logger.info(...)`, Pino
serializes the log to JSON and writes one line to stdout.
Inside a container, stdout is a stream that the container
runtime captures. Kubernetes writes those captured lines to a
file on the node:

```
/var/log/containers/<pod-name>_<namespace>_<container-name>.log
```

That file grows as the container produces output. Other tools
on the node can read it.

The cloud does not push to BetterStack itself. It writes JSON
to stdout. Everything from "stdout" onwards is infrastructure.

## Tailing (Unix sense)

`tail` the verb means "read the end of a file as it grows, in
real time." `tail -f some.log` is the canonical example: print
existing lines, stay open, print new lines as they appear.

When we say "Vector tails container stdout," we mean Vector is
reading those `/var/log/containers/*.log` files and streaming
new lines as they appear. There is no in-process hook from the
cloud; Vector is just file-tailing the logs the container
runtime already produces.

## Vector

Vector is an open-source log and metrics pipeline. Think of it
as `tail -f` with extras: it can read from many sources
(container log files, syslog, HTTP, files), run transforms
(parse JSON, filter, rename fields, route conditionally), and
write to many sinks (BetterStack, Datadog, S3, ClickHouse, and
more). One Go binary. Low memory footprint. No JVM.

For us, Vector reads container log files on each node, filters
to cloud containers, parses Pino JSON, flattens the fields, and
ships over HTTPS to BetterStack. Configuration lives in
`cloud/infra/betterstack-logs/values.yaml`.

Vector itself is just a binary. The deployment shape is what
makes it useful: we run it as a DaemonSet on every Kubernetes
node.

## Kubernetes node

A node is one VM in the cluster. Multiple pods share a node's
CPU, RAM, and disk. A small cluster might be 1-3 nodes; a busy
one might be 10+. Each Porter cluster (us-central, france,
etc.) is a Kubernetes cluster with one or more nodes. See
[../infra.md](../infra.md) for the broader Kubernetes primer.

## DaemonSet

A normal Kubernetes Deployment runs N replicas of a pod,
scheduled wherever there is room. A DaemonSet is a different
shape: it runs **exactly one pod per node** automatically. Add
a node, the DaemonSet schedules a copy there. Remove a node,
that pod goes away.

DaemonSets exist for things that need node-level access:

- Log collectors that have to read every container's logs on
  the node
- Metrics agents that need access to the node's stats
- Network plugins that attach to the node's network namespace

For us, the Vector pod runs as a DaemonSet on every AKS
cluster. Every node has exactly one Vector pod whose only job
is to read every other container's stdout on that node and
ship the lines to BetterStack.

## Helm

Helm is Kubernetes' package manager. A "Helm chart" is a
packaged Kubernetes application: a folder of templated YAML
files (Deployment, Service, ConfigMap, DaemonSet, etc.) plus a
`values.yaml` for parameters you can override.

You install a chart with:

```bash
helm install <release-name> <chart-source>
```

Helm renders the templates with your values, applies them to
the cluster, and tracks the release. To change configuration,
`helm upgrade`. To remove everything the chart installed,
`helm uninstall <release-name>`.

## The BetterStack Helm chart

BetterStack publishes a Helm chart that bundles Vector with
their preferred defaults for K8s log ingestion. When you
install it on a cluster you get:

- A Vector DaemonSet (one Vector pod per node)
- Default configuration for parsing K8s container logs
- Sinks pointed at BetterStack's HTTP ingest endpoint

We override the chart's `values.yaml` in
`cloud/infra/betterstack-logs/values.yaml` to:

1. Add a filter that drops everything except cloud containers.
2. Flatten Pino JSON fields to top-level so Live Tail filters
   work (`region`, `feature`, `level` etc.).
3. Point at the per-cluster source token.

The chart is installed once per cluster. After install it just
runs.

## ClickHouse (BetterStack's query backend)

When BetterStack receives an event, it stores it in a
ClickHouse-backed table. ClickHouse is a column-oriented
database designed for analytical queries over large tabular
data. Two relevant facts:

- The web UI Live Tail and the `bstack` CLI both query
  ClickHouse via BetterStack's SQL HTTP API.
- The `JSONExtract(raw, 'field', 'Type')` syntax you see in
  queries is ClickHouse's way of pulling a typed value out of
  a JSON-stringified column.

You do not need to know much more than that to write queries.
Examples in [bstack-cli.md](bstack-cli.md) and [using-the-website.md](using-the-website.md).

## Hot vs S3 storage

BetterStack splits storage between a hot tier and an S3-backed
cold tier:

- **Hot**: roughly the last 30 minutes. Sub-second queries.
  Used by Live Tail and the default `bstack` shortcut commands.
  Table reference in queries: `remote(t<id>_<source>_logs)`.
- **S3**: up to 90 days. Queries take 3-5 seconds. Used for
  weekly audits and anything older than the hot window. Table
  reference: `s3Cluster(primary, t<id>_<source>_s3)` with
  `WHERE _row_type = 1` for log rows (3 for spans).

Source IDs come from BetterStack. The `bstack` CLI knows the
mapping.

## End-to-end pipeline

```mermaid
flowchart TD
  A["Cloud Bun process<br/>logger.info('user signed in', { userId })"]
  B["Container stdout<br/>JSON line: level, time, msg, userId, ..."]
  C["Node disk<br/>/var/log/containers/cloud-prod-cloud_default_*.log"]
  D["Vector pod (DaemonSet on this node)<br/>filter container_name<br/>parse JSON, flatten Pino fields<br/>decorate _meta.kubernetes_pod"]
  E["BetterStack<br/>ClickHouse table for the source<br/>(e.g. mentra-us-central)"]
  F["Read paths<br/>Live Tail · bstack CLI · BetterStack dashboards"]

  A -->|Pino serializes to JSON| B
  B -->|container runtime captures| C
  C -->|Vector tails the file| D
  D -->|HTTPS POST with bearer token| E
  E -->|queryable| F
```

## Why we removed `@logtail/pino` from the cloud

There used to be a second path: `@logtail/pino` ran inside the
cloud Bun process as a Pino transport in a worker thread. It
buffered logs in memory and pushed them over HTTP to
BetterStack directly.

That path leaked heap because the worker's queue grew faster
than BetterStack could consume under load (~15 MB/min,
eventually crashing pods). It was removed from
`cloud/packages/cloud/src/services/logging/pino-logger.ts`. The
cloud now writes only to stdout; Vector handles all network
shipping.

The SDK still has the `@logtail/pino` transport wired up
(opt-in via `BETTERSTACK_SOURCE_TOKEN`), used by some internal
miniapps. Their logs land in the legacy `MentraCloud - Prod`
source, separate from the regional Vector sources. See the
README for which source receives what.

## Why the filter scope matters for cost

Vector tails every container's logs on the node. Without our
filter it would ingest kube-system pods, ingress-nginx,
cert-manager, every miniapp's container, the porter agent.

The filter `contains(container_name, "cloud-prod-cloud")` (and
sibling clauses for staging/dev/debug) is what bounds the
volume. Anything that accidentally matches the filter pattern
silently inflates the bill. Naming a future container
`cloud-prod-cloud-foo` would be enough to pull it in.

If you add a new app or rename a container, double-check the
filter does what you expect.
