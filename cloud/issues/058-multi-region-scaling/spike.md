# Spike: Multi-Region Scaling — US East/West, Session Affinity, Doppler, Cloudflare

## Overview

**What this doc covers:** Investigation and plan for adding US East and US West regions to cloud-prod, solving the WebSocket session affinity problem with Cloudflare geo load balancing, migrating environment variables to Doppler, and installing the BetterStack Collector on all 5 clusters.
**Why this doc exists:** 1,000 Mentra Live units have shipped. Users are connecting to `api.mentra.glass` via Cloudflare geo load balancer → US Central, France, East Asia. US East and US West need to come online. But the in-memory session model means a user's WebSocket can be on one region while their REST requests hit another — causing 503s and session loss.
**Who should read this:** Cloud engineers, anyone working on deployment infrastructure.

**Depends on:**
- [057-cloud-observability](../057-cloud-observability/) — memory leak fixes and observability now deployed to prod
- [055-cloud-prod-oom-crashes](../055-cloud-prod-oom-crashes/) — crash investigation that revealed the single-instance limitations

---

## Background

### Current architecture

```
User device (Mentra Live glasses + phone)
  → api.mentra.glass (Cloudflare DNS + geo load balancer)
    → US Central (Porter cluster 4689) — cloud-prod, single pod
    → France (Porter cluster 4696) — cloud-prod, single pod
    → East Asia (Porter cluster 4754) — cloud-prod, single pod

Sessions: in-memory Map<string, UserSession> per pod
WebSocket: persistent TCP connection to one specific pod
REST: per-request, Cloudflare can route to any region
UDP audio: direct to pod IP via LoadBalancer
```

### The problem

Sessions live in-memory on whichever pod the user's WebSocket connected to. REST requests from the same user can land on a different region because Cloudflare re-evaluates geo proximity per request. When this happens: REST hits a pod that doesn't have the session → 503.

This hasn't been a visible problem because most users are near US Central. With US East and US West coming online, users on the US East Coast could have their WebSocket on US Central but REST requests routed to US East.

---

## Questions to Answer

### 1. Session affinity — how do we keep a user's traffic on one region?

Options to investigate:
- **Cloudflare session affinity** — does the geo LB support sticky sessions by cookie or IP?
- **Porter/nginx ingress session affinity** — `nginx.ingress.kubernetes.io/affinity: cookie`?
- **Region-specific subdomains** — `us-central.api.mentra.glass`, `us-east.api.mentra.glass` — client connects to one and stays there?
- **Session-aware routing** — a lightweight session lookup layer that knows which region has the session?

### 2. Cloudflare configuration — what changes are needed?

- Current Cloudflare setup (geo LB pools, health checks, failover)
- Adding US East and US West pools
- Session affinity settings
- DNS propagation timing and risk

### 3. Environment variables — Doppler migration

- Porter currently manages env vars per app per cluster (5 clusters × N apps = lots of duplication)
- Doppler would centralize env management with environment inheritance (dev → staging → prod)
- Porter has a Doppler integration — how does it work?
- Migration plan: how to switch without downtime

### 4. BetterStack Collector — remaining 4 clusters

- US Central: ✅ installed
- East Asia, France, US West, US East: need collector installed
- Same process: create collector in BetterStack API, install via Porter Add-ons UI
- One collector per cluster, each with its own secret

### 5. New BetterStack source — prod log separation

- `MentraCloud - Prod` source (ID 2324289) created but not yet pointed to
- All prod and staging Porter envs need `BETTERSTACK_SOURCE_TOKEN` updated
- Staging log level should be set to `info` (currently sends debug)

### 6. Rollout risk — how do we add regions without breaking existing users?

- Users already connected via WebSocket to US Central — what happens when US East/West come online in Cloudflare?
- Do existing WebSocket connections stay on US Central? (Yes — TCP connections persist)
- Do new REST requests from those same users suddenly route to US East? (Possibly — depends on Cloudflare config)
- Can we add regions to Cloudflare with traffic weight 0 and ramp up gradually?

---

## What We Don't Know Yet

1. Exact Cloudflare geo LB configuration (need to audit current setup)
2. Whether Cloudflare supports session affinity at the geo LB level (vs just per-pool)
3. Whether Porter's nginx ingress supports sticky sessions across WebSocket + REST
4. How Doppler integration works with Porter (need to test on debug first)
5. Whether US East and US West Porter clusters are already provisioned or need to be created
6. Current state of environment variables across all clusters (are they in sync?)

---

## Next Steps

This spike needs hands-on investigation in the next conversation:

1. **Audit Cloudflare** — check the current geo LB config, pools, health checks
2. **Test session affinity options** — try Cloudflare sticky sessions on debug first
3. **Audit Porter env vars** — compare US Central vs East Asia vs France, identify drift
4. **Evaluate Doppler** — test the Porter integration on the debug cluster
5. **Plan the rollout** — zero-downtime strategy for adding US East/West to the LB
6. **Install collectors** — BetterStack Collector on the remaining 4 clusters
7. **Switch prod logs** — point prod/staging at the new `MentraCloud - Prod` source