# 109: Betterstack log ingest, V1 logs were double-shipped

**Status:** fix applied 2026-07-14 via Betterstack API (see Fix applied below)
**Owner:** Isaiah
**Related:** `cloud/runbooks/betterstack/` (pipeline docs), `cloud/infra/betterstack-logs/values.yaml` (our Vector chart), `cloud/tools/bstack/` (CLI used for all measurements)

## Problem

Betterstack ingest was far higher than the deprecated V1 system justifies. Measured via the bstack SQL API: the large majority of log volume was a duplicate copy, and most sources kept long retention windows (logs 60-90 days, metrics over a year), which multiplies Betterstack's per-GB pricing tier.

## Root cause: every V1 log line was ingested twice

1. **Intended path:** app writes Pino JSON to stdout -> our Vector DaemonSet (Helm, `cloud/infra/betterstack-logs/values.yaml`) filters to cloud containers, flattens, ships to the "MentraCloud - Prod" source. This is the source used for Live Tail / dashboard search.
2. **Accidental path:** the Betterstack **collector** DaemonSets (installed 2026-03 on the V1 clusters for infrastructure metrics) also tail every container's logs and ship them raw. A server-side VRL transformation aborts non `cloud-*` containers, but the surviving cloud logs were stored with the full Kubernetes/Porter envelope, roughly an order of magnitude larger per line than the intended copy.

Duplication was proven by matching a single event (same pino timestamp, pod, and payload) in both sources: the collector copy was the same log line wrapped in a much larger Kubernetes metadata envelope.

The collector log copies had no consumers: the bstack CLI, both dashboards, and the runbooks only use the collectors' *metrics* tables and the MentraCloud - Prod *logs* table.

Secondary contributor (not acted on, kept for searchability): most of the intended-path volume is info level, dominated by a handful of very chatty services (DisplayManager logs multiple lines per caption display request). V1's level is hardcoded `info` in production (`cloud/packages/cloud/src/services/logging/pino-logger.ts`). If ingest needs another cut later, filter at the Vector chart (no V1 redeploy needed), not in V1 code.

## Fix applied 2026-07-14 (Betterstack API, no cluster or V1 changes)

Decisions: keep the MentraCloud - Prod source fully intact (info level included) because it is actively used for reading/searching logs in the dashboard; kill only duplicates and retention.

1. Pre-flight: the telemetry API has no alert endpoints; known alerting is Uptime HTTP monitors (unaffected), and the bstack CLI config + dashboards only reference collector *metrics* tables, so nothing consumes the collector log copies.
2. Disabled Kubernetes log collection on all 5 collectors via `PATCH /api/v1/collectors/:id` with `configuration.components.logs_kubernetes: false`. This stops tailing at the DaemonSet itself, so it also saves cluster egress. `ebpf_metrics` stays on. Note: source `vrl_transformation_logs` is read-only through the API, so a VRL-abort approach was not usable.
3. Retention cuts to the lowest tier the API allows (30 days; allowed values are 30/60/90/180/365+):
   - MentraCloud - Prod: logs and metrics -> 30d
   - all 5 collector sources: logs and metrics -> 30d
4. Paused ingest entirely on the collector sources for the two idle regions. The third low-traffic region kept ingesting metrics since it carries real traffic. Pausing is reversible; delete outright once we are sure nobody wants their metrics history.

Result: the duplicate stream (the large majority of log ingest) is gone and all retention sits at the lowest tier. Searchable logs in the dashboard are unaffected apart from the shorter history window.

## Verification

- Post-change API sweep confirmed: retention applied on all sources, the two idle collector sources paused, all 5 collectors `logs_kubernetes=false` with metrics up.
- **Live-verified 2026-07-14 22:29 UTC:** collector log ingest flatlined to zero across the active regions roughly 45 minutes after the PATCH (managed agents pick the config up on their poll cycle, no DaemonSet restart needed). The intended MentraCloud - Prod path still flowing normally.
- Remaining: watch the Betterstack usage page trend over the next billing days.

```bash
# re-check ingest per day for a collector source
cd cloud/tools/bstack
bun bstack.ts sql "SELECT toDate(dt) AS day, count() \
  FROM s3Cluster(primary, t373499_mentra_us_central_s3) \
  WHERE _row_type = 1 AND dt > now() - INTERVAL 3 DAY GROUP BY day ORDER BY day"
```

## Follow-ups

- [ ] Delete the paused idle-region collector sources (the two idle regions only; the low-traffic active region stays until decommissioned) after a grace period.
- [ ] When V1 is fully retired: uninstall the Vector DaemonSets + collectors, delete all V1 sources.
- [ ] Runbook `cloud/runbooks/betterstack/README.md` lists a stale per-region source layout; update to the current source reality.
