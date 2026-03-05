# Spec: Dedicated WebSocket Ingress with Extended Timeouts

## Overview

**What this doc covers:** The permanent infrastructure fix for nginx killing Glasses WebSocket connections every 60 seconds. A dedicated Kubernetes Ingress resource for WebSocket paths (`/glasses-ws`, `/app-ws`) with extended timeouts, separate from the REST ingress managed by Porter.

**Why this doc exists:** The [spike](./spike.md) confirmed that nginx's `proxy-send-timeout: 60s` was killing idle WebSocket connections because no client → server traffic flows on the Glasses WS after initial setup. Bumping the timeout on the main ingress works but affects REST endpoints too. We need a targeted fix that only changes timeout behavior for WebSocket paths.

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

### Separate Ingress for WebSocket Paths

Create a standalone Kubernetes Ingress resource for each environment that:

- Matches only `/glasses-ws` and `/app-ws` paths
- Sets `proxy-send-timeout` and `proxy-read-timeout` to 3600 seconds (1 hour)
- Leaves `proxy-connect-timeout` at 60 seconds (the TCP handshake doesn't need an hour)
- Reuses the same TLS secrets as the main ingress
- Is NOT managed by Porter (Porter only manages `cloud-{env}-cloud`)

The main Porter-managed ingress continues to serve all other paths (REST API, health checks, etc.) with 60s timeouts. nginx evaluates locations by specificity — `/glasses-ws` exact match takes priority over the catch-all `/`.

### Timeout Values

| Setting                 | WebSocket Ingress | REST Ingress (Porter-managed) |
| ----------------------- | ----------------- | ----------------------------- |
| `proxy-read-timeout`    | **3600s**         | 60s                           |
| `proxy-send-timeout`    | **3600s**         | 60s                           |
| `proxy-connect-timeout` | 60s               | 60s                           |

**Why 3600 and not higher?** An hour is long enough that no user session would realistically be idle for that long without other keepalive mechanisms firing. If the connection is truly dead for an hour, it should be cleaned up. The client-side liveness detection from [034](../034-ws-liveness/spec.md) will detect and recover from dead connections within seconds regardless — this timeout is just a safety net to prevent nginx from proactively killing healthy connections.

**Why not infinity?** Zombie connections that are technically alive at the TCP level but functionally dead (e.g., the client process crashed without closing the socket) need to be cleaned up eventually. 3600s is a reasonable upper bound. The server-side pong timeout (30s) and Bun's `idleTimeout` (120s) provide tighter zombie detection at the application layer.

---

## Manifest

One YAML file per environment. Example for debug:

```yaml
# k8s/ws-ingress-debug.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cloud-debug-cloud-ws
  namespace: default
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  rules:
    - host: debug.augmentos.cloud
      http:
        paths:
          - path: /glasses-ws
            pathType: Prefix
            backend:
              service:
                name: cloud-debug-cloud
                port:
                  number: 80
          - path: /app-ws
            pathType: Prefix
            backend:
              service:
                name: cloud-debug-cloud
                port:
                  number: 80
    - host: debugapi.mentra.glass
      http:
        paths:
          - path: /glasses-ws
            pathType: Prefix
            backend:
              service:
                name: cloud-debug-cloud
                port:
                  number: 80
          - path: /app-ws
            pathType: Prefix
            backend:
              service:
                name: cloud-debug-cloud
                port:
                  number: 80
  tls:
    - hosts:
        - debug.augmentos.cloud
      secretName: cloud-debug-cloud-debug-augmentos-cloud
    - hosts:
        - debugapi.mentra.glass
      secretName: cloud-debug-cloud-debugapi-mentra-glass
```

Each environment needs its own manifest with the correct service name, hosts, and TLS secret names:

| Environment | Ingress Name             | Service               | Hosts                                              |
| ----------- | ------------------------ | --------------------- | -------------------------------------------------- |
| debug       | `cloud-debug-cloud-ws`   | `cloud-debug-cloud`   | `debug.augmentos.cloud`, `debugapi.mentra.glass`   |
| dev         | `cloud-dev-cloud-ws`     | `cloud-dev-cloud`     | `dev.augmentos.cloud`, `devapi.mentra.glass`       |
| staging     | `cloud-staging-cloud-ws` | `cloud-staging-cloud` | `stagingapi.mentraglass.com`                       |
| prod        | `cloud-prod-cloud-ws`    | `cloud-prod-cloud`    | `global.augmentos.cloud`, `api.mentra.glass`, etc. |

---

## Deployment

### Apply

```bash
porter kubectl -- apply -f k8s/ws-ingress-debug.yaml
porter kubectl -- apply -f k8s/ws-ingress-dev.yaml
porter kubectl -- apply -f k8s/ws-ingress-staging.yaml
porter kubectl -- apply -f k8s/ws-ingress-prod.yaml
```

### Verify

After applying, verify nginx generated separate location blocks with the correct timeouts:

```bash
porter kubectl -- exec <ingress-controller-pod> -n ingress-nginx -- \
    cat /etc/nginx/nginx.conf | grep -A5 'location = /glasses-ws'
```

Expected:

```
proxy_send_timeout                      3600s;
proxy_read_timeout                      3600s;
```

### Rollback

```bash
porter kubectl -- delete ingress cloud-debug-cloud-ws -n default
```

Deleting the WS ingress reverts behavior — WebSocket paths fall back to the main ingress's `location /` with 60s timeouts.

---

## Porter Compatibility

**Porter will not touch these ingress resources.** Porter only manages ingress resources it created (identified by Helm labels like `app.kubernetes.io/managed-by: Helm` and `app.kubernetes.io/instance: cloud-debug`). Our WS ingress resources are standalone — no Helm labels, no Porter annotations. Porter deploys will not overwrite or delete them.

**However:** If a Porter deploy changes the service name (unlikely but possible during major refactors), the WS ingress would need to be updated to match. This is a manual step.

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
| **Infrastructure (this issue)** | Extended nginx timeouts for WS paths                | Prevents nginx from killing healthy idle connections                                                                      |
| **Application — server (034)**  | App-level pings every 2s, pong responder            | Keeps Cloudflare's 100s timeout alive; gives client liveness signal                                                       |
| **Application — client (034)**  | Client sends pings, tracks liveness, fast reconnect | Detects dead connections in ~4s instead of 60–120s; creates client → server traffic that would also prevent nginx timeout |

Once the client-side pings from 034 are deployed (mobile app change), client → server traffic will flow every 2 seconds on the Glasses WS. This would independently prevent `proxy_send_timeout` from firing even at 60s. The extended timeout in this issue is defense-in-depth — it ensures the connection survives even if the client-side pings are delayed, batched, or temporarily interrupted.

**Both fixes should ship.** Neither alone is sufficient:

- Without this fix: client pings keep the connection alive, but any delay >60s in client ping delivery kills the connection.
- Without 034 client pings: this fix keeps nginx happy, but Cloudflare's 100s timeout could still fire during prolonged client silence, and the client has no way to detect a dead connection quickly.

---

## Verified

The fix was tested on debug on Feb 13, 2026:

1. Before fix: matt.cfosse's Glasses WS cycling 1006 every ~60 seconds continuously.
2. Applied WS ingress with 3600s timeouts.
3. After fix: Zero 1006s from timeout. Matt's connections showed only clean closes (1000/1001). All other users stopped cycling.
4. Remaining 1006s (caydenpierce4, isaiahballah) had irregular timing (19s, 84s, 93s) — confirmed as organic network disconnections, not timeouts.
