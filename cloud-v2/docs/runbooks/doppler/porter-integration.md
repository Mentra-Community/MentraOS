# Doppler ↔ Porter integration

Auto-sync secrets from Doppler into Porter env groups so we don't have to
manually `porter env set` every time something changes.

## Why we do this

Without the integration:
- Change a secret in Doppler → manually run a sync script → re-deploy
- Easy to forget, easy to drift between Doppler and Porter

With the integration:
- Change in Doppler → Porter env group updates within ~5 seconds
- `porter apply` picks up the latest values on next deploy
- Single source of truth (Doppler); Porter is downstream

## How it's set up for `cloud-v2-dev-doppler`

The integration is configured in the Porter dashboard, not via CLI (Porter
CLI doesn't expose Doppler integration commands as of v0.68).

### One-time setup steps (already done for `dev_aws` → `cloud-v2-dev-doppler`)

1. **Generate a Doppler service token** scoped to one config:
   ```bash
   doppler configs tokens create porter-cloud-v2-dev_aws \
     --config dev_aws --max-age=0s --plain
   # → dp.st.dev_aws.<token>
   ```
   The `--max-age=0s` means never expires. The token is **read-only** —
   Porter can fetch secrets but not modify them.

2. **Open Porter dashboard** → Integrations → Doppler → "Add Doppler env group".

3. Fill in the form:
   - **Env group name (vanity)**: `cloud-v2-dev-doppler` (or any name; Porter
     uses this as the group identifier you'll reference in `porter.yaml`)
   - **Doppler service token**: paste the token from step 1
   - Toggle **"Enable Doppler integration"** ON (top of the page)

4. Click **Add Doppler env group**. Porter starts polling Doppler for the
   secrets and creates the env group.

5. **Reference the group from `porter.yaml`**:
   ```yaml
   envGroups:
     - cloud-v2-dev-doppler
   ```
   Then `porter apply -f porter.yaml` so the app picks up the linked group.

## Verifying the integration works

Drop a canary value:

```bash
TS=$(date +%s)
doppler secrets set "DOPPLER_SYNC_CANARY=$TS" --config dev_aws --silent
sleep 10
porter env pull --group cloud-v2-dev-doppler | grep DOPPLER_SYNC_CANARY
# → DOPPLER_SYNC_CANARY=1779918990 (or whatever timestamp you set)
```

If the value matches what you set, sync is working. If not, see the
"Troubleshooting" section below.

Then clean up:

```bash
doppler secrets delete DOPPLER_SYNC_CANARY --config dev_aws
```

## Adding the same integration for staging / prod

When we get to those environments, repeat the steps with separate tokens:

```bash
doppler configs tokens create porter-cloud-v2-staging --config staging --max-age=0s --plain
doppler configs tokens create porter-cloud-v2-prod    --config prod    --max-age=0s --plain
```

Then in Porter dashboard, add two new env groups: `cloud-v2-staging-doppler`
and `cloud-v2-prod-doppler`. Reference each in the appropriate `porter.yaml`
(per-target overrides) when we set up staging/prod deployment targets.

## Rotating the service token

If the Doppler service token leaks, rotate it:

```bash
# 1. List existing tokens.
doppler configs tokens --config dev_aws

# 2. Create a new one.
doppler configs tokens create porter-cloud-v2-dev_aws-2 --config dev_aws --max-age=0s --plain

# 3. Update Porter dashboard → Integrations → Doppler → "cloud-v2-dev-doppler"
#    → paste the new token, save.

# 4. Verify sync still works (canary test above).

# 5. Revoke the old token.
doppler configs tokens revoke <old-token-slug> --config dev_aws --yes
```

## Troubleshooting

### Canary value isn't showing up in Porter

- Check that **"Enable Doppler integration"** toggle is ON (top of the
  Integrations → Doppler page). Without it, env groups exist but don't sync.
- Check that the env group name in `porter.yaml`'s `envGroups:` matches
  exactly. If it's wrong, the app pulls a different group (or no group).
- The token may have expired or been revoked. Verify in Doppler:
  ```bash
  doppler configs tokens --config dev_aws
  ```

### "No cloud environment groups found" from `porter env list`

Doppler-synced groups don't show up in `porter env list` (which is for
"cloud env groups" — Porter's term for synced secret-manager groups via a
different code path). The Doppler group works but lives in a different
category in their data model.

To verify it's actually wired up: `porter env pull --group <name>` works
and returns the values, even though `porter env list` is empty.

### Two env groups with similar names attached to the same app

Common mistake when first setting up Doppler — you end up with both:
- `cloud-v2-dev` (manually-synced via `porter env set`)
- `cloud-v2-dev-doppler` (Doppler-synced)

If both are referenced in `porter.yaml`'s `envGroups:`, Porter merges
them; on collision, the last one wins (order matters). To clean up:
- Update `porter.yaml` to reference only `cloud-v2-dev-doppler`.
- Detach the old `cloud-v2-dev` from the app in Porter dashboard (or just
  let it sit unused; legacy cluster env groups don't cost anything).

## The "manual" sync fallback

`./scripts/sync-doppler-to-porter.sh <doppler-config> <porter-group>`
still works for ad-hoc situations (broken integration, one-off bootstrap).
But for normal day-to-day, the integration handles it.

## What lives in `dev_aws` config

Names only (the values are secret):

```
AUDIO_PROVIDER, AUDIO_UDP_PORT, AUDIO_UDP_ADVERTISED_HOST,
AUDIO_UDP_ADVERTISED_PORT, AUDIO_WORKERS

MENTRA_JWT_PRIVATE_KEY, MENTRA_JWT_PUBLIC_KEY, REFRESH_TOKEN_PEPPER

MONGO_URL, REDIS_URL

NODE_ENV, LOG_LEVEL, LOG_STDOUT_JSON, REGION

SONIOX_API_KEY

BETTERSTACK_PASSWORD, BETTERSTACK_USERNAME, BETTERSTACK_SOURCE_TOKEN

SENTRY_DSN
```

For prod we'd add `prod_us-west-2`, `prod_us-east-2` etc. as branch
configs with per-region overrides (NLB hostname, regional Mongo/Redis).
