# Spec: BetterStack Log Collection Reconciliation

## Overview

**What this doc covers:** Fixing the duplicate log collection infrastructure that's costing ~$400/day, and setting up a clean one-collector-per-region architecture.
**Why this doc exists:** On April 2, 2026, BetterStack ingestion hit 449 GB/day ($850 incurred). Investigation found two separate log collectors running on US Central, MiniApp containers flooding unfiltered stdout, and four empty regional sources with no collectors installed.
**Who should read this:** Cloud team.

## The Problem in 30 Seconds

US Central has two log collection systems running simultaneously. The BetterStack Collector collects ALL container stdout (400 GB/day, unfiltered) and sends to `mentra-us-central`. Our custom Vector Helm chart collects cloud-only logs (5 GB/day, filtered) and sends to `MentraCloud - Prod`. Cloud logs are double-ingested. MiniApp logs flood the unfiltered collector. Four other regional collector sources exist but have no collectors installed, so we have no infrastructure metrics outside US Central.

## Current State

| Source             | ID      | Type       | What feeds it                                        | Daily volume | Used for                                                                                                                     |
| ------------------ | ------- | ---------- | ---------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| AugmentOS          | 1311181 | javascript | @logtail/pino from MiniApps                          | ~3-5 GB      | MiniApp log queries                                                                                                          |
| mentra-us-central  | 2321796 | collector  | BetterStack Collector (unfiltered, all containers)   | ~400 GB      | Infrastructure metrics dashboards (CPU, memory, restarts, OOM kills, network). Also ingesting all container logs unfiltered. |
| MentraCloud - Prod | 2324289 | javascript | Our custom Vector Helm chart (cloud containers only) | ~5-7 GB      | Cloud log queries, investigations, bstack CLI                                                                                |
| mentra-france      | 2326580 | collector  | Nothing (collector never installed)                  | 0            | Nothing                                                                                                                      |
| mentra-east-asia   | 2326583 | collector  | Nothing (collector never installed)                  | 0            | Nothing                                                                                                                      |
| mentra-us-west     | 2326586 | collector  | Nothing (collector never installed)                  | 0            | Nothing                                                                                                                      |
| mentra-us-east     | 2326589 | collector  | Nothing (collector never installed)                  | 0            | Nothing                                                                                                                      |

### What the BetterStack Collector actually does

The collector is not just a log shipper. It provides three things:

1. **Logs** from container stdout (this is the 400 GB/day problem)
2. **Metrics** via eBPF (container CPU, memory, restarts, OOM kills, network, disk). These power the Host overview, Services, Hosts, and MentraCloud SRE dashboards.
3. **Tracing** via eBPF auto-instrumentation (request latency, error rates)

Our custom Vector Helm chart (from issue 067) only handles logs. It was created to replace the log delivery mechanism (@logtail/pino was causing heap growth), not to replace the collector. But both ended up running, creating the duplicate.

### What should have happened

When we set up the custom Vector for filtered cloud logs (issue 067), we should have applied those same filters to the BetterStack Collector's Vector config instead of running a second Vector alongside it. The collector already has a Vector instance — it just needed our container filter and Pino flattening transforms added to it.

## Target State

One collector per cluster, each sending filtered logs + metrics + tracing to its regional source. No separate Vector Helm chart. No duplicate sources.

| Source            | What feeds it                                                                 | What it contains                                       |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| mentra-us-central | BetterStack Collector on US Central (with container filter + Pino flattening) | Filtered cloud logs + infrastructure metrics + tracing |
| mentra-france     | BetterStack Collector on France                                               | Same                                                   |
| mentra-east-asia  | BetterStack Collector on East Asia                                            | Same                                                   |
| mentra-us-west    | BetterStack Collector on US West                                              | Same                                                   |
| mentra-us-east    | BetterStack Collector on US East                                              | Same                                                   |
| AugmentOS         | @logtail/pino from MiniApps (until removed)                                   | MiniApp logs (legacy, can be phased out)               |

