# BetterStack

BetterStack is our observability platform. We use it for:

- **Log ingestion and storage** (ClickHouse-backed)
- **Live Tail** for real-time stdout streaming
- **Dashboards** for system vitals
- **Uptime monitoring** for public hostnames
- **Alerts** routed to Slack / on-call

For a primer on how logs flow into BetterStack (Vector DaemonSet,
Pino JSON, hot vs S3 storage), see [../infra.md](../infra.md).

## Access

You need a BetterStack account that has been added to the team.
Ask Isaiah or Israelov.

- Web: https://logs.betterstack.com/ and
  https://uptime.betterstack.com/
- API tokens for the `bstack` CLI live in Doppler under the
  `mentra-sre` project. See [bstack-cli.md](bstack-cli.md).

## What we have ingested

- **Production cloud (per region)**: separate sources per
  cluster (`cloud-prod`, `cloud-prod-us-east`,
  `cloud-prod-us-west`).
- **Staging cloud**: `cloud-staging` source.
- **Dev / debug clusters**: `cloud-dev`, `cloud-debug`.

Each source has its own ClickHouse table for queries. The
`bstack` CLI knows which table maps to which region; you mostly
do not need to remember the table names by hand.

## Hot vs S3 storage

- **Hot storage** holds the last few minutes (typically ~30 min)
  of logs. Fast queries (< 1s for typical lookups). Use for
  live debugging.
- **S3 storage** holds 90 days of logs. Queries take 3-5
  seconds. Use for retros, weekly audits, anything beyond the
  last hour.

The query syntax differs between them. The `bstack` CLI handles
both; the difference matters when you write raw SQL.

## Procedures

- [concepts.md](concepts.md): read first. Explains Vector, DaemonSets, the
  BetterStack Helm chart, and how a log line travels from
  the cloud to BetterStack.
- [using-the-website.md](using-the-website.md): Live Tail, dashboards, query basics in
  the web UI.
- [bstack-cli.md](bstack-cli.md): install, set up Doppler, the 12+ CLI commands.

## Related

- `cloud/tools/bstack/runbooks/` has incident-response runbooks
  that go deeper than this folder. They use the `bstack` CLI
  heavily. Keep them updated alongside the CLI doc here.
- [../porter/logs.md](../porter/logs.md): the Porter dashboard is the alternative
  for live tailing during a deploy.
- [../doppler/](../doppler/): the bstack CLI reads its credentials from
  Doppler.
