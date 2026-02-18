# Spike: nginx `proxy-send-timeout` Kills Glasses WebSocket Every 60 Seconds

## Overview

**What this doc covers:** Why the Glasses WebSocket (mobile client ↔ cloud) was being killed with close code 1006 every ~60 seconds on debug, even after deploying the app-level ping/pong fix from [034-ws-liveness](../034-ws-liveness/spike.md).

**Why this doc exists:** Issue 034 added application-level ping/pong to keep WebSocket connections alive. The server now sends `{"type": "ping"}` every 2 seconds and protocol-level pings every 10 seconds. Despite this, connections were still dying at a perfect ~60-second cadence. This spike documents the root cause investigation and the fix.

**Who should read this:** Anyone working on cloud infrastructure, WebSocket reliability, or debugging connection issues.

---

## Background

### What we expected after deploying 034

The [ws-liveness fix](../034-ws-liveness/design.md) added:

1. **Server → client app-level pings** every 2 seconds (`{"type": "ping"}`)
2. **Server → client protocol-level pings** every 10 seconds (`this.websocket.ping?.()`)
3. **Server responds to client pings** with `{"type": "pong"}`
4. **Bun's built-in `sendPings: true`** with `idleTimeout: 120`

With data flowing every 2 seconds, no timeout at any layer should fire. The connection should stay alive indefinitely.

### What actually happened

After deploying the `cloud/ws-liveness-detection` branch to debug at ~11:33 AM PST on Feb 13, 2026, the Glasses WebSocket continued to die with 1006 every ~60 seconds for every active user.

Example — matt.cfosse's connection cycle (all times PST):

| Time        | Event                                    |
| ----------- | ---------------------------------------- |
| 12:54:24 PM | Glasses WS opened, heartbeat established |
| 12:55:22 PM | 1006 — **58 seconds later**              |
| 12:55:28 PM | Reconnected, heartbeat re-established    |
| 12:56:26 PM | 1006 — **58 seconds later**              |
| 12:56:31 PM | Reconnected                              |
| 12:57:30 PM | 1006 — **59 seconds later**              |

Every single cycle: open → ~58–60 seconds → 1006 → reconnect → repeat. This was happening to all active users on debug simultaneously.

---

## Investigation

### Step 1: Confirm the server IS sending pings

Checked the deployed code in `UserSession.ts`. Both ping mechanisms are active:

```typescript
// Protocol-level pings every 10s
this.glassesHeartbeatInterval = setInterval(() => {
  this.websocket.ping?.();
}, 10000);

// App-level pings every 2s
this.appLevelPingInterval = setInterval(() => {
  this.websocket.send(JSON.stringify({ type: "ping" }));
}, 2000);
```

BetterStack logs confirmed heartbeats being established and cleared on each reconnect cycle. The server code is running correctly.

### Step 2: Check the nginx ingress configuration

Pulled the ingress YAML for `cloud-debug-cloud`:

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
  nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
