#!/usr/bin/env bash
# Sync a Doppler config → a Porter env group.
#
# Usage:
#   ./scripts/sync-doppler-to-porter.sh <doppler-config> <porter-env-group>
#
# Examples:
#   ./scripts/sync-doppler-to-porter.sh dev_aws        cloud-v2-dev
#   ./scripts/sync-doppler-to-porter.sh staging        cloud-v2-staging
#   ./scripts/sync-doppler-to-porter.sh prod_us-west-2 cloud-v2-prod-us-west-2
#
# Prereqs: doppler + porter CLIs authenticated; `doppler.yaml` in repo root.
# Note: --skip-redeploys means apps linked to the group won't auto-redeploy.
# Run `porter apply -f porter.yaml` after to redeploy.

set -euo pipefail

DOPPLER_CONFIG="${1:?usage: $0 <doppler-config> <porter-env-group>}"
PORTER_GROUP="${2:?usage: $0 <doppler-config> <porter-env-group>}"

SECRETS_JSON=$(doppler secrets --config "$DOPPLER_CONFIG" --json)
SEC_FLAGS=()
for key in $(echo "$SECRETS_JSON" | jq -r 'keys[]' | grep -v '^DOPPLER_'); do
  value=$(echo "$SECRETS_JSON" | jq -r --arg k "$key" '.[$k].computed')
  SEC_FLAGS+=(--secrets "$key=$value")
done

echo "syncing ${#SEC_FLAGS[@]} secrets: doppler '$DOPPLER_CONFIG' → porter group '$PORTER_GROUP'"
porter env set --group "$PORTER_GROUP" "${SEC_FLAGS[@]}" --skip-redeploys
echo "done. redeploy apps with \`porter apply -f porter.yaml\` when ready."
