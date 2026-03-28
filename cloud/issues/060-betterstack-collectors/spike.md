# Spike: BetterStack Collector — All Clusters

## Overview

**What this doc covers:** Installing the BetterStack Collector on the 4 remaining Porter clusters (France, East Asia, US West, US East) and verifying the existing US Central collector is healthy.
**Why this doc exists:** US Central has had a collector since March 25. The other 4 prod clusters have zero infrastructure metrics — no container CPU, memory, restart counts, or Kubernetes events. When France crashes every 3 hours, we can't see the container-level degradation curve. We need collectors everywhere.
**Who should read this:** Anyone working on cloud infrastructure or crash investigation.

**Depends on:**

- [057-cloud-observability](../057-cloud-observability/) — collector installed on US Central
- [058-multi-region-scaling](../058-multi-region-scaling/) — Doppler migration, all 5 clusters now operational

---

## Background

The BetterStack Collector is a Helm chart that runs as a DaemonSet on every node in the cluster. It collects:

- **Container metrics** — CPU, memory, restarts, OOMKills (via eBPF)
- **Kubernetes events** — pod scheduling, evictions, probe failures (events expire after ~1hr in K8s — the collector persists them)
- **Prometheus scraping** — if pods have `prometheus.io/scrape: "true"` annotations, the collector scrapes their `/metrics` endpoint
- **Node metrics** — disk, network, load average

Each cluster needs its own collector instance with a unique secret. The collector sends data to its own BetterStack source (one per cluster).

### What's already running

| Cluster           | Collector   | Source                         | Status           |
| ----------------- | ----------- | ------------------------------ | ---------------- |
| US Central (4689) | ✅ ID 60277 | mentra-us-central (ID 2321796) | Running, healthy |
| France (4696)     | ❌          | —                              | Needs setup      |
| East Asia (4754)  | ❌          | —                              | Needs setup      |
| US West (4965)    | ❌          | —                              | Needs setup      |
| US East (4977)    | ❌          | —                              | Needs setup      |

---

## Process Per Cluster

Proven process from US Central install. Repeat for each cluster.

### Step 1: Create collector via BetterStack API

```
curl -X POST "https://telemetry.betterstack.com/api/v1/collectors" \
  -H "Authorization: Bearer $BETTERSTACK_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "mentra-{region}",
    "platform": "kubernetes"
  }'
```

Response includes `collector_secret` — save it. Only shown once.

### Step 2: Install via Porter Helm

```bash
# Switch to the target cluster
porter config set-cluster {CLUSTER_ID}

# Add the BetterStack Helm repo (if not already added)
porter helm -- repo add better-stack https://cdn.betterstackdata.com/helm/collector
porter helm -- repo update

# Install the collector
porter helm -- install better-stack-collector better-stack/collector \
  --set collector.env.COLLECTOR_SECRET="$COLLECTOR_SECRET" \
  --set collector.tolerations[0].operator=Exists \
  --set ebpf.tolerations[0].operator=Exists
```

### Step 3: Verify

```bash
# Check DaemonSet pods are running
porter kubectl -- get pods -l app.kubernetes.io/name=collector

# Check logs for successful connection
porter kubectl -- logs -l app.kubernetes.io/name=collector --tail=20
```

### Key gotchas (from US Central install)

- **Tolerations are required.** Porter nodes have taints (`removable=true:NoSchedule`, `porter.run/node-group-id=...:NoSchedule`). Without `tolerations[0].operator=Exists` on BOTH the collector and eBPF containers, the DaemonSet pods won't schedule.
- **eBPF needs privileged access.** The collector's eBPF container runs as privileged. Verified working on Porter AKS clusters (kernel 5.15+).
- **Use `porter helm --`** not `helm` directly. Going through Porter ensures the correct kubeconfig/cluster context.

---

## Collector Naming Convention

| Cluster    | Cluster ID | Collector Name    | Expected Source Name                     |
| ---------- | ---------- | ----------------- | ---------------------------------------- |
| US Central | 4689       | mentra-us-central | mentra-us-central (existing, ID 2321796) |
| France     | 4696       | mentra-france     | mentra-france (new)                      |
| East Asia  | 4754       | mentra-east-asia  | mentra-east-asia (new)                   |
| US West    | 4965       | mentra-us-west    | mentra-us-west (new)                     |
| US East    | 4977       | mentra-us-east    | mentra-us-east (new)                     |

---

## What This Unlocks

Once collectors are on all clusters:

1. **Dashboard charts for all regions** — container CPU, memory, restarts. The `{{source}}` variable in dashboard charts resolves to the metrics table, which is what the collector feeds. This is the only way to get real dashboard charts (log-based queries don't work in dashboards).

2. **France crash investigation** — France is crashing every ~3 hours with 22-30 sessions. Without a collector, we can only see application logs. With a collector, we'll see the container memory curve, CPU saturation, and K8s events (probe failures, OOMKills) leading up to each crash.

3. **Cross-region comparison** — "Does France use more memory per session than US Central? Is East Asia's CPU pattern different?" These questions require collector metrics from all regions.

4. **Prometheus scraping** — once we add `prometheus.io/scrape: "true"` to porter.yaml (057 outstanding item), the collector will scrape the app's `/metrics` endpoint, giving us application-level metrics (event loop lag, heap, sessions) as proper time-series, not just structured logs.

---

## Effort Estimate

~15 minutes per cluster (API call + helm install + verify). 4 clusters = ~1 hour total. Zero code changes. Zero risk to running pods.

---

## Log Source Migration (Related)

As of this spike, the prod/staging Doppler configs have been updated to point at the new `MentraCloud - Prod` BetterStack source (ID 2324289). Once pods redeploy:

- **Prod logs** → `MentraCloud - Prod` (ID 2324289, table `t373499.mentracloud_prod`)
- **Dev/local/debug logs** → `AugmentOS` (ID 1311181, table `t373499.augmentos`) — unchanged
- **Staging logs** → `MentraCloud - Prod` (same as prod, with `LOG_LEVEL=info` set)

Queries against the old source will stop showing prod data after the redeploy. Update any saved queries, dashboards, or BetterStack Explore bookmarks to use the new source.

---

## Next Steps

1. Create collectors for 4 clusters (this spike covers the process)
2. Verify data flowing in BetterStack for each new source
3. Build a multi-region dashboard using collector metrics from all 5 sources
4. Add Prometheus scrape annotations to porter.yaml (separate change)