```

All three timeouts set to 60 seconds. These are per-ingress annotation overrides — the global nginx ConfigMap actually has `proxy-read-timeout: 240` and `proxy-send-timeout: 240`, but the ingress annotations override those back to 60.

### Step 3: Understand what each timeout means

In nginx's WebSocket tunnel mode, after the HTTP → WebSocket upgrade, nginx acts as a bidirectional byte forwarder. Each direction has its own timeout:

| Timeout              | Direction                               | What resets it                     |
| -------------------- | --------------------------------------- | ---------------------------------- |
| `proxy_read_timeout` | **upstream → nginx** (server → nginx)   | Any data sent by the cloud pod     |
| `proxy_send_timeout` | **downstream → nginx** (client → nginx) | Any data sent by the mobile client |

These are tracked **independently**. Data flowing server → client does NOT reset `proxy_send_timeout`. Only client → server data resets it.

### Step 4: Trace data flow in each direction

**Server → client (resets `proxy_read_timeout`):**

- App-level pings every 2s ✅
- Protocol-level pings every 10s ✅
- Display events, app state changes, etc. ✅

`proxy_read_timeout` is reset every 2 seconds. This timeout never fires.

**Client → server (resets `proxy_send_timeout`):**

Between connection setup and the next user action... **nothing**. Audio moved to UDP months ago. The Glasses WebSocket used to carry a constant firehose of audio chunks — now it only carries sporadic control messages. During idle periods, zero bytes flow client → server on the Glasses WS.

### Step 5: What about protocol-level pongs?

The server sends protocol-level pings every 10 seconds. The mobile OS automatically responds with protocol-level pongs. These pongs flow: **Mobile → Cloudflare → nginx → Cloud Pod**. This should reset `proxy_send_timeout`.

But the connection path is:

```
Mobile App ──→ Cloudflare ──→ nginx Ingress ──→ Cloud Pod
```

Cloudflare sits between the client and nginx. Cloudflare maintains **two separate TCP connections** (client ↔ edge, edge ↔ origin). Cloudflare's WebSocket proxy handles protocol-level ping/pong at the edge. When the server sends a protocol-level ping:

1. Cloud Pod → nginx → **Cloudflare edge** ← ping stops here
2. Cloudflare responds with a pong **back to nginx** on behalf of the client
3. Cloudflare may or may not forward the ping to the actual mobile client
4. The mobile client's pong (if any) goes to **Cloudflare edge** ← pong stops here

**Result: nginx never sees client-originated data.** The only pongs nginx receives are from Cloudflare's edge, which are on the upstream connection (edge → origin), not the downstream connection (client → origin). nginx's `proxy_send_timeout` tracks the downstream (client-side) connection and never gets reset.

### Step 6: Verify — what was the last client → server message before each kill?

For matt.cfosse's cycle between 12:54:24 PM and 12:55:22 PM:

| Time (PST)              | Direction       | Message                    |
| ----------------------- | --------------- | -------------------------- |
| 12:54:24 PM             | client → server | `GLASSES_CONNECTION_STATE` |
| 12:54:24 PM             | client → server | `device_state_update`      |
| 12:54:29 PM             | client → server | UDP register request       |
| _53 seconds of silence_ |                 |                            |
| 12:55:22 PM             | **💀 1006**     | nginx kills the connection |

Last client → server message at 12:54:29 PM. Kill at 12:55:22 PM. Gap: 53 seconds. With some variance for when the proxy_send_timeout timer started (from the WebSocket upgrade, not the last message), this aligns with 60 seconds.

### Step 7: Test the fix

Bumped `proxy-send-timeout` and `proxy-read-timeout` to 3600 seconds on the debug ingress:

```
porter kubectl -- annotate ingress cloud-debug-cloud \
    nginx.ingress.kubernetes.io/proxy-send-timeout="3600" \
    nginx.ingress.kubernetes.io/proxy-read-timeout="3600" --overwrite