`MentraCloud - Prod` gets deleted after migration. All cloud log queries move to the regional collector sources.

## Plan

### Step 1: Fix the immediate cost (today)

Apply a VRL transformation to the `mentra-us-central` collector to filter logs the same way our custom Vector does. This is a BetterStack API call using the `user_vector_config` or `source_vrl_transformation` field on the collector. No cluster changes needed.

The filter should:

- Only keep logs from cloud containers (`cloud-prod-cloud`, `cloud-staging-cloud`, `cloud-debug-cloud`, `cloud-dev-cloud`)
- Drop all other container stdout (dashboard, captions, translation, merge, K8s system pods, etc.)
- Flatten Pino JSON to top level (same transforms as our current `values.yaml`)
- Normalize log level numbers to strings

This immediately stops the ~400 GB/day of MiniApp and K8s system log ingestion. Metrics and tracing continue flowing because they go through separate pipelines in the collector, not through the log filter.

### Step 2: Remove our separate Vector Helm chart from US Central

Once the collector has the filter and we've verified logs look correct in `mentra-us-central`:

1. Uninstall our custom Vector Helm chart: `porter helm --cluster 4689 -- uninstall betterstack-logs --namespace betterstack`
2. Verify logs still flow to `mentra-us-central` (they should, the collector is still running)
3. Update all references from `mentracloud_prod` to `mentra_us_central` in:
   - `cloud/tools/bstack/runbooks/` (all runbooks)
   - `cloud/tools/bstack/bstack.ts` (the bstack CLI)
   - Any issue docs that reference the table name
4. Delete the `MentraCloud - Prod` source (ID: 2324289)

### Step 3: Install collectors on the other four clusters

For each region (France 4696, East Asia 4754, US West 4965, US East 4977):

1. Install the BetterStack Collector Helm chart with the same VRL transforms
2. Point it at the existing regional source (the sources are already created, just empty)
3. Verify logs + metrics flow

After this, every region has infrastructure metrics (CPU, memory, restarts, OOM kills) and filtered cloud logs. Currently we only have this for US Central.

### Step 4: Clean up

