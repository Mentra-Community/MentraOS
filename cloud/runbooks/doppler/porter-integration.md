# Doppler + Porter Integration

How secrets flow from Doppler into Porter pods. Production
relies on Porter's native Doppler integration, not on
`doppler run --` at process start. The two are easy to confuse
because both end with secrets in `process.env`; the difference
is who fetches them and when.

## The flow

1. A Porter project has a **Doppler integration** linked once,
   at the project level. Setup: Porter dashboard -> Integrations
   -> Doppler -> connect with a Doppler service account.
2. The integration creates a Doppler-managed **environment
   group** in Porter for each Doppler project + config. The env
   group keeps itself in sync with the underlying Doppler
   config.
3. To use a Doppler config on an app, attach the matching
   Doppler env group to the app the same way you would attach
   any normal Porter env group (Porter dashboard -> the app ->
   Environment -> Sync environment group).
4. At deploy time, Porter writes the env group's contents into
   the Kubernetes Secret backing the deployment. The integration
   also injects metadata env vars on the pod so you can
   identify the source: `DOPPLER_PROJECT`, `DOPPLER_CONFIG`,
   `DOPPLER_ENVIRONMENT`.
5. The pod starts. Its env block already contains the secrets.
   The `run` command is just `./start.sh` (which is
   `cd packages/cloud && bun run start`); no Doppler CLI
   involved.
6. The Bun process reads `process.env.FOO` normally.

This means:

- Code reads secrets via `process.env.FOO`, same as a local dev
  script.
- A secret update in Doppler does not flow into a running pod.
  Pods read env at process start. To pick up new values:
  redeploy or restart.
- There is no `DOPPLER_TOKEN` in the pod. The integration's
  auth happens entirely on Porter's side. The Doppler CLI is
  not in the container image.

## Per-app config mapping

Naming convention: each `cloud-prod` regional app pulls from
`mentraos-cloud:prod_<region>` (e.g. central US pulls from
`prod_central-us`, France from `prod_france`). `cloud-staging`
and `cloud-dev` pull from the matching `staging` and `dev`
configs in the same project.

Source of truth is the Porter dashboard (each app's Environment
tab plus the integration's view of which env groups it owns).
If you need to know what a specific app is wired to, look there.

## Setting up the integration for a new app

1. In Porter, open the app -> Environment.
2. Click "Sync environment group" and pick the Doppler-managed
   group whose name matches the project + config you want
   (e.g. `mentraos-cloud` / `prod_brazil-south` for a new
   region; the env group is created automatically by the
   integration once that Doppler config exists).
3. Save. Porter writes the group's secrets into the next deploy.
4. Trigger a redeploy (push to the watched branch, or use
   "Redeploy" in the dashboard).
5. Confirm in the dashboard that the env group appears as
   attached on the app.

## Stale `porter-*.yaml` files in the repo

The repo contains `cloud/porter-us-west.yaml`,
`cloud/porter-us-east.yaml`, etc. Some of those files have
`run: doppler run -- bun run start` instead of `./start.sh`.
That is leftover from when we were considering the runtime-
injection pattern; it is not what Porter is actually running.

```bash
# What the regional yamls in the repo say (often stale)
grep "run:" cloud/porter*.yaml

# What Porter is actually deploying for each region
for tuple in "4689 default" "4977 us-east-default" \
             "4965 us-west-default" "4696 france-default" \
             "4754 east-asia-default"; do
  cid=$(echo "$tuple" | awk '{print $1}')
  tgt=$(echo "$tuple" | awk '{print $2}')
  rline=$(porter app yaml cloud-prod --cluster $cid --target $tgt 2>/dev/null \
    | grep "^  run:" | head -1)
  echo "cluster $cid ($tgt): $rline"
done
```

If you ever see those two outputs disagree, the deployed config
wins. The repo yamls drift because Porter holds its own state
once the app is deployed. Worth cleaning up the stale yamls so
they match deployed reality, but that is its own task.

## Local dev parity

For local dev that needs the same secrets prod has, use the
local-dev pattern with the Doppler CLI directly:

```bash
doppler run --project mentraos-cloud --config prod_central-us -- \
  bun src/index.ts
```

This gives your local Bun process the exact same env vars the
production pod has. Be cautious: this connects to production
resources (DB, third-party APIs).

For dev-config local runs:

```bash
doppler run --project mentraos-cloud --config dev -- \
  bun src/index.ts
```

`doppler run --` is for local processes. Production pods use
the Porter integration above.

## Common failures

- **Pod starts but a required env var is missing**: the Doppler
  config does not have that secret. Add it
  ([adding-secrets.md](adding-secrets.md)), then redeploy.
- **One region works, another does not**: per-region configs
  drifted. See the cross-config drift check in
  [adding-secrets.md](adding-secrets.md).
- **Updates to a secret are not visible in the pod**: the pod
  loaded its env at process start. Restart the pod.
