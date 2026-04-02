# Spec: UDP Endpoint Hostname Migration for IPv6 Compatibility

## Overview

**What this doc covers:** What needs to change across infrastructure, cloud, and mobile to make UDP audio work on IPv6-only cellular networks — the exact steps, commands, and code changes required.
**Why this doc exists:** Issue 051 confirmed that Australian users on IPv6-only cellular (Telstra, Optus, Vodafone) cannot reach the UDP audio endpoint because we send a raw IPv4 address. NAT64 — the mechanism that lets IPv6 hosts reach IPv4 — only works with hostnames, not raw IPs. No hostname, no NAT64, no audio, no transcription.
**What you need to know first:** [cloud/issues/051-g1-captions-dropout-after-ble-reconnect/spike.md](../051-g1-captions-dropout-after-ble-reconnect/spike.md) (Finding 3), [cloud/issues/udp-loadbalancer/](../udp-loadbalancer/) (how the UDP LB is set up today).
**Who should read this:** Cloud engineers, mobile engineers, anyone managing DNS or Porter deployments.

## The Problem in 30 Seconds

The phone gets the UDP audio endpoint as a raw IPv4 address (`20.239.105.210`) from the cloud's `CONNECTION_ACK`. On IPv6-only cellular networks, the phone cannot open a UDP socket to a raw IPv4 literal — NAT64 requires a hostname so DNS64 can synthesize an IPv6 address. The phone logs `IPv6 has been deactivated due to bind/connect, and DNS lookup found no IPv4 address(es)` and UDP never connects. Audio never reaches the cloud. Transcription dies silently.

This affects any user on an IPv6-only carrier. Australia is the first confirmed case, but IPv6-only cellular is increasingly common globally (T-Mobile US, EE UK, Jio India, most carriers in parts of Asia).

## Current Architecture

```
Cloud env:   UDP_HOST=20.239.105.210  (raw IPv4, set in Porter)
                 ↓
Cloud code:  ackMessage.udpHost = process.env.UDP_HOST
                 ↓
Phone gets:  CONNECTION_ACK { udpHost: "20.239.105.210", udpPort: 8000 }
                 ↓
Phone code:  udp.configure(msg.udpHost, msg.udpPort, ...)
                 ↓
UdpManager:  dgram.createSocket({ type: "udp4" })  ← hardcoded IPv4
             socket.send(packet, port, host)
                 ↓
On IPv6-only: FAILS — udp4 socket can't route to IPv4 without NAT64,
              and raw IP bypasses DNS64
```

There are TWO problems stacked:

1. **No hostname** → DNS64/NAT64 can't synthesize an IPv6 route to the IPv4 endpoint
2. **`udp4` socket** → even if we resolve a hostname to IPv6, `dgram.createSocket({type: "udp4"})` in `mobile/src/services/UdpManager.ts:338` can't use an IPv6 address

### Key field names (don't change these)

| Where               | Name                            | Current value                                     |
| ------------------- | ------------------------------- | ------------------------------------------------- |
| Porter env var      | `UDP_HOST`                      | Raw IPv4 (e.g. `20.239.105.210`)                  |
| Porter env var      | `UDP_PORT`                      | `8000`                                            |
| CONNECTION_ACK JSON | `udpHost`                       | Whatever `process.env.UDP_HOST` is                |
| CONNECTION_ACK JSON | `udpPort`                       | Whatever `process.env.UDP_PORT` is (default 8000) |
| Phone reads         | `msg.udpHost \|\| msg.udp_host` | Passed straight to `UdpManager.configure()`       |

The phone field `udpHost` is what existing clients read. We keep this field name — just change its value from a raw IP to a hostname.

## Spec

### Step 1: Create DNS records in Cloudflare

Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → select the `mentraglass.com` zone → DNS → Records.

For each region, add an **A record** with **Proxy OFF (DNS only / gray cloud)**. Cloudflare cannot proxy UDP — orange cloud would silently drop all packets.