- Delete `MentraCloud - Prod` source (after step 2)
- Update `cloud/.architecture/infra.md` to reflect the new architecture
- Update `cloud/infra/betterstack-logs/values.yaml` with the collector config (or remove it if we're using the BetterStack API to configure the collector instead)
- Decide on `AugmentOS` source: MiniApp logs are getting cleaned up (issue 080 log cleanup PRs). Once the noise is reduced, do we still need a separate MiniApp log source? Or can we add MiniApp containers to the collector filter?

## VRL Filter

The VRL transformation to apply to the collector (same logic as our existing `values.yaml` but in VRL syntax for the collector API):

```
# Only keep logs from cloud containers
if !includes(["cloud-prod-cloud", "cloud-staging-cloud", "cloud-debug-cloud", "cloud-dev-cloud"], .kubernetes.container_name) {
  abort
}

# Flatten Pino JSON from .message to top level
pino = .message
if is_string(pino) {
  parsed, err = parse_json(string!(pino))
  if err == null {
    pino = parsed
  }
}

if is_object(pino) {
  kube_pod = to_string(.kubernetes.pod_name) ?? "unknown"
  kube_container = to_string(.kubernetes.container_name) ?? "unknown"
  . = object!(pino)
  ._meta.kubernetes_pod = kube_pod
  ._meta.kubernetes_container = kube_container
  ._meta.log_source = "vector"
}

# Normalize level numbers to strings
if is_integer(.level) {
  numeric_level = to_int!(.level)
  if numeric_level >= 60 {
    .level = "fatal"
  } else if numeric_level >= 50 {
    .level = "error"
  } else if numeric_level >= 40 {
    .level = "warn"
  } else if numeric_level >= 30 {
    .level = "info"
  } else if numeric_level >= 20 {
    .level = "debug"
  } else {
    .level = "trace"
  }
}

# Normalize field names (Pino uses msg/time, BetterStack expects message/dt)
if exists(.msg) {
  .message = del(.msg)
}
if exists(.time) {
  .dt = del(.time)
}
```

## Decision Log

| Decision                                                                              | Alternatives considered                       | Why we chose this                                                                                                      |
| ------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Apply filter to existing collector rather than delete and recreate                    | Delete mentra-us-central source entirely      | Dashboards depend on the source's metrics data. Deleting would lose historical metrics and break 6 dashboards.         |
| One collector source per region (not one unified source)                              | Send all regions to a single source           | Per-region sources let us query and dashboard each region independently. Matches the existing source structure.        |
| Remove our separate Vector Helm chart                                                 | Keep both running with the collector filtered | Two Vector instances on one cluster is wasteful and confusing. The collector can do everything our custom Vector does. |
| Phase the migration (filter first, remove Vector second, install other regions third) | Do everything at once                         | Safer. Each step is independently verifiable and reversible.                                                           |

## Implementation Log

### April 4, 2026

**Step 1: Apply VRL filter to US Central collector (60277)**

Applied `configuration.vrl_transformation` and `source_vrl_transformation` to collector 60277 (mentra-us-central). The VRL filters logs to only containers starting with `cloud-` (cloud-prod-cloud, cloud-staging-cloud, cloud-debug-cloud, cloud-dev-cloud). All other container stdout (dashboard, captions, translation, K8s system pods) is dropped before ingestion.

Result: Log volume dropped from ~40,000 logs/minute to ~130 logs/minute (99.7% reduction). Infrastructure metrics continued flowing at ~1M events/minute, completely unaffected.

**Step 2: Enable collectors on all four regional clusters**

Updated collectors 60500 (France), 60501 (East Asia), 60502 (US West), 60503 (US East). For each:

- Enabled `logs_kubernetes: true`, `ebpf_metrics: true`, `ebpf_red_metrics: true`
- Applied the same VRL container filter

These collectors were already installed on the clusters but had all components disabled. Enabling them started log collection (filtered to cloud containers only) and eBPF metrics collection.

Results after 2 minutes:

- mentra-france: 1,792 logs (cloud-prod-cloud only), 57K metrics. Working.
- mentra-east-asia: 274 logs (cloud-prod-cloud only), 92K metrics. Working.
- mentra-us-west: 0 logs (no active sessions on this cluster), metrics TBD. Enabled, awaiting traffic.
- mentra-us-east: 0 logs (no active sessions on this cluster), metrics TBD. Enabled, awaiting traffic.

**Verified: no impact on existing systems**

- `MentraCloud - Prod` (our custom Vector, ID 2324289) continues receiving logs from all regions. Completely unaffected.
- US Central SRE dashboard metrics still flowing.
- All six dashboards sourced from mentra-us-central still functional.

### What still needs to be done

- Monitor BetterStack usage over 24 hours to confirm cost reduction (should drop from ~$400/day to ~$10-20/day for logs)
- Decide whether to keep `MentraCloud - Prod` as a separate source or migrate queries to regional sources
- Decide whether to keep `AugmentOS` source (MiniApp logs via @logtail/pino) or phase it out now that MiniApp logs have been cleaned up
- Update `cloud/.architecture/infra.md` with the new architecture
- Update runbooks if any queries reference source-specific table names

### Collector IDs and source mappings

| Region     | Collector ID | Source ID | Source name       |
| ---------- | ------------ | --------- | ----------------- |
| US Central | 60277        | 2321796   | mentra-us-central |
| France     | 60500        | 2326580   | mentra-france     |
| East Asia  | 60501        | 2326583   | mentra-east-asia  |
| US West    | 60502        | 2326586   | mentra-us-west    |
| US East    | 60503        | 2326589   | mentra-us-east    |

### VRL filter applied to all collectors

```
container = to_string!(.kubernetes.container_name)
if !starts_with(container, "cloud-") {
  abort
}
.
```
