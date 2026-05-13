# Deploying to Porter

Each Porter app has a `porter.yaml` (or `porter-<region>.yaml`)
in the repo. Porter watches the linked branch on GitHub. When
that branch advances, Porter builds the Docker image (using the
Dockerfile referenced in the YAML), pushes it, and rolls the
deployment.

## Quick reference

The `cloud-prod` app is deployed to multiple Porter clusters,
distinguished by cluster ID and deployment target rather than by
having different app names. List them with:

```bash
porter cluster list                       # cluster IDs and names
porter app list --cluster <CLUSTER_ID>    # apps on that cluster
```

For each cluster running `cloud-prod`, confirm what branch the
deployment watches in the Porter dashboard under the app's
Settings -> Source. The watched branch is typically `main` for
production, `dev` for staging/dev variants, but the dashboard
is the source of truth.

The repo has multiple `porter*.yaml` files
(`porter.yaml`, `porter-us-east.yaml`, `porter-us-west.yaml`,
`porter-stress.yaml`). These are not all kept in sync with what
Porter actually deploys. Once a deployment exists, Porter holds
its own state for that app on that cluster; editing a regional
yaml in the repo and merging may not change deployed behavior
in that region. Check the live config with:

```bash
porter app yaml cloud-prod --cluster <CLUSTER_ID> --target <TARGET>
```

## Triggering a deploy

### Push the branch

The normal path. Merge to the watched branch and Porter starts a
build automatically.

```bash
# Stable production: merge through main
git checkout main
git pull
git merge --ff-only origin/dev   # or open a PR, merge via GitHub
git push origin main
```

Porter picks up the push within ~30s, builds, and starts the
rollout.

### Manual rebuild

If the branch has not changed but you want to rebuild (e.g.
base image security update, env var change that requires a
restart), trigger from the dashboard:

1. Open the app in https://dashboard.porter.run/
2. Click "Redeploy" or "Rebuild" on the app page.

The Porter CLI does not have a deploy/redeploy/restart command;
all of those are dashboard actions.

## Watching a deploy

Use the dashboard's Activity tab; the live view shows the
rolling deploy as new pods come up and old ones terminate.

From the CLI:

```bash
porter app list --cluster <CLUSTER_ID>
porter app logs cloud-prod --cluster <CLUSTER_ID> --target <TARGET>
```

`porter app logs` streams the running pod's stdout, which is
the most useful signal during a deploy. It supports
`--revision`, `--since`, `--search`, and `--service` flags;
`porter app logs --help` for the full set.

There is no `porter app status` command. Run
`porter app --help` to see the actual command set; the only
"watch" path from the CLI today is logs + listing.

## Rolling deploy mechanics

Porter uses a Kubernetes rolling deploy by default:

1. New pod is created with the new image.
2. Liveness probe (`/livez`) and readiness probe (`/health`)
   run.
3. Only when readiness passes does the new pod start receiving
   traffic from the load balancer.
4. Once the new pod is Ready, an old pod is killed.
5. Repeat until all pods are on the new version.

A failing readiness probe means the new pod is alive but is not
yet receiving REST traffic. Existing WebSocket connections on
old pods stay alive until those pods are killed.

Probe details and the readiness-failure cascade are documented
in [../infra.md](../infra.md).

## Rollback

Porter keeps prior revisions. To roll back from the dashboard:

1. Open the app.
2. Activity tab -> find the previous successful deploy.
3. Click the three-dot menu -> "Rollback to this version".

CLI:

```bash
porter app rollback cloud-prod --cluster <CLUSTER_ID> --target <TARGET>
```

`porter app rollback` always rolls back to the last successful
revision; there is no flag for picking an older revision via
the CLI. Use the dashboard if you need to skip past a recent
"successful" rollout that was actually broken.

If a rollback is urgent and the dashboard is slow, the fastest
recovery is to revert the offending commit on the watched
branch and push. The next deploy uses the reverted code.

## Multi-region coordination

Production runs `cloud-prod` on multiple regional clusters
(see [../infra.md](../infra.md) for the current cluster list). Each
deployment watches its branch independently, so a merge to
`main` triggers all of them roughly in parallel. They are not
synchronized; one region can be rolling while another is
already done.

If you ship a change that depends on cross-region coordination
(rare), pause the regions you are not actively deploying via
the Porter dashboard before merging.

Cloudflare's load balancer is the layer that hides the per-
region rollout from end users: an unhealthy pool drops out of
the LB rotation while it is mid-deploy. See
[../cloudflare/load-balancer.md](../cloudflare/load-balancer.md).

## Common failures

- **Build fails**: check `porter app logs cloud-prod --cluster
  <ID> --revision <build-revision>` or watch the build in the
  dashboard. Usually a Dockerfile issue, a dependency that did
  not install, or a TS compile error.
- **Pod crashloops**: see
  `cloud/tools/bstack/runbooks/pod-crash.md` for diagnostic
  steps. Common causes are bad env vars and missing secrets.
- **Pod stuck in `ContainerCreating`**: usually node pressure
  (no available capacity). Check the cluster's nodes in the
  Porter dashboard.
- **Readiness probe failing**: the pod is alive but `/health`
  returns non-200 or times out. Check the pod's logs for what
  happened during startup.

## After a deploy

- Watch BetterStack for ~10 minutes. The `bstack health`
  command is the fastest single-command sanity check.
- If the change touches the wire protocol or DB schema, also
  check `bstack incidents --limit 10` for new errors.
