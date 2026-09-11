# Cloud-v2 infrastructure primer

What runs where, why, and how the pieces fit together. Read this first if
you're new; reference it when something doesn't make sense.

## The big picture

```
phone (mobile SDK)
  │
  ├─ REST → core           (token exchange, REST endpoints)
  ├─ WS   → audio          (transcripts down, subscriptions up, audio fallback)
  └─ UDP  → audio NLB      (audio packets, primary path)

core   ──→ MongoDB Atlas     (identity, sessions, OEM records)
audio  ──→ AWS ElastiCache   (streams, ownership claims, session tags)
audio  ──→ Soniox            (transcription provider; per active sub)
```

## Three packages, three deployable services

We split the v1 monolith into three:

| Package | Role | Deployable | Talks to |
| --- | --- | --- | --- |
| `@mentra/cloud-core` | OEM auth, REST endpoints, miniapp store backend | yes (`core` service in `porter.yaml`) | MongoDB Atlas |
| `@mentra/cloud-audio` | UDP/WS audio ingress, workers, transcription | yes (`audio` service) | Redis (ElastiCache), Soniox |
| `@mentra/cloud-proxy` | OEM forwarder / reverse proxy (stub) | yes (planned) | core, audio (downstream) |
| `@mentra/cloud-shared` | Logger, health, JWT verifier | no (workspace dep) | — |

Why the split:
- **Audio is the biggest workload.** Splitting lets us scale it independently
  (more replicas, bigger nodes) without dragging core along.
- **OEM forwarder** (proxy) will eventually be deployable on a partner's
  infrastructure. Keeping it a separate package makes that boundary clean.
- **Core stays small.** Most REST endpoints get pushed to mini-app servers
  in the v2 design, leaving core focused on auth + cross-cutting concerns.

## Cluster topology

| Cluster | Role | Datastores |
| --- | --- | --- |
| `aws-us-west-2` (Porter ID 5692) | **Currently hosting dev** + future prod for west coast | ElastiCache: `cloud-elasticache-us-west-2`. Atlas: TBD. |
| `aws-us-east-2` (Porter ID 5690) | Reserved for future east-coast prod | None yet |
| Various Azure clusters (v1) | v1 prod — **do not touch** | — |

We've discussed splitting into a separate `aws-us-west-2-dev` cluster so
prod clusters look identical and dev gets its own playground (preview
envs, per-dev sandboxes). Not done yet — for now `aws-us-west-2` hosts
both dev (`cloud-v2-dev-doppler` env group) and will host prod (separate
deployment target later).

## Datastores

### MongoDB Atlas (identity)

Hosts the `oems`, `users`, `refreshTokens`, `revokedJtis`, `seenJtis`
collections — see `packages/core/src/models/`. v2 uses a **separate Atlas
cluster** from v1 (don't share databases — schemas differ).

### AWS ElastiCache (streams + coordination)

`cloud-elasticache-us-west-2` (Redis 7.1, `cache.t4g.medium`). Holds:

- Per-user audio streams: `audio:{mentraUserId}` (Redis Streams)
- Ownership claims: `{user:X}:owner` (string with TTL)
- Session-tag registry: `sessionTag:{u32}` (JSON, TTL)
- Consumer group: `audio-workers` (across all pods)

**Cluster-only access** — TLS + auth token required, only pods inside a
"connected cluster" (configured in Porter) can connect. Local dev uses a
docker Redis (`docker-compose.test.yml`).

## Deployment platform: Porter

[Porter](https://porter.run) is our PaaS on top of EKS. It handles:

- Image build + push to ECR
- Deploy to Kubernetes (using their Helm chart)
- Auto-provisioning an ALB-fronted Ingress (`*.onporter.run` hostname)
- Env var injection (via env groups, including Doppler-synced ones)

What Porter **doesn't** handle:

- **UDP exposure** — needs a manually-applied `Service type=LoadBalancer`
  (see [`deploy/udp-nlb-aws.md`](./deploy/udp-nlb-aws.md))
- **Datastore provisioning** — Atlas and ElastiCache are set up outside
  Porter (Atlas: via Mongo's UI; ElastiCache: via AWS Console / Terraform)
- **DNS** — Cloudflare (DNS-only for the NLB, see
  [`cloudflare/dns-for-nlb.md`](./cloudflare/dns-for-nlb.md))

## Secrets: Doppler

[Doppler](https://doppler.com) is our secrets manager. Project: `cloud-v2`.

Configs:

| Config | Used for | URLs point at |
| --- | --- | --- |
| `dev` | local dev | localhost (MongoDB local, Redis local) |
| `dev_aws` (branch of `dev`) | AWS dev cluster deploy | ElastiCache, Atlas |
| `staging` | future AWS staging | TBD |
| `prod` | future AWS prod | TBD |
| `prod_<region>` | future per-region overrides | TBD |

Branches **inherit** from their parent and override specific values. So
`dev_aws` automatically picks up everything in `dev` except where it
overrides (MONGO_URL, REDIS_URL, etc.).

Porter is auto-synced with `dev_aws` via the **Doppler integration** —
secrets land in the `cloud-v2-dev-doppler` Porter env group within
seconds of changing in Doppler. See
[`doppler/porter-integration.md`](./doppler/porter-integration.md).

## Logging: BetterStack + Vector

Cloud-v2 pods write JSON logs to stdout (`LOG_STDOUT_JSON=true` in
staging/prod). A **Vector DaemonSet** on each node ships them to
BetterStack via the `BETTERSTACK_*` env vars.

Local dev uses `pino-pretty` for human-readable output (`LOG_STDOUT_JSON=false`
in the `dev` config).

## Health endpoints

Every service exposes:

- `GET /healthz` — liveness (returns 200 if event loop responsive)
- `GET /ready` — readiness (returns 200 only if all `ReadinessCheck`s pass)

K8s probes use these. **Don't put expensive work in `/healthz`** — that's
what v1 issue 057 cost us. `/ready` is allowed to be slower (mongo ping,
redis ping, etc.) since failures only remove the pod from the LB, they
don't restart it.

## What's deployed right now

See [`deploy/porter-deploy.md`](./deploy/porter-deploy.md) for details.

```
Cluster: aws-us-west-2 (5692)
  app: cloud-v2 (deployed; revision: latest)
    service: core   → https://core-16427-87f939d6-fldz0e8y.onporter.run
    service: audio  → https://audio-16427-87f939d6-e4galhhw.onporter.run
                       wss://audio-16427-…/ws/session  (real WS endpoint)
  Service: cloud-v2-audio-udp (NOT applied yet — needs cluster admin kubectl)
```

## What you can ignore

- The `cloud-v2-mongo` and `cloud-v2-redis` Porter apps on `aws-us-east-2`
  (5690) — mistaken first-deploy artifacts. Delete via Porter dashboard.
- The `mentraos-cloud` (v1) Doppler project — DO NOT MODIFY. v1 prod is
  still serving real users.
- The Azure clusters in Porter's list — v1 territory.

## Where to go from here

- [`deploy/first-time-setup.md`](./deploy/first-time-setup.md) — get
  your machine ready to develop cloud-v2.
- [`deploy/porter-deploy.md`](./deploy/porter-deploy.md) — push a change
  to the dev cluster.
- [`deploy/udp-nlb-aws.md`](./deploy/udp-nlb-aws.md) — provision the
  UDP NLB if you need full audio e2e.
