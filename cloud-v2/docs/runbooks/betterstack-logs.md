# Cloud-v2 logs in BetterStack

Cloud-v2 pods write pino JSON to stdout (`LOG_STDOUT_JSON=true` in deployed
envs). A Vector DaemonSet on the cluster tails container stdout, filters to
cloud-v2 app containers, flattens the pino fields, and ships to BetterStack.
The app never ships logs itself; an in-process HTTP log transport buffers in
a worker thread and grows heap without bound under load.

## Sources

One Vector DaemonSet routes each cloud-v2 env to its own source (route transform
keyed on the container-name prefix). All sources are in the germany /
eu-central-1a region, 30-day retention.

| Env | Source | id | Table | Retention |
| --- | --- | --- | --- | --- |
| dev | MentraCloud V2 - Dev | 2616831 | `mentracloud_v2_dev_2` | 30 days |
| debug | MentraCloud V2 - Debug | 2616845 | `mentracloud_v2_debug` | 30 days |
| isaiah | MentraCloud V2 - Isaiah | 2616847 | `mentracloud_v2_isaiah` | 30 days |
| staging | MentraCloud V2 - Staging | 2616849 | `mentracloud_v2_staging` | 30 days |
| prod | MentraCloud V2 - Prod | 2616851 | `mentracloud_v2_prod` | 30 days |

Adding an env = one `starts_with` clause in the filter + a route entry + a sink
in `infra/betterstack-logs/values.yaml`, never a wildcard. Per-source ingest
tokens live in Doppler `mentra-sre/dev` as `BETTERSTACK_V2_SOURCE_TOKEN_<ENV>`
(injected into the addon values; not committed). Source-management + deploy
credentials (`BETTERSTACK_API_TOKEN`, `PORTER_TOKEN_ADMIN`) are in the same
Doppler config.

## Install / upgrade

Cluster 5692 does NOT expose kubeconfig, so `porter helm`/`kubectl` return
`kubeconfig 400` (architectural, not a permissions gap). Deploy through the
Porter dashboard: Add-ons -> Helm Chart, chart `betterstack-logs` **pinned to
v1.1.6** (do not use latest; v2 restructures the metrics pipeline under
`vector-aggregator` and breaks this `vector.customConfig` layout). Paste the
contents of `infra/betterstack-logs/values.yaml` with the real per-env tokens
from Doppler substituted for each `PLACEHOLDER_*_TOKEN`. To change config,
edit the add-on's Configuration tab and Deploy a new revision. The add-on's
API calls use the Admin token in Doppler `mentra-sre/dev` `PORTER_TOKEN_ADMIN`.

**Landmine (caused a ~19h total shipping outage on 2026-07-20/21):** one bad
sink token takes down ALL env shipping, not just that env's. Vector runs sink
healthchecks at startup; if any sink 401s (e.g. a token that is literally the
string `undefined` from an unset shell var during substitution), the
DaemonSet pods never go Ready, helm marks the release Failed, and the broken
config stays live (helm upgrade is not atomic here), so every route stops.
Before deploying, verify each substituted token with a direct ingest POST
(`curl -H "Authorization: Bearer $TOKEN" -X POST
https://s<SOURCE_ID>.eu-central-1a.betterstackdata.com -d '{...}'` must
return 202) and grep the pasted values for `undefined` and `PLACEHOLDER`.
After deploying, confirm the add-on shows Deployed (not Failed) AND fresh
rows arrive in every source's Live Tail.

## Cost guard

`cloudv2_only_filter` (the five `cloud-*` `starts_with` clauses) is the only
thing bounding ingest; cluster 5692 also runs kube-system, ingress, karaoke,
etc. which must never be shipped. Renaming a Porter app or adding a service
changes container names, so re-check the filter and the `route_by_env` prefixes
whenever that happens. Keep retention at 30 days per source unless there is a
reason. The metrics pipeline stays disabled (`metrics-server.enabled: false`)
to avoid the V1 metrics-datapoint cost, but the `better_stack_http_metrics_sink`
override must remain in the values anyway: the chart default for that sink has
`token: null`, which is invalid Vector config and crash-loops the whole
DaemonSet, killing log shipping for every env. Removing the override is what
caused the 2026-07-20/21 outage (addon revisions 3 and 4, roughly 19 hours of
lost logs; Vector backfills whatever is still in the node log files on restart,
rotated logs are gone). The sink receives no events while metrics-server is
disabled, so it just needs any valid token to pass config validation. Watch each
source's ingest volume for the first week after any change.

## Querying

### Via the BetterStack UI (works today)