```

**Result: The 60-second cycling stopped immediately.** Matt's connection went from constant 1006s every 60 seconds to only clean closes (1000/1001). Zero 1006s across all users after the change.

Then rolled back the global change and applied it only to WebSocket paths (see [spec.md](./spec.md) for the permanent fix).

---

## Additional finding: nginx ingress controller restart caused mass kill

During investigation, observed 4 users (aryan, isaiahballah, caydenpierce4, israelov+test3) all getting 1006 at exactly the same second (12:52:35 PM PST). This was caused by a nginx ingress controller pod restarting:

```
ingress-nginx-controller-64b464ff46-42hrx   Running   0   18m
```

The pod age (18 minutes) aligned exactly with the mass disconnect time. When a nginx ingress controller pod restarts, all WebSocket connections routed through that pod are killed. This is expected infrastructure behavior and unrelated to the timeout issue.

---

## Root Cause Summary

| Factor                                   | Detail                                                                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What killed the connection**           | nginx `proxy-send-timeout: 60s` firing due to no client → server traffic                                                                                                     |
| **Why server pings didn't help**         | Server pings flow server → client, resetting `proxy_read_timeout` only. `proxy_send_timeout` tracks the opposite direction independently.                                    |
| **Why protocol-level pongs didn't help** | Cloudflare absorbs protocol-level ping/pong at the edge. Pongs from the mobile client never reach nginx — they terminate at Cloudflare's edge.                               |
| **Why this wasn't a problem before**     | Audio used to flow over the Glasses WebSocket (hundreds of KB/s client → server). After migrating audio to UDP, the Glasses WS became idle in the client → server direction. |
| **Why the per-ingress timeout is 60s**   | Porter sets default annotations on managed ingress resources. The global nginx ConfigMap has 240s, but per-ingress annotations override it to 60s.                           |

---

## Remaining 1006s after the nginx fix

After applying the WS ingress fix to all clusters (debug, dev, staging, prod across us-central, east-asia, france, us-west, us-east), the 60-second cycling stopped. But monitoring over the following hours revealed **two additional kill mechanisms** still terminating Glasses WS connections.

### Kill mechanism #2: Server-side pong timeout (30s)

The codebase had a `PONG_TIMEOUT_ENABLED` flag in `UserSession.ts` (from the Bun WebSocket migration) that closes the Glasses WS with code 1001 "Ping timeout - no pong received" if no protocol-level pong arrives within 30 seconds.

The problem: Cloudflare absorbs protocol-level pongs at the edge (same root cause as the nginx issue). Bun sends protocol-level pings → Cloudflare edge → client. Client responds with pong → Cloudflare edge ← **stops here**. The pong never reaches Bun. So the 30s timer fires on every idle connection, killing healthy connections faster than nginx was.

**Impact observed on prod:** After the nginx fix, ~50% of remaining Glasses WS kills were code 1001 from this timeout. Users whose connections were killed took **3–7 minutes to reconnect** — the server was proactively killing connections that the client didn't know were dead, and the client's reconnect logic was slow to detect the server-initiated close.

**Fix:** Disabled `PONG_TIMEOUT_ENABLED`. The server still sends pings and tracks `lastPongTime` for observability, but no longer kills connections based on missing pongs. The client is responsible for detecting dead connections and reconnecting. See `UserSession.ts` line ~142.

### Kill mechanism #3: Bun idleTimeout (120s)

Bun's WebSocket handler has `idleTimeout: 120` — if no data flows in **either** direction for 120 seconds, Bun closes the connection with code 1006 and reason `"WebSocket timed out from inactivity"`.

This should rarely fire because the server sends app-level pings every 2 seconds (outbound data resets the idle timer). But it was observed on a small number of connections — likely cases where the ping interval was temporarily interrupted (e.g., during garbage collection, event loop saturation, or session setup delays).

**Impact:** ~3 kills/hour on prod, minor compared to the other two mechanisms.

**No fix needed:** The server's 2-second app-level pings keep this timer alive under normal conditions. The rare fires are edge cases that the client-side liveness detection from [034](../034-ws-liveness/spec.md) handles.

### Summary of all three kill mechanisms

| #   | Killer                     | Timer | Code | Reason                                | Status                                                       |
| --- | -------------------------- | ----- | ---- | ------------------------------------- | ------------------------------------------------------------ |
| 1   | nginx `proxy_send_timeout` | 60s   | 1006 | _(empty)_                             | **Fixed** — `ingressAnnotations` in `porter.yaml` with 3600s |
| 2   | Server pong timeout        | 30s   | 1001 | "Ping timeout - no pong received"     | **Fixed** — `PONG_TIMEOUT_ENABLED = false`                   |
| 3   | Bun `idleTimeout`          | 120s  | 1006 | "WebSocket timed out from inactivity" | **Mitigated** — server pings every 2s keep it alive          |

All three share the same root cause: **no client → server traffic visible to the server** after audio moved to UDP. Cloudflare's ping/pong absorption makes it worse — even protocol-level keepalives don't flow end-to-end.

### Post-fix metrics (prod us-central, hourly)

After applying the nginx fix, before disabling pong timeout:

- **App WS kills:** Dropped ~75% (from ~79/hr to ~20/hr). Mini apps benefited most since they don't have the pong timeout issue.
- **Glasses WS kills:** Dropped ~30% from the nginx fix alone. The pong timeout and Bun idleTimeout continued to churn.
- **Total kills per user:** Dropped from ~6.5/user/hr to ~3/user/hr.

After disabling pong timeout, the remaining Glasses WS kills should be only organic disconnections (mobile network instability, Cloudflare edge rotations) plus the rare Bun idleTimeout fire.

---

## Remaining organic 1006s

After all three fixes, some 1006s still occur with irregular timing (no pattern). These are genuine disconnections caused by:

- Mobile network instability (WiFi ↔ cellular handoffs)
- Cloudflare edge server rebalancing / code releases
- Temporary network black-holes

These are the disconnections that the [034 client-side liveness detection](../034-ws-liveness/spec.md) is designed to detect and recover from quickly. They are expected and cannot be eliminated at the infrastructure level.

---

## Next steps

- See [spec.md](./spec.md) for the permanent fix — `ingressAnnotations` in `porter.yaml` sets 3600s timeouts on the Porter-managed ingress
- ~~WS ingress manifests are checked into `cloud/k8s/` for all environments and clusters~~ **Deprecated** — separate WS ingress resources caused Porter domain conflicts that blocked all CI deploys. The `cloud/k8s/ws-ingress-*.yaml` manifests have been removed. Any previously-applied WS ingress resources must be deleted from clusters via `porter kubectl -- delete ingress cloud-<env>-cloud-ws -n default`
- Client-side pings (mobile app change from [034](../034-ws-liveness/spec.md)) will independently solve all three kill mechanisms by creating constant client → server traffic
