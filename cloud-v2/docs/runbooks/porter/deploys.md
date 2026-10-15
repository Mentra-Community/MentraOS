# Porter deploys

How code becomes running pods in cloud-v2. Covers our deploy model, env
layering, and what changes when you `porter apply`.

## Branch to environment mapping

Cloud V2 deploys use one Porter app per environment in the AWS us-west-2
cluster:

| Release source                              | Coordinated owner              | Porter app      | Generated manifest    | Public hosts                                                                          |
| ------------------------------------------- | ------------------------------ | --------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `dev`                                       | `coordinated-release.yml`      | `cloud-dev`     | `porter.dev.yaml`     | `core.dev.us-west-2.mentraglass.com`, `runtime.dev.us-west-2.mentraglass.com`         |
| `staging`                                   | `coordinated-release.yml`      | `cloud-staging` | `porter.staging.yaml` | `core.staging.us-west-2.mentraglass.com`, `runtime.staging.us-west-2.mentraglass.com` |
| selected release source contained in `main` | `production-release-cloud.yml` | `cloud-prod`    | `porter.prod.yaml`    | `core.mentraglass.com`, `runtime.mentraglass.com`                                     |

Both release systems call `reusable-coordinated-cloud-v2.yml`, which is the single
implementation owner for target resolution, Porter deployment, public health
checks, and deployment evidence. Dev and staging can be started with the
coordinator's `workflow_dispatch`; production remains a protected promotion of
a completed beta whose source is contained in `main`.

The production deployment must finish, and the actual currently published
Mentra App must pass against it, before production mobile candidates are built.
Beta mobile builds embed staging Cloud V2 and are not production-promotable
artifacts.

Do not add a second branch-push deploy workflow for these Porter apps. A manual
repair should rerun the exact coordinated job/source so its result remains
attached to the release record.

`cloud-debug` and `cloud-isaiah` are intentionally outside this promotion path and retain their explicit sandbox manifests. Treat it as an
explicit shared debugging environment and do not use it as a default test
target unless the person currently using it agrees.

## The deploy model

Each Porter app has the same service layout. All services share one Docker
image — each just runs a different process from it:

| Service   | Run                                 | HTTP port | UDP port |
| --------- | ----------------------------------- | --------- | -------- |
| `core`    | `bun packages/core/src/index.ts`    | 3000      | —        |
| `runtime` | `bun packages/runtime/src/index.ts` | 3001      | 8000     |

(The proxy service from `packages/proxy/` joins once it has real code.)

Service behavior lives once in [`deploy/porter.shared.yaml`](../../../deploy/porter.shared.yaml).
[`deploy/runtime-policy.yaml`](../../../deploy/runtime-policy.yaml) owns the shared
Runtime disruption budget and rolling strategy. The existing guarded target table
in `.github/scripts/coordinated-cloud-v2-records.mjs` supplies only app identity,
linked Doppler group, domains and deployment target. There is no per-environment
service override or generic merge layer.

The reusable deployer renders both inputs from the **exact frozen release source**,
using the workflow revision's renderer. Generated `porter.dev.yaml`,
`porter.staging.yaml`, `porter.prod.yaml` and their `.overrides.yaml` files are
ignored outputs, not copies to edit. They retain the existing logical names used
by deployment records. CI renders all three environments and checks service parity,
Runtime PDB100 and rolling zero-unavailable/one-surge.

To inspect one environment without deploying:

```bash
bun .github/scripts/render-cloud-v2-config.mjs --source-root . --environment staging
```

Run this from the repository root. Concrete outputs stay in `cloud-v2/` so the
Docker build context remains unchanged. Both dry-run validation and normal deploy
use these same inputs; actual apply always passes the Helm override. Rendered
files and SHA256 receipts accompany the deployment artifact. After apply, the
normal job checks actual Runtime Deployment/PDB selectors, current generations,
configured replicas, rolling strategy, 100% healthy budget and zero allowed
disruptions. Missing or weaker protection blocks a successful deployment record.
The measured policy receipt accompanies the existing artifact.

A release source predating this consolidation lacks the shared inputs and fails
before apply. Qualify a new completed beta containing the consolidation before
production promotion. Do not substitute newer policy files into an older release
or restore an alternate legacy deployment path.

The build is in
[`docker/Dockerfile`](../../../docker/Dockerfile). Note the share-an-image
approach — single build, multiple entry points. v1 was monolithic; v2's
three-process model could have been three Docker images, but one image
with `run:` overrides is simpler and the cost is negligible (a few extra
MB per service since they all bundle the same node_modules).

## What `porter apply -f porter.<env>.yaml` actually does