| Record | Type                 | Name                 | Content (IPv4) | Proxy | TTL |
| ------ | -------------------- | -------------------- | -------------- | ----- | --- |
| A      | `udp-prod-uscentral` | `52.189.74.237`      | DNS only       | 300   |
| A      | `udp-prod-uswest`    | _(get from kubectl)_ | DNS only       | 300   |
| A      | `udp-prod-useast`    | _(get from kubectl)_ | DNS only       | 300   |
| A      | `udp-prod-france`    | _(get from kubectl)_ | DNS only       | 300   |
| A      | `udp-prod-eastasia`  | `20.239.105.210`     | DNS only       | 300   |
| A      | `udp-prod-au`        | _(get from kubectl)_ | DNS only       | 300   |
| A      | `udp-prod-canada`    | _(get from kubectl)_ | DNS only       | 300   |

This produces hostnames like `udp-prod-au.mentraglass.com`.

For dev deployments, also create `udp-dev-{region}.mentraglass.com`.

**To get UDP LoadBalancer IPs you don't have yet:**

```bash
# List clusters
porter cluster list

# For each cluster, get the UDP service external IP
porter kubectl -- get svc -n default --cluster <CLUSTER_ID> | grep udp
```

The `EXTERNAL-IP` column is the value for the A record.

**Verify after creation:**

```bash
dig udp-prod-au.mentraglass.com +short
# Should return the IPv4 address
```

### Step 2: Update Porter env vars from raw IP to hostname