Live Tail and Events -> Explore logs query the V2 sources fine: pick the
`MentraCloud V2 - <env>` source in the source picker. BetterStack's own UI
federates internally across clusters, so this is the reliable path for
interactive debugging right now. Live Tail is fixed to the last 10 minutes;
use Explore logs (Table/Text viz) with a widened time range for history.

### Via the external SQL API (bstack CLI / curl)

Credentials are **cluster-bound**, not team-wide. The V2 sources live in the
`germany` data region on the `eu-central-1a` ClickHouse cluster; the legacy V1
sources live on `eu-nbg-2`. A ClickHouse HTTP client (Telemetry ->
Integrations -> SQL API) is issued against whichever cluster is the team's
primary at creation time and can only reach sources on that cluster.

- **V2 (eu-central-1a):** Doppler `mentra-sre` `BETTERSTACK_V2_USERNAME` /
  `BETTERSTACK_V2_PASSWORD`, host `BETTERSTACK_V2_HOST`
  (`https://eu-central-1a-connect.betterstackdata.com`). Created 2026-07-21;
  reaches all five V2 sources. Use this for cloud-v2 debugging.
- **V1 (eu-nbg-2):** the older Doppler `mentra-sre`
  `BETTERSTACK_USERNAME` / `PASSWORD`, host
  `https://eu-nbg-2-connect.betterstackdata.com`. Legacy V1 only; it returns
  `Code 701 CLUSTER_DOESNT_EXIST` for V2 tables and the V2 cred returns
  `Code 516 AUTHENTICATION_FAILED` on the wrong host, so do not cross them.

Verified 2026-07-21 against the V2 cred: `SELECT 1` -> ok;
`s3Cluster(primary, t373499_mentracloud_v2_dev_2_s3)` -> 26,013 rows (7d).

Two tables per source: `remote(...)` is the hot buffer (last ~30 min, empty
when the env is idle) and `s3Cluster(primary, ..._s3)` is the 30-day archive
(`_row_type = 1` for log rows). Query S3 for anything older than the last few
minutes. The `remote()` table only materializes once the source has data.

Application fields live inside the `raw` JSON column, not physical columns, so
extract them with `JSONExtractString` in both `SELECT` and `WHERE` (a bare
`WHERE level = ...` fails with `UNKNOWN_IDENTIFIER`). **Caveat:** these extract
to empty strings until the env deploys with `LOG_STDOUT_JSON=true` -- before
that, pino pretty-prints multi-line text and `raw` is not a JSON object, so
`level`/`package`/`module` come back blank (observed on cloud-dev 2026-07-21,
pending a redeploy).

Query the V2 cred against `$BETTERSTACK_V2_HOST`:

Hot storage (last ~30 min, sub-second):

```sql
SELECT dt,
       JSONExtractString(raw, 'level')   AS level,
       JSONExtractString(raw, 'message') AS message,
       JSONExtractString(raw, 'package') AS package,
       JSONExtractString(raw, 'module')  AS module
FROM remote(t373499_mentracloud_v2_dev_2_logs)
WHERE JSONExtractString(raw, 'level') = 'error'
  AND dt > now() - INTERVAL 30 MINUTE
ORDER BY dt DESC LIMIT 100
```

S3 storage (30 days, 3-5s per query, `_row_type = 1` for log rows):

```sql
SELECT dt, JSONExtractString(raw, 'message') AS msg
FROM s3Cluster(primary, t373499_mentracloud_v2_dev_2_s3)
WHERE _row_type = 1
  AND JSONExtractString(raw, 'level') = 'error'
  AND dt > now() - INTERVAL 7 DAY
ORDER BY dt DESC LIMIT 200
```

Useful fields (flattened from pino): `level`, `message`, `package`
(core/runtime), `module` (e.g. audio-worker, soniox), `service`, plus
whatever structured fields the call site attached. Vector metadata is under
`_meta` (`kubernetes_pod`, `kubernetes_container`).

Auth investigations: `session created`, `session revoked`, and refresh
rejections all log from `package=core, service=session.service`; correlate
with the mobile client's `MENTRA AUTH:` lines by timestamp and session id
suffix.

## Log hygiene rules

- Everything goes through `createLogger(pkg)` from `@mentra/cloud-shared`
  (pino). No `console.*` in server code: it bypasses LOG_LEVEL and ships
  unstructured.
- Per-message/per-chunk paths must be throttled or at debug. The audio
  worker's feed heartbeat (1 line per 128 chunks per user) is the ceiling
  for steady-state chatter.
- No per-request HTTP access logging. Log outcomes and errors, not traffic.
