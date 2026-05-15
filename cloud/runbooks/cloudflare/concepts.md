# Cloudflare: Concepts and Prerequisites

Read this first if you are new to the stack. Operational
procedures live in [load-balancer.md](load-balancer.md).

The summary: Cloudflare sits between the public internet and
our AKS clusters. It does DNS, TLS, edge caching (where we use
it), DDoS protection, and load balancing across our regional
clusters. The load balancer is the most active part for us.

If terms below are unfamiliar, the rest of this doc explains
each one.

## Anycast

A normal IP address points at one server. An anycast IP
address can point at many servers in many locations
simultaneously. Routers automatically deliver packets to the
geographically closest server.

Cloudflare's edge network is anycast. When a client resolves
`api.mentra.glass` they get a Cloudflare anycast IP (e.g.
`104.21.87.160`). Their traffic lands at whichever Cloudflare
data center is closest to them. From there Cloudflare opens a
connection back to our origin.

Practical effect: TLS handshakes are fast even for a user far
from our origin, because the handshake terminates at the
nearest Cloudflare PoP, not at our origin in Azure.

## Edge / PoP

Cloudflare runs hundreds of "Points of Presence" (PoPs), each
a small data center close to users. The edge is the ring of
PoPs facing the public internet.

When traffic reaches a Cloudflare PoP, Cloudflare can:

- Terminate TLS
- Apply WAF rules (Web Application Firewall)
- Serve cached responses (we mostly do not cache)
- Forward to our origin via a backend connection
- Block / rate-limit / challenge the request

For our load-balanced traffic, the PoP forwards to whichever
pool the LB picked.

## Proxied vs DNS-only (orange cloud vs gray cloud)

Each DNS record in the Cloudflare dashboard has a small cloud
icon:

- **Orange cloud** (proxied): the DNS record resolves to a
  Cloudflare anycast IP. Traffic flows through Cloudflare's
  edge. We get TLS termination, DDoS protection, WAF, etc.
- **Gray cloud** (DNS only): the DNS record resolves to the
  origin's real IP. Traffic goes directly to the origin.
  Cloudflare just answers the DNS query.

Use orange for HTTP and WebSocket traffic. Use gray for
anything Cloudflare cannot proxy, primarily UDP. The LB origin
hostnames (`uscentralapi.mentraglass.com` etc.) are gray
because the LB needs to reach the origin directly. The LB
hostname (`api.mentra.glass`) is orange because that IS the
public anycast.

Switching a record from orange to gray exposes the origin IP
publicly. Switching gray to orange breaks anything that needs
the origin IP directly (e.g. UDP).

## Zone

A "zone" in Cloudflare is one DNS domain you control. We have
zones for `mentra.glass`, `mentraglass.com`, `mentraos.com`,
plus several brand redirects.

Each zone has its own DNS records, its own TLS settings, its
own LBs. Both `api.mentra.glass` (in the `mentra.glass` zone)
and `api.mentraglass.com` (in the `mentraglass.com` zone) are
separate Cloudflare load balancers.

## Load balancer (Cloudflare's product)

Cloudflare's "Load Balancing" is a paid feature distinct from
the basic CDN. Our LB lives at the zone level. When traffic
hits the LB hostname, Cloudflare:

1. Looks up the LB's steering policy to pick a pool.
2. Looks up the pool's origins (one or more backend hosts).
3. Filters origins to the ones currently passing the pool's
   health monitor.
4. Picks one origin, opens a backend connection, forwards the
   request.

We have two LBs, one per zone, sharing the same pool inventory
but with different steering policies. See [load-balancer.md](load-balancer.md)
for the live config.

## Pool

A pool is a named group of one or more origin servers, plus a
health monitor that decides if the pool is "healthy."

