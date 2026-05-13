# Cloudflare

We use Cloudflare for two distinct things:

1. **Regional load balancer** (`api.mentra.glass`). Geo-steers
   user traffic to the nearest healthy Porter cluster. This is
   the operational thing the team works with day to day. See
   [load-balancer.md](load-balancer.md).
2. **DNS + edge proxy** for everything else: web properties,
   regional origin hostnames, the dev console, etc. Standard
   Cloudflare DNS; orange cloud on most records, gray cloud on
   anything that has to bypass the proxy (UDP audio, the LB
   origin hostnames).

## Access

You need a Cloudflare account that has been added to the Mentra
account. Ask Isaiah or Israelov.

- Dashboard: https://dash.cloudflare.com/
- API token for the LB lives in Doppler under the `mentra-sre`
  project (`CLOUDFLARE_LB_API_TOKEN`).
- Account-wide tokens live in Doppler under `mentraos-cloud`
  (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).

Pull a token for ad-hoc API work:

```bash
CF_TOKEN=$(doppler secrets get CLOUDFLARE_LB_API_TOKEN \
  --project mentra-sre --config dev --plain)
curl -s "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CF_TOKEN"
```

## Zones we own

20+ zones (`mentra.glass`, `mentraglass.com`, `mentraos.com`,
several brand-redirect domains). The two that matter for the API
load balancer:

- `mentra.glass` (zone id `5bb5c71a90dc175143eb10edaad85d49`):
  hosts the public `api.mentra.glass` LB record.
- `mentraglass.com` (zone id `86a59033615f078d613b3cd22fd30c44`):
  hosts the per-region origin hostnames the LB points at
  (`uscentralapi.mentraglass.com`,
  `franceapi.mentraglass.com`, etc.).

The rest are web properties, brand redirects, or unused. List
them with the API. Use the broader `CLOUDFLARE_API_TOKEN` from
`mentraos-cloud` rather than the LB-only token; zone listing is
not LB scope, and using the right token keeps the per-token
permission boundary clean even if scopes change later.

```bash
CF_TOKEN=$(doppler secrets get CLOUDFLARE_API_TOKEN \
  --project mentraos-cloud --config dev --plain)
ACCOUNT_ID=$(doppler secrets get CLOUDFLARE_ACCOUNT_ID \
  --project mentraos-cloud --config dev --plain)
curl -s "https://api.cloudflare.com/client/v4/zones?account.id=$ACCOUNT_ID" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import sys,json; r=json.load(sys.stdin); [print(z['id'], z['name']) for z in r['result']]"
```

## Procedures

- [concepts.md](concepts.md): read first. Explains anycast, the edge, proxy
  modes (orange vs gray cloud), zones, pools, monitors,
  steering policies (geo vs proximity), and session affinity.
- [load-balancer.md](load-balancer.md): how `api.mentra.glass` and
  `api.mentraglass.com` are configured, what pools exist, and
  how to add a new region or cluster to the rotation.

## Things to know before changing anything

- **Orange vs gray cloud.** Orange = proxied through Cloudflare
  (TLS termination, DDoS protection). Gray = DNS only, traffic
  goes direct to the origin IP. The LB hostname is orange, the
  per-region origin hostnames are gray. Flipping these breaks
  things.
- **The 100-second WebSocket idle timeout.** Cloudflare drops
  idle WebSockets at ~100s. Application-level pings handle this
  in normal operation. See [load-balancer.md](load-balancer.md).
- **The LB API token is scoped to LB only.** It does not have
  DNS read or write. For DNS work, use the
  `CLOUDFLARE_API_TOKEN` from `mentraos-cloud`.

## Related

- [../porter/](../porter/): the Porter clusters that the LB steers to.
  `porter/deploys.md` covers per-cluster `cloud-prod` deploys.
- [../doppler/](../doppler/): where Cloudflare API tokens live.
- [../infra.md](../infra.md): full traffic flow including BetterStack and
  Vector.
- `cloud/issues/udp-loadbalancer/`: history of the UDP-direct
  path used for audio. Kept on a gray-cloud DNS record because
  Cloudflare's proxy does not handle UDP.
