# `bstack` CLI

`bstack` is our homegrown CLI that wraps BetterStack's SQL API
with pre-built SRE queries. It is much faster than the web UI
for repeatable lookups.

Source: `cloud/tools/bstack/bstack.ts`
Existing incident-response runbooks that use it heavily:
`cloud/tools/bstack/runbooks/`

## Install

```bash
cd cloud/tools/bstack
bun install                       # if you have not already
echo "alias bstack='bun run $(pwd)/bstack.ts'" >> ~/.zshrc
source ~/.zshrc
bstack help
```

(Adjust for `~/.bashrc` if you use bash.)

## Doppler setup

`bstack` reads ClickHouse credentials and other secrets from
Doppler. The credentials live in the `mentra-sre` project.

You need:

- `doppler` CLI installed (see [../doppler/README.md](../doppler/README.md))
- A Doppler login that has been added to the `mentra-sre`
  project. Ask Isaiah or Israelov.

The CLI auto-detects Doppler when env vars are missing. If your
Doppler is configured, you can just run `bstack health` directly.
If env vars are missing and Doppler is not set up, the tool
prints instructions and exits.

Manual fallback (one-off):

```bash
doppler run --project mentra-sre --config dev -- bstack health
```

## The commands

| Command | What it does |
| --- | --- |
| `bstack health` | Quick health snapshot across all regions |
| `bstack diagnostics --region <r>` | Full diagnostic suite for one region |
| `bstack crash-timeline --region <r>` | What happened before the last crash |
| `bstack memory --region <r>` | Memory trend over time |
| `bstack memory-owners --region <r>` | Top memory holders (per-session, etc.) |
| `bstack device-state --region <r>` | Glasses connection / state breakdown |
| `bstack gc --region <r>` | GC probe analysis |
| `bstack gaps --region <r>` | Event loop gap analysis |
| `bstack budget --region <r>` | Operation budget (CPU consumers) |
| `bstack slow-queries --region <r>` | MongoDB slow queries |
| `bstack cache --region <r>` | App cache status |
| `bstack logs --region <r> [filters]` | Tail logs from a region |
| `bstack errors --region <r>` | Recent errors in a region |
| `bstack leaks --region <r>` | Detector for known leak patterns |
| `bstack session <userId>` | Find a user's session and which region |
| `bstack incidents --limit N` | Recent uptime incidents |
| `bstack sources` | List all BetterStack sources |
| `bstack sql "<query>"` | Run a raw ClickHouse SQL query |
| `bstack runbook <name>` | Open one of the runbooks under `cloud/tools/bstack/runbooks/` |

Many commands have short aliases (`diag`, `mem`, `crash`, `inc`,
`src`, etc.). See the source for the full list, or
`bstack help`.

## Region names

Use the human-readable names: `us-central`, `us-east`, `us-west`,
`france`, `east-asia`. The tool maps these to BetterStack source
prefixes and Doppler configs internally.

## Examples

```bash
# 30-second sanity check
bstack health

# Most common follow-up: dig into a specific region
bstack diagnostics --region us-central

# What happened before the last crash in France?
bstack crash-timeline --region france

# Find which region a user is in
bstack session user@example.com

# Recent disconnect errors for a user
bstack sql "
SELECT dt, JSONExtract(raw, 'message', 'Nullable(String)') as msg
FROM remote(t373499_mentracloud_prod_logs)
WHERE raw LIKE '%user@example.com%'
  AND dt > now() - INTERVAL 30 MINUTE
ORDER BY dt DESC LIMIT 50
"

# Beyond hot storage: weekly audit goes through S3
bstack sql "
SELECT dt, JSONExtract(raw, 'message', 'Nullable(String)') as msg
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type = 1
  AND dt > now() - INTERVAL 7 DAY
  AND JSONExtract(raw, 'level', 'Nullable(String)') = 'error'
ORDER BY dt DESC LIMIT 200
"
```

## When to use which storage

Hot storage (`remote(...)`):
- Queries that span the last few minutes
- Live debugging during an incident
- Default for `bstack` shortcut commands

S3 storage (`s3Cluster(...)`):
- Anything past the last hour
- Weekly audits
- Investigating something that happened yesterday
- `_row_type = 1` for logs, `_row_type = 3` for spans

The hot table holds ~30 minutes of data. Queries return in
under 1 second. The S3 table holds 90 days. Queries take 3-5
seconds.

## Adding a new pre-built query

If you keep running the same `bstack sql "..."`, add it as a
new subcommand. The implementation is in
`cloud/tools/bstack/bstack.ts`; copy an existing case as the
template. Add the new command to the table above and, if it
supports incident response, link it from a runbook in
`cloud/tools/bstack/runbooks/`.

## Related

- [using-the-website.md](using-the-website.md): when the web UI is the right tool
  instead.
- `cloud/tools/bstack/runbooks/`: incident-response procedures
  that use this CLI heavily. `pod-crash.md`,
  `client-disconnect.md`, and `weekly-error-audit.md` are the
  starting points.
- [../doppler/](../doppler/): where `bstack`'s credentials live.
