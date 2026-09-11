# Porter deploys

How code becomes running pods in cloud-v2. Covers our deploy model, env
layering, and what changes when you `porter apply`.

## Branch to environment mapping

Cloud V2 deploys use one Porter app per environment in the AWS us-west-2
cluster:

| Release source                              | Coordinated owner              | Porter app      | Manifest              | Public hosts                                                                          |
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

`cloud-debug` is intentionally outside this promotion path. Treat it as an
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

This shape is in the environment-specific `porter.*.yaml` manifests. The build is in
[`docker/Dockerfile`](../../../docker/Dockerfile). Note the share-an-image
approach — single build, multiple entry points. v1 was monolithic; v2's
three-process model could have been three Docker images, but one image
with `run:` overrides is simpler and the cost is negligible (a few extra
MB per service since they all bundle the same node_modules).

## What `porter apply -f porter.<env>.yaml` actually does

1. Reads the environment manifest.
2. Builds the Docker image (Dockerfile multi-stage build).
3. Pushes to our AWS ECR — `042724764545.dkr.ecr.us-west-2.amazonaws.com/...`.
4. Creates a new app **revision** (Porter's term for a deploy).
5. Triggers a rolling update — new pods come up, old pods drain (10s
   `terminationGracePeriodSeconds`).
6. Liveness + readiness probes gate the new pods before traffic.

Typical apply takes 2–4 min (mostly the Docker build; small code changes
get layer-cached so re-builds are faster).

## Where do env vars come from?

Three layers, in increasing priority:

1. **Service-level `env:` in `porter.yaml`** — non-secret values like
   `LOG_STDOUT_JSON=true`, `AUDIO_UDP_PORT=8000`.
2. **Linked env groups** (referenced in `envGroups:` in `porter.yaml`).
   We use `cloud-v2-dev-doppler`, `cloud-v2-staging-doppler`, and
   `cloud-v2-prod-doppler-sync`. See
   [`doppler/porter-integration.md`](../doppler/porter-integration.md).
3. **App-level env** (rarely set) — overrides env-group values per-app.

Verify what a pod actually sees:

```bash
porter env pull --app cloud-dev --merged | grep MENTRA_JWT
# Shows the merged env, including env-group values
```

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

Defined in `porter.yaml` per service:

```yaml
- name: core
  cpuCores: 1
  ramMegabytes: 1024
- name: audio
  cpuCores: 2
  ramMegabytes: 2048
```

Bump these in `porter.yaml` and re-apply when:

- OOM kills happen (check with `porter app logs ... --search OOMKilled`)
- CPU throttling shows up in metrics (the event-loop-lag gauge)
- You're scaling user count beyond what the current size handles

## Replica count

By default Porter runs 1 replica per service. To scale up:

```yaml
- name: audio
  instances: 3 # multi-replica
```

For audio specifically, multi-replica is REAL multi-pod, exercised by the
multi-pod integration tests. UDP and WS distribute across replicas via
the cluster's LB layer (ALB for WS, NLB for UDP).

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
