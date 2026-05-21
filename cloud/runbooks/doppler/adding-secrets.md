# Adding a Secret

How to add a new secret so the cloud can read it from
`process.env`. Covers the multi-region / multi-config case.

## Steps

### 1. Decide which project + configs

- Cloud secrets that pods read at startup go in
  `mentraos-cloud`. Add to every region config you need
  (`prod_central-us`, `prod_us-east`, `prod_us-west`, etc.) plus
  any non-prod configs (`dev`, `staging`).
- SRE / tooling secrets go in `mentra-sre`. Usually just `dev`
  and `prod` configs.

If a secret only matters in one region, document why; otherwise
keep all regions in sync to avoid surprises.

### 2. Add the secret

Web UI:

1. Open https://dashboard.doppler.com/
2. Pick the project, then the config.
3. Click "Add Secret", give it a name and value, save.
4. Repeat for every config that needs it.

CLI:

```bash
doppler secrets set FOO=bar \
  --project mentraos-cloud --config prod_central-us

doppler secrets set FOO=bar \
  --project mentraos-cloud --config prod_us-east
# ... and so on
```

For secrets that have the same value across configs, the web UI
"Add to multiple configs" shortcut is faster than running the
CLI per-config.

### 3. Reference it in code

```ts
const foo = process.env.FOO;
if (!foo) throw new Error("FOO is not set");
```

If the secret is required, fail loud at startup. Silent fallbacks
hide misconfiguration.

### 4. Re-sync Porter and roll the pods

Porter pulls secrets from Doppler at deploy time, not at pod
restart, so a Doppler update plus a plain pod restart can leave
the pod with the OLD secret value. Two reliable paths:

- **Trigger a redeploy.** Porter resyncs from Doppler on every
  deploy. Push a no-op commit to the watched branch, or use
  Porter dashboard -> the app -> "Redeploy" / "Sync now" button
  in Settings -> Environment.
- **Force-resync, then restart.** In the Porter dashboard, open
  the app's Environment tab, click "Sync now" against the
  Doppler integration, then restart the pods. The Sync now step
  is what brings the new value into the Kubernetes Secret; the
  restart is what makes the pod read it.

A pod restart without re-sync will roll pods that read the
same (stale) Kubernetes Secret. The Porter CLI does not have a
restart command (`porter app --help` to confirm); use the
Redeploy / Rebuild flow above instead.

If the new secret is required by code that is also new, sequence
matters: add the secret first, redeploy, then merge the code so
the next deploy picks up both. Otherwise the new pods crashloop
until the secret lands.

## Verification

Inside one pod, confirm the var is present without printing
its value (only when needed, this exec touches a production
pod):

```bash
porter kubectl --cluster <CLUSTER_ID> -- exec -n default \
  <POD_NAME> -- sh -c '[ -n "$FOO" ] && echo "FOO is set" || echo "FOO is NOT set"'
```

Avoid `printenv FOO` or `echo "$FOO"` here; both print the
secret value to your terminal and to anywhere your shell
history persists. The presence check above is enough to confirm
the env var landed.

Or rely on the application logs: many of our startup paths log
"loaded X" when a new secret is wired up.

## Rotating an existing secret

1. Generate the new value at the source (the API console, the DB,
   wherever).
2. Update Doppler (web UI or `doppler secrets set` per config).
3. Re-sync Porter and roll the pods (see step 4 of "Adding a
   secret" above; a plain pod restart without re-sync leaves
   pods on the stale value).
4. Verify the app is still healthy with `bstack health`.
5. Revoke the old value at the source.

The order matters: do not revoke the old value before the pods
have rolled to the new one, or you will cause a brief outage.

## Cross-config drift

A common gotcha: a secret was added to `prod_central-us` but
forgotten in `prod_us-east`. The east region's pods crashloop
on next restart while central is fine.

When you suspect drift, run this against all production regional
configs:

```bash
REGIONS=(prod_central-us prod_us-east prod_us-west prod_france prod_east-asia)

for cfg in "${REGIONS[@]}"; do
  doppler secrets --project mentraos-cloud --config $cfg \
    --only-names > /tmp/$cfg
done

# Diff every region against the canonical baseline (central-us)
for cfg in "${REGIONS[@]:1}"; do
  echo "=== prod_central-us vs $cfg ==="
  diff /tmp/prod_central-us /tmp/$cfg
done
```

Anything that diffs should either be reconciled or have a
documented reason for the difference. If you add a new region,
add it to `REGIONS` here so it stays in the rotation.

## Removing a secret

1. Remove all references in code first.
2. Merge and deploy. New pods do not need the secret.
3. Delete from Doppler in every config.

Reversing the order leaves running pods reading an env var that
no longer exists in Doppler. The pod keeps the value it has
until restart, but any operation that re-reads from Doppler
(unlikely in our setup, but worth noting) fails.
