# Porter Environment Variables

Porter pods get their environment from two places:

1. **Static env in `porter.yaml`**: literal values, mostly
   non-sensitive config like `LOG_LEVEL`, `HOST`, `SERVICE_NAME`,
   `RTMP_RELAY_URLS`. Visible in the repo.
2. **Synced from Doppler at deploy time**: secrets (API keys,
   DB passwords, JWT secrets, etc.). Porter has a Doppler
   integration that pulls from a project + config and writes
   the values into the pod's env block. See
   [../doppler/porter-integration.md](../doppler/porter-integration.md) for the full flow.

Anything secret belongs in Doppler. Anything that would be safe
to commit goes in `porter.yaml`.

## Static env in porter.yaml

Find the `env:` block under each service in
`cloud/porter*.yaml`:

```yaml
services:
  - name: cloud
    type: web
    env:
      HOST: "0.0.0.0"
      SERVICE_NAME: "cloud"
      LOG_LEVEL: "info"
      LOG_STDOUT_JSON: "true"
```

To change one of these:

1. Edit the YAML.
2. Open a PR, merge to the watched branch.
3. Porter rebuilds and rolls. New pods get the new value; old
   pods keep the old value until they are replaced.

A static env change without a code change still requires a
rebuild. Pushing the YAML edit alone is enough; Porter detects
the change.

## Doppler-synced secrets

Porter pulls secrets from Doppler at deploy time via the Doppler
integration linked at the project level. The integration
creates a Doppler-managed environment group for each Doppler
config; each app attaches the env group it needs through the
standard "Sync environment group" UI (same path as any other
Porter env group). At deploy time Porter writes the group's
secrets into the Kubernetes Secret backing the deployment;
the pod sees them as ordinary `process.env.FOO` values.

The pod's `run` is just `./start.sh` (which is
`cd packages/cloud && bun run start`). No Doppler CLI runs in
the pod. You can verify what config a pod was synced from by
inspecting `DOPPLER_PROJECT`, `DOPPLER_CONFIG`,
`DOPPLER_ENVIRONMENT` in the pod env (these metadata vars are
injected by the integration).

To change a secret, you change it in Doppler, not in
`porter.yaml`. The pod picks up the new value the next time it
starts (rolling restart, redeploy, or autoscaling event).

See [../doppler/adding-secrets.md](../doppler/adding-secrets.md) for the full procedure and
[../doppler/porter-integration.md](../doppler/porter-integration.md) for the integration setup.

## Forcing pods to pick up a new secret

Doppler updates do not flow into a running pod. The pod reads
its env at process start. The Porter CLI does not have a
restart command (`porter app --help` to confirm); the practical
options are:

- **Redeploy via the dashboard**: open the app, click
  "Redeploy" or "Rebuild." This builds (or re-uses) the image
  and rolls the pods, picking up the latest Doppler-synced env
  group.
- **Push a no-op commit** to the watched branch. Porter rebuilds
  and rolls.

For Doppler-managed env groups, the integration re-syncs on
deploy. A pod restart without a redeploy can roll pods that
still see the old (cached) env. See
[../doppler/adding-secrets.md](../doppler/adding-secrets.md).

## Adding a new env var

For non-secrets, the static `env:` block in `porter*.yaml` is
the source for newly-deployed apps, but for already-deployed
apps Porter holds its own state and editing the yaml may not
take effect on its own. Practical pattern:

1. Add to the `env:` block in `cloud/porter.yaml` (and the
   regional yaml files for parity).
2. Reference it in code (`process.env.FOO`).
3. Open a PR with both changes; merge.
4. Confirm the change actually landed in each region's deployed
   app via the Porter dashboard's Environment view.

For secrets:

1. Add it to Doppler in each environment that needs it (dev,
   staging, plus per-region prod configs). See
   [../doppler/adding-secrets.md](../doppler/adding-secrets.md).
2. Reference it in code (`process.env.FOO`).
3. Open a PR with the code change; merge.
4. Trigger redeploys so the Doppler integration re-syncs.

If the new secret is required (the process exits when
missing), add it to Doppler before merging the code. Otherwise
new pods will crashloop until the secret is in place.

## Reading what is currently set

- **Static values**: open the app in the Porter dashboard ->
  Environment, or grep `cloud/porter*.yaml`.
- **Secrets**: Doppler dashboard, or
  `doppler secrets --project <project> --config <config>`.

## Common mistakes

- **Assuming the regional `porter*.yaml` files are
  authoritative.** They are sometimes stale; once an app is
  deployed, Porter holds its own state for that app on that
  cluster. Confirm what is deployed with
  `porter app yaml cloud-prod --cluster <ID> --target <TARGET>`
  before relying on a repo yaml as truth.
- **Putting a secret in `porter.yaml`.** It ends up in git and
  the pod env. Move to Doppler, rotate the value, force-push
  the removal if the leak just happened (and rotate the secret
  externally).
- **Forgetting to redeploy after a Doppler change.** Without a
  redeploy, the Porter integration does not re-sync; pods that
  restart will still see the old value. See
  [../doppler/adding-secrets.md](../doppler/adding-secrets.md).
- **Mismatched config names across regions.** Each region maps
  to a different Doppler config (`prod_central-us`,
  `prod_us-east`, etc.). Adding a secret to one config does not
  add it to the others. See [../doppler/](../doppler/).