Use the Porter CLI or the [Porter Dashboard](https://dashboard.porter.run/) → select the app → Environment tab.

**Via CLI:**

```bash
# Example: update East Asia prod
porter env set -a cloud-prod --cluster 4754 \
  -v 'UDP_HOST=udp-prod-eastasia.mentraglass.com'

# Example: update Australia prod
porter env set -a cloud-prod --cluster 4978 \
  -v 'UDP_HOST=udp-prod-au.mentraglass.com'
```

**Via Dashboard:** Go to the app → Settings → Environment → find `UDP_HOST` → change the value → Save. The app will redeploy with the new value.

No cloud code changes needed for this step. The cloud already does:

```typescript
// cloud/packages/cloud/src/services/websocket/bun-websocket.ts:371
const udpHost = process.env.UDP_HOST // now a hostname string
;(ackMessage as any).udpHost = udpHost // sent as-is in CONNECTION_ACK
```

After this, phones receive `udpHost: "udp-prod-au.mentraglass.com"` instead of `udpHost: "20.239.105.210"`.

### Step 3: Mobile — fix the `udp4` hardcoded socket

This is the only code change required. In `mobile/src/services/UdpManager.ts`, the socket is hardcoded to IPv4:

```typescript
// Current (line ~338):
this.socket = dgram.createSocket({type: "udp4"})
```

This must become a dual-stack or IPv6-capable socket. The `react-native-udp` library (v4.1.7, based on `dgram`) supports `udp6`. The fix:

**Option A — always use `udp6` (simplest):** IPv6 sockets on most platforms can send to both IPv4 and IPv6 destinations (via IPv4-mapped IPv6 addresses). Test this first.

```typescript
this.socket = dgram.createSocket({type: "udp6"})
```

**Option B — detect network type:** Check what address the hostname resolves to and create the matching socket type. More defensive but more code.

**Option C — try `udp6`, fall back to `udp4`:** Create a `udp6` socket. If bind fails, retry with `udp4`. Handles edge cases on older Android versions where `udp6` isn't available.

The `socket.send(packet, port, host)` calls in `sendAudio()`, `sendAudioRaw()`, and `sendPing()` already pass `this.config.host` as a string — `react-native-udp` handles DNS resolution internally when given a hostname. No changes needed to the send calls.

### Backward Compatibility

**Old clients receiving a hostname in `udpHost`:** Old mobile clients read `msg.udpHost` and pass it directly to `udp.configure(host, port)` → `socket.send(packet, port, host)`. The `react-native-udp` `send()` function does resolve hostnames (node `dgram` behavior). So old clients on **IPv4 networks will work** — the library resolves the hostname to IPv4 and sends.

Old clients on **IPv6-only networks already don't work** (they fail today with raw IPs too), so the hostname doesn't make them worse.

**No new JSON field needed.** The existing `udpHost` field carries the hostname. No `udpHostFallbackIp` or `UDP_HOST_IP` required — old clients handle hostname strings via the UDP library's built-in resolution. The `udp4` socket type on old clients means they'll resolve to IPv4 only (which is the same as today's behavior with raw IPs).

The only clients that benefit from the hostname + need a code change are those on IPv6-only networks, and they need the `udp4` → `udp6` socket fix (Step 3) to actually use IPv6 addresses.

## Rollout Order

1. **Create DNS records in Cloudflare** — zero risk, purely additive, no client impact
2. **Verify DNS resolution** — `dig` from multiple locations, confirm correct IPs
3. **Update `UDP_HOST` on one non-prod deployment** (e.g., `cloud-dev` on central-us) — test with a phone on WiFi to confirm hostname resolution works with existing `udp4` socket on IPv4 networks
4. **Ship mobile update** with `udp4` → `udp6` (or dual-stack) socket change
5. **Roll `UDP_HOST` hostname to all production clusters** — after mobile update is in the wild
6. **Test on IPv6-only network** — use an Australian SIM, or create an IPv6-only WiFi hotspot on a Mac (`sudo sysctl -w net.inet6.ip6.accept_rtadv=1` + share IPv6-only connection)
7. **Set TTL to 3600** — once stable, raise DNS TTL from 300s to 3600s to reduce lookup overhead

## Decision Log

| Decision                                      | Alternatives considered                                  | Why we chose this                                                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DNS-only A records in Cloudflare (gray cloud) | Cloudflare proxy (orange cloud)                          | Cloudflare cannot proxy UDP — only HTTP/WS. Orange cloud would silently drop all UDP packets.                                                                                     |
| Change `UDP_HOST` value, not the field name   | Add new `UDP_HOSTNAME` env var + new `udpHostname` field | Unnecessary complexity. Old clients handle hostname strings fine on IPv4. The `udpHost` field already carries a string — changing its content from IP to hostname is transparent. |
| Per-region hostnames (not global GeoDNS)      | Single `udp.mentraglass.com` with geo routing            | Each region has its own Azure LB with its own IP. GeoDNS adds a failure mode. Per-region hostnames match the existing per-region `UDP_HOST` env vars.                             |
| `mentraglass.com` domain                      | `augmentos.cloud`                                        | `mentraglass.com` is the current production domain. Keeps DNS in one zone.                                                                                                        |
| `udp6` socket type                            | Dual-stack detection                                     | Simplest fix. IPv6 sockets handle IPv4 destinations via mapped addresses on iOS and modern Android. Test on both platforms to confirm.                                            |

## Testing

| Scenario                            | Expected result                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dual-stack WiFi (IPv4 + IPv6)       | Hostname resolves to IPv4 A record. `udp6` socket sends to IPv4-mapped address. No behavior change from user perspective.                         |
| IPv6-only cellular (Australia)      | DNS64 synthesizes IPv6 from A record. `udp6` socket sends to synthesized address. Packets go through NAT64 to Azure LB IPv4. **This is the fix.** |
| IPv4-only network                   | Hostname resolves to IPv4. `udp6` socket sends via IPv4-mapped address. Works.                                                                    |
| DNS failure                         | Phone logs error, retries on next UDP probe cycle (every 5 seconds). No silent failure.                                                           |
| Old client (udp4 socket) + hostname | Hostname resolves to IPv4 via A record. `udp4` socket sends. Works on IPv4 networks. Fails on IPv6-only networks (same as today — no regression). |

## Edge Cases

- **Azure LB IP changes:** If the K8s service is deleted/recreated, Azure assigns a new IP. Update the Cloudflare A record. This is one DNS update vs N Porter env var updates — simpler than today.
- **DNS TTL caching:** Set TTL to 300s during migration. If a phone caches a stale IP after a LB IP change, it fails until cache expires. Low TTL minimizes this window.
- **`udp6` not supported on old Android:** If `dgram.createSocket({type: "udp6"})` fails on an old device, catch the error and fall back to `udp4`. Log a warning so we know it happened.
