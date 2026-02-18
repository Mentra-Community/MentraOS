# Spec: Extended nginx Timeouts for WebSocket Connections

## Overview

**What this doc covers:** The permanent infrastructure fix for nginx killing Glasses WebSocket connections every 60 seconds. Extended timeout annotations on the Porter-managed ingress via `ingressAnnotations` in `porter.yaml`, applied globally to all paths.

**Why this doc exists:** The [spike](./spike.md) confirmed that nginx's `proxy-send-timeout: 60s` was killing idle WebSocket connections because no client → server traffic flows on the Glasses WS after initial setup. We need to extend these timeouts so nginx doesn't proactively kill healthy WebSocket connections.

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

## Fix: `ingressAnnotations` in `porter.yaml`

### Approach

Add `ingressAnnotations` to the cloud web service in `porter.yaml`. Porter applies these annotations to its managed ingress resource on every deploy, overriding the default 60s timeouts with 3600s.

This is the Porter-native way to customize nginx behavior — see [Porter Advanced Networking docs](https://docs.porter.run/applications/configure/advanced-networking).

```yaml
# cloud/porter.yaml (on the web service)
ingressAnnotations:
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
```

### Timeout Values

| Setting                 | Value     | Rationale                                                   |
| ----------------------- | --------- | ----------------------------------------------------------- |
| `proxy-read-timeout`    | **3600s** | Prevents nginx from killing idle server → client direction  |
| `proxy-send-timeout`    | **3600s** | Prevents nginx from killing idle client → server direction  |
| `proxy-connect-timeout` | **60s**   | TCP handshake doesn't need an hour — 60s is generous enough |

**Why 3600 and not higher?** An hour is long enough that no user session would realistically be idle for that long without other keepalive mechanisms firing. If the connection is truly dead for an hour, it should be cleaned up. The client-side liveness detection from [034](../034-ws-liveness/spec.md) will detect and recover from dead connections within seconds regardless — this timeout is just a safety net to prevent nginx from proactively killing healthy connections.

**Why not infinity?** Zombie connections that are technically alive at the TCP level but functionally dead (e.g., the client process crashed without closing the socket) need to be cleaned up eventually. 3600s is a reasonable upper bound. Bun's `idleTimeout` (120s) provides tighter zombie detection at the application layer.

### Effect on REST endpoints

The 3600s timeouts apply to **all paths**, including REST endpoints. This is fine in practice:

- REST requests complete in milliseconds to seconds. The timeout is a ceiling, not a delay.
- The only theoretical risk is a hung REST handler taking up to an hour to be killed by nginx instead of 60s. This is a marginal concern — application-level timeouts should catch this long before nginx does.
- Porter does not support per-path ingress annotations. This is the tradeoff for Porter compatibility.

---

## ~~Previous Approach: Separate WS Ingress Manifests (Deprecated)~~

### What we tried

The original approach created standalone Kubernetes Ingress resources per environment (`cloud/k8s/ws-ingress-*.yaml`) that matched only `/glasses-ws` and `/app-ws` paths with 3600s timeouts, while leaving the Porter-managed ingress at 60s for REST paths.

### Why it failed

Porter's API performs **domain-level** conflict detection across **all** ingress resources in the cluster, not just Porter-managed ones. When the WS ingress claimed the same domain (e.g., `stagingapi.mentraglass.com`) for WS paths, Porter refused to deploy the main app:

```
error: error calling update app endpoint: internal: domains [stagingapi.mentraglass.com] already exist on services [cloud-staging-cloud-ws]
```

This blocked every `porter apply` (i.e., every CI deploy) on any environment where a WS ingress had been applied. The separate ingress approach is fundamentally incompatible with Porter's domain validation.

### Cleanup required

The old WS ingress resources must be **deleted from all clusters** where they were applied, and the manifests removed from the repo:

**Delete from clusters:**

```bash
# For each cluster where WS ingress was applied:
porter kubectl -- delete ingress cloud-debug-cloud-ws -n default
porter kubectl -- delete ingress cloud-dev-cloud-ws -n default
porter kubectl -- delete ingress cloud-staging-cloud-ws -n default
porter kubectl -- delete ingress cloud-prod-cloud-ws -n default
# Repeat for east-asia, france, us-west, us-east clusters as needed
```

**Remove from repo:**

The `cloud/k8s/ws-ingress-*.yaml` manifests have been deleted from the repository. They are no longer needed since the fix lives in `porter.yaml`.

---

## Deployment

### How it deploys

The `ingressAnnotations` are part of `porter.yaml`, so they deploy automatically on every `porter apply` — no manual `kubectl` steps needed. Every environment (debug, dev, staging, prod) and every cluster gets the fix as part of normal CI/CD.

### Verify

After a deploy, confirm the annotations are on the Porter-managed ingress:

```bash
porter kubectl -- get ingress cloud-<env>-cloud -o yaml | grep -A3 proxy
```

Expected:

```yaml
nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

Or check the generated nginx config:

```bash
porter kubectl -- exec <ingress-controller-pod> -n ingress-nginx -- \
    cat /etc/nginx/nginx.conf | grep -A2 proxy_send_timeout
```

### Rollback

Remove the `ingressAnnotations` block from `porter.yaml` and run `porter apply`. Porter will revert the ingress to its default 60s timeouts. Note: this will immediately re-introduce the 60-second WS kill cycle.

---

## What This Does NOT Fix

- **Organic 1006s from network instability** — WiFi ↔ cellular handoffs, Cloudflare edge rebalancing, mobile network black-holes. These are handled by client-side liveness detection from [034](../034-ws-liveness/spec.md).
- **nginx ingress controller restarts** — When a controller pod restarts, all WebSocket connections through that pod die. This is a Kubernetes infrastructure event, not a timeout issue.
- **Cloudflare's 100-second idle timeout** — Cloudflare kills WebSocket connections with no data in either direction for 100 seconds. The server's app-level pings every 2 seconds keep this alive. No ingress change needed.
- **Client-side detection of dead connections** — Still requires the mobile app changes from [034](../034-ws-liveness/design.md) (client sends pings, tracks liveness, reconnects on timeout).

---

## Relationship to 034-ws-liveness

These are complementary fixes at different layers:

| Layer                           | Fix                                                 | What it solves                                                                                                            |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Infrastructure (this issue)** | Extended nginx timeouts via porter.yaml             | Prevents nginx from killing healthy idle connections                                                                      |
| **Application — server (034)**  | App-level pings every 2s, pong responder            | Keeps Cloudflare's 100s timeout alive; gives client liveness signal                                                       |
| **Application — client (034)**  | Client sends pings, tracks liveness, fast reconnect | Detects dead connections in ~4s instead of 60–120s; creates client → server traffic that would also prevent nginx timeout |

Once the client-side pings from 034 are deployed (mobile app change), client → server traffic will flow every 2 seconds on the Glasses WS. This would independently prevent `proxy_send_timeout` from firing even at 60s. The extended timeout in this issue is defense-in-depth — it ensures the connection survives even if the client-side pings are delayed, batched, or temporarily interrupted.

**Both fixes should ship.** Neither alone is sufficient:

- Without this fix: client pings keep the connection alive, but any delay >60s in client ping delivery kills the connection.
- Without 034 client pings: this fix keeps nginx happy, but Cloudflare's 100s timeout could still fire during prolonged client silence, and the client has no way to detect a dead connection quickly.

---

## Verified

The extended timeout fix was originally tested on debug on Feb 13, 2026 (via manual annotation, then via separate WS ingress):

1. Before fix: matt.cfosse's Glasses WS cycling 1006 every ~60 seconds continuously.
2. Applied 3600s timeouts.
3. After fix: Zero 1006s from timeout. Matt's connections showed only clean closes (1000/1001). All other users stopped cycling.
4. Remaining 1006s (caydenpierce4, isaiahballah) had irregular timing (19s, 84s, 93s) — confirmed as organic network disconnections, not timeouts.

The porter.yaml `ingressAnnotations` approach achieves the same result (same annotations on the same ingress) through a Porter-compatible mechanism.
