# Spike: AKS Node Maintenance Pod Evictions

**Issue:** 076
**Status:** Documented — no code fix needed
**Date:** 2026-03-31
**Reported by:** Isaiah (captions app stopped unexpectedly on US West during testing)

---

## Overview

**What this doc covers:** Investigation of unexpected pod restarts on March 31, 2026 that caused the captions debug app (and other apps) to stop mid-session. Root cause: Azure AKS scheduled node maintenance, not a code bug.

**Why this doc exists:** The team will see pods restarting and apps disconnecting without any code changes being pushed. This documents the evidence so we don't waste time investigating a non-bug.

---

## Incident Timeline

**2026-03-31 ~00:28 UTC (5:28 PM Pacific)**

Isaiah was running `com.mentra.captions.debug` on US West (cluster 4965) to test the hot-path allocation hotfix (PR #2389). The captions app suddenly stopped — no error on the glasses, just captions disappeared.

### Cloud Logs (US West)

```
[00:31:06] [AppManager] Resurrection failed for com.mentra.captions.debug:
           Webhook failed: Webhook failed after 2 attempts: Request failed with status code 503
[00:31:06] [AppManager] Sent app_stopped to mobile after resurrection failure
[00:31:07] [MicrophoneManager] Mic-off holddown complete, still no media subscriptions - turning mic off
```

The cloud detected the `app-ws` disconnect, tried to resurrect by sending a webhook to the captions debug server, got 503 (server unavailable), and reported app_stopped to the mobile client.

### Was it a code deploy?

**No.** Last deploy to the captions repo:

```
$ gh api repos/Mentra-Community/LiveCaptionsOnSmartGlasses/actions/runs

2026-03-12  [beta] Deploy captions-beta
2026-03-11  [debug] Deploy captions-debug
2026-03-11  [debug] Deploy captions-debug
2026-01-24  [debug] Deploy captions-debug
```

Last captions-debug deploy was **March 11** — 20 days before this incident. Nobody pushed any code.

### What actually happened

```
$ porter kubectl --cluster 4689 -- get events -n default --sort-by=.lastTimestamp

2m  Warning  RebootScheduled   node/aks-a4689qbpv-27613717-vmss00001n  Timeout when running plugin check_reboot.sh
2m  Warning  RedeployScheduled node/aks-a4689qbpv-27613717-vmss00001n  Timeout when running plugin check_redeploy.sh
2m  Normal   Killing           pod/better-stack-collector-5lptb        Stopping container ebpf
2m  Normal   Killing           pod/better-stack-collector-gj24z        Stopping container collector
89s Normal   Killing           pod/better-stack-collector-pzm7z        Stopping container collector
73s Warning  BackOff           pod/soga-dev-soga-56b484fd75-82wjc      Back-off restarting failed container
2s  Normal   Killing           pod/camera-photo-dev-...                Stopping container
```

**Azure AKS was doing scheduled node maintenance** on node `vmss00001n`. The `RebootScheduled` and `RedeployScheduled` events confirm Azure was patching/rebooting the underlying VM. ALL pods on that node were evicted — not just captions:

- `better-stack-collector` (3 pods killed)
- `soga-dev` (killed, back-off restart)
- `camera-photo-dev` (killed)
- `captions-debug` (killed, rescheduled)
- `captions-live` (killed, rescheduled)

### Pod replacement evidence

```
$ porter kubectl --cluster 4689 -- get pods | grep captions-debug

captions-debug-live-captions-5bc8d8c765-8tklh   1/1  Running  0  4m36s
```

- Same ReplicaSet (`5bc8d8c765`, created 18 days ago) — NOT a new deployment
- New pod name (`8tklh` replaced old `sgcbx`) — Kubernetes killed the old pod and created a new one
- Restart count 0 — fresh pod, not a container restart
- The new pod pulled the same image (`44e30a5a...`) in 13 seconds and started normally

---

## Root Cause

**Azure AKS scheduled node maintenance.** Azure periodically patches and reboots the underlying VMs that host Kubernetes nodes. When a node is rebooted:

1. All pods on that node receive SIGTERM
2. Kubernetes waits `terminationGracePeriodSeconds` (30s for our apps)
3. Pods are killed
4. Kubernetes reschedules them on other nodes
5. New pods start up (image pull + container start)

During steps 3-5, the app is down. For captions-debug, this was ~2 minutes.

### How often does Azure do this?

| Type | Frequency | Impact |
|------|-----------|--------|
| Security patches (CVEs) | Weekly | Nodes rebooted one at a time (rolling) |
| Platform updates | Monthly | Hypervisor/host OS updates |
| Unplanned hardware | Rare | Failing hardware, live migration or reboot |

The `RebootScheduled` event we saw is most likely the weekly security patch cycle.

---

## Cloud Behavior During Eviction

The cloud handled this correctly:

1. ✅ Detected `app-ws` disconnect when captions pod was killed
2. ✅ Attempted resurrection via webhook (correct behavior)
3. ✅ Got 503 because captions server was still restarting (expected)
4. ✅ Reported `app_stopped` to mobile (correct — user knows the app stopped)
5. ✅ User can restart the app once the new pod is ready

**No code fix needed.** The cloud's reconnection and resurrection logic worked as designed.

---

## Recommendations

### 1. AKS Planned Maintenance Window (recommended)

Configure AKS to only do maintenance during low-traffic hours:

```
az aks maintenancewindow add \
  --resource-group <RG> \
  --cluster-name <CLUSTER> \
  --name default \
  --schedule-type Weekly \
  --day-of-week Sunday \
  --start-time 02:00 \
  --duration 4
```

This tells Azure: "only reboot nodes between 2-6 AM UTC on Sundays." Reduces impact on active users.

Applies to all clusters: US Central (4689), France (4696), East Asia (4754), US West (4965), US East (4977).

### 2. Pod Disruption Budgets (optional)

Add a PodDisruptionBudget to ensure at least 1 replica stays running during node drains:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cloud-prod-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: cloud-prod-cloud
```

Only useful if we run multiple replicas per region (we currently run 1).

### 3. Document in runbooks

Add to the pod-crash runbook: "If multiple unrelated pods restart simultaneously on the same cluster, check for AKS node maintenance events before investigating code bugs."

---

## How to Verify This in the Future

If someone reports apps randomly dying and you suspect node maintenance:

```bash
# Check for node events (RebootScheduled, RedeployScheduled, NodeNotReady)
porter kubectl --cluster <CLUSTER_ID> -- get events -n default --sort-by=.lastTimestamp | grep -i "reboot\|redeploy\|evict\|drain\|NotReady"

# Check if multiple unrelated pods restarted at the same time
porter kubectl --cluster <CLUSTER_ID> -- get pods -n default --sort-by=.status.startTime | tail -20

# Check which node a pod was on
porter kubectl --cluster <CLUSTER_ID> -- get pods -n default -o wide | grep <POD_NAME>

# Check node status
porter kubectl --cluster <CLUSTER_ID> -- get nodes
porter kubectl --cluster <CLUSTER_ID> -- describe node <NODE_NAME> | grep -A10 "Conditions"
```

If you see `RebootScheduled`/`RedeployScheduled` events and multiple pods killed at the same time — it's Azure maintenance, not a code bug.

---

## Cluster IDs for Reference

| Region | Cluster ID | Node pool prefix |
|--------|-----------|-----------------|
| US Central | 4689 | aks-a4689qbpv |
| France | 4696 | aks-a4696* |
| East Asia | 4754 | aks-a4754* |
| US West | 4965 | aks-a4965* |
| US East | 4977 | aks-a4977* |