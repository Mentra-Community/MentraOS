# DNS for the UDP NLB (Cloudflare, DNS-only mode)

When clients connect to audio over UDP, they need a stable hostname. The
NLB itself has a hostname like
`a1b2c3.elb.us-west-2.amazonaws.com` which is fine for tests but not for
production:

- Not branded (clients hardcoded to `mentra.glass` won't reach it)
- Region-baked into the name (if we ever need to move regions, the NLB
  hostname changes; a custom CNAME stays stable)

So we map a friendly hostname like `audio-udp-us-west-2.mentra.glass` → NLB
hostname via Cloudflare DNS.

## The critical thing: DNS-only mode (not proxied)

Cloudflare has two DNS modes per record:

- **Proxied** (orange cloud): traffic flows through Cloudflare's edge.
  Adds TLS termination, DDoS protection, caching. **HTTP/HTTPS only — does
  NOT proxy UDP.**
- **DNS-only** (grey cloud): Cloudflare just answers the DNS query; traffic
  goes direct from client to origin. Works for any protocol.

For the UDP NLB record we **must use DNS-only mode** (grey cloud). Proxied
mode would just drop UDP packets entirely (Cloudflare returns its own IP,
which isn't listening on 8000/udp).

V1 used the same DNS-only pattern. Cloud V2 preserves it because Cloudflare's
HTTP proxy does not carry UDP traffic.

## Setting up a DNS record for a new NLB

1. **Get the NLB hostname**:
   ```bash
   kubectl get svc cloud-v2-audio-udp \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
   # → a1b2c3d4...elb.us-west-2.amazonaws.com
   ```

2. **Go to Cloudflare dashboard** → mentra.glass → DNS → Records.

3. **Add a CNAME**:
   - Type: CNAME
   - Name: `audio-udp-us-west-2` (or whatever convention)
   - Target: the NLB hostname from step 1
   - Proxy status: **DNS only** (toggle OFF the orange cloud)
   - TTL: Auto

4. **Update `AUDIO_UDP_ADVERTISED_HOST`** in Doppler so the CONNECTION_ACK
   advertises the friendly name:
   ```bash
   doppler secrets set \
     "AUDIO_UDP_ADVERTISED_HOST=audio-udp-us-west-2.mentra.glass" \
     --config dev_aws
   ```

5. **Redeploy** so the env propagates to audio pods:
   ```bash
   porter apply -f porter.yaml
   ```

6. **Verify** clients can resolve and reach it:
   ```bash
   # DNS resolves to the NLB
   dig +short audio-udp-us-west-2.mentra.glass
   # → a1b2c3...elb.us-west-2.amazonaws.com.
   # → <NLB IP>

   # UDP reachable (run from outside the cluster)
   nc -u -z -v audio-udp-us-west-2.mentra.glass 8000
   ```

## Why not Route 53?

Route 53 (AWS's DNS) would work fine — alias record points at the NLB,
slightly faster resolution from AWS clients. We use Cloudflare for
consistency with v1 (everything else is already there) and we get:

- Single DNS pane for all `mentra.glass` records
- Free tier covers our query volume
- Cloudflare's anycast DNS resolves globally faster than Route 53

If we ever leave Cloudflare we'd move to Route 53. No rush.

## Gotchas

### Proxied mode silently breaks UDP

If someone toggles the orange cloud back ON for a UDP record (a common
mistake — "proxied is more secure, why not"), audio breaks immediately
and there are no useful errors. Just packet drops.

Symptom: clients connect via WS, get CONNECTION_ACK with the right
hostname, send UDP, and nothing reaches the cloud. UDP packets to
Cloudflare's IPs get blackholed.

**Always grey-cloud the UDP CNAMEs.** Add a comment in the DNS record's
description: `"UDP — DO NOT PROXY"`.

### CNAME → CNAME chain depth

Cloudflare can follow CNAMEs, but some resolvers cap at 8 hops. The NLB
hostname is already a CNAME-like construct. Don't add more CNAME hops on
top (e.g., `audio.mentra.glass` → `audio-udp-us-west-2.mentra.glass` →
NLB) — go direct from your friendly name to the NLB hostname.

### TTL

`Auto` (default ~5 min) is fine. Don't set it too low (excessive DNS
queries) or too high (DNS changes take forever to propagate).

If you're about to delete + recreate the NLB and need fast DNS flip,
set TTL to 60s a day ahead, do the swap, then bump back to Auto.

## Multi-region

In future when prod runs in multiple regions:

```
audio-udp-us-west-2.mentra.glass  → NLB in us-west-2
audio-udp-us-east-2.mentra.glass  → NLB in us-east-2
audio-udp-eu-central-1.mentra.glass → NLB in EU
```

Each region's deploy sets its own `AUDIO_UDP_ADVERTISED_HOST` to the
appropriate per-region hostname. CONNECTION_ACK then tells clients to dial
the closest NLB based on which pod ingressed their WS.

(For client-side geo-routing, Cloudflare Load Balancing — separate from
Cloudflare DNS proxying — can return different IPs based on client
location. That's a Phase 3 concern when we have multi-region traffic.)
