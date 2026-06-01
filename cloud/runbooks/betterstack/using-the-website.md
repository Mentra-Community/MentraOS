# Using BetterStack's Website

The web UI is best for live tailing, browsing dashboards, and
ad-hoc exploration. For repeatable queries and incident response,
the `bstack` CLI is faster (see [bstack-cli.md](bstack-cli.md)).

## Logging in

- Logs and queries: https://logs.betterstack.com/
- Uptime monitoring and alerts: https://uptime.betterstack.com/
- Account is provisioned by Isaiah or Israelov.

The first time you log in, you land on a Sources list. Each
source corresponds to one cluster (`cloud-prod`, `cloud-prod-us-east`,
etc.). Click a source to see its logs.

## Live Tail

Real-time stdout streaming. The fastest way to see what is
happening right now.

1. Log into https://logs.betterstack.com/
2. Click the source for the region you want
   (e.g. `MentraCloud - Prod`).
3. The default view is Live Tail.
4. Use the filter bar at the top to narrow by:
   - **Level**: `info`, `warn`, `error`, etc.
   - **Free-text search**: matches anywhere in the JSON.
   - **Field filters**: `feature:"system-vitals"`,
     `userId:"foo@bar.com"`, etc.

Live Tail queries top-level fields. Our Vector pipeline flattens
Pino's nested JSON to the top level, so `level` and `message`
work as filter keys. If a field is buried under `_meta`, you can
still filter on it but the syntax is `_meta.kubernetes_pod`.

Tip: pin a tab to Live Tail with `feature:"system-vitals"` while
debugging. It surfaces the periodic vitals payloads (sessions,
memory, GC, event-loop gaps) without other noise.

## Saved Views and dashboards

The Dashboards tab has pre-built views for system vitals,
disconnects, reconnects, and memory trends. Open one to see how
queries are constructed; copy the queries into your own ad-hoc
exploration.

To save a query as a view: run it in the Explore tab, then click
"Save as View" in the top-right. Views are private by default;
share with the team via the Share button.

Tip: pin a tab to Live Tail with a filter while debugging. Real
filters the team uses (visible in your search history once you
have queried at least once): `region="us-west"`, `level=error`,
`userId="<email>" level=error`. The filter chip turns green
when the field exists; if you see "No matching logs found" with
a filter, it usually means the field is not indexed by that
name in this source (try the Explore tab to see the actual
schema).

## Explore tab (custom queries)

For anything beyond a simple Live Tail filter, switch to the
Explore tab. Two query modes:

- **Filter mode**: GUI for adding `field op value` clauses.
  Auto-builds the underlying SQL.
- **SQL mode**: write ClickHouse SQL directly against the source
  table.

The "Edit as SQL" button toggles between modes. Filter mode is
fine for simple lookups; SQL mode is what the `bstack` CLI uses
under the hood.

### Hot vs S3 in the UI

The default Explore query targets hot storage. For history older
than ~30 minutes, change the table in the FROM clause to the S3
table and add `WHERE _row_type = 1` (logs) or `WHERE _row_type = 3`
(spans).

Hot:

```sql
SELECT dt, JSONExtract(raw, 'message', 'Nullable(String)') as msg
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt > now() - INTERVAL 10 MINUTE
ORDER BY dt DESC LIMIT 50
```

S3:

```sql
SELECT dt, JSONExtract(raw, 'message', 'Nullable(String)') as msg
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type = 1
  AND dt > now() - INTERVAL 6 HOUR
ORDER BY dt DESC LIMIT 50
```

Replace `t373499_mentracloud_prod` with the matching prefix for
the source you are querying. To find the prefix: open the source
in BetterStack (Sources -> click a source -> Configure ->
Connect), where the table name is shown in the example queries.
Each source has its own prefix.

## Common query patterns

**Last few errors across all sources** (run per source, then
combine):

```sql
SELECT dt, JSONExtract(raw, 'message', 'Nullable(String)') as msg,
       JSONExtract(raw, 'feature', 'Nullable(String)') as feature
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt > now() - INTERVAL 15 MINUTE
  AND JSONExtract(raw, 'level', 'Nullable(String)') = 'error'
ORDER BY dt DESC LIMIT 100
```

**A specific user's recent activity:**

```sql
SELECT dt, JSONExtract(raw, 'region', 'Nullable(String)') as region,
       JSONExtract(raw, 'message', 'Nullable(String)') as msg
FROM remote(t373499_mentracloud_prod_logs)
WHERE raw LIKE '%user@example.com%'
  AND dt > now() - INTERVAL 30 MINUTE
ORDER BY dt DESC LIMIT 50
```

(For longer history, use the `s3Cluster` table with `_row_type = 1`.)

**System vitals trend:**

```sql
SELECT dt,
       JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') as sessions,
       JSONExtract(raw, 'rss', 'Nullable(Int64)') as rss
FROM remote(t373499_mentracloud_prod_logs)
WHERE JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals'
  AND JSONExtract(raw, 'region', 'Nullable(String)') = 'us-central'
  AND dt > now() - INTERVAL 1 HOUR
ORDER BY dt DESC
```

## Uptime monitoring

https://uptime.betterstack.com/ tracks the public hostnames. Each
monitor has:

- A target URL
- A check interval (typically 30s or 1m)
- Expected status code
- An incident escalation policy

Click a monitor to see its history. Failed checks become
"incidents" with their own page; the `bstack incidents` CLI
command surfaces these too.

The monitors we run today cover the regional `cloud-prod`
hostnames (`uscentralapi.mentraglass.com` etc.) and the LB
hostnames (`api.mentra.glass`, `api.mentraglass.com`). The full
list lives in the Uptime dashboard.

## Alerts

Alerts are configured per source (logs) and per monitor
(uptime). They route to Slack and on-call email. Pause an alert
during a known incident or planned change to avoid noise; resume
when done. Pausing is per-alert, not global.

If you add a new alert, document its trigger and recipient in
this folder so on-call knows what is firing. A short note in
[README.md](README.md) is enough.
