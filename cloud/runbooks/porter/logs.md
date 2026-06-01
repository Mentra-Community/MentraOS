# Porter Logs

We have two places to read pod logs from. They show the same raw
stdout but with different latency, retention, and query power.

| Source | Latency | Retention | Query | Use for |
| --- | --- | --- | --- | --- |
| Porter dashboard | seconds | minutes to hours | grep-style filter | Live debugging during a deploy |
| BetterStack | seconds for hot, seconds-to-minutes for S3 | days (hot) and 90 days (S3) | full ClickHouse SQL | Anything past the last hour, structured queries, dashboards, alerts |

When in doubt, BetterStack. The Porter UI is for live tailing
during a deploy.

## Porter dashboard

1. Open the app at https://dashboard.porter.run/
2. Click the service name.
3. Logs tab.

Filters: pod name, container, free-text grep. Updates live. No
history beyond what's in the buffer (typically minutes to a few
hours, depends on volume).

## Porter CLI (kubectl pass-through)

For tailing a specific pod, use the kubectl pass-through:

```bash
# List pods for an app
porter kubectl --cluster <CLUSTER_ID> -- get pods -n default \
  -l "app.kubernetes.io/name=cloud-prod-cloud"

# Tail one pod's logs
porter kubectl --cluster <CLUSTER_ID> -- logs -n default \
  <POD_NAME> --tail=100 --follow

# Logs from the previous container if it crashed
porter kubectl --cluster <CLUSTER_ID> -- logs -n default \
  <POD_NAME> --previous --tail=200
```

The `<CLUSTER_ID>` is in the dashboard URL when you open a
cluster. Common ones for this repo's apps are documented in
`cloud/tools/bstack/runbooks/pod-crash.md`.

## BetterStack

BetterStack ingests stdout from every cloud pod via the Vector
DaemonSet. Logs are JSON, parsed from Pino, with fields
flattened to top-level so they are queryable.

- Web UI for live tailing and dashboards: see
  [../betterstack/using-the-website.md](../betterstack/using-the-website.md).
- CLI for SQL queries against the ClickHouse-backed log table:
  see [../betterstack/bstack-cli.md](../betterstack/bstack-cli.md).

A typical lookup for a recent error:

```bash
bstack sql "
SELECT dt, JSONExtract(raw, 'message', 'Nullable(String)') as msg
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt > now() - INTERVAL 10 MINUTE
  AND JSONExtract(raw, 'level', 'Nullable(String)') = 'error'
ORDER BY dt DESC LIMIT 50
"
```

Replace the table with `s3Cluster(primary, t373499_mentracloud_prod_s3)`
for queries beyond the hot window. See the bstack runbook for
the full pattern.

## Why we use Vector and not @logtail/pino

Historically the cloud used `@logtail/pino` to ship logs from
the Bun process directly to BetterStack over HTTP. That caused
a heap-growth issue (the transport queued faster than it
flushed under load). The cloud now writes JSON to stdout
(`LOG_STDOUT_JSON=true`) and Vector picks it up at the node
level.

Operationally this means: do not `console.log` non-JSON in
production. The Vector parser will treat it as an opaque string
and the structured fields will not be queryable. Always use the
Pino logger (`createLogger` from `@mentra/utils`).

## Common queries

- "Did this pod restart in the last hour?"
  `porter kubectl --cluster <ID> -- get pods -n default | grep cloud`
  (look at the `RESTARTS` column, then dig into BetterStack)
- "What was the last error before the crash?"
  See `cloud/tools/bstack/runbooks/pod-crash.md`.
- "Is a specific user's session active?"
  See `cloud/tools/bstack/runbooks/client-disconnect.md`.

## Log levels

- `LOG_LEVEL` in `porter.yaml` controls what the cloud emits.
  Production is `info`. Bumping to `debug` is expensive on
  ingestion costs and makes Live Tail noisy.
- One-off debug session: redeploy a single region with
  `LOG_LEVEL: "debug"`, capture what you need, revert. Do not
  leave debug on across regions.
