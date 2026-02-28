# Spike: Why Are Mobile ↔ Cloud WebSocket Connections Dying?

## Overview

**What this doc covers:** The mobile client's WebSocket connection to cloud drops frequently, causing app start failures, silent UI errors, and a broken user experience. This spike investigates _which infrastructure layer_ is killing the connection and _what we can do about it_.

**Why this doc exists:** We've always had occasional WS drops — that's expected with mobile networks. But recently the drops have become more frequent, and more importantly, the client takes 30–90+ seconds to notice and reconnect (sometimes never). Before we fix detection/recovery (see [spec.md](./spec.md)), we need to understand the root cause so we're not just patching symptoms.

**Who should read this:** Anyone working on the mobile client, cloud infrastructure, or debugging connection issues.

---

## Background

### The path a WebSocket takes

Every WS connection from the mobile client to cloud passes through three layers, each of which can kill it:

```
Mobile App ──→ Cloudflare ──→ nginx Ingress ──→ Cloud Pod (:80)
               (Layer 1)      (Layer 2)         (Layer 3)
```

- **Cloudflare** — geo load balancer + CDN. Terminates TLS, proxies to the origin.
- **nginx Ingress** — Kubernetes ingress controller managed by Porter. Proxies HTTP/WS to the pod.
- **Cloud Pod** — Bun server running the cloud service. Accepts the WS, creates a `UserSession`.

UDP audio takes a completely separate path (`Mobile → LoadBalancer IP:8000 → Pod :8000`) and bypasses Cloudflare and nginx entirely. This is important — see findings below.

### What a 1006 close code means

When a WS connection dies, the close event includes a numeric code. We're seeing mostly **1006**, which means:

> **Abnormal closure** — the connection was lost without a proper WebSocket close handshake.

Translation: something between the client and server severed the TCP connection. Neither the client nor the server intentionally closed it. The connection was cut by an intermediary (Cloudflare or nginx) or by a network-level event.

Other codes for context:

