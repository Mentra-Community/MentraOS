# Spec: Extended WebSocket Timeouts via Porter `ingressAnnotations`

## Overview

**What this doc covers:** The permanent infrastructure fix for nginx killing Glasses WebSocket connections every 60 seconds. Extended timeout annotations applied directly to the Porter-managed ingress via `ingressAnnotations` in the Porter YAML files.

**Why this doc exists:** The [spike](./spike.md) confirmed that nginx's `proxy-send-timeout: 60s` was killing idle WebSocket connections because no client → server traffic flows on the Glasses WS after initial setup. This spec documents the chosen fix and the evolution from a separate-ingress approach to the current Porter-native approach.

**What you need to know first:** Read [spike.md](./spike.md) for the root cause investigation.

**Who should read this:** Cloud engineers, infra engineers, anyone deploying cloud environments.

---

## The Problem in 30 Seconds

1. Porter manages the cloud ingress (`cloud-{env}-cloud`) and sets `proxy-send-timeout: 60s` on all paths.
2. For REST requests, 60s is fine — responses come back fast.
3. For WebSocket connections, `proxy-send-timeout` fires when the **client** doesn't send data for 60 seconds. The server's pings don't help — they only reset the server → client direction timeout.
4. Audio moved from the Glasses WebSocket to UDP months ago. The Glasses WS is now idle in the client → server direction between sporadic control messages.
5. nginx kills the connection with 1006 every ~60 seconds.

---

## Fix

### Porter `ingressAnnotations` (Current Approach)

Extended timeout annotations are applied directly to the Porter-managed ingress via `ingressAnnotations` in the Porter YAML files (`porter.yaml` and `porter-livekit.yaml`):

```yaml
ingressAnnotations:
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
```

This tells Porter to set these annotations on its own managed ingress resource. No separate ingress resources are needed.

### Timeout Values

| Setting                 | Value     | Purpose                                       |
| ----------------------- | --------- | --------------------------------------------- |
| `proxy-read-timeout`    | **3600s** | Don't kill WS if server is quiet for < 1 hour |
| `proxy-send-timeout`    | **3600s** | Don't kill WS if client is quiet for < 1 hour |
| `proxy-connect-timeout` | 60s       | TCP handshake timeout (unchanged)             |

**Why 3600 and not higher?** An hour is long enough that no user session would realistically be idle for that long without other keepalive mechanisms firing. If the connection is truly dead for an hour, it should be cleaned up. The client-side liveness detection from [034](../034-ws-liveness/spec.md) will detect and recover from dead connections within seconds regardless — this timeout is just a safety net to prevent nginx from proactively killing healthy connections.

**Why not infinity?** Zombie connections that are technically alive at the TCP level but functionally dead (e.g., the client process crashed without closing the socket) need to be cleaned up eventually. 3600s is a reasonable upper bound. The server-side pong timeout (30s) and Bun's `idleTimeout` (120s) provide tighter zombie detection at the application layer.

### Tradeoff: Timeouts Apply to All Paths

