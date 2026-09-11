# Naming conventions

Decisions about names that aren't enforced by code but matter for everyone
working on cloud-v2. Updates are easy if we change our minds; consistency
is what we're paying for.

## Doppler

**Project**: `cloud-v2` (not `mentraos-cloud-v2` — workspace already says
MentraOS).

**Configs** (one per environment):

| Slug | What it's for |
| --- | --- |
| `dev` | Local development. `MONGO_URL` etc. point at localhost / docker. |
| `dev_aws` | Branch of `dev`. AWS dev cluster deploy — overrides URLs to point at ElastiCache, eventually Atlas. |
| `staging` | (Future) Staging deploys. |
| `prod` | (Future) Prod deploys, root config. |
| `prod_<region>` | (Future) Per-region overrides for prod. Pattern matches v1's `prod_us-east`, `prod_us-west`. |
| `dev_<name>` | (Future) Per-developer dev sandboxes. Pattern from v1: `dev_isaiah-cloud`, `dev_aryan-cloud`. |

**Underscore, not dash.** Doppler convention is `dev_aws` not `dev-aws`.
Matches v1's pattern. Branch configs always include the parent slug as
prefix: `dev_aws`, never `aws-dev`.

## Porter

**App name**: `cloud-v2`. Singular — all the services (core, audio, future
proxy) are services *within* this one app, not separate apps.

**Service names**: `core`, `audio`, `proxy`. Match the package names in
`packages/*/`. No `cloud-v2-` prefix on the service name (Porter
automatically scopes to the app).

**Auxiliary apps** that aren't part of cloud-v2 but live in the same
cluster get `cloud-v2-` prefix to make ownership obvious:
- `cloud-v2-audio-udp` — the manually-applied UDP Service (NLB)
- `cloud-v2-mongo`, `cloud-v2-redis` — early experiments, should be deleted

**Env groups**: `cloud-v2-<doppler-config>-doppler` for Doppler-synced
groups. E.g., `cloud-v2-dev-doppler` syncs `dev_aws`. Naming reflects:
- which app: `cloud-v2`
- which env: `dev` (or `staging` / `prod` later)
- how it's sourced: `-doppler` suffix

Manual (legacy) env groups: same name without `-doppler` suffix. We have
`cloud-v2-dev` from before the integration was set up — should be retired
once we confirm `cloud-v2-dev-doppler` covers everything.

## AWS

**ECR repository**: just `cloud-v2`. Porter manages tags (uses git SHA).

**ElastiCache**: `cloud-elasticache-<region>`. We have
`cloud-elasticache-us-west-2`; future would be
`cloud-elasticache-us-east-2`, etc.

**NLB Service name in k8s**: `cloud-v2-audio-udp`. The `-udp` suffix
disambiguates from Porter's auto-created `cloud-v2-audio` Service (which
is TCP/HTTP only).

## DNS (Cloudflare)

**Custom hostnames**: `<service>.<env>.<region>.mentraglass.com`

Examples:

- `core.dev.us-west-2.mentraglass.com` → dev Core HTTP/REST ALB
- `runtime.dev.us-west-2.mentraglass.com` → dev Runtime HTTP/WS ALB
- `core.debug.us-west-2.mentraglass.com` → debug Core HTTP/REST ALB
- `runtime.debug.us-west-2.mentraglass.com` → debug Runtime HTTP/WS ALB
- `audio-udp.debug.us-west-2.mentraglass.com` → debug Runtime UDP NLB
- `runtime.staging.us-west-2.mentraglass.com` → future staging Runtime HTTP/WS ALB

Service first keeps the mobile/debug UI readable, and `<env>.<region>` makes
it clear which deployed environment and AWS region a hostname targets. Avoid
mixing environment words in one hostname (for example, don't use both
`debug` and `dev` in the same name).

**DNS-only mode (grey cloud)** for UDP records. Always. See
[`cloudflare/dns-for-nlb.md`](../cloudflare/dns-for-nlb.md).

## Git branches

(Pattern emerging — refine as we ship more.)

| Pattern | What it is |
| --- | --- |
| `main` | What ships to staging on merge. |
| `cloud-v2/<topic>` | Feature branches that touch only cloud-v2. Mirrors v1's `cloud/<topic>` convention. |
| `cloud-v2/issue-<NNN>` | Branch implementing the cloud-v2 ticket `OS-<NNN>` from Linear. |
| `cloud-v2/<name>-personal` | Personal sandbox branch. Won't auto-deploy. |

PR-preview deploys (when we wire them up) will use the branch name as
the deployment target — `cloud-v2/issue-1523` → deployment target
`pr-1523` on the dev cluster.

## What goes where

| Code thing | Lives in |
| --- | --- |
| Spec / design per work item | `docs/issues/<NNN>-<slug>/` |
| Operational knowledge (this folder) | `docs/runbooks/` |
| Architecture decisions | `docs/issues/<NNN>-<slug>/design.md` (one per work item) |
| Conventions (this doc) | `docs/runbooks/conventions/` |
| Deploy manifests (NLB, etc.) | `deploy/` |
| Build config (Dockerfile) | `docker/` |
| Workflow scripts (sync, smoke) | `scripts/` |
| Tests | `tests/` (integration), `packages/*/src/**.test.ts` (unit) |
| Test fixtures (TEST OEM, TEST CLIENT) | `test/` (different from `tests/` — these are workspace packages) |

The `test/` vs `tests/` split is annoying-but-deliberate:
- `test/<name>/` = a workspace package, like `test/test-oem/` — has its
  own `package.json`, importable code
- `tests/<file>.test.ts` = integration test file, not a workspace package