- `1000` — clean close, server or client intentionally disconnected
- `1001` — "going away," e.g. server shutting down during a deployment
- `1006` — abnormal, no close frame (this is what we're seeing)

---

## Findings

### 1. nginx Ingress default timeouts are likely the primary killer

The Kubernetes nginx ingress controller has these defaults:

| Setting                 | Default | What it does                                                                        |
| ----------------------- | ------- | ----------------------------------------------------------------------------------- |
| `proxy-read-timeout`    | **60s** | If the _backend_ (cloud pod) doesn't send data for 60s, nginx closes the connection |
| `proxy-send-timeout`    | **60s** | If the _client_ doesn't send data for 60s, nginx closes the connection              |
| `proxy-connect-timeout` | 5s      | Time to establish a connection to the backend                                       |

Porter manages the nginx ingress and **does not expose these settings** in `porter.yaml`. They're left at defaults unless overridden via Kubernetes ingress annotations, which requires `porter kubectl`.

**Why this matters now more than before:** Over the past several months, traffic has been gradually migrated off the WebSocket. Audio moved from WS to LiveKit (September 2025), then from LiveKit to UDP (early 2026). Various client-to-cloud operations that used to go over the WS were moved to REST requests. The WS used to carry a constant firehose of audio chunks (many per second) — it was never idle. Now it only carries control messages (display events, app state changes, occasional RPCs), which can have gaps of 30–60+ seconds between them. A 60-second gap triggers the nginx timeout, and the connection dies with a 1006.

### 2. Cloudflare has a 100-second idle timeout for WebSockets

Cloudflare's WebSocket proxy has a 100-second idle timeout. If no data flows in either direction for 100 seconds, Cloudflare terminates the connection. This is longer than nginx's 60s default, so nginx would kill it first in most cases. But Cloudflare can also terminate connections during:

- Edge server rebalancing
- DDoS mitigation events
- Regional failover

These are unpredictable and outside our control.

### 3. Pod restarts during deployments

When Porter deploys a new version, Kubernetes performs a rolling update — the old pod is terminated and a new one starts. During this window:

- Active WS connections on the old pod are killed (close code 1001 or 1006)
- The client needs to reconnect to the new pod

This is expected behavior and not a bug, but the client needs to handle it gracefully.

### 4. The server-side heartbeat is invisible to the client

The cloud already sends WebSocket protocol-level pings every 10 seconds:

```typescript
// cloud/packages/cloud/src/services/session/UserSession.ts
private setupGlassesHeartbeat(): void {
    const HEARTBEAT_INTERVAL = 10000; // 10 seconds
    this.glassesHeartbeatInterval = setInterval(() => {
        if (this.websocket && this.websocket.readyState === WebSocketReadyState.OPEN) {
            this.websocket.ping?.();
        }
    }, HEARTBEAT_INTERVAL);
}
```

These are **protocol-level pings** (RFC 6455 control frames). The mobile OS automatically responds with a pong, but React Native's `WebSocket` API does not surface these to JavaScript. The `onmessage` callback never fires for protocol-level ping/pong frames. So from the client's perspective, it has no idea the server is pinging it, and no way to detect when the server stops.

These protocol-level pings _do_ keep the connection alive through nginx and Cloudflare (since they count as traffic). But if the server goes down or the connection is severed upstream of the server, the client has zero signal.

### 5. The client has no liveness detection at all

`WebSocketManager.ts` relies entirely on the browser/OS `onerror` and `onclose` events to detect a dead connection. These events are triggered by:

- The server sending a close frame (clean close)
- The OS detecting a dead TCP connection via TCP keepalive

The problem: TCP keepalive on Android can take **minutes** to detect a dead connection (30–120+ seconds depending on device, carrier, and battery settings). Samsung devices with aggressive battery management are even worse. If the intermediary (nginx/Cloudflare) kills the connection without sending a RST packet to the client, or if the network silently drops packets (e.g. wifi ↔ cellular handoff), the client sits there thinking it's connected.

**Verified experimentally:** Connecting to a local cloud, then pausing the Docker VM, the client did not detect the dead connection for over 60 seconds. No `onerror`, no `onclose`, nothing.

---

## Conclusions

| Cause                                    |     Controllable?     | Fix                                                                                              |
| ---------------------------------------- | :-------------------: | ------------------------------------------------------------------------------------------------ |
| nginx `proxy-read-timeout` (60s default) |        ✅ Yes         | Increase via ingress annotations for WS paths, OR keep the connection alive with app-level pings |
| Cloudflare idle timeout (100s)           |         ❌ No         | Keep the connection alive with app-level pings                                                   |
| Cloudflare edge rebalancing              |         ❌ No         | Detect and reconnect fast                                                                        |
| Pod restarts during deployment           |     ⚠️ Partially      | Detect and reconnect fast                                                                        |
| Client can't see protocol-level pings    | ❌ No (RN limitation) | Use application-level pings instead                                                              |
| Client has no liveness detection         |        ✅ Yes         | Implement app-level ping/pong with timeout                                                       |
| TCP keepalive too slow on Android        |   ❌ No (OS-level)    | Don't rely on it — use app-level detection                                                       |

**The pattern:** Most of these are either uncontrollable or only partially controllable. The one thing we _can_ fully control is what the client and server do at the application level. Application-level ping/pong solves two problems at once:

1. **Keepalive** — regular traffic prevents nginx and Cloudflare from considering the connection idle
2. **Liveness detection** — if pings go unanswered, the client knows the connection is dead within seconds, not minutes

We should also increase the nginx timeout for WS paths as defense-in-depth, so we're not relying solely on client-side pings to prevent our own infrastructure from killing connections.

---

## Next steps

1. **[spec.md](./spec.md)** — Spec for application-level ping/pong between mobile client and cloud
2. **[design.md](./design.md)** — Implementation design for client (`WebSocketManager.ts`) and cloud (glasses WS handler)
3. **Infra task** — Increase nginx `proxy-read-timeout` and `proxy-send-timeout` for the `/glasses-ws` and `/app-ws` ingress paths via `porter kubectl`

---

## Note: Cloud ↔ Mini-App WebSockets

The same WS liveness problem exists between cloud and third-party mini-apps (TPAs). However, this is less critical right now because:

- Mini-apps **do** detect 1006 close codes via the SDK
- The SDK's reconnection logic kicks in immediately on disconnect
- Cloud-side resurrection handles the reconnect within seconds

The mini-app side may benefit from the same app-level ping/pong eventually, but it's not the priority — the mobile client connection is the one users directly experience.