Unlike the previous approach (see [Superseded Approach](#superseded-approach-separate-ws-ingress) below), the 3600s timeouts apply to **all** paths — REST endpoints included, not just `/glasses-ws` and `/app-ws`.

This is fine in practice. For REST requests, responses come back in <1s. The timeout only means "don't kill the connection if idle for <3600s" — it doesn't make REST requests slower. A REST request that takes 60s to respond would have failed under the old 60s timeout too, and that's a server bug, not a timeout issue.

---

## Where the Annotations Live

Both Porter YAML files carry the annotations:

- **`cloud/porter.yaml`** — used by `porter-prod.yml` for us-central
- **`cloud/porter-livekit.yaml`** — used by `porter-debug.yml`, `porter-dev.yml`, and others

Any new Porter YAML variants must also include the `ingressAnnotations` block.

---

## Deployment Status

### ✅ Fixed: debug, dev, staging (us-central cluster 4689)

These environments deploy via `porter-livekit.yaml` which includes the `ingressAnnotations`. The old standalone WS ingress resources were deleted from the cluster, and Porter deploys succeed.

### ❌ Blocked: prod (all clusters)

As of Feb 19, 2026, prod deploys are blocked because the old standalone `cloud-prod-cloud-ws` ingress resources still exist in the prod clusters. Porter sees those ingresses claiming the same domains and refuses to deploy.

**Error:**

```
domains [global.augmentos.cloud, us-central.augmentos.cloud, uscentral.api.mentra.glass,
api.mentra.glass, uscentralapi.mentra.glass, prod.augmentos.cloud] already exist on
services [cloud-prod-cloud-ws]
```

### Fix: Delete the old WS ingresses from all prod clusters

Run these commands to remove the standalone WS ingress from each prod cluster:

```bash
# us-central (4689) — default cluster, no PORTER_CLUSTER needed
porter kubectl -- delete ingress cloud-prod-cloud-ws -n default

# east-asia (4754)
PORTER_CLUSTER=4754 porter kubectl -- delete ingress cloud-prod-cloud-ws -n default

# france (4696)
PORTER_CLUSTER=4696 porter kubectl -- delete ingress cloud-prod-cloud-ws -n default

# us-west (4965)
PORTER_CLUSTER=4965 porter kubectl -- delete ingress cloud-prod-cloud-ws -n default

# us-east (4977)
PORTER_CLUSTER=4977 porter kubectl -- delete ingress cloud-prod-cloud-ws -n default
```

After deleting, re-trigger the prod deploy (push to `main` or `workflow_dispatch`). Porter will create/update the main `cloud-prod-cloud` ingress with the 3600s annotations baked in.

### Verify

After a successful deploy, confirm the annotations are on the Porter-managed ingress:

```bash
porter kubectl -- get ingress cloud-prod-cloud -n default -o yaml | grep -A3 proxy
```

Expected:

```
nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

---

## Superseded Approach: Separate WS Ingress

The original approach (documented in previous versions of this spec) created standalone Kubernetes Ingress resources (`cloud-{env}-cloud-ws`) for WebSocket paths only:

- Matched only `/glasses-ws` and `/app-ws` paths
- Set 3600s timeouts only on those paths
- Left the Porter-managed ingress untouched at 60s for REST

**Why this was abandoned:** Porter validates domain uniqueness across all ingress resources in the cluster. When a standalone WS ingress claimed the same hostnames (e.g., `api.mentra.glass`) as the Porter-managed ingress — even on different paths — Porter blocked all deployments with "domains already exist on services" errors. This made it impossible to deploy any code changes.

The standalone WS ingress manifests (`cloud/k8s/ws-ingress-*.yaml`) have been deleted from the repo. If you find a `cloud-{env}-cloud-ws` ingress in any cluster, it's a leftover from this approach and should be deleted.

---

## What This Does NOT Fix

- **Organic 1006s from network instability** — WiFi ↔ cellular handoffs, Cloudflare edge rebalancing, mobile network black-holes. These are handled by client-side liveness detection from [034](../034-ws-liveness/spec.md).
- **nginx ingress controller restarts** — When a controller pod restarts, all WebSocket connections through that pod die. This is a Kubernetes infrastructure event, not a timeout issue.
- **Cloudflare's 100-second idle timeout** — Cloudflare kills WebSocket connections with no data in either direction for 100 seconds. The server's app-level pings every 2 seconds keep this alive. No ingress change needed.
- **Client-side detection of dead connections** — Still requires the mobile app changes from [034](../034-ws-liveness/spec.md) (client sends pings, tracks liveness, reconnects on timeout).

---

## Relationship to 034-ws-liveness

These are complementary fixes at different layers:

| Layer                           | Fix                                                   | What it solves                                                                                                            |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Infrastructure (this issue)** | Extended nginx timeouts via Porter ingressAnnotations | Prevents nginx from killing healthy idle connections                                                                      |
| **Application — server (034)**  | App-level pings every 2s, pong responder              | Keeps Cloudflare's 100s timeout alive; gives client liveness signal                                                       |
| **Application — client (034)**  | Client sends pings, tracks liveness, fast reconnect   | Detects dead connections in ~4s instead of 60–120s; creates client → server traffic that would also prevent nginx timeout |

Once the client-side pings from 034 are deployed (mobile app change), client → server traffic will flow every 2 seconds on the Glasses WS. This would independently prevent `proxy_send_timeout` from firing even at 60s. The extended timeout in this issue is defense-in-depth — it ensures the connection survives even if the client-side pings are delayed, batched, or temporarily interrupted.

**Both fixes should ship.** Neither alone is sufficient:

- Without this fix: client pings keep the connection alive, but any delay >60s in client ping delivery kills the connection.
- Without 034 client pings: this fix keeps nginx happy, but Cloudflare's 100s timeout could still fire during prolonged client silence, and the client has no way to detect a dead connection quickly.

---

## Verified

The fix was tested on debug on Feb 13, 2026:

1. Before fix: matt.cfosse's Glasses WS cycling 1006 every ~60 seconds continuously.
2. Applied extended timeouts (initially via standalone WS ingress, now via Porter ingressAnnotations — same nginx behavior).
3. After fix: Zero 1006s from timeout. Matt's connections showed only clean closes (1000/1001). All other users stopped cycling.
4. Remaining 1006s (caydenpierce4, isaiahballah) had irregular timing (19s, 84s, 93s) — confirmed as organic network disconnections, not timeouts.

Debug, dev, and staging confirmed working with the Porter `ingressAnnotations` approach after deleting the old standalone WS ingresses from us-central cluster (4689).
