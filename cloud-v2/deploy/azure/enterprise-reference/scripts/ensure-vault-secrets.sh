#!/usr/bin/env bash
set -euo pipefail

# Create the deployment's signing keys directly in Key Vault, exactly once.
# They exist on this machine only in a private temporary directory that is
# removed on exit. A deployed Core is never given new keys: that would sign
# every employee out and invalidate issued tokens. --fleet also creates the
# secrets Core and MFM share.
FLEET=false
if [[ "${1:-}" == --fleet ]]; then
  FLEET=true
  shift
fi
if [[ $# -ne 3 ]]; then
  printf 'Usage: %s [--fleet] <key-vault-name> <resource-group> <core-app-name>\n' "$0" >&2
  exit 2
fi
VAULT="$1"
RESOURCE_GROUP="$2"
CORE_NAME="$3"
[[ "$VAULT" =~ ^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$ ]] || { printf 'Invalid Key Vault name\n' >&2; exit 2; }
[[ "$CORE_NAME" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]] || { printf 'Invalid Core app name\n' >&2; exit 2; }
for command in az jq openssl; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 1; }
done
if [[ -n "${MENTRA_SUBSCRIPTION_ID:-}" ]]; then
  az() { command az "$@" --subscription "$MENTRA_SUBSCRIPTION_ID"; }
fi
NAMES=(refresh-token-pepper mentra-jwt-public-key miniapp-jwt-public-key mentra-jwt-private-key miniapp-jwt-private-key)
RETRY_SECONDS="${MENTRA_VAULT_RETRY_SECONDS:-10}"

ERRORS="$(mktemp "${TMPDIR:-/tmp}/mentra-vault-errors.XXXXXX")"
trap 'rm -f "$ERRORS"' EXIT

# A role assignment made moments ago by bootstrap.bicep can take a few minutes
# to reach Key Vault, and a new vault's name can take a moment to resolve.
# Retry only those; any other refusal is shown at once.
vault_call() {
  local attempt
  for attempt in $(seq 1 30); do
    if "$@" 2>"$ERRORS"; then return 0; fi
    if grep -q 'ForbiddenByRbac' "$ERRORS" || { grep -q 'Forbidden' "$ERRORS" && ! grep -q 'ForbiddenBy' "$ERRORS"; } ||
      grep -Eqi 'getaddrinfo|Name or service not known|nodename nor servname|Failed to establish a new connection' "$ERRORS"; then
      sleep "$RETRY_SECONDS"
      continue
    fi
    if grep -Eq 'ObjectIsDeletedButRecoverable|deleted but recoverable' "$ERRORS"; then
      printf 'Key Vault %s holds a deleted secret with that name. Recover it with "az keyvault secret recover --vault-name %s --name NAME", then run setup again.\n' \
        "$VAULT" "$VAULT" >&2
    fi
    grep '^ERROR' "$ERRORS" | head -n 3 >&2 || true
    return 1
  done
  printf 'Cannot use Key Vault %s yet. Setup gives whoever runs it the Key Vault Secrets Officer role, which can take a few minutes to apply; run setup again shortly.\n' "$VAULT" >&2
  return 1
}

list_names() { az keyvault secret list --vault-name "$VAULT" --query '[].name' --output json; }
PRESENT="$(vault_call list_names)"
MISSING=()
for name in "${NAMES[@]}"; do
  jq -e --arg name "$name" 'index($name) != null' <<<"$PRESENT" >/dev/null || MISSING+=("$name")
done
# Core's sign-in server's cookie keys and the admin portal's client secret at
# it. New values sign nobody out, so a missing one is created on any run that
# finds or creates the signing keys.
GENERATED=(oidc-cookie-keys oidc-admin-portal-client-secret)
# Mentra Portal's client secret at Core's sign-in server, likewise.
[[ "$FLEET" == true ]] && GENERATED+=(oidc-workspace-portal-client-secret)
generate_secret() {
  local dir status
  dir="$(mktemp -d)"
  (umask 077 && openssl rand -base64 48 | tr -d '\r\n' > "$dir/$1")
  az keyvault secret set --vault-name "$VAULT" --name "$1" --file "$dir/$1" --encoding utf-8 \
    --content-type text/plain --output none
  status=$?
  rm -rf "$dir"
  return $status
}
ensure_generated() {
  local name
  for name in "${GENERATED[@]}"; do
    if ! jq -e --arg name "$name" 'index($name) != null' <<<"$PRESENT" >/dev/null; then
      vault_call generate_secret "$name"
      printf 'Created %s in Key Vault %s.\n' "$name" "$VAULT" >&2
    fi
  done
  [[ "$FLEET" == true ]] && ensure_fleet
  return 0
}

# The two secrets Core and MFM share, each stored the way its reader takes it:
# Core signs what it forwards with fleet-forwarding-secret, which MFM checks
# against fleet-forwarding-secrets (a JSON array, newest first); MFM calls Core
# with fleet-service-secret, which Core finds under "fleet" in
# core-service-secrets (its CLOUD_CORE_SERVICE_SECRETS). The four are created
# together, once; a rotation edits them by hand (operations.md).
FLEET_SECRETS=(fleet-forwarding-secret fleet-forwarding-secrets fleet-service-secret core-service-secrets)
set_fleet_secret() {
  az keyvault secret set --vault-name "$VAULT" --name "$1" --file "$2" --encoding utf-8 --content-type text/plain --output none
}
ensure_fleet() {
  local name present=0 dir
  for name in "${FLEET_SECRETS[@]}"; do
    jq -e --arg name "$name" 'index($name) != null' <<<"$PRESENT" >/dev/null && present=$((present + 1))
  done
  [[ "$present" == "${#FLEET_SECRETS[@]}" ]] && return 0
  if [[ "$present" != 0 ]]; then
    printf 'Key Vault %s holds only some of %s. Recover the missing ones with "az keyvault secret recover", or delete them all and run setup again to create a new set.\n' \
      "$VAULT" "${FLEET_SECRETS[*]}" >&2
    exit 1
  fi
  dir="$(mktemp -d)"
  (
    umask 077
    random() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\r\n'; }
    forwarding="$(random)"
    service="$(random)"
    printf '%s' "$forwarding" > "$dir/fleet-forwarding-secret"
    jq -cn --arg s "$forwarding" '[$s]' | tr -d '\n' > "$dir/fleet-forwarding-secrets"
    printf '%s' "$service" > "$dir/fleet-service-secret"
    jq -cn --arg s "$service" '{fleet: [$s]}' | tr -d '\n' > "$dir/core-service-secrets"
  )
  for name in "${FLEET_SECRETS[@]}"; do
    [[ -s "$dir/$name" ]] || { rm -rf "$dir"; printf 'Secret generation produced an empty %s\n' "$name" >&2; exit 1; }
    vault_call set_fleet_secret "$name" "$dir/$name" || { rm -rf "$dir"; exit 1; }
  done
  rm -rf "$dir"
  printf 'Created the secrets Core and MFM share in Key Vault %s.\n' "$VAULT" >&2
}

if [[ ${#MISSING[@]} -eq 0 ]]; then
  printf 'Signing keys are in Key Vault %s.\n' "$VAULT" >&2
  ensure_generated
  exit 0
fi
# A failed lookup stops here; it must never read as "no Core yet".
CORE_COUNT="$(az containerapp list --resource-group "$RESOURCE_GROUP" --query "length([?name=='$CORE_NAME'])" --output tsv)"
if [[ "$CORE_COUNT" != 0 ]]; then
  printf 'Key Vault %s is missing %s, but Core already runs with the original keys. Recover them with "az keyvault secret recover --vault-name %s --name NAME". Setup never replaces the keys of a running deployment.\n' \
    "$VAULT" "${MISSING[*]}" "$VAULT" >&2
  exit 1
fi

# Nothing has used the keys yet, so an interrupted first run is completed
# by writing one fresh, matching set.
umask 077
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR" "$ERRORS"' EXIT
key_body() { sed '/^-----/d' "$1" | tr -d '\r\n'; }
openssl genpkey -algorithm ED25519 -out "$TEMP_DIR/access.pem"
openssl pkey -in "$TEMP_DIR/access.pem" -pubout -out "$TEMP_DIR/access.pub"
openssl genpkey -algorithm ED25519 -out "$TEMP_DIR/miniapp.pem"
openssl pkey -in "$TEMP_DIR/miniapp.pem" -pubout -out "$TEMP_DIR/miniapp.pub"
openssl rand -base64 48 | tr -d '\r\n' > "$TEMP_DIR/refresh-token-pepper"
key_body "$TEMP_DIR/access.pub" > "$TEMP_DIR/mentra-jwt-public-key"
key_body "$TEMP_DIR/miniapp.pub" > "$TEMP_DIR/miniapp-jwt-public-key"
key_body "$TEMP_DIR/access.pem" > "$TEMP_DIR/mentra-jwt-private-key"
key_body "$TEMP_DIR/miniapp.pem" > "$TEMP_DIR/miniapp-jwt-private-key"
set_secret() {
  # The value is read from a file, never passed as a command-line argument.
  az keyvault secret set --vault-name "$VAULT" --name "$1" --file "$TEMP_DIR/$1" --encoding utf-8 \
    --content-type text/plain --output none
}
for name in "${NAMES[@]}"; do
  [[ -s "$TEMP_DIR/$name" ]] || { printf 'Key generation produced an empty %s\n' "$name" >&2; exit 1; }
  vault_call set_secret "$name"
done
printf 'Created signing keys in Key Vault %s.\n' "$VAULT" >&2
ensure_generated