For us, each pool currently has exactly one origin (one AKS
cluster's nginx ingress). Multiple origins per pool are useful
if you want to scale-out within a region; we do not today.

A pool can be enabled or disabled. Disabling drains the pool:
existing connections stay, new ones go to the next pool in the
LB's steering list.

## Origin

The actual backend server a request gets sent to. For us,
origins are AKS LoadBalancer service IPs reached via gray-cloud
DNS records (`uscentralapi.mentraglass.com` etc.). Cloudflare
knows them by hostname, not IP, so DNS rotation is the way to
change them.

## Monitor

A health check Cloudflare runs against every origin in the
pool. Our monitors:

```
type: HTTPS
method: GET
path: /health
interval: 60s
timeout: 5s
retries: 2
expected_codes: 200
```

If `/health` fails twice in a row (with 60-second intervals),
the origin flips to "unhealthy" and the LB stops sending it
traffic. When `/health` returns 200 again, Cloudflare retries
and re-enables.

## Steering policy

How the LB decides which pool a request goes to. The two we
use:

### `geo` (legacy LB)

Cloudflare divides the world into pre-defined regions: WNAM,
ENAM, NSAM, SSAM, WEU, EEU, OC, ME, NEAS, SEAS, SAS, AF.
We map each region to one pool.

Coarse: WNAM is "all of West North America" (Seattle to San
Diego), so all WNAM users go to the same pool no matter where
they are inside that region.

### `proximity` (next-gen LB)

Cloudflare picks the closest healthy pool by great-circle
distance from the user's resolver to the pool's lat/long.

Granular: a user in Seattle gets routed to whichever pool's
lat/long is closest to Seattle, not to a coarse "West NA"
bucket. As we add regional pools, traffic redistributes
automatically.

Fails over more gracefully too: if a pool is unhealthy, the
second-closest pool is the natural fallback, no manual region
remapping required.

## Session affinity

When a client makes multiple requests in a row, you usually
want them all to land on the same backend. Cloudflare LB
supports this via session affinity:

- `none`: each request is steered independently. Bad for
  WebSocket-heavy apps.
- `cookie`: Cloudflare sets a cookie on the first request and
  pins subsequent requests with that cookie to the same pool.
- `ip_cookie` (what we use): same as cookie, but if the
  cookie is missing, falls back to client-IP-based pinning.
  Safer for clients that drop cookies.

Our TTL is 3600 seconds (1 hour). After that, the user can be
re-steered to a different pool.

## WebSocket idle timeout

Cloudflare drops idle WebSocket connections at around 100
seconds. If neither side sends a frame within that window the
connection is closed.

Both ends already exchange application-level pings well below
that interval, so it does not bite in normal operation. It
will bite if a code change defers pings or extends the
interval. See [load-balancer.md](load-balancer.md).

## DNS records you encounter in our setup

- **A record** (orange or gray): IPv4. Used for direct origin
  hostnames and for the LB's apex (the LB itself synthesizes
  an A record at the LB hostname).
- **AAAA record**: IPv6. Same as A but for IPv6 traffic.
- **CNAME record**: alias from one hostname to another. Used
  by the LB to point at pool origins (`uscentralapi.mentraglass.com`
  is an A record, not a CNAME, but pool origins can be either).

Cloudflare's UI shows the record type in the table.

## API tokens

Two tokens we use:

- `CLOUDFLARE_LB_API_TOKEN` (Doppler `mentra-sre`): scoped to
  load balancer read/write. Cannot read DNS zones or other
  account data.
- `CLOUDFLARE_API_TOKEN` (Doppler `mentraos-cloud`): broader
  account-level token. Used by services that need DNS or
  account access.

Tokens are scoped on creation. If a token returns
"Authentication error" for an endpoint, it does not have
permission for that endpoint, not that the token is invalid.

## How a request actually flows

```mermaid
flowchart TD
  A["User app<br/>HTTPS request to api.mentra.glass"]
  B["DNS resolves to Cloudflare anycast IP<br/>(e.g. 104.21.87.160)"]
  C["Nearest Cloudflare PoP<br/>terminates TLS, looks up the LB by hostname"]
  D["LB picks a pool by steering policy<br/>(geo or proximity)"]
  E["Pool filters origins by health monitor,<br/>picks a healthy one,<br/>resolves origin hostname (e.g. uscentralapi.mentraglass.com)"]
  F["AKS LoadBalancer service IP<br/>(e.g. 128.203.164.18)"]
  G["nginx ingress<br/>reads Host header,<br/>routes to cloud-prod service,<br/>forwards to a pod"]
  H["Cloud Bun process handles the request<br/>response flows back along the same path"]

  A --> B --> C --> D --> E --> F --> G --> H
```