1. Reads the rendered manifest and its required Runtime Helm policy.
2. Builds the Docker image (Dockerfile multi-stage build).
3. Pushes to our AWS ECR — `042724764545.dkr.ecr.us-west-2.amazonaws.com/...`.
4. Creates a new app **revision** (Porter's term for a deploy).
5. Triggers a rolling update — new pods come up, old pods drain (10s
   `terminationGracePeriodSeconds`).
6. Liveness + readiness probes gate the new pods before traffic.

Typical apply takes 2–4 min (mostly the Docker build; small code changes
get layer-cached so re-builds are faster).

## Where do env vars come from?

Doppler is authoritative. The renderer links `cloud-v2-dev-doppler`,
`cloud-v2-staging-doppler`, or `cloud-v2-prod-doppler-sync` for the selected target.
Application settings and secrets do not belong in the shared YAML or Porter app
overrides. CI renders every release environment before running the source guard.
See [`doppler/porter-integration.md`](../doppler/porter-integration.md).

## Watching a deploy

```bash
# Live logs from one service (Ctrl+C to stop)
porter app logs cloud-dev --service core
porter app logs cloud-dev --service runtime

# Historical logs
porter app logs cloud-dev --service core --since 30m
porter app logs cloud-dev --service core --limit 100
```

## Rollback

```bash
# Roll back to the previous successful revision
porter app rollback cloud-dev

# Roll back to a specific revision number
porter app rollback cloud-dev --revision 5
```

Rollbacks are instant — Porter just shifts the Helm release back to the
previous values. Use this when a fresh deploy made things worse.

## Updating env vars without a code change

If you only need to change an env var (no code change), you can:

```bash
# Change in Doppler — auto-syncs to Porter via the integration.
doppler secrets set FOO=bar --config dev_aws

# Trigger a new coordinated dev release so pods pick up the new env.
gh workflow run coordinated-release.yml --ref dev -f dry_run=false
```

Pods don't auto-restart on env changes (avoids cascading restarts). You
have to run the matching coordinator again. Use `--ref staging` for staging;
production remains a protected production promotion rather than an ad hoc
cloud-only deployment.

## Public URLs

The HTTP/WS endpoints are auto-provisioned by Porter via the cluster's
ALB ingress. Hostnames are derived from `<service>-<project-id>-<target-id>.onporter.run`:

| Service  | URL                                                         |
| -------- | ----------------------------------------------------------- |
| core     | https://core-16427-87f939d6-fldz0e8y.onporter.run           |
| audio    | https://audio-16427-87f939d6-e4galhhw.onporter.run          |
| audio WS | wss://audio-16427-87f939d6-e4galhhw.onporter.run/ws/session |

To get the URLs programmatically:

```bash
porter kubectl -- get ingress -l porter.run/app-name=cloud-dev
```

For UDP, see [`udp-nlb-aws.md`](./udp-nlb-aws.md) — separate Service +
NLB needed.

## Custom domains

(TODO when we set them up.) v1 used Cloudflare CNAMEs pointing at the
Porter ALB hostnames. We'd do the same for cloud-v2 — e.g.,
`audio.cloud-v2.mentra.glass` → Porter ALB ingress.

## Health checks

Both services expose:

- `GET /healthz` — liveness, returns 200 if responsive
- `GET /ready` — readiness, returns 200 if all deps connected

K8s readiness probes hit `/ready` on a 15s initial-delay + every poll
afterwards. A pod that goes unready gets removed from the service's
endpoints (no more traffic) but is NOT restarted. K8s liveness probes
hit `/healthz`; failures restart the pod.

We set `/ready` to be the slower check (Mongo ping, Redis ping). `/healthz`
just returns "ok" — no work — so liveness can't false-positive under load.

(Lesson from v1 issue 057.)

The coordinated deployer verifies both paths through every configured public
Core and Runtime hostname after `porter apply -w`. Missing DNS, an unhealthy
dependency, or an unready pod fails the cloud job and prevents mobile
publication. It then reads pod `imageID` values and the Porter pod revision back
through read-only `porter kubectl`; those immutable observations are stored in
`cloud-v2-deployment.json` and copied into the completed release manifest.

## Resource limits

The shared source requests one Core replica at 0.25 CPU / 1024 MiB and one
Runtime replica at 0.5 CPU / 2048 MiB in every release environment. Change shared
service resources once; promotion carries the same behavior through staging and
production. Explicit sandbox manifests are outside this contract.

Runtime's PDB requires 100% healthy pods and its rolling update allows zero
unavailable and one temporary surge. See
[`Runtime voluntary disruption`](../../../deploy/runtime-disruption.md) for the
maintenance and availability limits. This protects ordinary voluntary singleton
eviction; it does not qualify abrupt node loss or uninterrupted WebSockets.

## Gotchas

### Builds take forever after a node_modules change

Docker layer cache invalidates on `bun.lock` change → full reinstall.
Expected — the install is ~60s. If it's taking longer, your local Docker
might be low on cache disk; `docker system prune -a` helps.

### "ImagePullBackOff" after deploy

Usually means the build succeeded but Porter pushed to a registry the
cluster can't read from. Check:

```bash
porter kubectl -- get pods -l porter.run/app-name=cloud-dev
porter kubectl -- describe pod <pod-name> | grep -A5 Events
```

Fix is usually in the cluster's ECR auth — talk to whoever set up Porter.

### Deploy succeeds but pods crash-loop on env

Most often: a placeholder URL in Doppler (e.g., MONGO_URL = TBD_PROVISION
something). Check:

```bash
porter app logs cloud-dev --service core --search "error" --limit 20
```

Update Doppler, re-apply.

### Deploys are slow because of `bun run typecheck` in the Dockerfile

The Dockerfile runs `bun run typecheck` as a build-time gate so we don't
deploy broken types. Costs ~10s. Worth it. Skip via `--build-arg
SKIP_TYPECHECK=true` only if you're debugging the deploy itself.

(TODO: actually wire that build arg if it becomes useful.)
